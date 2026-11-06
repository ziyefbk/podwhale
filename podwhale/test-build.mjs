/** Exercise the real development builder against isolated, deliberately invalid sources. */
import { execFile } from 'node:child_process';
import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
const execute = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
// Allows an isolated one-file emit to test this source without changing runtime JS.
const packageRoot = resolve(process.env.PODWHALE_BUILD_TEST_PACKAGE_ROOT || HERE);
const parent = join(packageRoot, '..', '.tmp');
await mkdir(parent, { recursive: true });
const fixture = await mkdtemp(join(parent, 'build-test-'));
const modulesLink = join(fixture, 'node_modules');
const modulesTarget = await realpath(join(packageRoot, 'node_modules'));
let linked = false;
let failures = 0;
let passed = 0;
function check(name, ok) {
    console.log((ok ? 'ok   ' : 'FAIL ') + name);
    if (ok)
        passed += 1;
    else
        failures += 1;
}
async function put(relative, text) {
    const path = join(fixture, relative);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text, 'utf8');
}
async function build(...args) {
    try {
        const result = await execute(process.execPath, [join(fixture, 'tools/build.mjs'), ...args], {
            cwd: fixture, windowsHide: true, timeout: 60000, maxBuffer: 1024 * 1024,
        });
        return { ok: true, output: result.stdout + result.stderr };
    }
    catch (caught) {
        const error = caught;
        return { ok: false, output: (error.stdout || '') + (error.stderr || '') };
    }
}
async function snapshot() {
    return Promise.all([readFile(join(fixture, 'server/mobile.mjs'), 'utf8'), readFile(join(fixture, 'server/page.mjs'), 'utf8')]);
}
function identical(left, right) {
    return left.length === right.length && left.every((text, index) => text === right[index]);
}
const mobileSource = "const MOBILE_SCRIPT = '__PODWHALE_MOBILE_SCRIPT__';\nexport const MOBILE = `<html><script>${MOBILE_SCRIPT}</script></html>`;\n";
const pageSource = "const PAGE_SCRIPT = '__PODWHALE_PAGE_SCRIPT__';\nexport const PAGE = `<html><script>${PAGE_SCRIPT}</script></html>`;\n";
const mobileBrowser = "console.log('mobile fixture');\n";
const pageBrowser = "console.log('page fixture');\n";
const config = {
    compilerOptions: {
        target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext', rootDir: 'src', outDir: '.compiled',
        strict: true, noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true,
        useUnknownInCatchVariables: true, noEmitOnError: true, types: [], lib: ['ES2023'], newLine: 'lf',
    },
    include: ['src/**/*.mts'],
};
try {
    await mkdir(join(fixture, 'tools'));
    await mkdir(join(fixture, 'server'));
    await mkdir(join(fixture, 'miniprogram'));
    await symlink(modulesTarget, modulesLink, process.platform === 'win32' ? 'junction' : 'dir');
    linked = true;
    await copyFile(join(packageRoot, 'tools/build.mjs'), join(fixture, 'tools/build.mjs'));
    await put('package.json', '{"private":true,"type":"module"}\n');
    await put('tsconfig.json', JSON.stringify(config));
    await put('tools/source-inventory.json', '["server/mobile.mjs","server/page.mjs"]\n');
    await put('src/server/mobile.mts', mobileSource);
    await put('src/server/page.mts', pageSource);
    await put('src/browser/mobile.ts', mobileBrowser);
    await put('src/browser/page.ts', pageBrowser);
    for (const name of ['browser-common', 'browser-mobile', 'browser-page'])
        await put('src/types/' + name + '.d.ts', '');
    const built = await build();
    if (!built.ok)
        throw new Error('Valid build fixture was rejected');
    const original = await snapshot();
    const mobile = await import(pathToFileURL(join(fixture, 'server/mobile.mjs')).href);
    const page = await import(pathToFileURL(join(fixture, 'server/page.mjs')).href);
    check('a real build emits both inline browser scripts without unresolved markers', typeof mobile.MOBILE === 'string'
        && typeof page.PAGE === 'string' && mobile.MOBILE.includes('mobile fixture') && page.PAGE.includes('page fixture')
        && !original.some((text) => text.includes('__PODWHALE_')));
    check('consistency mode accepts fresh generated JavaScript without rewriting it', (await build('--check')).ok
        && identical(original, await snapshot()));
    check('typecheck mode validates sources without rewriting runtime JavaScript', (await build('--typecheck')).ok
        && identical(original, await snapshot()));
    await put('server/mobile.mjs', original[0] + '\n// handwritten fixture change\n');
    const tampered = await snapshot();
    const stale = await build('--check');
    check('consistency mode rejects stale JavaScript and preserves the edited bytes', !stale.ok
        && stale.output.includes('Stale generated JS') && identical(tampered, await snapshot()));
    await put('server/mobile.mjs', original[0]);
    await put('src/server/mobile.mts', mobileSource + 'const invalid: string = 42;\n');
    await put('src/browser/page.ts', "console.log('changed page must not be published');\n");
    const invalid = await build();
    check('a source type error prevents all runtime writes including other changed outputs', !invalid.ok
        && invalid.output.includes('TS2322') && identical(original, await snapshot()));
    await put('src/server/mobile.mts', mobileSource);
    await put('src/browser/page.ts', pageBrowser);
    await unlink(join(fixture, 'src/browser/mobile.ts'));
    const absent = await build();
    check('missing browser source fails without publishing an unresolved template marker', !absent.ok
        && absent.output.includes('Missing inline script or template') && identical(original, await snapshot()));
    await put('src/browser/mobile.ts', mobileBrowser);
    await put('unmapped.js', 'console.log("native fixture");\n');
    const native = await build();
    check('native JavaScript without a TypeScript source is rejected before runtime writes', !native.ok
        && native.output.includes('JavaScript has no TypeScript source') && identical(original, await snapshot()));
    await unlink(join(fixture, 'unmapped.js'));
    await put('src/browser/mobile.ts', 'const value: ' + 'any' + ' = 1; console.log(value);\n');
    const escaped = await build();
    check('an explicit untyped escape is rejected without changing runtime bytes', !escaped.ok
        && escaped.output.includes('Explicit any') && identical(original, await snapshot()));
    for (const directive of ['ignore', 'nocheck']) {
        await put('src/browser/mobile.ts', '// @ts-' + directive + '\nconst invalid: string = 42;\n');
        const suppressed = await build();
        check('suppressed checking is rejected: ' + directive, !suppressed.ok
            && suppressed.output.includes('Suppressed type checking') && identical(original, await snapshot()));
    }
    await put('src/browser/mobile.ts', mobileBrowser);
    await put('tsconfig.json', JSON.stringify({ ...config, compilerOptions: { ...config.compilerOptions, strict: false } }));
    const relaxed = await build();
    check('disabling strict checking is refused without changing runtime bytes', !relaxed.ok
        && relaxed.output.includes('Required compiler option: strict') && identical(original, await snapshot()));
    await put('tsconfig.json', JSON.stringify(config));
    await put('src/browser/mobile.ts', "console.log('</script>');\n");
    const closingTag = await build();
    check('a browser closing-script tag cannot escape the emitted HTML template', !closingTag.ok
        && closingTag.output.includes('Inline script contains an HTML closing tag') && identical(original, await snapshot()));
}
catch {
    check('isolated build regression suite completes', false);
}
finally {
    const actual = await realpath(fixture);
    const expectedParent = await realpath(parent);
    if (dirname(actual).toLowerCase() !== expectedParent.toLowerCase() || !basename(actual).startsWith('build-test-')) {
        throw new Error('Unexpected build fixture cleanup path');
    }
    if (linked) {
        if (!(await lstat(modulesLink)).isSymbolicLink() || await realpath(modulesLink) !== modulesTarget) {
            throw new Error('Unexpected build dependency junction');
        }
        // Remove the link itself before recursively deleting this fixture.
        await unlink(modulesLink);
    }
    await rm(actual, { recursive: true, force: true });
}
console.log(failures ? failures + ' FAILED' : 'ALL PASS (' + passed + ' checks)');
process.exitCode = failures ? 1 : 0;
