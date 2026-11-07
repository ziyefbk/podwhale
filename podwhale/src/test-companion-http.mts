import { createServer, request } from 'node:http';
import type { Server } from 'node:http';
import { createHash } from 'node:crypto';
import { registerCompanionRoutes } from './companion-http.mjs';
import { companionWechatRequestId, companionWechatScope } from './companion-types.mjs';
import type { CompanionApi, CompanionBridgeAccess, CompanionConnection, CompanionJob } from './companion-types.mjs';
import type { Dispose, WebRoute } from './host-types.mjs';

const BASE = '/xiaolanshu/api/companion';
const PRIVATE_ERROR = 'private-fixture-error-never-return-this';
const routes = new Map<string, WebRoute>();
const calls: { operation: string; scope: string; value?: string }[] = [];
const jobs = new Map<string, Map<string, CompanionJob>>();
let failed = 0, serial = 0, connectionCalls = 0;
let mode: 'normal' | 'throw' = 'normal';
let serviceError: string | undefined;
let access: CompanionBridgeAccess | undefined;
let accessThrows = false;
let origin = '';
let dispose: Dispose | undefined;
let server: Server | undefined;
function check(name: string, ok: unknown) { console.log((ok ? 'ok   ' : 'FAIL ') + name); if (!ok) failed += 1; }
function fields(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid fixture response');
  return value as Record<string, unknown>;
}
function serviceFailure() {
  if (serviceError) throw Object.assign(new Error(PRIVATE_ERROR), serviceError === 'unknown' ? {} : { code: serviceError });
}
function owned(scope: string) { let entries = jobs.get(scope); if (!entries) { entries = new Map(); jobs.set(scope, entries); } return entries; }
const chat: CompanionApi = {
  async view(scope, jobId) {
    calls.push({ operation: 'view', scope, ...(jobId === undefined ? {} : { value: jobId }) }); serviceFailure();
    const entries = owned(scope);
    const job = jobId === undefined ? [...entries.values()].at(-1) ?? null : entries.get(jobId);
    if (job === undefined) throw Object.assign(new Error(PRIVATE_ERROR), { code: 'companion_job_not_found' });
    return { ok: true, ready: true, model: { provider: 'fixture', model: 'no-model' }, messages: [], job };
  },
  async send(scope, input) {
    calls.push({ operation: 'send', scope, value: input.requestId }); serviceFailure();
    const entries = owned(scope), existing = [...entries.values()].find((job) => job.requestId === input.requestId);
    if (existing) return existing;
    const job: CompanionJob = { id: 'job-' + (++serial), requestId: input.requestId, input: input.text,
      state: 'preparing', createdAt: '2026-01-01T00:00:00.000Z' };
    entries.set(job.id, job); return job;
  },
  async cancel(scope, jobId) {
    calls.push({ operation: 'cancel', scope, value: jobId }); serviceFailure();
    const job = owned(scope).get(jobId);
    if (!job) throw Object.assign(new Error(PRIVATE_ERROR), { code: 'companion_job_not_found' });
    job.state = 'cancelled'; return job;
  },
  async clear(scope) { calls.push({ operation: 'clear', scope }); serviceFailure(); jobs.delete(scope); },
};
const connection: CompanionConnection = {
  requestRejection(req) {
    connectionCalls += 1;
    if (this !== connection || mode === 'throw') throw new Error(PRIVATE_ERROR);
    if (req.headers.origin && req.headers.origin !== origin) return 403;
    if (req.headers.host !== new URL(origin).host) return 403;
    return req.headers.cookie === 'dsh_fixture=synthetic-owner' ? undefined : 401;
  },
};
interface Reply { status: number; headers: import('node:http').IncomingHttpHeaders; value: unknown; raw: string }
async function http(method: string, path: string, options: { body?: unknown; raw?: string; headers?: Record<string, string>; chunked?: boolean } = {}): Promise<Reply> {
  const data = options.raw ?? (options.body === undefined ? '' : JSON.stringify(options.body));
  return new Promise((resolve, reject) => {
    const headers = { ...(data ? { 'content-type': 'application/json' } : {}),
      ...(data && !options.chunked ? { 'content-length': String(Buffer.byteLength(data)) } : {}), ...options.headers };
    const req = request(origin + path, { method, headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: unknown) => { if (Buffer.isBuffer(chunk)) chunks.push(chunk); });
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString(); let value: unknown = null;
        try { value = JSON.parse(raw); } catch { /* HEAD and empty responses have no JSON. */ }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, value, raw });
      });
    });
    req.on('error', reject); req.setTimeout(5000, () => req.destroy(new Error('fixture HTTP timeout')));
    if (options.chunked) { req.write(data.slice(0, 100)); req.end(data.slice(100)); }
    else req.end(data);
  });
}
function safe(reply: Reply, code: string, status: number) {
  return reply.status === status && fields(reply.value).code === code && !reply.raw.includes(PRIVATE_ERROR)
    && reply.headers['cache-control'] === 'no-store' && reply.headers['x-content-type-options'] === 'nosniff';
}
try {
  dispose = registerCompanionRoutes({ webServer: { register(route) { routes.set(route.path, route); return () => { routes.delete(route.path); }; } },
    connection, chat, bridgeAccess: async () => { if (accessThrows) throw new Error(PRIVATE_ERROR); return access; } });
  server = createServer((req, res) => {
    const route = routes.get(new URL(req.url ?? '/', 'http://localhost').pathname);
    if (!route) { res.writeHead(404); res.end(); return; }
    Promise.resolve(route.handler(req, res)).catch(() => { res.writeHead(500); res.end(); });
  });
  await new Promise<void>((resolve) => { server!.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('invalid fixture address');
  origin = 'http://127.0.0.1:' + address.port;
  const browser = { cookie: 'dsh_fixture=synthetic-owner', origin };
  check('only the five fixed exact companion routes are registered', routes.size === 5 && [...routes.values()].every((route) => route.kind === 'exact'));
  const beforeDenied = calls.length;
  check('desktop rejects an unauthenticated loopback request', safe(await http('GET', BASE), 'companion_forbidden', 403));
  for (const [method, path, body] of [['POST', BASE + '/messages', { requestId: 'unauthorized', text: 'hello' }],
    ['POST', BASE + '/cancel', { jobId: 'private-job' }], ['DELETE', BASE, undefined]] as const) {
    check('desktop mutations also require connection authentication', safe(await http(method, path, { ...(body === undefined ? {} : { body }) }), 'companion_forbidden', 403));
  }
  check('desktop rejects a foreign browser Origin through connection', safe(await http('GET', BASE, { headers: { ...browser, origin: 'https://foreign.invalid' } }), 'companion_forbidden', 403));
  check('desktop rejects a rebound Host through connection', safe(await http('GET', BASE, { headers: { ...browser, host: 'foreign.invalid' } }), 'companion_forbidden', 403));
  mode = 'throw'; check('connection failure is closed without returning its private exception', safe(await http('GET', BASE, { headers: browser }), 'companion_forbidden', 403));
  const realAdmission = connection.requestRejection;
  Reflect.set(connection, 'requestRejection', () => null);
  check('an unknown connection result is never treated as authentication', safe(await http('GET', BASE, { headers: browser }), 'companion_forbidden', 403));
  Reflect.set(connection, 'requestRejection', realAdmission);
  mode = 'normal';
  check('rejected desktop requests never read or mutate a conversation', calls.length === beforeDenied);
  const viewed = await http('GET', BASE, { headers: browser });
  check('a same-origin cookie-authorized desktop request preserves connection this', viewed.status === 200 && fields(viewed.value).ready === true
    && viewed.headers['cache-control'] === 'no-store' && viewed.headers['x-content-type-options'] === 'nosniff');
  check('desktop can only view its fixed scope', calls.at(-1)?.scope === 'desktop' && calls.at(-1)?.operation === 'view');
  const desktopJob = await http('POST', BASE + '/messages', { headers: browser, body: { requestId: 'desktop-1', text: 'Synthetic hello' } });
  const desktopId = fields(fields(desktopJob.value).job).id;
  if (typeof desktopId !== 'string') throw new Error('missing job fixture');
  check('desktop submission returns an accepted job', desktopJob.status === 202 && fields(fields(desktopJob.value).job).requestId === 'desktop-1');
  check('desktop polls only the requested job in its own scope', (await http('GET', BASE + '?jobId=' + desktopId, { headers: browser })).status === 200
    && calls.at(-1)?.scope === 'desktop' && calls.at(-1)?.value === desktopId);
  check('desktop cancellation stays in its own scope', (await http('POST', BASE + '/cancel', { headers: browser, body: { jobId: desktopId } })).status === 200
    && calls.at(-1)?.operation === 'cancel' && calls.at(-1)?.scope === 'desktop');
  check('desktop clear returns the cleared desktop view', (await http('DELETE', BASE, { headers: browser })).status === 200
    && calls.at(-2)?.operation === 'clear' && calls.at(-2)?.scope === 'desktop' && calls.at(-1)?.scope === 'desktop');
  for (const [method, path] of [['POST', BASE], ['GET', BASE + '/messages'], ['DELETE', BASE + '/cancel']] as const) {
    check('desktop rejects unsupported method ' + method + ' ' + path, safe(await http(method, path, { headers: browser }), 'companion_method_not_allowed', 405));
  }
  for (const body of [{ requestId: 'x', text: 'hello', role: 'owner' }, { requestId: 'x', text: 'hello', scope: 'private-session' },
    { requestId: 'x', text: 'hello', source: {} }, { requestId: 'x', text: '' }, { requestId: 1, text: 'hello' }, []]) {
    check('desktop rejects extra authorization fields and malformed input', safe(await http('POST', BASE + '/messages', { headers: browser, body }), 'companion_invalid_input', 400));
  }
  check('desktop rejects unknown and repeated query fields', safe(await http('GET', BASE + '?scope=private-session', { headers: browser }), 'companion_invalid_input', 400)
    && safe(await http('GET', BASE + '?jobId=a&jobId=b', { headers: browser }), 'companion_invalid_input', 400));
  check('desktop rejects malformed JSON', safe(await http('POST', BASE + '/messages', { headers: browser, raw: '{' }), 'companion_invalid_input', 400));
  check('desktop requires JSON rather than a browser form', safe(await http('POST', BASE + '/messages', { headers: { ...browser, 'content-type': 'text/plain' }, raw: 'hello' }), 'companion_json_required', 415));
  check('declared oversized bodies are rejected without waiting for their bytes', safe(await http('POST', BASE + '/messages', { headers: { ...browser, 'content-length': '16385', 'content-type': 'application/json' } }), 'companion_body_too_large', 413));
  check('chunked bodies are bounded by actual received bytes', safe(await http('POST', BASE + '/messages', { headers: browser, body: { requestId: 'large', text: 'a'.repeat(17000) }, chunked: true }), 'companion_body_too_large', 413));
  serviceError = 'unknown'; check('unknown service errors return only a fixed code', safe(await http('GET', BASE, { headers: browser }), 'companion_failed', 500));
  serviceError = 'companion_busy'; check('known service failures keep their fixed safe status and code', safe(await http('GET', BASE, { headers: browser }), 'companion_busy', 409));
  serviceError = undefined;

  const token = 'companion-fixture-' + 'a'.repeat(48);
  const bearer = { authorization: 'Bearer ' + token };
  const event = { selfId: 'wxid_self', peerType: 'private' as const, peerId: 'wxid_peer', senderId: 'wxid_peer', messageId: 'msg-1', text: 'Synthetic WeChat hello' };
  check('WeChat stays disabled without its independent local configuration', safe(await http('POST', BASE + '/wechat/messages', { headers: bearer, body: event }), 'companion_bridge_disabled', 503));
  access = { tokenHash: 'bad', accounts: [event.selfId], peers: ['private:wxid_self:wxid_peer'] };
  check('malformed bridge configuration never enables the bridge', safe(await http('POST', BASE + '/wechat/messages', { headers: bearer, body: event }), 'companion_bridge_disabled', 503));
  accessThrows = true; check('bridge configuration read failures are closed without details', safe(await http('POST', BASE + '/wechat/messages', { headers: bearer, body: event }), 'companion_bridge_disabled', 503)); accessThrows = false;
  access = { tokenHash: createHash('sha256').update(token).digest('hex'), accounts: [event.selfId], peers: ['private:wxid_self:wxid_peer', 'group:wxid_self:group-1@chatroom'] };
  check('browser authentication cannot replace the independent bridge token', safe(await http('POST', BASE + '/wechat/messages', { body: event }), 'companion_forbidden', 403));
  check('a wrong bridge token cannot invoke chat', safe(await http('POST', BASE + '/wechat/messages', { headers: { authorization: 'Bearer ' + 'z'.repeat(32) }, body: event }), 'companion_forbidden', 403));
  for (const header of [{ host: 'foreign.invalid' }, { origin }, { referer: origin }, { cookie: 'dsh_fixture=synthetic-owner' },
    { forwarded: 'for=127.0.0.1' }, { 'x-forwarded-for': '127.0.0.1' }, { 'x-real-ip': '127.0.0.1' },
    { via: 'synthetic-proxy' }, { 'sec-fetch-site': 'same-origin' }]) {
    check('WeChat rejects browser and forwarded request metadata', safe(await http('POST', BASE + '/wechat/messages', { headers: { ...bearer, ...header }, body: event }), 'companion_forbidden', 403));
  }
  const connectionBeforeWechat = connectionCalls;
  const wx = await http('POST', BASE + '/wechat/messages', { headers: bearer, body: event });
  const wxJob = fields(fields(wx.value).job), wxId = wxJob.id;
  if (typeof wxId !== 'string') throw new Error('missing WeChat job fixture');
  check('authorized WeChat submits only its canonical independent conversation', wx.status === 202 && calls.at(-1)?.scope === companionWechatScope(event)
    && calls.at(-1)?.scope !== 'desktop' && wxJob.requestId === companionWechatRequestId(event, event.messageId)
    && fields(fields(wx.value).target).peerId === event.peerId && connectionCalls === connectionBeforeWechat);
  const duplicate = await http('POST', BASE + '/wechat/messages', { headers: bearer, body: event });
  check('duplicate WeChat message IDs preserve the same scoped idempotency key', fields(fields(duplicate.value).job).id === wxId);
  const group = { ...event, peerType: 'group' as const, peerId: 'group-1@chatroom' };
  const groupReply = await http('POST', BASE + '/wechat/messages', { headers: bearer, body: group });
  check('the same message ID in another allowed peer has a different scope and key', groupReply.status === 202
    && fields(fields(groupReply.value).job).requestId !== wxJob.requestId && calls.at(-1)?.scope === companionWechatScope(group));
  const status = await http('POST', BASE + '/wechat/status', { headers: bearer, body: { selfId: event.selfId, peerType: event.peerType,
    peerId: event.peerId, senderId: event.senderId, jobId: wxId } });
  check('WeChat status returns the requested job and bound target only in that peer scope', status.status === 200
    && fields(fields(status.value).job).id === wxId && fields(fields(status.value).target).senderId === event.senderId
    && calls.at(-1)?.operation === 'view' && calls.at(-1)?.scope === companionWechatScope(event));
  check('WeChat cannot read a different peer job by guessing its ID', safe(await http('POST', BASE + '/wechat/status', { headers: bearer,
    body: { selfId: group.selfId, peerType: group.peerType, peerId: group.peerId, senderId: group.senderId, jobId: wxId } }), 'companion_job_not_found', 404));
  const deniedBridgeBefore = calls.length;
  for (const body of [{ ...event, selfId: 'wxid_other' }, { ...event, peerId: 'wxid_unlisted' }]) {
    check('WeChat account and peer whitelists are exact', safe(await http('POST', BASE + '/wechat/messages', { headers: bearer, body }), 'companion_forbidden', 403));
  }
  for (const body of [{ ...event, peerType: 'unknown' }, { ...event, peerId: 'self:peer' }, { ...event, owner: 'desktop' }, { ...event, role: 'human' }, { ...event, source: { trusted: true } }]) {
    check('WeChat rejects ambiguous IDs and untrusted permission fields', safe(await http('POST', BASE + '/wechat/messages', { headers: bearer, body }), 'companion_invalid_input', 400));
  }
  check('rejected WeChat input never touches any conversation', calls.length === deniedBridgeBefore);
  check('WeChat method whitelist remains enforced for authenticated gateways', safe(await http('GET', BASE + '/wechat/messages', { headers: bearer }), 'companion_method_not_allowed', 405));
  check('unknown companion paths cannot dispatch arbitrary chat operations', (await http('POST', BASE + '/wechat/clear', { headers: bearer, body: event })).status === 404);
  check('only desktop and approved canonical WeChat scopes ever reach chat', calls.every((call) => call.scope === 'desktop'
    || call.scope === companionWechatScope(event) || call.scope === companionWechatScope(group)));
  await dispose(); dispose = undefined;
  check('disposing the module removes every registered HTTP route', routes.size === 0);
  const missingRoutes = new Map<string, WebRoute>();
  const disposeMissing = registerCompanionRoutes({ webServer: { register(route) { missingRoutes.set(route.path, route); return () => {}; } }, chat });
  for (const [path, route] of missingRoutes) routes.set(path, route);
  check('missing connection service leaves desktop chat closed', safe(await http('GET', BASE, { headers: browser }), 'companion_forbidden', 403));
  await disposeMissing();
} catch (error) {
  check('companion HTTP fixture completes without an unexpected exception', false);
  console.error(error instanceof Error ? error.stack : 'unexpected fixture failure');
} finally {
  if (dispose) await dispose();
  if (server) { server.closeAllConnections(); await new Promise<void>((resolve) => server!.close(() => resolve())); }
}
console.log(failed ? failed + ' FAILED' : 'ALL PASS');
process.exitCode = failed ? 1 : 0;
