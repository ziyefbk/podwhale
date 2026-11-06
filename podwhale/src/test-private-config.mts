/** Real-file compatibility tests. Never read the developer's private settings. */
import { mkdtemp, mkdir, writeFile, copyFile, rm, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readLocalConfig } from './private-config.mjs';

const tempParent = resolve(tmpdir());
const temp = await mkdtemp(join(tempParent, 'podwhale-private-config-'));
let failed = 0;
let passed = 0;
function check(name: string, ok: unknown) {
  console.log((ok ? 'ok   ' : 'FAIL ') + name);
  if (ok) passed++; else failed++;
}
async function failure(task: () => unknown) { try { await task(); return null; } catch (caught) { const error = caught as Error & { code?: string; status?: number; phase?: string; stopped?: boolean; detail?: string; }; return error; } }
const raw = { remote: 'https://synthetic.invalid/xiaolanshu', host: 'synthetic.invalid', nested: { keep: true } };
const privateValue = 'synthetic-private-configuration-value';
function safeFailure(caught: unknown) {
  const error = caught as Error & { code?: string };
  return error?.code === 'XLB_LOCAL_CONFIG_INVALID' && error.message === 'Invalid local configuration'
    && !JSON.stringify(error).includes(temp) && !JSON.stringify(error).includes(privateValue)
    && error.cause === undefined;
}
async function fixture(name: string) {
  const root = join(temp, name);
  const packageDir = join(root, 'podwhale');
  const legacyDir = join(root, 'xiaolanshu');
  await mkdir(packageDir, { recursive: true });
  await mkdir(legacyDir, { recursive: true });
  return { packageDir, primary: join(packageDir, 'local.json'), legacy: join(legacyDir, 'local.json') };
}

try {
  const defaults = await fixture('defaults');
  check('missing current and legacy defaults return an empty object', JSON.stringify(await readLocalConfig({ packageDir: defaults.packageDir, env: {} })) === '{}');
  await writeFile(defaults.legacy, JSON.stringify(raw));
  check('legacy sibling local.json remains readable after the source directory rename', JSON.stringify(await readLocalConfig({ packageDir: defaults.packageDir, env: {} })) === JSON.stringify(raw));
  await writeFile(defaults.primary, JSON.stringify({ ...raw, source: 'current' }));
  check('the current package local.json takes precedence over legacy settings', (await readLocalConfig({ packageDir: defaults.packageDir, env: {} })).source === 'current');
  await writeFile(defaults.primary, '{}');
  check('an existing empty current object does not inherit legacy settings', JSON.stringify(await readLocalConfig({ packageDir: defaults.packageDir, env: {} })) === '{}');

  const explicit = join(temp, 'explicit.json');
  await writeFile(explicit, JSON.stringify({ source: 'explicit', nested: raw.nested }));
  for (const name of ['XLB_LOCAL_CONFIG', 'XLB_CONFIG_FILE']) {
    check(name + ' selects its explicit file before defaults', (await readLocalConfig({ packageDir: defaults.packageDir, env: { [name]: explicit } })).source === 'explicit');
  }
  check('both environment names accept the same resolved file', (await readLocalConfig({ packageDir: defaults.packageDir,
    env: { XLB_LOCAL_CONFIG: explicit, XLB_CONFIG_FILE: join(temp, '.', 'explicit.json') } })).source === 'explicit');
  check('empty environment overrides retain default selection', JSON.stringify(await readLocalConfig({ packageDir: defaults.packageDir,
    env: { XLB_LOCAL_CONFIG: '', XLB_CONFIG_FILE: '' } })) === '{}');
  check('conflicting explicit names fail without disclosing either path', safeFailure(await failure(() => readLocalConfig({ packageDir: defaults.packageDir,
    env: { XLB_LOCAL_CONFIG: explicit, XLB_CONFIG_FILE: defaults.legacy } }))));
  check('a missing explicit file does not fall back to current or legacy settings', safeFailure(await failure(() => readLocalConfig({ packageDir: defaults.packageDir,
    env: { XLB_LOCAL_CONFIG: join(temp, privateValue) } }))));

  for (const [name, text] of [['malformed JSON', '{' + privateValue], ['null', 'null'], ['array', '[]'], ['string', JSON.stringify(privateValue)], ['number', '7'], ['boolean', 'false']]) {
    await writeFile(explicit, text!);
    check('explicit ' + name + ' fails with a fixed private error', safeFailure(await failure(() => readLocalConfig({ packageDir: defaults.packageDir, env: { XLB_LOCAL_CONFIG: explicit } }))));
  }
  for (const [name, text] of [['malformed JSON', '{' + privateValue], ['null', 'null'], ['array', '[]']]) {
    await writeFile(defaults.primary, text!);
    check('current ' + name + ' cannot silently fall back to legacy settings', safeFailure(await failure(() => readLocalConfig({ packageDir: defaults.packageDir, env: {} }))));
  }
  await rm(defaults.primary);
  await mkdir(defaults.primary);
  check('an unreadable current file does not fall back to legacy settings', safeFailure(await failure(() => readLocalConfig({ packageDir: defaults.packageDir, env: {} }))));
  await rmdir(defaults.primary);
  await writeFile(defaults.legacy, '{' + privateValue);
  check('malformed legacy settings also fail without disclosing their content', safeFailure(await failure(() => readLocalConfig({ packageDir: defaults.packageDir, env: {} }))));
  check('a non-string explicit path fails with a fixed error', safeFailure(await failure(() => readLocalConfig({ packageDir: defaults.packageDir, env: { XLB_LOCAL_CONFIG: 7 } }))));
  check('an invalid package directory fails with a fixed error', safeFailure(await failure(() => readLocalConfig({ packageDir: null, env: {} }))));

  const relocated = await fixture('runtime');
  await copyFile(new URL('./runtime.mjs', import.meta.url), join(relocated.packageDir, 'runtime.mjs'));
  await copyFile(new URL('./private-config.mjs', import.meta.url), join(relocated.packageDir, 'private-config.mjs'));
  await writeFile(relocated.legacy, JSON.stringify(raw));
  const runtime = await import(pathToFileURL(join(relocated.packageDir, 'runtime.mjs')).href);
  check('the relocated runtime uses the same legacy-compatible reader', JSON.stringify(await runtime.localConfig({})) === JSON.stringify(raw));
  await writeFile(explicit, JSON.stringify({ source: 'runtime-explicit' }));
  check('runtime and deployment can share explicit environment configuration', (await runtime.localConfig({ XLB_CONFIG_FILE: explicit })).source === 'runtime-explicit');
} finally {
  if (dirname(resolve(temp)) !== tempParent || !basename(temp).startsWith('podwhale-private-config-')) throw new Error('Invalid test cleanup target');
  await rm(temp, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
