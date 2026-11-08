/** Build and inspect a zero-dependency release; never publishes or runs scripts. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const execute = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export const CHARACTER_FILES = ['atlas-a.png', 'atlas-b.png', 'atlas-c.png', 'portrait.png', 'face.png', 'manifest.json', 'SOURCE.md'] as const;
const CHARACTER_PNGS = ['atlas-a.png', 'atlas-b.png', 'atlas-c.png', 'portrait.png', 'face.png'] as const;
type CharacterPng = typeof CHARACTER_PNGS[number];
const CHARACTER_ACTIONS = {
  'atlas-a.png': ['idle', 'wave', 'happy', 'sleep'],
  'atlas-b.png': ['think', 'drag', 'read', 'write'],
  'atlas-c.png': ['talk', 'walk', 'stretch', 'surprised'],
} as const;
interface CharacterImage { sha256: string; width: number; height: number }
function artError(): never { throw new Error('Invalid bundled character art or manifest'); }
function exactRecord(value: unknown, keys: readonly string[]) {
  if (!record(value) || Object.keys(value).length !== keys.length || !keys.every(key => Object.prototype.hasOwnProperty.call(value, key))) artError();
  return value;
}
function artHash(value: unknown) { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) artError(); return value; }
function artDimension(value: unknown) { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 8192) artError(); return value; }
function characterManifest(value: unknown) {
  const manifest = exactRecord(value, ['schemaVersion', 'artVersion', 'provenance', 'files']);
  if (manifest.schemaVersion !== 1 || manifest.artVersion !== 'v1') artError();
  const source = exactRecord(manifest.provenance, ['tool', 'referencePath', 'referenceSha256', 'sourceDocument', 'sourceSha256']);
  if (source.tool !== 'imagegen' || source.referencePath !== '.github/marketing/whale-community-art.png' || source.sourceDocument !== 'SOURCE.md') artError();
  artHash(source.referenceSha256);
  const sourceSha256 = artHash(source.sourceSha256);
  const files = exactRecord(manifest.files, CHARACTER_PNGS);
  const images = new Map<CharacterPng, CharacterImage>();
  for (const name of CHARACTER_PNGS) {
    const atlas = name === 'atlas-a.png' || name === 'atlas-b.png' || name === 'atlas-c.png';
    const file = exactRecord(files[name], atlas ? ['sha256', 'width', 'height', 'columns', 'rows', 'actions'] : ['sha256', 'width', 'height']);
    const image = { sha256: artHash(file.sha256), width: artDimension(file.width), height: artDimension(file.height) };
    const actions = file.actions;
    if (atlas && (image.width !== image.height || file.columns !== 4 || file.rows !== 4 || !Array.isArray(actions)
      || actions.length !== 4 || !CHARACTER_ACTIONS[name].every((action, index) => actions[index] === action))) artError();
    images.set(name, image);
  }
  return { sourceSha256, images };
}
const CRC_TABLE = Uint32Array.from(Array.from({ length: 256 }, (_value, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
}));
function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 255]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function inspectCharacterPng(bytes: Buffer, expected: CharacterImage) {
  if (bytes.length < 45 || bytes.length > 20 * 1024 * 1024 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) artError();
  let offset = 8, header = false, pixels = false, end = false;
  while (offset + 12 <= bytes.length && !end) {
    const size = bytes.readUInt32BE(offset), next = offset + size + 12;
    if (next > bytes.length) artError();
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    if (!/^[A-Za-z]{4}$/.test(type) || crc32(bytes.subarray(offset + 4, next - 4)) !== bytes.readUInt32BE(next - 4)) artError();
    if (!header && type !== 'IHDR') artError();
    if (type === 'IHDR') {
      if (header || offset !== 8 || size !== 13 || bytes.readUInt32BE(offset + 8) !== expected.width || bytes.readUInt32BE(offset + 12) !== expected.height
        || bytes[offset + 16] !== 8 || bytes[offset + 17] !== 6 || bytes[offset + 18] !== 0 || bytes[offset + 19] !== 0 || bytes[offset + 20] !== 0) artError();
      header = true;
    } else if (type === 'IDAT') { if (!size) artError(); pixels = true; }
    else if (type === 'IEND') { if (size || !pixels) artError(); end = true; }
    else if (/^[A-Z]/.test(type) && type !== 'PLTE') artError();
    offset = next;
  }
  if (!header || !pixels || !end || offset !== bytes.length || createHash('sha256').update(bytes).digest('hex') !== expected.sha256) artError();
}
async function inspectCharacterData(read: (name: typeof CHARACTER_FILES[number]) => Promise<Buffer>) {
  const bytes = await read('manifest.json');
  if (bytes.length > 32768) artError();
  const value: unknown = JSON.parse(bytes.toString('utf8'));
  const manifest = characterManifest(value);
  const source = await read('SOURCE.md');
  if (!source.length || source.length > 131072 || createHash('sha256').update(source).digest('hex') !== manifest.sourceSha256) artError();
  for (const name of CHARACTER_PNGS) inspectCharacterPng(await read(name), manifest.images.get(name)!);
  return { files: CHARACTER_FILES.length, pngs: CHARACTER_PNGS.length, actions: 12, rgba: true, checksums: true };
}
/** Validate fixed public assets without loading optional local artwork. */
export async function inspectCharacterArt(packageDir = HERE) {
  return inspectCharacterData(name => readFile(join(packageDir, 'pet-art', name)));
}
const REQUIRED = ['package.json', 'README.md', 'LICENSE', 'NOTICE', 'index.js', 'client.js',
  'cordis.patch.yml', 'community-endpoint.mjs', 'official-community.mjs', 'community-connection.mjs', 'community-connection-http.mjs',
  'patrol-runtime.mjs', 'final-request-validator.mjs', 'private-config.mjs',
  'companion-runtime.mjs', 'companion-service.mjs', 'companion-types.mjs', 'companion-http.mjs', 'companion-setup.mjs', 'wechat-relay.mjs',
  'social-controller.mjs', 'social-types.mjs', 'social-http.mjs', 'social-community.mjs', 'server/social-policy.mjs',
  'server/community.mjs', 'server/auth.mjs', 'server/http-guard.mjs', 'server/types.mjs',
  'server/static/icon-192.png', 'server/static/icon-512.png', 'docs/compatibility.md',
  'docs/releasing.md', 'docs/screenshots/mobile-feed.png',
  'docs/screenshots/mobile-tasks.png', 'docs/screenshots/mobile-approval.png', 'docs/character-art.md',
  ...CHARACTER_FILES.map(name => 'pet-art/' + name)];

async function exists(path: string) { try { await access(path); return true; } catch { return false; } }

export function inspectReleaseFiles(files: unknown, { version }: { version?: string } = {}) {
  if (!Array.isArray(files) || !files.length) throw new Error('Release file list is empty');
  for (const name of files) {
    if (typeof name !== 'string' || name.startsWith('/') || name.includes('\\')
        || name.split('/').some((part) => !part || part === '..' || part === '.')) {
      throw new Error('Unsafe release archive path');
    }
    const segments = name.toLowerCase().split('/');
    const leaf = segments.at(-1)!;
    if (segments[0] === 'pet-art' && !CHARACTER_FILES.some(file => name === 'pet-art/' + file)) throw new Error('Unlisted bundled character file');
    if (segments.some((part) => ['data', 'assets', 'legacy', 'node_modules', '.git', '.tmp'].includes(part))
        || /^(?:local|remote|owners|credentials|companion|companion-wechat-access|companion-wechat-client|social)\.json$/.test(leaf)
        || /^\.env(?:\.|$)/.test(leaf) || leaf === '.npmrc' || leaf === '.credentials.yaml'
        || /\.(?:db|db-journal|db-wal|db-shm|log|pem|key)$/.test(leaf)) {
      throw new Error('Private or optional local content included in release');
    }
  }
  const required = version ? [...REQUIRED, `docs/release-${version}.md`] : REQUIRED;
  for (const name of required) if (!files.includes(name)) throw new Error('Missing release file: ' + name);
}

async function npmCli() {
  const candidates = [];
  if (process.env.npm_execpath) candidates.push(process.env.npm_execpath);
  const { stdout } = await execute(process.platform === 'win32' ? 'where.exe' : 'which',
    [process.platform === 'win32' ? 'npm.cmd' : 'npm'], { timeout: 10000, windowsHide: true });
  for (const command of stdout.trim().split(/\r?\n/)) {
    const resolved = await realpath(command);
    if (basename(resolved) === 'npm-cli.js') candidates.push(resolved);
    candidates.push(join(dirname(command), 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  }
  for (const candidate of candidates) if (await exists(candidate)) return candidate;
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
  const metadata: unknown = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'));
  if (!record(metadata) || metadata.name !== 'podwhale' || typeof metadata.version !== 'string'
      || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(metadata.version)
      || metadata.license !== 'MIT' || !record(metadata.dsh) || !record(metadata.dsh.bundle) || !metadata.dsh.bundle.patch) {
    throw new Error('Invalid release package metadata');
  }
  const output = resolve(outDir);
  await inspectCharacterArt(packageDir);
  await mkdir(output, { recursive: true });
  const { stdout } = await execute(process.execPath, [await npmCli(), 'pack', '--ignore-scripts',
    '--json', '--pack-destination', output], { cwd: packageDir, timeout: 60000, windowsHide: true,
    maxBuffer: 2 * 1024 * 1024 });
  const packResults: unknown = JSON.parse(stdout);
  if (!Array.isArray(packResults) || !record(packResults[0])) throw new Error('Invalid npm archive metadata');
  const packed = packResults[0];
  const expected = `podwhale-${metadata.version}.tgz`;
  if (packed.filename !== expected) throw new Error('Unexpected release archive name');
  const files: unknown = packed.files;
  if (!Array.isArray(files) || !files.every((file: unknown): file is { path: string } => record(file) && typeof file.path === 'string')) {
    throw new Error('Invalid npm archive file list');
  }
  const names = files.map((file) => file.path);
  inspectReleaseFiles(names, { version: metadata.version });
  const artifact = join(output, expected);
  const listing = await execute('tar', ['-tzf', artifact], { timeout: 10000, windowsHide: true });
  const entries = listing.stdout.trim().split(/\r?\n/);
  if (entries.some((entry) => !entry.startsWith('package/'))) throw new Error('Unexpected archive root');
  inspectReleaseFiles(entries.filter((entry) => !entry.endsWith('/')).map((entry) => entry.slice(8)), { version: metadata.version });
  await inspectCharacterData(async name => {
    const { stdout } = await execute('tar', ['-xOzf', artifact, 'package/pet-art/' + name], { encoding: 'buffer', timeout: 10000, windowsHide: true, maxBuffer: 21 * 1024 * 1024 });
    return stdout;
  });
  const sha256 = createHash('sha256').update(await readFile(artifact)).digest('hex');
  const checksums = join(output, 'SHA256SUMS');
  await writeFile(checksums, `${sha256}  ${expected}\n`);
  return { artifact, checksums, sha256, version: metadata.version, files: names };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const args = process.argv.slice(2);
    if (args.length && (args.length !== 2 || args[0] !== '--out-dir')) throw new Error('Usage: node pack-release.mjs [--out-dir DIRECTORY]');
    const result = await packRelease(args.length ? { outDir: args[1] } : {});
    console.log(JSON.stringify({ version: result.version, artifact: result.artifact,
      checksums: result.checksums, sha256: result.sha256 }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
