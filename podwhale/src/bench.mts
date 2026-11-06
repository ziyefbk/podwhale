/**
 * How does the service behave when the community is not tiny?
 *
 * Seeds a large number of notes straight into the store, then times the
 * endpoints the panel and the phone call on every load.
 *
 *   node bench.mjs           5000 notes
 *   node bench.mjs 20000     20000 notes
 */
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function benchmarkState(value: unknown): value is Record<string, unknown> & { posts: unknown[] } { return record(value) && Array.isArray(value.posts); }

const HERE = fileURLToPath(new URL('.', import.meta.url));
const PORT = 8769;
const BASE = `http://127.0.0.1:${PORT}`;
const COUNT = Number(process.argv[2] || 5000);

const dataDir = await mkdtemp(join(tmpdir(), 'xlb-bench-'));
let child: import('node:child_process').ChildProcessByStdio<null, import('node:stream').Readable, import('node:stream').Readable> | null = null;

async function start() {
  child = spawn(process.execPath, [join(HERE, 'server/community.mjs')], {
    cwd: HERE,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, XLB_PORT: String(PORT), XLB_HOST: '127.0.0.1', XLB_DATA: dataDir, XLB_WRITE_LIMIT: '500' },
  });
  child.stderr.on('data', () => {});
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(BASE + '/health');
      if (response.ok) return;
    } catch {
      /* waiting */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('server did not start');
}

async function stop() {
  if (!child) return;
  child.kill();
  child = null;
  await new Promise((resolve) => setTimeout(resolve, 250));
}

async function time(path: string, token: string | null, runs = 5) {
  const headers: Record<string, string> = token ? { authorization: `Bearer ${token}`, accept: 'application/json' } : { accept: 'application/json' };
  const samples = [];
  for (let index = 0; index < runs; index += 1) {
    const started = process.hrtime.bigint();
    const response = await fetch(BASE + path, { headers });
    await response.arrayBuffer();
    samples.push(Number(process.hrtime.bigint() - started) / 1e6);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)]!;
}

try {
  await start();
  const enrolled: unknown = await (await fetch(BASE + '/enroll', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: '压测主人', handle: '压' }),
  })).json();
  if (!record(enrolled) || typeof enrolled.token !== 'string') throw new Error('invalid enrollment response');
  const token = enrolled.token;

  await stop();

  const feedFile = join(dataDir, 'feed.json');
  const state: unknown = JSON.parse(await readFile(feedFile, 'utf8'));
  if (!benchmarkState(state)) throw new Error('invalid benchmark feed fixture');
  const kinds = ['技术', '科研', '生活', '吐槽', '求帮忙'];
  const base = Date.now();
  for (let index = 0; index < COUNT; index += 1) {
    state.posts.push({
      id: 'bench' + index.toString(36),
      ownerId: 'bench-owner-' + (index % 200),
      ai: '阿' + (index % 200),
      kind: kinds[index % kinds.length],
      title: '压力测试笔记 ' + index + ' 关于 vLLM 与投机解码',
      text: '这是一条用于压测的正文，长度接近真实帖子，包含一些技术词汇和标点。'.repeat(2),
      tags: ['技术', '压力测试'],
      likes: index % 7,
      saves: index % 3,
      createdAt: new Date(base - index * 60000).toISOString(),
      appearance: { shape: 'cat', palette: 'blue', accessory: 'none' },
      source: 'agent',
    });
  }
  await writeFile(feedFile, JSON.stringify(state), 'utf8');

  console.log(`seeded ${COUNT} extra notes; store is ${Math.round((await readFile(feedFile)).byteLength / 1024)} KB`);

  await start();
  const rows: [string, number][] = [
    ['GET /feed?limit=20', await time('/feed?limit=20', token)],
    ['GET /feed (全部)', await time('/feed', token)],
    ['GET /feed?q=投机解码', await time('/feed?q=' + encodeURIComponent('投机解码'), token)],
    ['GET /digest', await time('/digest', token)],
    ['GET /health', await time('/health', null)],
    ['GET /m', await time('/m', null)],
    ['GET /notifications', await time('/notifications', token)],
  ];
  for (const [label, ms] of rows) console.log(`  ${ms.toFixed(1).padStart(7)} ms   ${label}`);
} catch (error) {
  console.error('bench failed:', error instanceof Error && error.message);
} finally {
  await stop();
  await rm(dataDir, { recursive: true, force: true });
}
