/**
 * A backup is only a backup if you can run on it.
 *
 * This drills the documented procedure end to end: create real data, take the
 * same tar snapshot the timer takes, wipe the data directory, restore from the
 * archive, start a fresh process against it, and prove the old token still
 * works and the content is still there.
 *
 *   node test-restore.mjs
 */
import { spawn, execFile } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { humanSession } from './server/test-human-session.mjs';

const run = promisify(execFile);
const HERE = fileURLToPath(new URL('.', import.meta.url));
const PORT = 8768;
const BASE = `http://127.0.0.1:${PORT}`;

const failures = [];
function step(name, ok, detail) {
  if (!ok) failures.push(name + (detail ? ' — ' + detail : ''));
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  — ' + detail : ''}`);
}

async function call(path, token, body) {
  const headers = { accept: 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (body) headers['content-type'] = 'application/json';
  const response = await fetch(BASE + path, {
    method: body ? 'POST' : 'GET',
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await response.json();
  } catch {
    /* not json */
  }
  return { status: response.status, json };
}

let child = null;
async function startServer(dataDir) {
  child = spawn(process.execPath, [join(HERE, 'server/community.mjs')], {
    cwd: HERE,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, XLB_PORT: String(PORT), XLB_HOST: '127.0.0.1', XLB_DATA: dataDir },
  });
  child.stderr.on('data', (chunk) => process.stderr.write(chunk));
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(BASE + '/health');
      if (response.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

async function stopServer() {
  if (!child) return;
  const dying = child;
  child = null;
  dying.kill();
  await new Promise((resolve) => setTimeout(resolve, 300));
}

const dataDir = await mkdtemp(join(tmpdir(), 'xlb-restore-data-'));
const backupDir = await mkdtemp(join(tmpdir(), 'xlb-restore-backup-'));

try {
  // 1. Live data on a running instance.
  step('the service starts on a fresh data dir', await startServer(dataDir));
  const enrolled = await call('/enroll', null, { name: '还原演练的主人', handle: '盐' });
  step('an owner enrolls', enrolled.status === 201, enrolled.status);
  const token = await humanSession(dataDir, enrolled.json.owner.id, BASE);
  const posted = await call('/post', token, { title: '还原之后必须还在这条', text: '如果这条没了，备份就是假的' });
  step('the owner posts a note', posted.status === 201, posted.status);
  const asked = await call('/ask', token, { text: '这条提问也要活下来' });
  step('the owner asks a question', asked.status === 201, asked.status);
  const before = await call('/feed', token, null);
  const beforeCount = (before.json.posts || []).length;
  step('the live feed has content', beforeCount >= 1, String(beforeCount));

  // 2. Take exactly the snapshot the timer takes.
  await stopServer();
  const archive = join(backupDir, 'xlb-drill.tar.gz');
  // 和线上备份脚本一致：不要把 -shm 打进去，陈旧的内存映射会让恢复端忽略 WAL。
  await run('tar', ['-czf', archive, '--exclude=*.db-shm', '-C', dataDir, '.']);
  step('a snapshot can be taken while the service is stopped', true, archive);

  // 3. Disaster: the data directory is gone.
  for (const name of await readdir(dataDir)) {
    await rm(join(dataDir, name), { recursive: true, force: true });
  }
  const empty = await readdir(dataDir);
  step('the data directory is now empty', empty.length === 0, empty.join(','));

  // 4. Restore, exactly as the runbook says.
  await run('tar', ['-xzf', archive, '-C', dataDir]);
  const restored = await readdir(dataDir);
  step('the archive restores the store', restored.includes('feed.db'), restored.join(','));

  // 5. The only proof that matters: a fresh process serves the old data.
  step('the service starts again on the restored data', await startServer(dataDir));
  const after = await call('/feed', token, null);
  step('the old token still authenticates', after.status === 200, after.status);
  step('the note survived', (after.json.posts || []).some((post) => post.id === posted.json.post.id), String((after.json.posts || []).length));
  step('the question survived', (after.json.asks || []).some((ask) => ask.id === asked.json.ask.id), String((after.json.asks || []).length));
  step('the content count matches', (after.json.posts || []).length === beforeCount, `${beforeCount} → ${(after.json.posts || []).length}`);

  const whoami = await call('/whoami', token);
  step('the owner record survived', whoami.status === 200 && whoami.json.owner.name === '还原演练的主人', whoami.status);
} catch (error) {
  step('the drill finishes without throwing', false, String(error && error.message));
} finally {
  await stopServer();
  await rm(dataDir, { recursive: true, force: true });
  await rm(backupDir, { recursive: true, force: true });
}

console.log('');
if (failures.length === 0) {
  console.log('ALL PASS');
  process.exit(0);
}
console.log(failures.length + ' FAILED');
process.exit(1);
