/** Real HTTP regressions for credentials revoked while a request is in flight. */
import { spawn, execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer, request } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { ownerRegistry, isRecord, errorMessage } from './types.mjs';
import { credentialOf } from './auth.mjs';
import type { ClientRequest, ServerResponse } from 'node:http';
import type { ChildProcess } from 'node:child_process';
type JsonObject = Record<string, unknown>;
interface Payload extends JsonObject { token?: string; code?: string; credential?: JsonObject; proposal?: JsonObject; items: JsonObject[]; posts: JsonObject[] }
interface Reply { status: number; json: Payload }
function payload(value: unknown): Payload {
  const source = isRecord(value) ? value : {};
  const result: Payload = { ...source, items: [], posts: [] };
  for (const key of ['items', 'posts'] as const) {
    const rows = source[key];
    if (rows !== undefined) {
      if (!Array.isArray(rows) || !rows.every(isRecord)) throw new Error('Unexpected response collection');
      result[key] = rows;
    }
  }
  for (const key of ['token', 'code'] as const) {
    const field = source[key];
    if (field !== undefined) { if (typeof field !== 'string') throw new Error('Unexpected response token or code'); result[key] = field; }
  }
  for (const key of ['credential', 'proposal'] as const) {
    const field = source[key];
    if (field !== undefined) { if (!isRecord(field)) throw new Error('Unexpected response object'); result[key] = field; }
  }
  return result;
}

const HERE = fileURLToPath(new URL('.', import.meta.url));
const BASE = 'http://127.0.0.1:8783';
const MOCK = 'http://127.0.0.1:8784';
const temporaryRoot = resolve(tmpdir());
const dataDir = await mkdtemp(join(temporaryRoot, 'xlb-revocation-'));
const dbFile = join(dataDir, 'feed.db');
const run = promisify(execFile);
const agentToken = 'xlb_' + 'a'.repeat(48);
const ownerId = 'orevocation';
const childEnv = {
  ...process.env, XLB_HOST: '127.0.0.1', XLB_PORT: '8783', XLB_DATA: dataDir, XLB_DB: dbFile,
  XLB_WRITE_LIMIT: '200', XLB_ADMIN_OWNER: ownerId, XLB_PATROL_MAX_HOURS: '0',
  XLB_WECHAT_APPID: 'revocation-fixture-app', XLB_WECHAT_SECRET: 'revocation-fixture-secret',
  XLB_WECHAT_OAUTH_BASE: MOCK, XLB_WECHAT_TOKEN: '', XLB_PUBLIC_URL: 'https://example.test/xiaolanshu',
};
const pause = (ms: number) => new Promise((resolvePause) => setTimeout(resolvePause, ms));
const pendingRequests = new Set<ClientRequest>();
let child: ChildProcess | null = null;
let failed = 0;
let heldOauthResponse: ServerResponse | null = null;
let markOauthHeld: () => void = () => { throw new Error('OAuth barrier is not initialized'); };
const oauthHeld = new Promise<void>((resolveHeld) => { markOauthHeld = resolveHeld; });
function currentChild(): ChildProcess | null { return child; }
function currentOauthResponse(): ServerResponse | null { return heldOauthResponse; }

function check(name: string, ok: unknown, detail: unknown = "") {
  console.log((ok ? 'ok  ' : 'FAIL') + ' ' + name + (detail ? ' -> ' + detail : ''));
  if (!ok) failed += 1;
}

function sendOpenid(res: import('node:http').ServerResponse) {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ openid: 'revocation-fixture-openid', session_key: 'fixture-session' }));
}

const oauthMock = createServer((req, res) => {
  const url = new URL(req.url || '', MOCK);
  if (url.pathname !== '/sns/jscode2session') { res.writeHead(404); res.end(); return; }
  if (url.searchParams.get('js_code') === 'held-login') {
    heldOauthResponse = res;
    markOauthHeld();
    return;
  }
  sendOpenid(res);
});

async function call(path: string, token?: string | null, body?: unknown): Promise<Reply> {
  const response = await fetch(BASE + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'manual',
    signal: AbortSignal.timeout(7000),
  });
  const json: unknown = await response.json().catch(() => ({}));
  return { status: response.status, json: payload(json) };
}

async function recoverHuman() {
  const result = await run(process.execPath, [join(HERE, 'enroll.mjs'), '--human', ownerId], {
    env: childEnv, windowsHide: true,
  });
  const token = /token:\s*(xlb_[0-9a-f]{48})/.exec(result.stdout)?.[1];
  if (!token) throw new Error('Trusted recovery did not issue a human credential');
  const identity = await call('/whoami', token);
  if (identity.status !== 200 || identity.json.credential?.role !== 'human') {
    throw new Error('Recovered human credential is not immediately active');
  }
  return token;
}

// Older SQLite bindings retain statement handles until GC. A real operator
// process releases every native handle on exit before the test removes data.
const ownerReader = `import { openStore, loadOwners } from ${JSON.stringify(new URL('./db.mjs', import.meta.url).href)};
const db = openStore(process.argv[1]);
try { process.stdout.write(JSON.stringify(loadOwners(db))); } finally { db.close(); }`;
function savedOwners() {
  const stdout = execFileSync(process.execPath, ['--input-type=module', '--eval', ownerReader, dbFile], {
    env: childEnv, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  const parsed: unknown = JSON.parse(stdout);
  return ownerRegistry(parsed);
}

function agentHashes() {
  return Object.entries(savedOwners()).filter(([, owner]) => owner.id === ownerId
    && credentialOf(owner).role === 'agent').map(([hash]) => hash).sort().join(',');
}

/**
 * The server receives valid authorization headers and an incomplete JSON body.
 * A separate completed health request is a barrier before the operator revokes
 * the credential. The original request is then allowed to finish its body.
 */
async function slowPost(path: string, token: string, body: unknown) {
  const raw = JSON.stringify(body);
  if (raw === undefined) throw new Error('Invalid slow-request fixture');
  const prefix = raw.slice(0, 1);
  let req: ClientRequest | undefined;
  let responseStarted = false;
  let ready: () => void = () => { throw new Error('Continue barrier is not initialized'); };
  const started = new Promise<void>((resolveStarted) => { ready = resolveStarted; });
  const response = new Promise<Reply>((resolveResponse, rejectResponse) => {
    const outgoing = request(BASE + path, {
      method: 'POST', headers: {
        authorization: 'Bearer ' + token, 'content-type': 'application/json',
        'content-length': Buffer.byteLength(raw), expect: '100-continue',
      },
    }, (res) => {
      responseStarted = true;
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('error', rejectResponse);
      res.on('end', () => {
        pendingRequests.delete(outgoing);
        let json: unknown = {};
        try { json = JSON.parse(text); } catch { /* unexpected responses fail the status assertions */ }
        resolveResponse({ status: res.statusCode ?? 0, json: payload(json) });
      });
    });
    req = outgoing;
    pendingRequests.add(outgoing);
    outgoing.on('error', (error) => { pendingRequests.delete(outgoing); rejectResponse(error); });
    outgoing.setTimeout(10000, () => outgoing.destroy(new Error('slow request timed out')));
    outgoing.once('continue', () => { outgoing.write(prefix); ready(); });
    outgoing.flushHeaders();
  });
  // Keep rejected requests handled even if setup fails before finish().
  response.catch(() => {});
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([started, response.then(() => { throw new Error(path + ' responded before its body was sent'); }),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('No continue response')), 5000); })]);
  } finally { clearTimeout(timeout); }
  await call('/health');
  if (responseStarted) throw new Error(path + ' executed before receiving its complete body');
  return {
    finish() { if (!req) throw new Error('Slow request was not initialized'); req.end(raw.slice(prefix.length)); return response; },
  };
}

async function start() {
  await writeFile(join(dataDir, 'owners.json'), JSON.stringify({
    [createHash('sha256').update(agentToken).digest('hex')]: {
      id: ownerId, name: '撤销竞争测试', handle: '测试 AI', ownerLabel: '你', revoked: false,
      createdAt: new Date().toISOString(), credential: { role: 'agent', expiresAt: new Date(Date.now() + 86400000).toISOString() },
    },
  }), 'utf8');
  await new Promise<void>((resolveListen, rejectListen) => {
    oauthMock.once('error', rejectListen);
    oauthMock.listen(8784, '127.0.0.1', () => resolveListen());
  });
  child = spawn(process.execPath, [join(HERE, 'community.mjs')], { env: childEnv, stdio: 'ignore', windowsHide: true });
  let spawnError: Error | undefined;
  child.on('error', (error) => { spawnError = error; });
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null) throw new Error('Revocation test server exited during startup');
    try { if ((await call('/health')).status === 200) return; } catch { /* starting */ }
    await pause(100);
  }
  throw new Error('Revocation test server did not start');
}

try {
  await start();
  let human = await recoverHuman();
  const proposed = await call('/proposals', agentToken, {
    action: 'post', payload: { title: 'revoked-slow-approval', text: '撤销后不得发布这条草稿' },
  });
  const proposal = proposed.json.proposal;
  if (![201, 202].includes(proposed.status) || !proposal?.id) throw new Error('Cannot create the slow approval fixture');

  const oldApprover = human;
  const delayedApproval = await slowPost('/proposals/approve', oldApprover, { id: proposal.id, digest: proposal.digest });
  human = await recoverHuman();
  const deniedApproval = await delayedApproval.finish();
  check('human revoked during approval body cannot execute it', [401, 403].includes(deniedApproval.status), deniedApproval.status);
  check('revoked approval leaves proposal pending', (await call('/proposals', human)).json.items.some((item: Record<string, unknown>) => item.id === proposal.id && item.status === 'pending'));
  check('revoked approval leaves public feed unchanged', !(await call('/feed', human)).json.posts.some((post: Record<string, unknown>) => post.title === 'revoked-slow-approval'));
  check('old approver remains revoked after its request finishes', (await call('/whoami', oldApprover)).status === 401);
  check('new human can still approve the same reviewed proposal', (await call('/proposals/approve', human, { id: proposal.id, digest: proposal.digest })).status === 200);
  check('legitimate approval publishes only once', (await call('/feed', human)).json.posts.filter((post: Record<string, unknown>) => post.title === 'revoked-slow-approval').length === 1);

  const beforeAgents = agentHashes();
  const oldIssuer = human;
  const delayedIssuance = await slowPost('/credentials/agent', oldIssuer, { expiresInSeconds: 3600 });
  human = await recoverHuman();
  const deniedIssuance = await delayedIssuance.finish();
  check('human revoked during issuance body cannot mint an agent', [401, 403].includes(deniedIssuance.status), deniedIssuance.status);
  check('revoked issuer response contains no usable token', !deniedIssuance.json.token);
  check('revoked issuance writes no extra agent credential', agentHashes() === beforeAgents);
  check('recovered human survives the rejected issuance', (await call('/whoami', human)).status === 200);

  const oldRotator = human;
  const delayedRotation = await slowPost('/rotate', oldRotator, {});
  human = await recoverHuman();
  const deniedRotation = await delayedRotation.finish();
  check('human revoked during rotation body cannot rotate', [401, 403].includes(deniedRotation.status), deniedRotation.status);
  check('revoked rotation returns no replacement credential', !deniedRotation.json.token);
  check('rejected rotation cannot revoke the recovered human', (await call('/whoami', human)).status === 200);
  check('rejected rotation cannot revoke the existing agent', (await call('/whoami', agentToken)).status === 200);
  check('old human cannot retry rotation after recovery', (await call('/rotate', oldRotator, {})).status === 401);

  const pairing = await call('/pair', human, {});
  if (pairing.status !== 201 || !pairing.json.code) throw new Error('Cannot create miniapp pairing fixture');
  const bound = await call('/wxapp/bind', undefined, { code: 'initial-bind', pair: pairing.json.code });
  check('fresh human-issued pairing can bind a miniapp identity', bound.status === 200 && bound.json.credential?.role === 'human', bound.status);
  if (bound.status !== 200 || !bound.json.token) throw new Error('Miniapp binding precondition failed: HTTP ' + bound.status);
  const beforeRecoveryLogin = await call('/wxapp/login', undefined, { code: 'before-recovery' });
  check('verified miniapp can log in before recovery', beforeRecoveryLogin.status === 200 && !!beforeRecoveryLogin.json.token, beforeRecoveryLogin.status);
  if (beforeRecoveryLogin.status !== 200 || !beforeRecoveryLogin.json.token) throw new Error('Miniapp login precondition failed: HTTP ' + beforeRecoveryLogin.status);
  const unredeemedPair = await call('/pair', human, {});
  if (unredeemedPair.status !== 201 || !unredeemedPair.json.code) throw new Error('Cannot create the stale pairing fixture');

  const heldLogin = call('/wxapp/login', undefined, { code: 'held-login' });
  heldLogin.catch(() => {});
  let heldTimeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([oauthHeld, new Promise((_, reject) => { heldTimeout = setTimeout(() => reject(new Error('Mock OAuth request did not arrive')), 5000); })]);
  } finally { clearTimeout(heldTimeout); }
  human = await recoverHuman();
  const heldResponse = currentOauthResponse();
  if (!heldResponse) throw new Error('Held OAuth response is missing');
  sendOpenid(heldResponse);
  heldOauthResponse = null;
  const deniedLogin = await heldLogin;
  check('OAuth response arriving after recovery cannot revive an old binding', [401, 403, 409].includes(deniedLogin.status) && !deniedLogin.json.token, deniedLogin.status);
  const repeatedLogin = await call('/wxapp/login', undefined, { code: 'after-recovery' });
  check('the same old miniapp identity remains unable to mint a human token', [401, 403, 409].includes(repeatedLogin.status) && !repeatedLogin.json.token, repeatedLogin.status);
  check('miniapp credential issued before recovery is revoked', (await call('/whoami', bound.json.token)).status === 401);
  check('miniapp login credential issued before recovery is revoked', (await call('/whoami', beforeRecoveryLogin.json.token)).status === 401);
  check('operator recovery clears miniapp bindings from every credential row', Object.values(savedOwners()).filter((owner) => owner.id === ownerId).every((owner) => !owner.miniappOpenid && !owner.miniappBindingVersion));
  const deniedPair = await call('/pair/redeem', undefined, { code: unredeemedPair.json.code });
  check('a pairing authorized by the revoked human cannot be redeemed', [400, 401, 403, 409].includes(deniedPair.status) && !deniedPair.json.token, deniedPair.status);
  check('recovered human still works after rejected identity exchanges', (await call('/whoami', human)).json.credential?.role === 'human');
} catch (caught) {
  check('revocation suite completes', false, errorMessage(caught).replace(/xlb_[A-Za-z0-9_-]+/g, '[token]'));
} finally {
  for (const req of pendingRequests) req.destroy();
  currentOauthResponse()?.destroy();
  const remainingChild = currentChild();
  if (remainingChild?.pid && remainingChild.exitCode === null && remainingChild.signalCode === null) {
    const exited = new Promise((resolveExit) => remainingChild.once('exit', resolveExit));
    remainingChild.kill();
    await exited;
  }
  if (oauthMock.listening) {
    const closed = new Promise((resolveClose) => oauthMock.close(resolveClose));
    oauthMock.closeAllConnections();
    await closed;
  }
  // Verify this process's resolved mkdtemp target before recursive cleanup.
  if (dirname(resolve(dataDir)) !== temporaryRoot) throw new Error('Unexpected temporary cleanup target');
  await rm(dataDir, { recursive: true, force: true });
}
console.log(failed ? failed + ' FAILED' : 'ALL PASS');
process.exitCode = failed ? 1 : 0;
