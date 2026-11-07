import { createHash, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Dispose, WebServer } from './host-types.mjs';
import { companionWechatRequestId, companionWechatScope } from './companion-types.mjs';
import type { CompanionApi, CompanionBridgeAccess, CompanionConnection, CompanionWechatTarget } from './companion-types.mjs';

const BASE = '/xiaolanshu/api/companion';
const BODY_LIMIT = 16 * 1024;
const BODY_TIMEOUT = 10000;
const SERVICE_ERRORS: Readonly<Record<string, number>> = {
  companion_busy: 409, companion_not_ready: 503, companion_job_not_found: 404,
  companion_invalid_input: 400, companion_store_unavailable: 503,
  companion_limit: 429, companion_conflict: 409,
};
class HttpFault extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function only(value: Record<string, unknown>, keys: readonly string[]) {
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    throw new HttpFault(400, 'companion_invalid_input');
  }
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.@-]{1,256}$/.test(value)) throw new HttpFault(400, 'companion_invalid_input');
  return value;
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw new HttpFault(400, 'companion_invalid_input');
  return value;
}
function headers(res: ServerResponse) {
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-content-type-options', 'nosniff');
}
function respond(res: ServerResponse, status: number, value: unknown) {
  if (res.destroyed || res.writableEnded) return;
  headers(res); res.statusCode = status; res.end(JSON.stringify(value));
}
function fail(res: ServerResponse, error: unknown) {
  let status = 500, code = 'companion_failed';
  if (error instanceof HttpFault) { status = error.status; code = error.code; }
  else if (object(error) && typeof error.code === 'string' && Object.hasOwn(SERVICE_ERRORS, error.code)) {
    code = error.code; status = SERVICE_ERRORS[code] ?? 500;
  }
  res.shouldKeepAlive = false;
  res.setHeader('connection', 'close');
  respond(res, status, { ok: false, code, error: code });
}
function methods(req: IncomingMessage, res: ServerResponse, allowed: readonly string[]) {
  if (!allowed.includes(req.method ?? '')) {
    res.setHeader('allow', allowed.join(', ')); throw new HttpFault(405, 'companion_method_not_allowed');
  }
}
function noBody(req: IncomingMessage) {
  if (req.headers['transfer-encoding'] !== undefined || (req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0')) {
    throw new HttpFault(400, 'companion_invalid_input');
  }
}
function query(req: IncomingMessage, allowJob = false): string | undefined {
  const params = new URL(req.url ?? '/', 'http://localhost').searchParams;
  if ([...params.keys()].some((key) => !allowJob || key !== 'jobId') || params.getAll('jobId').length > 1) {
    throw new HttpFault(400, 'companion_invalid_input');
  }
  const jobId = params.get('jobId');
  return jobId === null ? undefined : id(jobId);
}
async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const length = req.headers['content-length'];
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > BODY_LIMIT)) throw new HttpFault(413, 'companion_body_too_large');
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '')
    || (req.headers['content-encoding'] !== undefined && req.headers['content-encoding'] !== 'identity')) {
    throw new HttpFault(415, 'companion_json_required');
  }
  const bytes = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []; let size = 0, settled = false;
    const finish = (error?: HttpFault) => {
      if (settled) return; settled = true;
      clearTimeout(timer); req.off('data', data); req.off('end', end); req.off('aborted', aborted); req.off('error', aborted);
      if (error) { req.pause(); reject(error); } else resolve(Buffer.concat(chunks));
    };
    const data = (chunk: unknown) => {
      if (!Buffer.isBuffer(chunk)) { finish(new HttpFault(400, 'companion_invalid_input')); return; }
      size += chunk.length;
      if (size > BODY_LIMIT) { finish(new HttpFault(413, 'companion_body_too_large')); return; }
      chunks.push(chunk);
    };
    const end = () => finish();
    const aborted = () => finish(new HttpFault(400, 'companion_invalid_input'));
    const timer = setTimeout(() => finish(new HttpFault(408, 'companion_body_timeout')), BODY_TIMEOUT);
    timer.unref();
    req.on('data', data); req.once('end', end); req.once('aborted', aborted); req.once('error', aborted);
  });
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString('utf8')); } catch { throw new HttpFault(400, 'companion_invalid_input'); }
  if (!object(parsed)) throw new HttpFault(400, 'companion_invalid_input');
  return parsed;
}
function desktop(req: IncomingMessage, connection: CompanionConnection | undefined) {
  try {
    if (!connection || typeof connection.requestRejection !== 'function' || connection.requestRejection(req) !== undefined) {
      throw new Error('denied');
    }
  } catch { throw new HttpFault(403, 'companion_forbidden'); }
}
function loopback(address: string | undefined) {
  if (!address) return false;
  const value = address.replace(/^::ffff:/i, '');
  return value === '::1' || (isIP(value) === 4 && value.startsWith('127.'));
}
function bridgeOrigin(req: IncomingMessage) {
  const host = req.headers.host;
  const authority = typeof host === 'string' ? /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::(\d{1,5}))?$/i.exec(host) : null;
  if (!loopback(req.socket.remoteAddress) || !authority
    || (authority[1]?.toLowerCase() !== 'localhost' && !loopback(authority[1]?.replace(/^\[|\]$/g, '')))
    || (authority[2] !== undefined && (Number(authority[2]) < 1 || Number(authority[2]) > 65535))
    || Object.keys(req.headers).some((key) => ['origin', 'referer', 'cookie', 'forwarded', 'x-real-ip', 'via'].includes(key)
      || key.startsWith('x-forwarded-') || key.startsWith('sec-fetch-') || key.startsWith('sec-websocket-'))) {
    throw new HttpFault(403, 'companion_forbidden');
  }
}
async function bridge(req: IncomingMessage, readAccess: (() => Promise<CompanionBridgeAccess | undefined>) | undefined) {
  bridgeOrigin(req);
  let access: unknown;
  try { access = await readAccess?.(); } catch { throw new HttpFault(503, 'companion_bridge_disabled'); }
  if (!object(access) || typeof access.tokenHash !== 'string' || !/^[a-f0-9]{64}$/i.test(access.tokenHash)
    || !Array.isArray(access.accounts) || !Array.isArray(access.peers)) {
    throw new HttpFault(503, 'companion_bridge_disabled');
  }
  const accounts: unknown[] = access.accounts, peers: unknown[] = access.peers;
  if (!accounts.length || accounts.length > 1000
    || !accounts.every((value): value is string => typeof value === 'string' && /^[A-Za-z0-9_.@-]{1,256}$/.test(value))
    || !peers.length || peers.length > 10000
    || !peers.every((value): value is string => typeof value === 'string' && /^(?:private|group):[A-Za-z0-9_.@-]{1,256}:[A-Za-z0-9_.@-]{1,256}$/.test(value))) {
    throw new HttpFault(503, 'companion_bridge_disabled');
  }
  const token = /^Bearer ([A-Za-z0-9._~-]{16,512})$/.exec(req.headers.authorization ?? '')?.[1];
  if (!token || !timingSafeEqual(createHash('sha256').update(token).digest(), Buffer.from(access.tokenHash, 'hex'))) {
    throw new HttpFault(403, 'companion_forbidden');
  }
  return { accounts, peers };
}
function target(value: Record<string, unknown>, access: { accounts: unknown[]; peers: unknown[] }): CompanionWechatTarget {
  const selfId = id(value.selfId), peerId = id(value.peerId), senderId = id(value.senderId);
  if (value.peerType !== 'private' && value.peerType !== 'group') throw new HttpFault(400, 'companion_invalid_input');
  const peerType = value.peerType;
  if (!access.accounts.includes(selfId) || !access.peers.includes(`${peerType}:${selfId}:${peerId}`)) throw new HttpFault(403, 'companion_forbidden');
  return { selfId, peerType, peerId, senderId };
}

export function registerCompanionRoutes({ webServer, connection, chat, bridgeAccess }: {
  webServer: WebServer;
  connection?: CompanionConnection | undefined;
  chat: CompanionApi;
  bridgeAccess?: (() => Promise<CompanionBridgeAccess | undefined>) | undefined;
}): Dispose {
  const disposers: Dispose[] = [];
  const route = (path: string, action: (req: IncomingMessage, res: ServerResponse) => Promise<void>) => {
    disposers.push(webServer.register({ kind: 'exact', path, async handler(req, res) {
      try { await action(req, res); } catch (error) { fail(res, error); }
    } }));
  };
  route(BASE, async (req, res) => {
    desktop(req, connection); methods(req, res, ['GET', 'DELETE']); noBody(req);
    const jobId = query(req, req.method === 'GET');
    if (req.method === 'DELETE') await chat.clear('desktop');
    respond(res, 200, await chat.view('desktop', jobId));
  });
  route(BASE + '/messages', async (req, res) => {
    desktop(req, connection); methods(req, res, ['POST']); query(req);
    const value = await body(req); only(value, ['requestId', 'text']);
    respond(res, 202, { ok: true, job: await chat.send('desktop', { requestId: id(value.requestId), text: text(value.text) }) });
  });
  route(BASE + '/cancel', async (req, res) => {
    desktop(req, connection); methods(req, res, ['POST']); query(req);
    const value = await body(req); only(value, ['jobId']);
    respond(res, 200, { ok: true, job: await chat.cancel('desktop', id(value.jobId)) });
  });
  route(BASE + '/wechat/messages', async (req, res) => {
    const access = await bridge(req, bridgeAccess); methods(req, res, ['POST']); query(req);
    const value = await body(req); only(value, ['selfId', 'peerType', 'peerId', 'senderId', 'messageId', 'text']);
    const destination = target(value, access), scope = companionWechatScope(destination);
    const input = { requestId: companionWechatRequestId(destination, id(value.messageId)), text: text(value.text) };
    respond(res, 202, { ok: true, job: await chat.send(scope, input), target: destination });
  });
  route(BASE + '/wechat/status', async (req, res) => {
    const access = await bridge(req, bridgeAccess); methods(req, res, ['POST']); query(req);
    const value = await body(req); only(value, ['selfId', 'peerType', 'peerId', 'senderId', 'jobId']);
    const destination = target(value, access);
    respond(res, 200, { ...await chat.view(companionWechatScope(destination), id(value.jobId)), target: destination });
  });
  return async () => { await Promise.all(disposers.map(async (dispose) => { await dispose(); })); };
}
