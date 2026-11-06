/** Exercise the actual npm archive and Node resolution in a new profile. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packRelease, inspectReleaseFiles } from './pack-release.mjs';
const HERE = dirname(fileURLToPath(import.meta.url));
const parent = resolve(HERE, '..', '.tmp');
await mkdir(parent, { recursive: true });
const temp = await mkdtemp(join(parent, 'package-test-'));
const execute = promisify(execFile);
let failed = 0;
function check(name, ok) { console.log((ok ? 'ok   ' : 'FAIL ') + name); if (!ok)
    failed += 1; }
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
    const sources = [...readme.matchAll(/<img\s[^>]*src="([^"]+)"/g)].map((match) => match[1]);
    const screenshots = sources.filter((source) => source.startsWith('docs/screenshots/'));
    check('readme screenshots ship as local release assets', screenshots.length === 3
        && screenshots.every((source) => packed.files.includes(source)));
    for (const size of [192, 512]) {
        const png = await readFile(join(installed, 'server', 'static', `icon-${size}.png`));
        check(`published PWA icon has the advertised ${size}px dimensions`, png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
            && png.readUInt32BE(16) === size && png.readUInt32BE(20) === size);
    }
    const privateFiles = ['local.json', 'remote.json', '.env', '.npmrc', 'server/data/owners.json',
        'server/data/media/private.png', 'data/feed.db', 'assets/whale-girl.png', 'legacy/owners.json'];
    for (const name of privateFiles) {
        const target = join(installed, name);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, 'private-fixture-not-for-distribution');
    }
    const repacked = await packRelease({ packageDir: installed, outDir: join(temp, 'with-private-fixtures') });
    check('real repack excludes private configs, runtime data and optional artwork', privateFiles.every((name) => !repacked.files.includes(name)));
    for (const name of ['../outside', '/absolute', 'server/data/owners.json', 'remote.json', '.env.production', 'key.pem']) {
        let rejected = false;
        try {
            inspectReleaseFiles([...packed.files, name]);
        }
        catch {
            rejected = true;
        }
        check('release gate refuses unsafe member ' + name, rejected);
    }
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
