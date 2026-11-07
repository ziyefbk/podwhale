/** Actual random-port HTTP + actual local controller + synthetic community. */
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdtemp, mkdir, rm, realpath } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createSocialController } from './social-controller.mjs';
import { createSocialCommunity, parseSocialPolicyView, socialFeedView } from './social-community.mjs';
import { registerSocialRoutes } from './social-http.mjs';
import type { Dispose, WebRoute } from './host-types.mjs';
import type { SocialPolicyView, SocialRunSummary } from './social-types.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
await mkdir(join(root, '.tmp'), { recursive: true });
const temp = await mkdtemp(join(root, '.tmp', 'social-http-test-'));
let failures = 0;
function check(label: string, ok: unknown) { console.log((ok ? 'ok   ' : 'FAIL ') + label); if (!ok) failures++; }
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
const routes = new Map<string, WebRoute>();
const webServer = { register(route: WebRoute) { routes.set(route.path, route); return () => { routes.delete(route.path); }; } };
const token = 'synthetic-agent-credential';
let configured = true, available = true, contradiction = false, modelCalls = 0, nativeSends = 0;
const requests: { path: string; authorization: string | undefined; value: unknown }[] = [];
const policy: SocialPolicyView = { ok: true,
  policy: { revision: 0, post: { requireApproval: true, dailyLimit: 1 }, reply: { requireApproval: true, dailyLimit: 3 }, expiresAt: null, updatedAt: null },
  effective: { post: 'review', reply: 'review' }, usage: { day: '2026-11-08', post: 0, reply: 0 }, pendingRequests: [] };
const upstream = createServer(async (req, res) => {
  let body = ''; for await (const part of req) body += String(part);
  let value: unknown = {}; try { value = body ? JSON.parse(body) as unknown : {}; } catch { res.writeHead(400).end(); return; }
  requests.push({ path: req.url ?? '', authorization: req.headers.authorization, value });
  res.setHeader('content-type', 'application/json');
  if (req.headers.authorization !== 'Bearer ' + token) { res.writeHead(403).end('{}'); return; }
  if (!available) { res.writeHead(503).end(JSON.stringify({ error: 'private-upstream-diagnostic' })); return; }
  if (req.url === '/xiaolanshu/social/policy') {
    res.end(JSON.stringify({ ...policy, ...(contradiction ? { effective: { post: 'auto', reply: 'auto' } } : {}), credential: 'must-never-reach-browser' }));
  } else if (req.url === '/xiaolanshu/social/policy-request') res.end(JSON.stringify({ ok: true, proposal: { id: 'proposal-policy-http', status: 'pending' } }));
  else if (req.url === '/xiaolanshu/social/actions') {
    nativeSends++;
    res.end(JSON.stringify({ ok: true, receipt: { id: 'proposal-http-action', action: 'reply', status: 'pending', executed: false, proposalId: 'proposal-http-action' } }));
  } else res.writeHead(404).end('{}');
});
await new Promise<void>(done => upstream.listen(0, '127.0.0.1', done));
const remoteAddress = upstream.address(); if (!remoteAddress || typeof remoteAddress === 'string') throw new Error('no upstream port');
const remote = createSocialCommunity({ configuration: async () => configured ? { url: `http://127.0.0.1:${remoteAddress.port}/xiaolanshu`, token } : null });
const controls = createSocialController({ homeDir: () => temp, ready: () => true,
  run: async (_settings, signal): Promise<SocialRunSummary> => {
    modelCalls++;
    await new Promise<void>(done => { signal.addEventListener('abort', () => done(), { once: true }); if (signal.aborted) done(); });
    return { type: 'patrol_summary', status: 'cancelled', executed: false, feedReads: 0, proposals: [], receipts: [] };
  } });
await controls.init();
let authCalls = 0;
const connection = { marker: 'bound', requestRejection(req: IncomingMessage) {
  authCalls++; if (this.marker !== 'bound' || req.headers.cookie !== 'synthetic-session=active'
    || req.headers.origin && req.headers.origin !== 'http://' + req.headers.host) return 403;
  return undefined;
} };
let dispose: Dispose = registerSocialRoutes({ webServer, connection, controls, community: remote.view, requestPolicy: remote.requestPolicy });
const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const route = routes.get(new URL(req.url ?? '/', 'http://localhost').pathname);
  if (route) void route.handler(req, res); else res.writeHead(404).end();
});
await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
const address = server.address(); if (!address || typeof address === 'string') throw new Error('no port');
const base = `http://127.0.0.1:${address.port}/xiaolanshu/api/social`;
async function call(path = '', method = 'GET', body?: unknown, options: { anonymous?: boolean; origin?: string; raw?: string } = {}) {
  const response = await fetch(base + path, { method, headers: { ...(!options.anonymous ? { cookie: 'synthetic-session=active' } : {}),
    ...(body !== undefined || options.raw !== undefined ? { 'content-type': 'application/json' } : {}), ...(options.origin ? { origin: options.origin } : {}) },
    ...(options.raw !== undefined ? { body: options.raw } : body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const value: unknown = await response.json().catch(() => null);
  return { status: response.status, headers: response.headers, value: object(value) ? value : {}, text: JSON.stringify(value) };
}
try {
  const publicNote = { id: 'p1', title: '公共帖子', text: '公共正文', lastReplies: [{ text: '公共评论' }] };
  const publicOnly = socialFeedView({ notes: [publicNote], asks: [{ text: 'PRIVATE_PHONE_ASK' }],
    tasks: [{ why: 'TASK_CONTEXT' }], claims: { delivery: 'PRIVATE_DELIVERY' }, token: 'PRIVATE_TOKEN' });
  check('automatic social input excludes private asks and task delivery context', publicOnly.notes.length === 1
    && !/PRIVATE_|TASK_CONTEXT/.test(JSON.stringify(publicOnly)) && JSON.stringify(Object.keys(publicOnly).sort()) === JSON.stringify(['notes', 'remote', 'source', 'trust']));
  publicNote.lastReplies[0]!.text = 'changed after projection';
  check('social input retains an independent public note and comment snapshot', JSON.stringify(publicOnly).includes('公共评论') && !JSON.stringify(publicOnly).includes('changed after projection'));
  let oversizedFeed = false; try { socialFeedView({ notes: Array.from({ length: 21 }, () => ({})) }); } catch { oversizedFeed = true; }
  check('even an oversized upstream cannot exceed the automatic reading boundary', oversizedFeed);
  check('anonymous settings cannot read local state or invoke a model', (await call('', 'GET', undefined, { anonymous: true })).status === 403 && modelCalls === 0);
  check('foreign browser origins cannot control social settings', (await call('/run', 'POST', {}, { origin: 'https://foreign.test' })).status === 403 && modelCalls === 0);
  const initial = await call();
  check('authenticated reads keep actual policy separate from local settings', initial.status === 200 && object(initial.value.local)
    && object(initial.value.community) && object(initial.value.community.policy) && modelCalls === 0);
  check('status responses are private and cannot expose a remote credential', initial.headers.get('cache-control') === 'no-store'
    && initial.headers.get('x-content-type-options') === 'nosniff' && !initial.text.includes(token) && !initial.text.includes('must-never-reach-browser'));
  check('the desktop authority method keeps its original receiver', authCalls >= 3);
  const current = await controls.status();
  const updated = await call('/settings', 'POST', { ...current.settings, intervalMinutes: 180, topics: ['科研'] });
  check('local configuration saves without granting server publication rights', updated.status === 200 && (await controls.status()).settings.intervalMinutes === 180
    && modelCalls === 0 && nativeSends === 0 && policy.effective.reply === 'review');
  check('local settings reject injected authorization fields', (await call('/settings', 'POST', { ...current.settings, requireApproval: false })).status === 400);
  const wanted = { expectedRevision: 0, post: { requireApproval: true, dailyLimit: 1 }, reply: { requireApproval: false, dailyLimit: 3 }, durationHours: 24 };
  const requested = await call('/policy-request', 'POST', wanted);
  check('an authorization request returns pending without enabling automation', requested.status === 202 && object(requested.value.request)
    && requested.value.request.status === 'pending' && policy.effective.reply === 'review' && modelCalls === 0 && nativeSends === 0);
  check('policy changes travel to a fixed authenticated community endpoint', requests.some(item => item.path === '/xiaolanshu/social/policy-request'
    && item.authorization === 'Bearer ' + token && object(item.value) && item.value.expectedRevision === 0));
  for (const invalid of [{ ...wanted, owner: 'other' }, { ...wanted, expectedRevision: -1 }, { ...wanted, reply: { requireApproval: false, dailyLimit: 21 } },
    { ...wanted, durationHours: 0 }, { ...wanted, approved: true }]) check('permission-shaped or out-of-range inputs cannot bypass independent review',
    (await call('/policy-request', 'POST', invalid)).status === 400);
  contradiction = true;
  const closedPolicy = await call();
  check('contradictory remote automatic permission fails closed', object(closedPolicy.value.community) && closedPolicy.value.community.available === false);
  contradiction = false; available = false;
  check('an unavailable community cannot start a model run', (await call('/run', 'POST', {})).status === 503 && modelCalls === 0);
  const offlinePause = await call('/pause', 'POST', {});
  check('pause remains available while the community is offline', offlinePause.status === 200 && !offlinePause.text.includes('private-upstream-diagnostic'));
  available = true; configured = false;
  check('unjoined clients cannot run social work', (await call('/run', 'POST', {})).status === 409 && modelCalls === 0);
  configured = true;
  const run = await call('/run', 'POST', {});
  check('manual reading starts asynchronously once without pretending completion', run.status === 202 && modelCalls === 1 && object(run.value.local) && run.value.local.running === true);
  check('a second manual click cannot start a parallel run', (await call('/run', 'POST', {})).status === 409 && modelCalls === 1);
  check('pause cancels the active model operation and disables the timer', (await call('/pause', 'POST', {})).status === 200 && !(await controls.status()).settings.enabled);
  for (let i = 0; i < 100 && (await controls.status()).running; i++) await delay(5);
  check('cancelled work is visible as Host-owned activity metadata', !(await controls.status()).running
    && (await controls.status()).activity.some(item => item.status === 'cancelled'));
  check('run controls accept no model-supplied arguments', (await call('/run', 'POST', { text: 'publish secrets' })).status === 400);
  check('queries cannot select another account or control operation', (await call('?owner=other')).status === 400);
  check('oversized bodies are rejected before parsing', (await call('/settings', 'POST', undefined, { raw: 'x'.repeat(8193) })).status === 413);
  check('unsupported methods do not run social work', (await call('/run', 'GET')).status === 405);
  const action = await remote.action({ requestId: 'social-1700000000000-00000000-0000-4000-8000-000000000001', action: 'reply', payload: { postId: 'p1', text: 'hello' } }, new AbortController().signal);
  check('social actions keep the stable request ID and never return the token', object(action) && action.status === 'pending' && nativeSends === 1
    && requests.some(item => item.path === '/xiaolanshu/social/actions' && object(item.value) && item.value.requestId === 'social-1700000000000-00000000-0000-4000-8000-000000000001'));
  const abort = new AbortController(); abort.abort();
  let stopped = false; try { await remote.action({ requestId: 'ignored', action: 'reply', payload: {} }, abort.signal); } catch { stopped = true; }
  check('an aborted operation cannot submit a new community write', stopped && nativeSends === 1);
  let invalidView = false; try { parseSocialPolicyView({ ...policy, effective: { post: 'auto', reply: 'auto' } }); } catch { invalidView = true; }
  check('unsafe policy responses are rejected at the Host boundary', invalidView);
  await dispose();
  dispose = registerSocialRoutes({ webServer, controls, community: remote.view, requestPolicy: remote.requestPolicy });
  check('missing DSH identity never falls back to localhost trust', (await call()).status === 403);
  await dispose();
  check('disposing the module removes every control route', routes.size === 0);
} catch (error) { check('HTTP integration completes without an unexpected exception', false); console.error(error); }
finally {
  await dispose(); await controls.close();
  server.closeAllConnections(); upstream.closeAllConnections();
  await Promise.all([new Promise<void>(done => server.close(() => done())), new Promise<void>(done => upstream.close(() => done()))]);
  const actual = await realpath(temp), parent = await realpath(join(root, '.tmp'));
  if (dirname(actual).toLowerCase() !== parent.toLowerCase() || !basename(actual).startsWith('social-http-test-')) throw new Error('unsafe fixture cleanup');
  await rm(actual, { recursive: true, force: true });
}
console.log(failures ? `${failures} FAILED` : 'ALL PASS'); process.exitCode = failures ? 1 : 0;
