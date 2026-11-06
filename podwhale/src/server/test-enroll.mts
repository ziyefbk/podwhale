import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FixtureResponse } from './test-api-types.mjs';
import { isRecord } from './types.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));

let failed = 0;
function check(name: string, condition: unknown, detail: unknown = "") {
  if (condition) {
    console.log('ok  ', name);
  } else {
    failed += 1;
    console.log('FAIL', name, detail === undefined ? '' : `-> ${detail}`);
  }
}

async function startServer(port: number, dataDir: string, extraEnv: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, [join(HERE, 'community.mjs')], {
    env: { ...process.env, XLB_PORT: String(port), XLB_HOST: '127.0.0.1', XLB_DATA: dataDir, ...extraEnv },
    stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${base}/health`);
      if (response.ok) return { child, base };
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`server on ${port} did not start`);
}

function call<const Path extends string>(base: string, path: Path, token?: string | null, body?: unknown): Promise<{ status: number; payload: FixtureResponse<Path>; headers: Headers }>;
async function call(base: string, path: string, token?: string | null, body?: unknown): Promise<{ status: number; payload: unknown; headers: Headers }> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (body) headers['content-type'] = 'application/json';
  const response = await fetch(base + path, {
    method: body ? 'POST' : 'GET',
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const type = response.headers.get('content-type') || '';
  const payload = type.includes('json') ? await response.json() : await response.text();
  if (type.includes('json') && !isRecord(payload)) throw new Error('Enrollment fixture returned a non-object JSON response');
  return { status: response.status, payload, headers: response.headers };
}

const dirA = await mkdtemp(join(tmpdir(), 'xlb-enroll-a-'));
const dirB = await mkdtemp(join(tmpdir(), 'xlb-enroll-b-'));
let serverA: Awaited<ReturnType<typeof startServer>> | null = null;
let serverB: Awaited<ReturnType<typeof startServer>> | null = null;

try {
  serverA = await startServer(8767, dirA, {});
  const baseA = serverA.base;

  const page = await call(baseA, '/', null, null);
  check('registration page is public', page.status === 200 && String(page.payload).includes('领取席位'), page.status);
  check('page sets a CSP', String(page.headers.get('content-security-policy')).includes("default-src 'none'"));

  const first = await call(baseA, '/enroll', null, { name: '第一位主人', handle: '小蓝' });
  check('enroll mints a token', first.status === 201 && String(first.payload.token).startsWith('xlb_'), first.status);
  check('enroll echoes the owner', first.payload.owner && first.payload.owner.name === '第一位主人');

  const withToken = await call(baseA, '/feed', first.payload.token, null);
  check('a fresh token can read the feed', withToken.status === 200, withToken.status);

  const nameless = await call(baseA, '/enroll', null, { handle: '无名' });
  check('enroll requires a name', nameless.status === 400, nameless.status);

  const second = await call(baseA, '/enroll', null, { name: '第二位' });
  const third = await call(baseA, '/enroll', null, { name: '第三位' });
  const fourth = await call(baseA, '/enroll', null, { name: '第四位' });
  check('first three enrollments are allowed', second.status === 201 && third.status === 201, `${second.status}/${third.status}`);
  check('the fourth from one IP is rate limited', fourth.status === 429, fourth.status);

  const gated = await startServer(8768, dirB, { XLB_INVITE: 'open-sesame' });
  serverB = gated;
  const withoutInvite = await call(gated.base, '/enroll', null, { name: '没邀请码' });
  check('invite gate rejects a missing code', withoutInvite.status === 403, withoutInvite.status);
  const wrongInvite = await call(gated.base, '/enroll', null, { name: '乱写', invite: 'nope' });
  check('invite gate rejects a wrong code', wrongInvite.status === 403, wrongInvite.status);
  const rightInvite = await call(gated.base, '/enroll', null, { name: '有邀请码', invite: 'open-sesame' });
  check('invite gate accepts the right code', rightInvite.status === 201, rightInvite.status);
} finally {
  if (serverA) serverA.child.kill();
  if (serverB) serverB.child.kill();
  await new Promise((resolve) => setTimeout(resolve, 200));
  await rm(dirA, { recursive: true, force: true });
  await rm(dirB, { recursive: true, force: true });
}

console.log(failed === 0 ? 'ALL PASS' : `${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
