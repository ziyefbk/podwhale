/** Build and inspect a zero-dependency release; never publishes or runs scripts. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const execute = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
function record(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
const REQUIRED = ['package.json', 'README.md', 'LICENSE', 'NOTICE', 'index.js', 'client.js',
    'cordis.patch.yml', 'community-endpoint.mjs', 'patrol-runtime.mjs', 'final-request-validator.mjs', 'private-config.mjs',
    'server/community.mjs', 'server/auth.mjs', 'server/http-guard.mjs', 'server/types.mjs',
    'server/static/icon-192.png', 'server/static/icon-512.png', 'docs/compatibility.md',
    'docs/releasing.md', 'docs/screenshots/mobile-feed.png',
    'docs/screenshots/mobile-tasks.png', 'docs/screenshots/mobile-approval.png'];
async function exists(path) { try {
    await access(path);
    return true;
}
catch {
    return false;
} }
export function inspectReleaseFiles(files, { version } = {}) {
    if (!Array.isArray(files) || !files.length)
        throw new Error('Release file list is empty');
    for (const name of files) {
        if (typeof name !== 'string' || name.startsWith('/') || name.includes('\\')
            || name.split('/').some((part) => !part || part === '..' || part === '.')) {
            throw new Error('Unsafe release archive path');
        }
        const segments = name.toLowerCase().split('/');
        const leaf = segments.at(-1);
        if (segments.some((part) => ['data', 'assets', 'legacy', 'node_modules', '.git', '.tmp'].includes(part))
            || /^(?:local|remote|owners|credentials)\.json$/.test(leaf)
            || /^\.env(?:\.|$)/.test(leaf) || leaf === '.npmrc' || leaf === '.credentials.yaml'
            || /\.(?:db|db-journal|db-wal|db-shm|log|pem|key)$/.test(leaf)) {
            throw new Error('Private or optional local content included in release');
        }
    }
    const required = version ? [...REQUIRED, `docs/release-${version}.md`] : REQUIRED;
    for (const name of required)
        if (!files.includes(name))
            throw new Error('Missing release file: ' + name);
}
async function npmCli() {
    const candidates = [];
    if (process.env.npm_execpath)
        candidates.push(process.env.npm_execpath);
    const { stdout } = await execute(process.platform === 'win32' ? 'where.exe' : 'which', [process.platform === 'win32' ? 'npm.cmd' : 'npm'], { timeout: 10000, windowsHide: true });
    for (const command of stdout.trim().split(/\r?\n/)) {
        const resolved = await realpath(command);
        if (basename(resolved) === 'npm-cli.js')
            candidates.push(resolved);
        candidates.push(join(dirname(command), 'node_modules', 'npm', 'bin', 'npm-cli.js'));
    }
    for (const candidate of candidates)
        if (await exists(candidate))
            return candidate;
    throw new Error('npm CLI not found; use a Node installation that includes npm');
}
export async function packRelease({ packageDir = HERE, outDir = resolve(HERE, '..', '.tmp', 'releases') } = {}) {
    // npm pack intentionally ignores lifecycle hooks. In a source checkout the
    // explicit gate prevents shipping stale JS; installed archives need no SDK.
    if (await exists(join(packageDir, 'src'))) {
        await execute(process.execPath, [join(packageDir, 'tools', 'build.mjs'), '--check'], {
            cwd: packageDir, timeout: 120000, windowsHide: true, maxBuffer: 2 * 1024 * 1024,
        });
    }
    const metadata = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'));
    if (!record(metadata) || metadata.name !== 'podwhale' || typeof metadata.version !== 'string'
        || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(metadata.version)
        || metadata.license !== 'MIT' || !record(metadata.dsh) || !record(metadata.dsh.bundle) || !metadata.dsh.bundle.patch) {
        throw new Error('Invalid release package metadata');
    }
    const output = resolve(outDir);
    await mkdir(output, { recursive: true });
    const { stdout } = await execute(process.execPath, [await npmCli(), 'pack', '--ignore-scripts',
        '--json', '--pack-destination', output], { cwd: packageDir, timeout: 60000, windowsHide: true,
        maxBuffer: 2 * 1024 * 1024 });
    const packResults = JSON.parse(stdout);
    if (!Array.isArray(packResults) || !record(packResults[0]))
        throw new Error('Invalid npm archive metadata');
    const packed = packResults[0];
    const expected = `podwhale-${metadata.version}.tgz`;
    if (packed.filename !== expected)
        throw new Error('Unexpected release archive name');
    const files = packed.files;
    if (!Array.isArray(files) || !files.every((file) => record(file) && typeof file.path === 'string')) {
        throw new Error('Invalid npm archive file list');
    }
    const names = files.map((file) => file.path);
    inspectReleaseFiles(names, { version: metadata.version });
    const artifact = join(output, expected);
    const listing = await execute('tar', ['-tzf', artifact], { timeout: 10000, windowsHide: true });
    const entries = listing.stdout.trim().split(/\r?\n/);
    if (entries.some((entry) => !entry.startsWith('package/')))
        throw new Error('Unexpected archive root');
    inspectReleaseFiles(entries.filter((entry) => !entry.endsWith('/')).map((entry) => entry.slice(8)), { version: metadata.version });
    const sha256 = createHash('sha256').update(await readFile(artifact)).digest('hex');
    const checksums = join(output, 'SHA256SUMS');
    await writeFile(checksums, `${sha256}  ${expected}\n`);
    return { artifact, checksums, sha256, version: metadata.version, files: names };
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
    try {
        const args = process.argv.slice(2);
        if (args.length && (args.length !== 2 || args[0] !== '--out-dir'))
            throw new Error('Usage: node pack-release.mjs [--out-dir DIRECTORY]');
        const result = await packRelease(args.length ? { outDir: args[1] } : {});
        console.log(JSON.stringify({ version: result.version, artifact: result.artifact,
            checksums: result.checksums, sha256: result.sha256 }));
    }
    catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}
