/** Exercise the actual npm archive and Node resolution in a new profile. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { packRelease, inspectReleaseFiles, inspectCharacterArt, CHARACTER_FILES } from './pack-release.mjs';
const HERE = dirname(fileURLToPath(import.meta.url));
const parent = resolve(HERE, '..', '.tmp');
await mkdir(parent, { recursive: true });
const temp = await mkdtemp(join(parent, 'package-test-'));
const execute = promisify(execFile);
let failed = 0;
function check(name, ok) { console.log((ok ? 'ok   ' : 'FAIL ') + name); if (!ok)
    failed += 1; }
function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++)
            crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
    return (crc ^ 0xffffffff) >>> 0;
}
function rgbaFixture(size) {
    const chunk = (name, data) => {
        const value = Buffer.alloc(data.length + 12);
        value.writeUInt32BE(data.length);
        value.write(name, 4, 'ascii');
        data.copy(value, 8);
        value.writeUInt32BE(crc32(value.subarray(4, -4)), value.length - 4);
        return value;
    };
    const header = Buffer.alloc(13);
    header.writeUInt32BE(size);
    header.writeUInt32BE(size, 4);
    header[8] = 8;
    header[9] = 6;
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.alloc(size * (size * 4 + 1)))), chunk('IEND', Buffer.alloc(0))]);
}
try {
    const packed = await packRelease({ outDir: join(temp, 'original') });
    check('real npm archive contains runtime helpers, licenses and PWA icons', packed.files.includes('NOTICE') && packed.files.includes('LICENSE')
        && packed.files.includes('server/http-guard.mjs') && packed.files.includes('server/static/icon-512.png'));
    const checksum = await readFile(packed.checksums, 'utf8');
    check('checksum file describes the exact release archive bytes', checksum === createHash('sha256').update(await readFile(packed.artifact)).digest('hex')
        + '  ' + basename(packed.artifact) + '\n');
    const profile = join(temp, 'fresh-profile');
    const installed = join(profile, 'node_modules', 'podwhale');
    await mkdir(installed, { recursive: true });
    await writeFile(join(profile, 'package.json'), '{"private":true,"type":"module"}');
    await execute('tar', ['-xzf', packed.artifact, '--strip-components', '1', '-C', installed], { timeout: 10000, windowsHide: true });
    const metadata = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'));
    check('published runtime has no npm dependencies', Object.keys(metadata.dependencies || {}).length === 0);
    check('release is publishable only to the public npm registry', metadata.private !== true
        && metadata.publishConfig?.registry === 'https://registry.npmjs.org/' && metadata.publishConfig?.access === 'public');
    check('archive excludes TypeScript sources and development compiler tools', packed.files.every((file) => !/^(?:src|tools|node_modules)\//.test(file) && !/\.(?:mts|ts)$/.test(file)));
    const patch = await readFile(join(installed, metadata.dsh.bundle.patch), 'utf8');
    const reference = /^\s+name:\s*['"]?([^'"\r\n]+)['"]?\s*$/m.exec(patch)?.[1]?.trim();
    // Resolve the bundle's actual row from a fresh profile, with no @local alias.
    const probe = `import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const require=createRequire(pathToFileURL(process.cwd()+'/package.json'));
const entry=require.resolve(process.argv[1]);
const plugin=await import(pathToFileURL(entry));
if(typeof plugin.apply!=='function')process.exit(2);
console.log(JSON.stringify({loaded:true,entry}));`;
    const loaded = await execute(process.execPath, ['--input-type=module', '-e', probe, reference], {
        cwd: profile, timeout: 10000, windowsHide: true,
    });
    const result = JSON.parse(loaded.stdout);
    check('bundle row resolves and imports from an unaliased fresh profile', result.loaded
        && resolve(result.entry) === resolve(installed, 'index.js'));
    check('package declares its real repository subdirectory and MIT license', metadata.repository.directory === 'podwhale' && metadata.license === 'MIT');
    check('release declares a host compatibility range and no installation hooks', typeof metadata.engines.dsh === 'string'
        && !['preinstall', 'install', 'postinstall', 'prepare'].some((key) => metadata.scripts?.[key]));
    const license = await readFile(join(installed, 'LICENSE'), 'utf8');
    check('published license matches the repository grant', license === await readFile(join(HERE, '..', 'LICENSE'), 'utf8')
        && license.includes('Permission is hereby granted'));
    const readme = await readFile(join(installed, 'README.md'), 'utf8');
    const sources = [
        ...[...readme.matchAll(/<img\s[^>]*src="([^"]+)"/g)].map((match) => match[1]),
        ...[...readme.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)].map((match) => match[1]),
    ];
    // Screenshot count is presentation; local references must work in the actual archive.
    const localFiles = [...new Set(sources.filter((source) => !/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(source))
            .map((source) => decodeURIComponent(source.split(/[?#]/)[0]).replace(/^\.\//, '')))];
    check('readme local documentation and images ship in the release', localFiles.length > 0
        && localFiles.every((file) => packed.files.includes(file)));
    const art = await inspectCharacterArt(installed);
    check('public package bundles exactly the audited character files', art.files === 7 && art.pngs === 5 && art.actions === 12
        && packed.files.filter(name => name.startsWith('pet-art/')).length === 7 && CHARACTER_FILES.every(name => packed.files.includes('pet-art/' + name)));
    const artDir = join(installed, 'pet-art'), manifestPath = join(artDir, 'manifest.json');
    const manifestBytes = await readFile(manifestPath), portraitBytes = await readFile(join(artDir, 'portrait.png')), atlasBytes = await readFile(join(artDir, 'atlas-a.png'));
    const manifest = () => JSON.parse(manifestBytes.toString('utf8'));
    const rejectedArt = async () => { try {
        await inspectCharacterArt(installed);
        return false;
    }
    catch {
        return true;
    } };
    const extraManifest = { ...manifest(), unexpected: true };
    await writeFile(manifestPath, JSON.stringify(extraManifest));
    check('character manifest rejects unknown fields', await rejectedArt());
    const wrongDimensions = manifest();
    wrongDimensions.files['portrait.png'].width += 1;
    await writeFile(manifestPath, JSON.stringify(wrongDimensions));
    check('character art rejects a manifest with wrong actual dimensions', await rejectedArt());
    const wrongActions = manifest();
    wrongActions.files['atlas-a.png'].actions = ['wave', 'idle', 'happy', 'sleep'];
    await writeFile(manifestPath, JSON.stringify(wrongActions));
    check('character art rejects an incorrect atlas action order', await rejectedArt());
    const brokenPng = Buffer.from(portraitBytes);
    brokenPng[brokenPng.length - 1] = brokenPng[brokenPng.length - 1] ^ 1;
    const brokenManifest = manifest();
    brokenManifest.files['portrait.png'].sha256 = createHash('sha256').update(brokenPng).digest('hex');
    await writeFile(join(artDir, 'portrait.png'), brokenPng);
    await writeFile(manifestPath, JSON.stringify(brokenManifest));
    check('character art checks PNG CRC even when a changed image hash matches', await rejectedArt());
    const opaqueHeader = Buffer.from(portraitBytes);
    opaqueHeader[25] = 2;
    opaqueHeader.writeUInt32BE(crc32(opaqueHeader.subarray(12, 29)), 29);
    const opaqueManifest = manifest();
    opaqueManifest.files['portrait.png'].sha256 = createHash('sha256').update(opaqueHeader).digest('hex');
    await writeFile(join(artDir, 'portrait.png'), opaqueHeader);
    await writeFile(manifestPath, JSON.stringify(opaqueManifest));
    check('character art requires RGBA even with a matching hash and valid header CRC', await rejectedArt());
    await writeFile(join(artDir, 'portrait.png'), portraitBytes);
    const fractional = rgbaFixture(5), fractionalManifest = manifest();
    Object.assign(fractionalManifest.files['atlas-a.png'], { width: 5, height: 5, sha256: createHash('sha256').update(fractional).digest('hex') });
    await writeFile(join(artDir, 'atlas-a.png'), fractional);
    await writeFile(manifestPath, JSON.stringify(fractionalManifest));
    check('character atlases accept fractional cells instead of requiring dimensions divisible by four', (await inspectCharacterArt(installed)).actions === 12);
    await writeFile(join(artDir, 'atlas-a.png'), atlasBytes);
    await writeFile(manifestPath, manifestBytes);
    const sourcePath = join(artDir, 'SOURCE.md'), sourceBytes = await readFile(sourcePath);
    await writeFile(sourcePath, Buffer.concat([sourceBytes, Buffer.from('\nchanged synthetic source\n')]));
    check('character source provenance is protected by its manifest checksum', await rejectedArt());
    await writeFile(sourcePath, sourceBytes);
    for (const size of [192, 512]) {
        const png = await readFile(join(installed, 'server', 'static', `icon-${size}.png`));
        check(`published PWA icon has the advertised ${size}px dimensions`, png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
            && png.readUInt32BE(16) === size && png.readUInt32BE(20) === size);
    }
    const privateFiles = ['local.json', 'remote.json', 'companion.json', 'companion-wechat-access.json', 'companion-wechat-client.json', 'social.json', '.env', '.npmrc', 'server/data/owners.json',
        'server/data/media/private.png', 'data/feed.db', 'assets/whale-girl.png',
        'assets/whale-girl-face.png', 'assets/whale-actions-a.png', 'assets/whale-actions-b.png', 'legacy/owners.json',
        'pet-art/private.png', 'pet-art/extra.json', 'pet-art/candidates/sheet.png'];
    for (const name of privateFiles) {
        const target = join(installed, name);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, 'private-fixture-not-for-distribution');
    }
    const repacked = await packRelease({ packageDir: installed, outDir: join(temp, 'with-private-fixtures') });
    check('real repack excludes private configs, runtime data and optional artwork', privateFiles.every((name) => !repacked.files.includes(name)));
    for (const name of ['../outside', '/absolute', 'server/data/owners.json', 'remote.json', '.env.production', 'key.pem', 'pet-art/private.png', 'pet-art/extra.json', 'pet-art/candidates/sheet.png']) {
        let rejected = false;
        try {
            inspectReleaseFiles([...packed.files, name]);
        }
        catch {
            rejected = true;
        }
        check('release gate refuses unsafe member ' + name, rejected);
    }
    let missingArt = false;
    try {
        inspectReleaseFiles(packed.files.filter(name => name !== 'pet-art/face.png'));
    }
    catch {
        missingArt = true;
    }
    check('release gate requires every bundled character image', missingArt);
}
catch (caught) {
    const error = caught;
    check('release archive can be built and loaded without an unexpected exception', false);
    console.error(error.message);
}
finally {
    const actual = await realpath(temp);
    const expected = await realpath(parent);
    if (dirname(actual).toLowerCase() !== expected.toLowerCase() || !basename(actual).startsWith('package-test-'))
        throw new Error('Unsafe package fixture cleanup');
    await rm(actual, { recursive: true, force: true });
}
process.exitCode = failed ? 1 : 0;
