/** Session-authenticated task views and proposal-only desktop actions. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { CompanionConnection } from './companion-types.mjs';
import type { Dispose, WebServer } from './host-types.mjs';

const BASE = '/xiaolanshu/api';
const MAX_BODY = 64 * 1024;
const ACTION_FIELDS: Readonly<Record<string, readonly string[]>> = {
  task: ['title', 'desc', 'description', 'budget', 'period', 'tags', 'match', 'acceptanceCriteria', 'deadlineAt'],
  claim: ['taskId', 'note', 'expectedRevision'],
  deliver: ['taskId', 'text', 'artifacts', 'expectedRevision', 'claimId', 'deliveryVersion'],
  confirm: ['taskId', 'expectedRevision', 'claimId', 'deliveryVersion'],
  task_start: ['taskId', 'expectedRevision', 'claimId', 'deliveryVersion'],
  task_rework: ['taskId', 'reason', 'expectedRevision', 'claimId', 'deliveryVersion'],
  task_withdraw: ['taskId', 'reason', 'expectedRevision', 'claimId', 'deliveryVersion'],
  task_cancel: ['taskId', 'reason', 'expectedRevision', 'claimId', 'deliveryVersion'],
};
const LIST_FIELDS = ['limit', 'before', 'q', 'scope', 'status', 'sort'];
const READ_ONLY = ['feed', 'tasks', 'proposals', 'notifications'];
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function fault(code: string, status = 400) { return Object.assign(new Error(code), { code, status }); }
function authenticate(req: IncomingMessage, connection: CompanionConnection) {
  try {
    if (typeof connection.requestRejection !== 'function' || connection.requestRejection(req) !== undefined) throw new Error('denied');
  } catch { throw fault('task_forbidden', 403); }
}
function send(res: ServerResponse, status: number, value: unknown) {
  if (res.destroyed || res.writableEnded) return;
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-content-type-options', 'nosniff');
  res.end(JSON.stringify(value));
}
async function json(req: IncomingMessage): Promise<Record<string, unknown>> {
  const length = req.headers['content-length'];
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > MAX_BODY)) throw fault('task_body_too_large', 413);
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '')
    || req.headers['content-encoding'] !== undefined && req.headers['content-encoding'] !== 'identity') throw fault('task_json_required', 415);
  const bytes = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []; let size = 0, settled = false;
    const finish = (error?: Error) => {
      if (settled) return; settled = true; clearTimeout(timer);
      req.off('data', data); req.off('end', end); req.off('error', aborted); req.off('aborted', aborted);
      if (error) { req.pause(); reject(error); } else resolve(Buffer.concat(chunks));
    };
    const data = (chunk: unknown) => {
      if (!Buffer.isBuffer(chunk)) { finish(fault('task_invalid_input')); return; }
      size += chunk.length;
      if (size > MAX_BODY) { finish(fault('task_body_too_large', 413)); return; }
      chunks.push(chunk);
    };
    const end = () => finish();
    const aborted = () => finish(fault('task_invalid_input'));
    const timer = setTimeout(() => finish(fault('task_body_timeout', 408)), 10000); timer.unref();
    req.on('data', data); req.once('end', end); req.once('error', aborted); req.once('aborted', aborted);
  });
  let value: unknown;
  try { value = JSON.parse(bytes.toString('utf8')) as unknown; } catch { throw fault('task_invalid_input'); }
  if (!object(value)) throw fault('task_invalid_input');
  return value;
}
function parameters(req: IncomingMessage, allowed: readonly string[]) {
  const input = new URL(req.url ?? '/', 'http://localhost').searchParams;
  const output = new URLSearchParams();
  for (const key of input.keys()) {
    if (!allowed.includes(key) || input.getAll(key).length !== 1 || (input.get(key)?.length ?? 0) > 1000) throw fault('task_invalid_input');
    output.set(key, input.get(key)!);
  }
  return output;
}
interface TaskRoutesOptions {
  webServer: WebServer;
  connection: CompanionConnection;
  request(path: string, body?: unknown, signal?: AbortSignal): Promise<Record<string, unknown> | null>;
  readFeed(query: URLSearchParams): Promise<Record<string, unknown>>;
}
export function registerTaskRoutes({ webServer, connection, request, readFeed }: TaskRoutesOptions): Dispose {
  const stops: Dispose[] = [];
  for (const action of [...READ_ONLY, ...Object.keys(ACTION_FIELDS)]) {
    stops.push(webServer.register({ kind: 'exact', path: BASE + '/' + action, async handler(req, res) {
      try {
        authenticate(req, connection);
        if (req.method === 'GET' && (READ_ONLY.includes(action) || action === 'task')) {
          if (req.headers['transfer-encoding'] !== undefined || req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0') throw fault('task_invalid_input');
          const query = parameters(req, action === 'feed' ? ['limit', 'before', 'q'] : action === 'task' ? ['taskId'] : action === 'tasks' ? LIST_FIELDS : []);
          if (action === 'task' && !/^[a-zA-Z0-9_-]{1,80}$/.test(query.get('taskId') ?? '')) throw fault('task_invalid_input');
          if (action === 'feed') { send(res, 200, await readFeed(query)); return; }
          const result = await request('/' + action + (query.size ? '?' + query.toString() : ''));
          if (!result && (action === 'proposals' || action === 'notifications')) {
            send(res, 200, { ok: true, items: [], ...(action === 'notifications' ? { unread: 0 } : {}) }); return;
          }
          if (!result) throw fault('task_not_joined', 409);
          send(res, 200, result); return;
        }
        if (req.method !== 'POST' || READ_ONLY.includes(action)) { res.setHeader('allow', action === 'task' ? 'GET, POST' : READ_ONLY.includes(action) ? 'GET' : 'POST'); throw fault('task_method_not_allowed', 405); }
        parameters(req, []);
        const body = await json(req);
        if (Object.keys(body).some(key => !ACTION_FIELDS[action]!.includes(key))) throw fault('task_invalid_input');
        const result = await request('/' + action, body);
        if (!result) throw fault('task_not_joined', 409);
        if (result.ok !== true || result.status !== 'pending' || result.executed !== false || result.action !== action
          || typeof result.proposalId !== 'string' || !/^proposal[a-zA-Z0-9_-]{1,150}$/.test(result.proposalId)) throw fault('task_receipt_invalid', 502);
        send(res, 202, { ok: true, status: 'pending', executed: false, proposalId: result.proposalId, action });
      } catch (error) {
        res.shouldKeepAlive = false;
        res.setHeader('connection', 'close');
        const status = object(error) && typeof error.status === 'number' && error.status >= 400 && error.status <= 599 ? error.status : 503;
        const code = object(error) && typeof error.code === 'string' && /^task_[a-z_]{1,60}$/.test(error.code) ? error.code
          : status === 409 ? 'task_conflict' : status === 401 || status === 403 ? 'task_forbidden' : 'task_unavailable';
        send(res, status, { ok: false, code, error: code });
      }
    } }));
  }
  return async () => { for (const stop of stops.splice(0)) await stop(); };
}
