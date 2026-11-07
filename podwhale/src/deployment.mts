import type { Module } from 'node:vm';
export interface DeploymentConfig { host: string; user: string; remote: string; port: string; remoteDir: string; dataDir: string; remoteNode: string }
export interface RunnerOptions { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs: number; input?: string; phase?: string }
export interface RunnerResult { code: number; stdout?: string; stderr?: string; timedOut?: boolean }
export type Runner = (command: string, args: string[], options: RunnerOptions & { phase: string; input: string }) => Promise<RunnerResult>;
export type DeploymentFailure = Error & { detail?: string; phase?: string; stopped?: boolean };
type Manifest = Record<string, string>;
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFile, writeFile, mkdir, mkdtemp, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename, posix } from 'node:path';
import { isIP } from 'node:net';
import { readLocalConfig } from './private-config.mjs';

const PACKAGE_SOURCES = [
  'server/community.mjs', 'server/auth.mjs',
  'server/db.mjs', 'server/enroll.mjs', 'server/http-guard.mjs', 'server/types.mjs', 'server/social-policy.mjs',
  'server/mobile.mjs', 'server/page.mjs', 'server/media.mjs', 'redact.js',
  'server/static/icon-192.png', 'server/static/icon-512.png',
];
export const SOURCE_FILES = PACKAGE_SOURCES.map((file) => 'podwhale/' + file);
// Existing systemd units execute app/xiaolanshu/server/community.mjs. Keep that
// installation layout distinct from the public repository's package directory.
export const REMOTE_SOURCE_FILES = PACKAGE_SOURCES.map((file) => 'xiaolanshu/' + file);

function invalid(field: string): never {
  throw new Error('Invalid or missing deployment configuration: ' + field);
}

function absoluteRemotePath(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^\/[A-Za-z0-9_./-]+$/.test(value)
    || value.includes('//') || value.endsWith('/')
    || value.split('/').some((part) => part === '.' || part === '..')
    || value.split('/').filter(Boolean).length < 2) invalid(field);
  return value;
}

/** Validation precedes tests, archives, and every network operation. */
export function validateDeploymentConfig(raw: Record<string, unknown>, env: NodeJS.ProcessEnv = {}): DeploymentConfig {
  const host = env.XLB_DEPLOY_HOST || raw.host;
  const user = env.XLB_DEPLOY_USER || raw.user;
  const remote = env.XLB_REMOTE || raw.remote;
  if (typeof host !== 'string' || host.length > 253
    || !(/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(host) || isIP(host) === 6)) invalid('host');
  if (typeof user !== 'string' || !/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(user)) invalid('user');
  if (typeof remote !== 'string' || /[\x00-\x20\x7f]/.test(remote)) invalid('remote');
  let url;
  try { url = new URL(remote); } catch { invalid('remote'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) invalid('remote');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const loopback = hostname === 'localhost' || hostname === '::1'
    || (isIP(hostname) === 4 && hostname.split('.')[0] === '127');
  if (url.protocol === 'http:' && !loopback) invalid('remote requires HTTPS');
  const portValue = env.XLB_DEPLOY_PORT || raw.port || '22';
  if (!/^\d{1,5}$/.test(String(portValue)) || Number(portValue) < 1 || Number(portValue) > 65535) invalid('port');
  const remoteDir = absoluteRemotePath(env.XLB_DEPLOY_DIR || raw.remoteDir || raw.directory || '/home/ubuntu/xiaolanshu', 'remoteDir');
  const dataDir = absoluteRemotePath(env.XLB_DEPLOY_DATA || raw.dataDir || remoteDir + '/data', 'dataDir');
  if (!dataDir.startsWith(remoteDir + '/') || ['app', 'backups'].some((part) => dataDir === remoteDir + '/' + part || dataDir.startsWith(remoteDir + '/' + part + '/'))) invalid('dataDir');
  const remoteNode = absoluteRemotePath(env.XLB_DEPLOY_NODE || raw.remoteNode || raw.node || remoteDir + '/runtime/bin/node', 'remoteNode');
  return { host, user, remote: url.href.replace(/\/+$/, ''), port: String(Number(portValue)), remoteDir, dataDir, remoteNode };
}

export async function loadDeploymentConfig(env: NodeJS.ProcessEnv, repoRoot: string) {
  return validateDeploymentConfig(await readLocalConfig({ packageDir: join(repoRoot, 'podwhale'), env }), env);
}

export function shellQuote(value: unknown) {
  return "'" + String(value).replace(/'/g, "'\"'\"'") + "'";
}

export function redactDeploymentOutput(value: unknown, config: DeploymentConfig) {
  let text = String(value || '');
  const values = [config.remote, config.host, encodeURIComponent(config.host)].filter(Boolean).sort((a, b) => b.length - a.length);
  for (const secret of values) text = text.split(secret).join('[private deployment value]');
  return text.replace(/https?:\/\/[^\s'"<>]+/gi, '[private URL]')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[private address]')
    .replace(/(?:xlb_|sk-|ghp_|gho_|ghs_)[A-Za-z0-9_-]{12,}/g, '[secret]')
    .replace(/\b(?:token|password|secret|api[_-]?key)\s*[=:]\s*[^\s,;]+/gi, '[secret field]');
}

export function sshArguments(config: DeploymentConfig) {
  const host = isIP(config.host) === 6 ? '[' + config.host + ']' : config.host;
  return ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'UpdateHostKeys=no',
    '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'ConnectTimeout=10',
    '-o', 'LogLevel=ERROR', '-p', config.port, config.user + '@' + host, 'bash', '-s', '--'];
}

export function scpArguments(config: DeploymentConfig, archive: string, release: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/.test(release)) invalid('release');
  const host = isIP(config.host) === 6 ? '[' + config.host + ']' : config.host;
  return ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'UpdateHostKeys=no',
    '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'ConnectTimeout=10',
    '-o', 'LogLevel=ERROR', '-P', config.port, archive,
    config.user + '@' + host + ':' + config.remoteDir + '/.deploy-' + release + '/source.tar.gz'];
}

/** Link the ES module graph without evaluating service startup code. */
export async function verifyModuleGraph(entry: string) {
  const { SourceTextModule, SyntheticModule } = await import('node:vm');
  const { readFile } = await import('node:fs/promises');
  const { pathToFileURL, fileURLToPath } = await import('node:url');
  if (!SourceTextModule) throw new Error('module graph verification unavailable');
  const modules = new Map<string, Module>();
  const get = async (url: string): Promise<Module> => {
    if (modules.has(url)) return modules.get(url)!;
    if (url.startsWith('node:')) {
      const namespace = await import(url);
      const module = new SyntheticModule(Object.keys(namespace), function () {
        for (const name of Object.keys(namespace)) this.setExport(name, namespace[name]);
      }, { identifier: url });
      modules.set(url, module);
      return module;
    }
    if (!url.startsWith('file:')) throw new Error('external module is not allowed');
    const source = await readFile(fileURLToPath(url), 'utf8');
    const module = new SourceTextModule(source, { identifier: url });
    modules.set(url, module);
    return module;
  };
  const root = await get(pathToFileURL(entry).href);
  await root.link((specifier, referencing) => {
    if (!specifier.startsWith('node:') && !specifier.startsWith('.')) throw new Error('external module is not allowed');
    return get(specifier.startsWith('node:') ? specifier : new URL(specifier, referencing.identifier).href);
  });
}

function prelude(config: DeploymentConfig, release: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/.test(release)) invalid('release');
  return `set -euo pipefail
umask 077
REMOTE_DIR=${shellQuote(config.remoteDir)}
NODE=${shellQuote(config.remoteNode)}
DATA_DIR=${shellQuote(config.dataDir)}
RELEASE=${shellQuote(release)}
SERVICE=xiaolanshu
SYSTEMCTL=/usr/bin/systemctl
BASE=$(realpath -e -- "$REMOTE_DIR")
case "$BASE" in /|/home|/home/ubuntu|/etc|/usr|/var|/tmp|/srv) exit 30;; esac
inside() {
  local target
  target=$(realpath -m -- "$1")
  case "$target" in "$BASE"/*) ;; *) exit 31;; esac
}
APP="$BASE/app"
DATA=$(realpath -e -- "$DATA_DIR")
BACKUPS="$BASE/backups"
STAGE="$BASE/.deploy-$RELEASE"
STAGE_APP="$STAGE/app"
BACKUP="$BACKUPS/deploy-$RELEASE"
inside "$APP"
inside "$DATA"
inside "$BACKUPS"
inside "$STAGE"
inside "$BACKUP"
test ! -L "$APP"
test ! -L "$BACKUPS"
`;
}

export function preflightScript(config: DeploymentConfig, release: string) {
  return prelude(config, release) + `test -d "$APP"
test -d "$DATA"
test -d "$BACKUPS"
test -w "$BASE"
test -w "$BACKUPS"
test -r "$DATA/feed.db"
test -x "$NODE"
"$NODE" --input-type=module -e 'if(Number(process.versions.node.split(".")[0]) < 24) process.exit(1); await import("node:sqlite"); console.log("NODE_VERSION " + process.versions.node)'
"$SYSTEMCTL" is-active --quiet "$SERVICE"
sudo -n -l "$SYSTEMCTL" stop "$SERVICE" >/dev/null
sudo -n -l "$SYSTEMCTL" restart "$SERVICE" >/dev/null
data_kb=$(du -sk -- "$DATA" | awk '{print $1}')
app_kb=$(du -sk -- "$APP" | awk '{print $1}')
available_kb=$(df -Pk -- "$BASE" | awk 'NR==2 {print $4}')
required_kb=$((data_kb * 2 + app_kb * 3 + 102400))
test "$available_kb" -gt "$required_kb"
printf 'PODWHALE_PREFLIGHT_OK\\n'
`;
}

function stageScript(config: DeploymentConfig, release: string) {
  return prelude(config, release) + `test ! -e "$STAGE"
mkdir -m 700 -- "$STAGE"
cp -a -- "$APP" "$STAGE_APP"
printf 'PODWHALE_STAGE_CREATED\\n'
`;
}

function manifestText(manifest: Manifest) {
  if (REMOTE_SOURCE_FILES.some((file) => !/^[a-f0-9]{64}$/.test(manifest[file] || ''))) invalid('source manifest');
  return REMOTE_SOURCE_FILES.map((file) => manifest[file] + '  ' + file).join('\n');
}

function verifyHashes(directory: string, manifest: Manifest) {
  return `(cd "${directory}" && sha256sum --check --status <<'PODWHALE_HASHES'
${manifestText(manifest)}
PODWHALE_HASHES
)
`;
}

export function validateStageScript(config: DeploymentConfig, release: string, manifest: Manifest) {
  const graph = '(' + verifyModuleGraph.toString() + ')(process.argv[1]).catch(() => { console.error("MODULE_GRAPH_INVALID"); process.exit(1); });';
  return prelude(config, release) + `test -f "$STAGE/source.tar.gz"
test ! -L "$STAGE_APP"
test -d "$STAGE_APP/xiaolanshu"
if test -n "$(find "$STAGE_APP/xiaolanshu" -type l -print -quit)"; then exit 34; fi
tar -tzf "$STAGE/source.tar.gz" | LC_ALL=C sort > "$STAGE/archive-list"
LC_ALL=C sort <<'PODWHALE_FILES' | diff - "$STAGE/archive-list" >/dev/null
${REMOTE_SOURCE_FILES.join('\n')}
PODWHALE_FILES
tar -xzf "$STAGE/source.tar.gz" -C "$STAGE_APP" --no-same-owner
` + verifyHashes('$STAGE_APP', manifest) + REMOTE_SOURCE_FILES.filter((file) => /\.(mjs|js)$/.test(file)).map((file) => `"$NODE" --input-type=module --check < "$STAGE_APP/${file}"`).join('\n') + `
"$NODE" --experimental-vm-modules --input-type=module -e ${shellQuote(graph)} "$STAGE_APP/xiaolanshu/server/community.mjs"
printf 'PODWHALE_STAGE_VALIDATED\\n'
`;
}

export function publishScript(config: DeploymentConfig, release: string, manifest: Manifest) {
  const smoke = `const base=process.argv[1];
const deadline=Date.now()+25000;
let ready=false;
while(Date.now()<deadline){try{
const health=await fetch(base+"/health",{redirect:"manual",signal:AbortSignal.timeout(4000),headers:{"cache-control":"no-cache"}});
const body=await health.json();
if(health.status!==200||body.ok!==true)throw new Error();
if(body.lastPatrol&&Object.keys(body.lastPatrol).some(key=>key!=="at"))throw new Error();
const oauth=await fetch(base+"/wx",{redirect:"manual",signal:AbortSignal.timeout(4000)});
if(oauth.status!==410)throw new Error();
const webhook=await fetch(base+"/wechat?signature=invalid&timestamp=1&nonce=invalid",{method:"POST",body:"<xml/>",redirect:"manual",signal:AbortSignal.timeout(4000)});
if(![403,503].includes(webhook.status))throw new Error();
ready=true;break;
}catch{await new Promise(resolve=>setTimeout(resolve,500));}}
if(!ready){console.error("SECURITY_HEALTH_CHECK_FAILED");process.exit(1);}
console.log("PODWHALE_SECURITY_HEALTH_OK");`;
  return prelude(config, release) + `test -d "$STAGE_APP"
` + verifyHashes('$STAGE_APP', manifest) + `stopped=0
complete=0
on_exit() {
  code=$?
  if test "$complete" != 1 && test "$stopped" = 1; then
    sudo -n "$SYSTEMCTL" stop "$SERVICE" >/dev/null 2>&1 || true
    printf 'PODWHALE_FAILED_CLOSED_BACKUPS_RETAINED\\n' >&2
  fi
  trap - EXIT
  exit "$code"
}
trap on_exit EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
sudo -n "$SYSTEMCTL" stop "$SERVICE"
stopped=1
if "$SYSTEMCTL" is-active --quiet "$SERVICE"; then exit 32; fi
test ! -e "$BACKUP"
mkdir -m 700 -- "$BACKUP"
tar -czf "$BACKUP/data.tar.gz" -C "$DATA" .
tar -czf "$BACKUP/code.tar.gz" -C "$APP" .
(cd "$BACKUP" && sha256sum data.tar.gz code.tar.gz > archive-sha256.txt)
printf 'PODWHALE_BACKUPS_COMPLETE\\n'
inside "$APP"
inside "$STAGE_APP"
inside "$BACKUP/app-before"
mv -- "$APP" "$BACKUP/app-before"
mv -- "$STAGE_APP" "$APP"
sudo -n "$SYSTEMCTL" restart "$SERVICE"
"$SYSTEMCTL" is-active --quiet "$SERVICE"
` + verifyHashes('$APP', manifest) + `"$NODE" --input-type=module -e ${shellQuote(smoke)} ${shellQuote(config.remote)}
complete=1
printf 'PODWHALE_DEPLOYMENT_OK\\n'
`;
}

function stopScript(config: DeploymentConfig, release: string) {
  return prelude(config, release) + `sudo -n "$SYSTEMCTL" stop "$SERVICE"
if "$SYSTEMCTL" is-active --quiet "$SERVICE"; then exit 33; fi
printf 'PODWHALE_STOP_CONFIRMED\\n'
`;
}

/** Every child is bounded, takes argv without a shell, and captures private logs. */
export function processRunner(command: string, args: string[], options: RunnerOptions): Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolvePromise) => {
    let output = '', errorOutput = '', timedOut = false, settled = false;
    const child = spawn(command, args, { cwd: options.cwd, env: options.env || process.env,
      stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true });
    const finish = (result: { code: number; stdout: string; stderr: string; timedOut: boolean }) => { if (!settled) { settled = true; clearTimeout(timer); resolvePromise(result); } };
    const timer = setTimeout(() => { timedOut = true; child.kill(); finish({ code: -1, timedOut, stdout: output, stderr: errorOutput }); }, options.timeoutMs);
    child.stdout.on('data', (chunk) => { if (output.length < 1024 * 1024) output += chunk; });
    child.stderr.on('data', (chunk) => { if (errorOutput.length < 1024 * 1024) errorOutput += chunk; });
    child.on('error', () => finish({ code: -1, stdout: output, stderr: 'process could not be started', timedOut }));
    child.on('close', (code) => finish({ code: code === null ? -1 : code, stdout: output, stderr: errorOutput, timedOut }));
    child.stdin.on('error', () => {});
    child.stdin.end(options.input || '');
  });
}

async function removeLocalTemp(directory: string) {
  const parent = await realpath(tmpdir());
  const target = await realpath(directory);
  if (dirname(target).toLowerCase() !== parent.toLowerCase() || !basename(target).startsWith('podwhale-deploy-')) {
    throw new Error('refusing cleanup outside the deployment temp directory');
  }
  await rm(target, { recursive: true, force: true });
}

export async function runDeployment({ repoRoot, env = process.env, config: suppliedConfig, node = process.execPath,
  preflightOnly = false, runner = processRunner, log = () => {} }: { repoRoot: string; env?: NodeJS.ProcessEnv; config?: Record<string, unknown>; node?: string; preflightOnly?: boolean; runner?: Runner; log?: (message: string) => void }) {
  const config = suppliedConfig ? validateDeploymentConfig(suppliedConfig, env) : await loadDeploymentConfig(env, repoRoot);
  const release = new Date().toISOString().replace(/\D/g, '').slice(0, 14) + '-' + randomBytes(4).toString('hex');
  const invoke = async (phase: string, command: string, args: string[], input: string, timeoutMs: number) => {
    const result = await runner(command, args, { cwd: repoRoot, env, input, timeoutMs, phase });
    if (result.code !== 0 || result.timedOut) {
      const error: DeploymentFailure = new Error('Deployment step failed: ' + phase + (result.timedOut ? ' (timeout)' : ''));
      error.detail = redactDeploymentOutput(result.stderr || result.stdout, config).slice(0, 2000);
      error.phase = phase;
      throw error;
    }
    return result;
  };
  const ssh = (phase: string, script: string, timeout = 30000) => invoke(phase, 'ssh', sshArguments(config), script, timeout);
  log('Read-only deployment preflight');
  await ssh('preflight', preflightScript(config, release));
  if (preflightOnly) return { preflight: true };
  log('Local verification');
  await invoke('local-tests', node, [join(repoRoot, 'podwhale', 'check.mjs'), '--local'], '', 180000);
  const temp = await mkdtemp(join(tmpdir(), 'podwhale-deploy-'));
  try {
    const archive = join(temp, 'source.tar.gz');
    const sourceSnapshot = join(temp, 'source');
    const manifest: Manifest = {};
    for (let i = 0; i < SOURCE_FILES.length; i++) {
      const bytes = await readFile(join(repoRoot, SOURCE_FILES[i]!));
      const remoteFile = REMOTE_SOURCE_FILES[i]!;
      const target = join(sourceSnapshot, remoteFile);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, bytes);
      manifest[remoteFile] = createHash('sha256').update(bytes).digest('hex');
    }
    log('Packaging service source');
    // A source snapshot works with both BSD tar (Windows/macOS) and GNU tar;
    // no platform-specific path rewrite flags or production directory moves.
    await invoke('pack', 'tar', ['-czf', archive, '-C', sourceSnapshot, ...REMOTE_SOURCE_FILES], '', 60000);
    await ssh('create-stage', stageScript(config, release));
    await invoke('upload', 'scp', scpArguments(config, archive, release), '', 60000);
    log('Validating staged source');
    await ssh('validate-stage', validateStageScript(config, release, manifest), 60000);
    log('Consistent backup, publication, and security verification');
    try { await ssh('publish', publishScript(config, release, manifest), 180000); }
    catch (caught) {
      const error = caught as DeploymentFailure;
      try { await ssh('fail-closed-stop', stopScript(config, release)); error.stopped = true; }
      catch { error.stopped = false; }
      error.message += error.stopped
        ? '; service stopped, backups retained, old code was not restored'
        : '; service stop could not be confirmed; backups retained, operator attention required';
      throw error;
    }
    return { preflight: false, release, backupDir: posix.join(config.remoteDir, 'backups', 'deploy-' + release), manifest };
  } finally {
    await removeLocalTemp(temp);
  }
}
