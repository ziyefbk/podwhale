/**
 * Deploy the community service, then prove it still works.
 *
 *   node deploy.mjs              pre-flight tests → upload → restart → live check
 *   node deploy.mjs --skip-local upload → restart → live check
 *
 * Aborts before touching the server if the local suites fail, and exits
 * non-zero if the live check does not come back green.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nodeBin, localConfig } from './runtime.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const APPNODE = await nodeBin();
const LOCAL = await localConfig();
const ROOT = resolve(HERE, '..');
const HOST = process.env.XLB_DEPLOY_HOST || LOCAL.host || '';
const USER = process.env.XLB_DEPLOY_USER || LOCAL.user || 'ubuntu';
const PORT = process.env.XLB_DEPLOY_PORT || '22';
const REMOTE_DIR = process.env.XLB_DEPLOY_DIR || '/home/ubuntu/xiaolanshu';
const skipLocal = process.argv.includes('--skip-local');

function step(label) {
  console.log(`\n▸ ${label}`);
}

function run(command, args, options = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd || ROOT,
      stdio: options.quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      shell: false,
      env: process.env,
    });
    let output = '';
    if (options.quiet) {
      child.stdout.on('data', (chunk) => { output += chunk; });
      child.stderr.on('data', (chunk) => { output += chunk; });
    }
    child.on('error', (error) => resolvePromise({ code: -1, output: String(error && error.message) }));
    child.on('exit', (code) => resolvePromise({ code: code === null ? -1 : code, output: output }));
  });
}

function fail(message) {
  console.error(`\n✘ ${message}`);
  process.exit(1);
}

if (!skipLocal) {
  step('本地测试（失败就不碰服务器）');
  const local = await run(APPNODE, [join(HERE, 'check.mjs'), '--local'], { quiet: true });
  console.log(local.output.trim());
  if (local.code !== 0) fail('本地测试没过，部署中止');
}

const temp = await mkdtemp(join(tmpdir(), 'xlb-deploy-'));
const archive = join(temp, 'xlb-app.tar.gz');

step('打包');
const packed = await run('tar', ['-czf', archive, 'xiaolanshu/server/community.mjs', 'xiaolanshu/server/db.mjs', 'xiaolanshu/server/enroll.mjs', 'xiaolanshu/server/mobile.mjs', 'xiaolanshu/server/page.mjs', 'xiaolanshu/server/media.mjs', 'xiaolanshu/server/static', 'xiaolanshu/redact.js']);
if (packed.code !== 0) fail('打包失败');

step(`上传到 ${HOST}`);
const uploaded = await run('scp', ['-P', PORT, archive, `${USER}@${HOST}:${REMOTE_DIR}/xlb-app.tar.gz`]);
if (uploaded.code !== 0) fail('上传失败');

step('解包并重启服务');
const remoteScript = [
  'set -euo pipefail',
  `tar -xzf ${REMOTE_DIR}/xlb-app.tar.gz -C ${REMOTE_DIR}/app`,
  'sudo systemctl restart xiaolanshu',
  'sleep 2',
  'systemctl is-active xiaolanshu',
].join(' && ');
const restarted = await run('ssh', ['-o', 'BatchMode=yes', '-p', PORT, `${USER}@${HOST}`, remoteScript]);
if (restarted.code !== 0) fail('重启失败，服务可能没起来');

await rm(temp, { recursive: true, force: true });

step('线上自检');
const live = await run(process.execPath, [join(HERE, 'check.mjs'), '--live-only'], { quiet: true });
console.log(live.output.trim());
if (live.code !== 0) fail('部署完成但线上自检未通过，去看上面的红项');

console.log('\n✔ 部署完成，线上全绿');
