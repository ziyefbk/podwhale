import type { AddressInfo, Socket, TcpNetConnectOpts } from 'node:net';
import type { IncomingHttpHeaders } from 'node:http';
import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
interface Fixture { port: number; child: ChildProcessByStdio<null, Readable, Readable>; backupDir: string; sockets: Set<Socket> }
interface JsonResponse { credential?: { role?: string }; items?: unknown[]; proposal?: { status?: string }; backup?: { files?: number } }
interface Response { status: number | undefined; headers: IncomingHttpHeaders; json: JsonResponse }
interface RawResponse { status: number; statuses: number[]; firstHeaders: string; timedOut: boolean }
/** Real, low-volume HTTP regressions for the public network boundary. */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { request } from 'node:http';
import { connect, createServer } from 'node:net';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const temporaryRoot = resolve(tmpdir());
const dataRoot = await mkdtemp(join(temporaryRoot, 'xlb-http-security-'));
const token = 'xlb_' + '6'.repeat(48);
const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('XLB_')));
const fixtures = new Set<Fixture>();
const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));
let failed = 0;
let passed = 0;
let sequence = 0;

function check(name: string, ok: unknown, detail: unknown = "") {
  console.log((ok ? 'ok  ' : 'FAIL') + ' ' + name + (!ok && detail ? ' -> ' + detail : ''));
  if (ok) passed += 1;
  else failed += 1;
}

async function unusedPort() {
  const probe = createServer();
  await new Promise<void>((done, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', done); });
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((done, reject) => probe.close((error) => error ? reject(error) : done()));
  return port;
}

async function fixture(overrides: NodeJS.ProcessEnv = {}) {
  const data = join(dataRoot, 'case-' + (++sequence));
  await mkdir(data);
  const backupDir = join(data, 'backups');
  await mkdir(backupDir);
  const future = new Date(Date.now() + 86400000).toISOString();
  await writeFile(join(data, 'owners.json'), JSON.stringify({
    [createHash('sha256').update(token).digest('hex')]: {
      id: 'ohttpfixture', name: 'HTTP fixture', handle: 'fixture', revoked: false,
      createdAt: new Date().toISOString(), credential: { role: 'agent', expiresAt: future },
    },
  }));
  const port = await unusedPort();
  const child = spawn(process.execPath, [join(HERE, 'community.mjs')], {
    env: { ...inherited, XLB_HOST: '127.0.0.1', XLB_PORT: String(port), XLB_DATA: data,
      XLB_BACKUP_DIR: backupDir, XLB_WRITE_LIMIT: '200', XLB_PATROL_MAX_HOURS: '0', ...overrides },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  const state = { port, child, backupDir, sockets: new Set<Socket>() };
  fixtures.add(state);
  // Readiness must not spend a request in the intentionally tiny test buckets.
  await new Promise<void>((done, reject) => {
    let tail = '';
    const timer = setTimeout(() => finish(new Error('HTTP fixture did not start')), 10000);
    const onError = () => finish(new Error('HTTP fixture failed to start'));
    const onExit = () => finish(new Error('HTTP fixture exited during startup'));
    const onData = (chunk: Buffer) => {
      tail = (tail + chunk.toString()).slice(-2048);
      if (tail.includes('listening on ')) finish();
    };
    function finish(error?: Error) {
      clearTimeout(timer);
      child.off('error', onError);
      child.off('exit', onExit);
      child.stdout.off('data', onData);
      child.stdout.resume();
      error ? reject(error) : done();
    }
    child.once('error', onError);
    child.once('exit', onExit);
    child.stdout.on('data', onData);
    child.stderr.resume();
  });
  return state;
}

async function stop(state: Fixture) {
  for (const socket of state.sockets) socket.destroy();
  const child = state.child;
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise((done) => child.once('exit', done));
    let timer: ReturnType<typeof setTimeout> | undefined;
    child.kill();
    await Promise.race([exited, new Promise((done) => { timer = setTimeout(done, 2500); })]);
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
  }
  fixtures.delete(state);
}

async function withFixture(options: NodeJS.ProcessEnv, run: (state: Fixture) => Promise<void>) {
  const state = await fixture(options);
  try { await run(state); } finally { await stop(state); }
}

function call(state: Fixture, path: string, { credential, method = 'GET', body, headers = {} }: { credential?: string; method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<Response> {
  return new Promise<Response>((done, reject) => {
    const req = request({ host: '127.0.0.1', port: state.port, path, method, agent: false,
      headers: { ...(credential ? { authorization: 'Bearer ' + credential } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        clearTimeout(timer);
        const text = Buffer.concat(chunks).toString('utf8');
        let json;
        try { json = JSON.parse(text); } catch { json = {}; }
        done({ status: res.statusCode, headers: res.headers, json });
      });
    });
    const timer = setTimeout(() => req.destroy(new Error('HTTP fixture request timed out')), 7000);
    req.once('error', (error) => { clearTimeout(timer); reject(error); });
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

function socketFor(state: Fixture, options: Partial<TcpNetConnectOpts> = {}) {
  const socket = connect({ host: '127.0.0.1', port: state.port, ...options });
  state.sockets.add(socket);
  socket.once('close', () => state.sockets.delete(socket));
  return socket;
}

function raw(state: Fixture, bytes: string, timeout = 6000): Promise<RawResponse> {
  return new Promise((done) => {
    const socket = socketFor(state);
    let response = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; socket.destroy(); }, timeout);
    socket.once('connect', () => socket.write(bytes));
    socket.on('data', (chunk) => { response = (response + chunk.toString('utf8')).slice(0, 65536); });
    socket.on('error', () => {}); // Reset/EOF is an intentional rejection for excess or timed-out sockets.
    socket.once('close', () => {
      clearTimeout(timer);
      done({ status: Number(/^HTTP\/1\.[01] (\d{3})/.exec(response)?.[1] || 0),
        statuses: [...response.matchAll(/HTTP\/1\.[01] (\d{3})/g)].map((match) => Number(match[1])),
        firstHeaders: response.split('\r\n\r\n')[0]!, timedOut });
    });
  });
}

function finishBodyAfterTimeout(state: Fixture, body: string, headerDelay = 0): Promise<{ attempted: boolean; timedOut: boolean; status: number }> {
  return new Promise((done) => {
    const socket = socketFor(state, { allowHalfOpen: true });
    let response = '';
    let attempted = false;
    let timedOut = false;
    let headerTimer: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => { timedOut = true; socket.destroy(); }, 5000);
    socket.once('connect', () => {
      socket.write('POST /proposals HTTP/1.1\r\n');
      const finishHeaders = () => socket.write('Host: localhost\r\nAuthorization: Bearer ' + token
        + '\r\nContent-Type: application/json\r\nContent-Length: ' + Buffer.byteLength(body)
        + '\r\nConnection: close\r\n\r\n' + body.slice(0, -1));
      if (headerDelay) headerTimer = setTimeout(finishHeaders, headerDelay);
      else finishHeaders();
    });
    socket.on('data', (chunk) => {
      response += chunk.toString('utf8');
      if (!attempted && /^HTTP\/1\.[01] 408\b/.test(response)) {
        attempted = true;
        // Finish the hostile upload, then close our own half of the connection.
        // With allowHalfOpen a server FIN alone must not make this test hang.
        socket.end(body.slice(-1));
      }
    });
    socket.on('error', () => {});
    socket.once('close', () => {
      clearTimeout(timer);
      clearTimeout(headerTimer);
      done({ attempted, timedOut, status: Number(/^HTTP\/1\.[01] (\d{3})/.exec(response)?.[1] || 0) });
    });
  });
}

try {
  await withFixture({ XLB_HTTP_IP_RATE: '0.01', XLB_HTTP_IP_BURST: '3' }, async (state) => {
    check('anonymous health remains available within its request budget', (await call(state, '/health')).status === 200);
    const unauthorized = await raw(state, 'POST /profile HTTP/1.1\r\nHost: localhost\r\n'
      + 'Expect: 100-continue\r\nContent-Length: 1000\r\nConnection: close\r\n\r\n');
    check('missing bearer is rejected before a body is required', !unauthorized.timedOut && unauthorized.status === 401);
    check('unauthorized request is not invited to upload its body', !unauthorized.statuses.includes(100));
    check('untrusted forwarded headers do not change the source budget', (await call(state, '/health', {
      headers: { 'x-forwarded-for': '198.51.100.1' },
    })).status === 200);
    const blocked = await call(state, '/health', { headers: { 'x-forwarded-for': '198.51.100.2' } });
    check('anonymous health is rate limited before its route executes', blocked.status === 429);
    check('rate rejection gives a bounded retry hint and closes the connection', blocked.headers.connection === 'close'
      && /^\d+$/.test(blocked.headers['retry-after'] || '') && Number(blocked.headers['retry-after']) > 0);
    check('changing forwarded addresses cannot escape the default IP limiter', (await call(state, '/feed', {
      headers: { 'x-forwarded-for': '198.51.100.3' },
    })).status === 429);
    const rejectedUpload = await raw(state, 'POST /enroll HTTP/1.1\r\nHost: localhost\r\n'
      + 'Expect: 100-continue\r\nContent-Length: 1000\r\nConnection: close\r\n\r\n');
    check('request limiting rejects Expect uploads before sending continue', !rejectedUpload.timedOut
      && rejectedUpload.status === 429 && !rejectedUpload.statuses.includes(100));
  });

  await withFixture({ XLB_TRUST_PROXY: '1', XLB_HTTP_GLOBAL_RATE: '0.01', XLB_HTTP_GLOBAL_BURST: '3' }, async (state) => {
    const admitted = [];
    for (let i = 1; i <= 3; i += 1) admitted.push((await call(state, '/health', {
      headers: { 'x-forwarded-for': '198.51.100.' + i },
    })).status);
    check('separate trusted fixture addresses initially share a usable global budget', admitted.every((status) => status === 200));
    check('a new source cannot evade the global request budget', (await call(state, '/health', {
      headers: { 'x-forwarded-for': '198.51.100.4' },
    })).status === 429);
  });

  await withFixture({ XLB_HTTP_AUTH_FAIL_RATE: '0.01', XLB_HTTP_AUTH_FAIL_BURST: '3' }, async (state) => {
    const failures = [];
    for (let i = 0; i < 3; i += 1) failures.push(await call(state, '/whoami', {
      credential: 'xlb_' + String(i).repeat(48), headers: { 'x-forwarded-for': '203.0.113.' + (i + 1) },
    }));
    check('initial invalid credentials receive ordinary authentication failures', failures.every((result) => result.status === 401));
    check('authentication failures close unread request connections', failures.every((result) => result.headers.connection === 'close'));
    check('new bearer strings and forwarded addresses do not reset the failed-auth bucket', (await call(state, '/whoami', {
      credential: 'xlb_' + '9'.repeat(48), headers: { 'x-forwarded-for': '203.0.113.9' },
    })).status === 429);
    const valid = await call(state, '/whoami', { credential: token });
    check('a valid session remains usable after failed-auth exhaustion', valid.status === 200
      && valid.json.credential?.role === 'agent');
  });

  await withFixture({ XLB_TRUST_PROXY: '1', XLB_HTTP_AUTH_GLOBAL_RATE: '0.01', XLB_HTTP_AUTH_GLOBAL_BURST: '2' }, async (state) => {
    const invalid = { credential: 'xlb_' + '9'.repeat(48) };
    const first = await call(state, '/whoami', { ...invalid, headers: { 'x-forwarded-for': '203.0.113.11' } });
    const second = await call(state, '/whoami', { ...invalid, headers: { 'x-forwarded-for': '203.0.113.12' } });
    const third = await call(state, '/whoami', { ...invalid, headers: { 'x-forwarded-for': '203.0.113.13' } });
    check('global failed-auth budget covers different trusted source addresses', first.status === 401 && second.status === 401 && third.status === 429);
    check('successful authentication does not consume the global failure budget', (await call(state, '/whoami', {
      credential: token, headers: { 'x-forwarded-for': '203.0.113.14' },
    })).status === 200);
  });

  await withFixture({ XLB_TRUST_PROXY: '1', XLB_HTTP_IP_RATE: '0.01', XLB_HTTP_IP_BURST: '2',
    XLB_HTTP_IP_KEYS: '2', XLB_HTTP_BUCKET_TTL_MS: '50' }, async (state) => {
    const from = (ip: string) => call(state, '/health', { headers: { 'x-forwarded-for': ip } });
    check('small source table initially admits its first address', (await from('198.51.100.21')).status === 200);
    check('source token bucket permits its configured burst', (await from('198.51.100.21')).status === 200);
    check('small source table admits a second address', (await from('198.51.100.22')).status === 200);
    await pause(80);
    check('full source table rejects new keys instead of growing without bound', (await from('198.51.100.23')).status === 429);
    check('short configured TTL cannot reset an exhausted active source', (await from('198.51.100.21')).status === 429);
    check('table pressure preserves an existing source with remaining tokens', (await from('198.51.100.22')).status === 200);
  });

  await withFixture({ XLB_HTTP_HEADERS_TIMEOUT_MS: '200', XLB_HTTP_REQUEST_TIMEOUT_MS: '400',
    XLB_HTTP_CHECK_INTERVAL_MS: '10', XLB_HTTP_SOCKET_TIMEOUT_MS: '1500' }, async (state) => {
    const pending = JSON.stringify({ action: 'post', payload: { title: 'slow fixture', text: 'must never be stored' } });
    const stalled = await raw(state, 'POST /proposals HTTP/1.1\r\nHost: localhost\r\n'
      + 'Authorization: Bearer ' + token + '\r\nContent-Type: application/json\r\n'
      + 'Content-Length: ' + Buffer.byteLength(pending) + '\r\nConnection: close\r\n\r\n' + pending.slice(0, 20), 3000);
    check('unfinished authenticated request bodies are closed within the configured deadline', !stalled.timedOut
      && (stalled.status === 408 || stalled.status === 0));
    const proposals = await call(state, '/proposals', { credential: token });
    check('a timed-out partial body creates no proposal', proposals.status === 200 && proposals.json.items?.length === 0);
    const incompleteHeaders = await raw(state, 'GET /health HTTP/1.1\r\nHost: localhost\r\nX-Slow: ', 3000);
    check('unfinished HTTP headers are closed within the configured deadline', !incompleteHeaders.timedOut
      && (incompleteHeaders.status === 408 || incompleteHeaders.status === 0));
    check('ordinary sessions still work after slow requests are removed', (await call(state, '/whoami', { credential: token })).status === 200);
    const complete = await call(state, '/proposals', { credential: token, method: 'POST', body: JSON.parse(pending) });
    check('a complete authenticated body remains a pending proposal', complete.status === 201 && complete.json.proposal?.status === 'pending');
  });

  await withFixture({ XLB_HTTP_HEADERS_TIMEOUT_MS: '150', XLB_HTTP_REQUEST_TIMEOUT_MS: '250',
    XLB_HTTP_CHECK_INTERVAL_MS: '10', XLB_HTTP_SOCKET_TIMEOUT_MS: '4000', XLB_HTTP_REJECT_GRACE_MS: '2000' }, async (state) => {
    const before = await call(state, '/proposals', { credential: token });
    const late = await finishBodyAfterTimeout(state, JSON.stringify({ action: 'post',
      payload: { title: 'expired body fixture', text: 'must not execute after rejection' } }));
    check('a hostile half-open client attempts its final body byte only after receiving 408', late.attempted && !late.timedOut);
    const after = await call(state, '/proposals', { credential: token });
    check('completing a request body after timeout cannot create a proposal', before.status === 200 && before.json.items?.length === 0
      && after.status === 200 && after.json.items?.length === 0);
  });

  await withFixture({ XLB_HTTP_HEADERS_TIMEOUT_MS: '300', XLB_HTTP_REQUEST_TIMEOUT_MS: '500',
    XLB_HTTP_CHECK_INTERVAL_MS: '10', XLB_HTTP_SOCKET_TIMEOUT_MS: '4000', XLB_HTTP_REJECT_GRACE_MS: '2000' }, async (state) => {
    const late = await finishBodyAfterTimeout(state, JSON.stringify({ action: 'post',
      payload: { title: 'parser deadline fixture', text: 'must not execute after parser timeout' } }), 200);
    check('headers elapsed time lets the parser deadline reject before the admitted body deadline', late.attempted && !late.timedOut,
      JSON.stringify(late));
    const after = await call(state, '/proposals', { credential: token });
    check('parser timeout also prevents a late completed body from creating a proposal', after.status === 200 && after.json.items?.length === 0,
      'HTTP ' + after.status + ', proposals ' + (after.json.items?.length ?? 'missing'));
  });

  await withFixture({}, async (state) => {
    const oversized = JSON.stringify({ action: 'post', payload: { title: 'oversized fixture', text: 'x'.repeat(65536) } });
    const rejected = await raw(state, 'POST /proposals HTTP/1.1\r\nHost: localhost\r\n'
      + 'Authorization: Bearer ' + token + '\r\nContent-Type: application/json\r\n'
      + 'Content-Length: ' + Buffer.byteLength(oversized) + '\r\nConnection: close\r\n\r\n' + oversized);
    check('oversized authenticated JSON is rejected without retaining its body', !rejected.timedOut && rejected.status === 413);
    const proposals = await call(state, '/proposals', { credential: token });
    check('oversized body rejection leaves storage unchanged and the session usable', proposals.status === 200 && proposals.json.items?.length === 0);
  });

  await withFixture({ XLB_HTTP_MAX_HEADER_BYTES: '512', XLB_HTTP_MAX_HEADERS: '4' }, async (state) => {
    const large = await raw(state, 'GET /health HTTP/1.1\r\nHost: localhost\r\nX-Padding: ' + 'x'.repeat(700)
      + '\r\nConnection: close\r\n\r\n');
    check('configured HTTP header byte budget rejects an oversized header', !large.timedOut && large.status === 431);
    const many = await raw(state, 'GET /health HTTP/1.1\r\nHost: localhost\r\nX-One: 1\r\nX-Two: 2\r\nX-Three: 3\r\nConnection: close\r\n\r\n');
    check('configured HTTP header count budget rejects extra headers', !many.timedOut && many.status === 431);
    check('header rejection does not prevent a later ordinary request', (await call(state, '/health')).status === 200);
  });

  await withFixture({ XLB_HTTP_MAX_CONNECTIONS: '2', XLB_HTTP_HEADERS_TIMEOUT_MS: '5000',
    XLB_HTTP_REQUEST_TIMEOUT_MS: '5000', XLB_HTTP_SOCKET_TIMEOUT_MS: '5000' }, async (state) => {
    const held = await Promise.all([0, 1].map(() => new Promise<Socket>((done, reject) => {
      const socket = socketFor(state);
      socket.once('error', reject);
      socket.once('connect', () => { socket.write('GET /health HTTP/1.1\r\nHost: localhost\r\n'); done(socket); });
    })));
    const excess = await raw(state, 'GET /health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n', 1000);
    check('connection budget rejects a new connection while two incomplete requests are held', !excess.timedOut
      && (excess.status === 0 || excess.status === 503));
    await Promise.all(held.map((socket) => new Promise((done) => { socket.once('close', done); socket.destroy(); })));
    check('releasing held sockets restores capacity for an ordinary request', (await call(state, '/health')).status === 200);
  });

  await withFixture({ XLB_HTTP_MAX_REQUESTS_PER_SOCKET: '1', XLB_HTTP_KEEP_ALIVE_TIMEOUT_MS: '50' }, async (state) => {
    const result = await raw(state, 'GET /health HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\n'
      + 'GET /health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
    check('per-socket request budget closes or refuses requests beyond its first admitted request', !result.timedOut
      && result.status === 200 && /\r\nconnection: close(?:\r\n|$)/i.test(result.firstHeaders)
      && result.statuses.slice(1).every((status) => status === 503));
    check('a new connection remains usable after the per-socket limit', (await call(state, '/health')).status === 200);
  });

  await withFixture({ XLB_HEALTH_CACHE_MS: '60000' }, async (state) => {
    const initial = await call(state, '/health');
    check('health cache initially reports the real empty backup directory', initial.status === 200 && initial.json.backup?.files === 0);
    // backupStatus examines names and stat metadata, so no archive extraction is needed.
    await writeFile(join(state.backupDir, 'http-cache-fixture.tar.gz'), 'local backup metadata fixture');
    const cached = await call(state, '/health');
    check('health reuses backup metadata within its configured cache lifetime', cached.status === 200 && cached.json.backup?.files === 0);
    const changed = await call(state, '/proposals', { credential: token, method: 'POST',
      body: { action: 'post', payload: { title: 'cache invalidation fixture', text: 'pending proposal only' } } });
    const refreshed = await call(state, '/health');
    check('a persisted proposal invalidates cached health metadata immediately', changed.status === 201
      && changed.json.proposal?.status === 'pending' && refreshed.status === 200 && refreshed.json.backup?.files === 1);
  });

  await withFixture({ XLB_HEALTH_CACHE_MS: '100' }, async (state) => {
    const initial = await call(state, '/health');
    await writeFile(join(state.backupDir, 'http-expiry-fixture.tar.gz'), 'local backup metadata fixture');
    await pause(150);
    const expired = await call(state, '/health');
    check('health refreshes external backup metadata after cache expiry without a business write', initial.status === 200
      && initial.json.backup?.files === 0 && expired.status === 200 && expired.json.backup?.files === 1);
  });
} catch {
  // Never print response bodies, configuration, or bearer credentials on failure.
  check('HTTP security suite completes', false);
} finally {
  for (const state of fixtures) await stop(state);
  if (dirname(resolve(dataRoot)) !== temporaryRoot) throw new Error('Unexpected HTTP fixture cleanup target');
  await rm(dataRoot, { recursive: true, force: true });
}
console.log(failed ? failed + ' FAILED' : 'ALL PASS (' + passed + ' checks)');
process.exitCode = failed ? 1 : 0;
