/** Authenticated desktop controls. The browser never receives a community credential. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Dispose, WebServer } from './host-types.mjs';
import type { CompanionConnection } from './companion-types.mjs';
import type { SocialCommunityStatus, SocialPolicyUpdate, SocialStatus, SocialView } from './social-types.mjs';

const BASE = '/xiaolanshu/api/social';
const LIMIT = 8192;
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function fault(code: string, status: number) { return Object.assign(new Error(code), { code, status }); }
interface Controls {
  status(): Promise<SocialStatus>;
  update(value: unknown): Promise<SocialStatus>;
  runNow(): Promise<SocialStatus>;
  pause(): Promise<SocialStatus>;
}
function authenticate(req: IncomingMessage, connection: CompanionConnection | undefined) {
  try {
    if (!connection || typeof connection.requestRejection !== 'function' || connection.requestRejection(req) !== undefined) throw new Error('denied');
  } catch { throw fault('social_forbidden', 403); }
}
function send(res: ServerResponse, status: number, value: unknown) {
  if (res.destroyed || res.writableEnded) return;
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-content-type-options', 'nosniff');
  res.end(JSON.stringify(value));
}
async function json(req: IncomingMessage, empty = false): Promise<unknown> {
  const length = req.headers['content-length'];
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > LIMIT)) throw fault('social_body_too_large', 413);
  if (empty && req.headers['transfer-encoding'] === undefined && (length === undefined || length === '0')) return {};
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '')
    || (req.headers['content-encoding'] !== undefined && req.headers['content-encoding'] !== 'identity')) throw fault('social_json_required', 415);
  const buffer = await new Promise<Buffer>((done, reject) => {
    const chunks: Buffer[] = []; let size = 0, settled = false;
    const finish = (error?: Error) => {
      if (settled) return; settled = true; clearTimeout(timer);
      req.off('data', data); req.off('end', end); req.off('error', aborted); req.off('aborted', aborted);
      if (error) { req.pause(); reject(error); } else done(Buffer.concat(chunks));
    };
    const data = (chunk: unknown) => {
      if (!Buffer.isBuffer(chunk)) { finish(fault('social_invalid_input', 400)); return; }
      size += chunk.length;
      if (size > LIMIT) { finish(fault('social_body_too_large', 413)); return; }
      chunks.push(chunk);
    };
    const end = () => finish();
    const aborted = () => finish(fault('social_invalid_input', 400));
    const timer = setTimeout(() => finish(fault('social_body_timeout', 408)), 10000); timer.unref();
    req.on('data', data); req.once('end', end); req.once('error', aborted); req.once('aborted', aborted);
  });
  try { return JSON.parse(buffer.toString('utf8')) as unknown; } catch { throw fault('social_invalid_input', 400); }
}
function noParameters(req: IncomingMessage) {
  if (new URL(req.url ?? '/', 'http://localhost').search) throw fault('social_invalid_input', 400);
}
export function parseSocialPolicyUpdate(value: unknown): SocialPolicyUpdate {
  if (!object(value) || Object.keys(value).length !== 4
    || Object.keys(value).some(key => !['expectedRevision', 'post', 'reply', 'durationHours'].includes(key))
    || !Number.isSafeInteger(value.expectedRevision) || Number(value.expectedRevision) < 0) throw fault('social_invalid_input', 400);
  const action = (input: unknown, max: number) => {
    if (!object(input) || Object.keys(input).length !== 2 || !Object.hasOwn(input, 'requireApproval') || !Object.hasOwn(input, 'dailyLimit')
      || typeof input.requireApproval !== 'boolean' || !Number.isSafeInteger(input.dailyLimit) || Number(input.dailyLimit) < 0 || Number(input.dailyLimit) > max) throw fault('social_invalid_input', 400);
    return { requireApproval: input.requireApproval, dailyLimit: Number(input.dailyLimit) };
  };
  const post = action(value.post, 5), reply = action(value.reply, 20);
  if (!Number.isSafeInteger(value.durationHours) || Number(value.durationHours) < (post.requireApproval && reply.requireApproval ? 0 : 1)
    || Number(value.durationHours) > 168) throw fault('social_invalid_input', 400);
  return { expectedRevision: Number(value.expectedRevision), post, reply, durationHours: Number(value.durationHours) };
}
export function registerSocialRoutes({ webServer, connection, controls, community, requestPolicy }: {
  webServer: WebServer;
  connection?: CompanionConnection | undefined;
  controls: Controls;
  community(): Promise<SocialCommunityStatus>;
  requestPolicy(value: SocialPolicyUpdate): Promise<{ id: string; status: 'pending' }>;
}): Dispose {
  const stops: Dispose[] = [];
  const view = async (): Promise<SocialView> => {
    const [local, remote] = await Promise.all([controls.status(), community()]);
    return { ok: true, local, community: remote };
  };
  for (const [suffix, method] of [['', 'GET'], ['/settings', 'POST'], ['/run', 'POST'], ['/pause', 'POST'], ['/policy-request', 'POST']] as const) {
    stops.push(webServer.register({ kind: 'exact', path: BASE + suffix, async handler(req, res) {
      try {
        authenticate(req, connection); noParameters(req);
        if (req.method !== method) { res.setHeader('allow', method); throw fault('social_method_not_allowed', 405); }
        if (method === 'GET') {
          if (req.headers['transfer-encoding'] !== undefined || req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0') throw fault('social_invalid_input', 400);
          send(res, 200, await view()); return;
        }
        const input = await json(req, suffix === '/run' || suffix === '/pause');
        let request: { id: string; status: 'pending' } | undefined;
        if (suffix === '/settings') await controls.update(input);
        else if (suffix === '/policy-request') request = await requestPolicy(parseSocialPolicyUpdate(input));
        else {
          if (!object(input) || Object.keys(input).length) throw fault('social_invalid_input', 400);
          if (suffix === '/pause') await controls.pause();
          else {
            const remote = await community();
            if (!remote.connected) throw fault('social_not_joined', 409);
            if (!remote.available) throw fault('social_policy_unavailable', 503);
            await controls.runNow();
          }
        }
        send(res, suffix === '/run' || suffix === '/policy-request' ? 202 : 200, { ...await view(), ...(request ? { request } : {}) });
      } catch (error) {
        const status = object(error) && Number.isInteger(error.status) && Number(error.status) >= 400 && Number(error.status) <= 599 ? Number(error.status) : 503;
        const code = object(error) && typeof error.code === 'string' && /^social_[a-z_]{1,60}$/.test(error.code) ? error.code : 'social_unavailable';
        res.shouldKeepAlive = false; res.setHeader('connection', 'close'); send(res, status, { ok: false, code, error: code });
      }
    } }));
  }
  return async () => { await Promise.all(stops.map(async stop => { await stop(); })); };
}
