/** Real loopback HTTP plus a fake native sender: never opens WeChat or a model. */
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import type { Server, IncomingMessage, ServerResponse } from 'node:http';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { companionWechatRequestId, companionWechatScope } from './companion-types.mjs';
import type { CompanionApi, CompanionJob, CompanionWechatTarget } from './companion-types.mjs';
import { registerCompanionRoutes } from './companion-http.mjs';
import { createCompanionService } from './companion-service.mjs';
import { field } from './redact.js';
import type { WebRoute } from './host-types.mjs';
import { createWechatRelay, loadReviewedWechatUpstream, normalizeWechatRelayEvent, readWechatRelayConfig,
  relayHostOrigin, relayHttpFetch, REVIEWED_WECHAT_FILES, runWechatRelayCli, wechatRelayError } from './wechat-relay.mjs';
import type { WechatRelayOptions, WechatRelayUpstream, WechatSendRequest } from './wechat-relay.mjs';

const TOKEN = 'synthetic_bridge_token_' + '1'.repeat(40);
let total = 0, failed = 0;
function check(name: string, valid: unknown) { total++; console.log((valid ? 'ok   ' : 'FAIL ') + name); if (!valid) failed++; }
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function event(messageId: string | number = '1', patch: Record<string, unknown> = {}): Record<string, unknown> {
  return { post_type: 'message', message_type: 'private', self_id: 1, user_id: 2, message_id: messageId,
    message: [{ type: 'text', data: { text: 'Synthetic question' } }], ...patch };
}
class FakeUpstream implements WechatRelayUpstream {
  account = 'synthetic-account'; selfId = 1; permits = true; stopCalls = 0; checks = 0;
  actions: WechatSendRequest[] = []; mode: 'ok' | 'uncertain' | 'hang' | 'bad-echo' | 'bare-ret' = 'ok';
  reload() {}
  allowed() { return this.permits; }
  async checkNative(): Promise<unknown> { this.checks++; return { account: this.account, selfId: this.selfId }; }
  async action(request: WechatSendRequest): Promise<unknown> {
    this.actions.push(structuredClone(request));
    if (this.mode === 'hang') return new Promise<never>(() => {});
    if (this.mode === 'uncertain') return { status: 'failed', retcode: 1407, echo: request.echo, data: { attempted: true } };
    if (this.mode === 'bad-echo') return { status: 'ok', retcode: 0, echo: 'unrelated', data: { receipt: 'wechat-server-id', delivered: 'database-confirmed' } };
    if (this.mode === 'bare-ret') return { status: 'ok', retcode: 0, echo: request.echo, data: { accepted: true } };
    return { status: 'ok', retcode: 0, echo: request.echo, data: { receipt: 'wechat-server-id', delivered: 'database-confirmed' } };
  }
  async stop() { this.stopCalls++; }
}
type HostMode = 'normal' | 'wrong-target' | 'wrong-request' | 'wrong-input' | 'wrong-job' | 'cq' | 'empty'
  | 'failed' | 'forever' | 'redirect' | 'oversize' | 'no-target';
class SyntheticHost {
  server: Server; origin = ''; mode: HostMode = 'normal'; calls: { route: string; body: Record<string, unknown> }[] = [];
  jobs = new Map<string, { target: CompanionWechatTarget; job: CompanionJob }>();
  onMessage: (() => void) | undefined;
  constructor() { this.server = createServer((req, res) => { void this.handle(req, res).catch(() => { res.destroy(); }); }); }
  async start() { await new Promise<void>(done => this.server.listen(0, '127.0.0.1', done));
    const address = this.server.address(); if (!address || typeof address === 'string') throw Error('Synthetic listener unavailable');
    this.origin = 'http://127.0.0.1:' + address.port; }
  async close() { this.server.closeAllConnections(); await new Promise<void>(done => this.server.close(() => done())); }
  async handle(req: IncomingMessage, res: ServerResponse) {
    if (req.method !== 'POST' || req.headers.authorization !== 'Bearer ' + TOKEN || req.headers.origin || req.headers.cookie) { res.writeHead(403); res.end(); return; }
    const chunks: Buffer[] = []; let size = 0;
    for await (const item of req) { const chunk: unknown = item;
      if (!Buffer.isBuffer(chunk)) throw Error('Synthetic request body invalid'); size += chunk.length;
      if (size > 16384) throw Error('Synthetic request too large'); chunks.push(chunk); }
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString()); if (!record(body)) throw Error('Synthetic request invalid');
    const route = req.url?.split('/').at(-1) ?? ''; this.calls.push({ route, body });
    if (this.mode === 'redirect') { res.writeHead(302, { location: this.origin + '/redirect-target' }); res.end(); return; }
    res.setHeader('content-type', 'application/json');
    if (this.mode === 'oversize') { res.end(JSON.stringify({ ok: true, padding: 'a'.repeat(66000) })); return; }
    let target: CompanionWechatTarget, job: CompanionJob;
    if (route === 'messages') {
      if (typeof body.selfId !== 'string' || (body.peerType !== 'group' && body.peerType !== 'private')
          || typeof body.peerId !== 'string' || typeof body.senderId !== 'string' || typeof body.messageId !== 'string' || typeof body.text !== 'string') throw Error('Synthetic event invalid');
      target = { selfId: body.selfId, peerType: body.peerType, peerId: body.peerId, senderId: body.senderId };
      job = { id: 'job-' + this.jobs.size, requestId: companionWechatRequestId(target, body.messageId),
        state: 'generating', input: body.text, createdAt: '2026-01-01T00:00:00.000Z' };
      this.jobs.set(job.id, { target, job }); this.onMessage?.(); res.statusCode = 202;
    } else {
      const found = typeof body.jobId === 'string' ? this.jobs.get(body.jobId) : undefined;
      if (!found) throw Error('Synthetic job missing'); target = found.target;
      job = { ...found.job, state: this.mode === 'forever' ? 'generating' : this.mode === 'failed' ? 'failed' : 'completed',
        reply: this.mode === 'cq' ? '[CQ:at,qq=999] injected' : this.mode === 'empty' ? '' : 'Synthetic reply' };
    }
    if (this.mode === 'wrong-target') target = { ...target, peerId: '999' };
    if (this.mode === 'wrong-request') job = { ...job, requestId: 'wx-unrelated' };
    if (this.mode === 'wrong-input') job = { ...job, input: 'another question' };
    if (this.mode === 'wrong-job' && route === 'status') job = { ...job, id: 'another-job' };
    res.end(JSON.stringify({ ok: true, ready: true, model: null, messages: [], job, ...(this.mode === 'no-target' ? {} : { target }) }));
  }
}
function options(upstream: FakeUpstream, host: SyntheticHost, extra: Partial<WechatRelayOptions> = {}): WechatRelayOptions {
  return { upstream, hostBaseUrl: host.origin, hostToken: TOKEN, accounts: ['1'], peers: ['private:1:2','private:1:3','group:1:9'],
    pollMs: 1, requestTimeoutMs: 500, sendTimeoutMs: 100, jobTimeoutMs: 1000, ...extra };
}
async function withRelay(run: (relay: ReturnType<typeof createWechatRelay>, upstream: FakeUpstream, host: SyntheticHost) => Promise<void>,
  mode: HostMode = 'normal', extra: Partial<WechatRelayOptions> = {}) {
  const host = new SyntheticHost(); host.mode = mode; await host.start(); const upstream = new FakeUpstream();
  const relay = createWechatRelay(options(upstream, host, extra));
  try { await run(relay, upstream, host); } finally { await relay.stop(); await host.close(); }
}
async function rejects(work: () => unknown | Promise<unknown>, expected: string) {
  try { await work(); return false; } catch (error) { return wechatRelayError(error) === expected; }
}

check('normalizes text into a frozen event with stable opaque message ID', (() => {
  const normalized = normalizeWechatRelayEvent(event()); return normalized?.text === 'Synthetic question'
    && normalized.messageId.startsWith('ob-') && Object.isFrozen(normalized)
    && normalized.messageId === normalizeWechatRelayEvent(event(1))?.messageId;
})());
for (const [name, patch] of Object.entries({
  'self echo': { user_id: 1 }, 'own outgoing flag': { isSend: true }, 'self subtype': { sub_type: 'self' },
  'invalid numeric message ID': { message_id: NaN }, 'unknown event': { post_type: 'notice' }, 'unknown peer type': { message_type: 'channel' },
  'missing message ID': { message_id: '' }, 'invalid self': { self_id: '1:2' }, 'nontext segment': { message: [{ type: 'image', data: { file: 'private' } }] },
  'CQ markup': { message: [{ type: 'text', data: { text: '[CQ:at,qq=2]' } }] },
  'empty content': { message: [{ type: 'text', data: { text: ' ' } }] },
  'unaddressed group': { message_type: 'group', group_id: 9 },
  'wrong group mention': { message_type: 'group', group_id: 9, message: [{ type: 'at', data: { qq: 99 } }, { type: 'text', data: { text: 'hello' } }] },
})) check('rejects ' + name, normalizeWechatRelayEvent(event('attack', patch)) === undefined);
for (const url of ['https://example.com','http://example.com','http://127.0.0.1@evil.example','http://127.0.0.1/?token=x',
  'http://127.0.0.1/#fragment','http://127.0.0.1/path','http://[::ffff:192.0.2.1]']) {
  check('rejects nonlocal or credential-bearing host ' + url, await rejects(() => relayHostOrigin(url), 'relay_invalid_config'));
}
check('supports explicit IPv4 and IPv6 loopback origins', relayHostOrigin('http://127.0.0.1:1234') === 'http://127.0.0.1:1234'
  && relayHostOrigin('http://[::1]:1234') === 'http://[::1]:1234');
await withRelay(async (relay, upstream, host) => {
  check('creation is inert and rejects events until explicit start', !relay.accept(event()) && !host.calls.length && !upstream.checks);
  await relay.start(); check('verified start admits one incoming message', relay.accept(event()));
  check('deduplicates an in-flight incoming message', !relay.accept(event()));
  await relay.settle(); check('runs real messages POST then job status POST', host.calls.map(call => call.route).join(',') === 'messages,status');
  const message = host.calls[0]?.body, status = host.calls[1]?.body, sent = upstream.actions[0];
  check('polling keeps sender and original peer fixed', message?.senderId === '2' && status?.senderId === '2' && status.peerId === '2' && status.selfId === '1');
  check('sends the completed reply to the original target exactly once', upstream.actions.length === 1 && sent?.action === 'send_private_msg'
    && sent.params.user_id === '2' && sent.params.group_id === undefined && sent.params.message[0]?.data.text === 'Synthetic reply');
  check('delivery ID is stable and tied to the native receipt echo', !!sent && /^[a-f0-9]{64}$/.test(sent.echo) && sent.echo === sent.params.wechatagent_delivery_id);
  check('deduplicates an already completed message', !relay.accept(event()));
  check('reports database-confirmed completion without storing plaintext in status', relay.snapshot().completed === 1 && !JSON.stringify(relay.snapshot()).includes('Synthetic reply'));
});
await withRelay(async (relay, upstream, host) => {
  await relay.start(); relay.accept(event('first')); relay.accept(event('second')); await relay.settle();
  check('serializes messages within one chat', host.calls.map(call => call.route).join(',') === 'messages,status,messages,status' && upstream.actions.length === 2);
});
await withRelay(async (relay, upstream, host) => {
  await relay.start(); relay.accept(event('restart')); await relay.settle(); await relay.stop();
  const restarted = createWechatRelay(options(upstream, host));
  try { await restarted.start(); restarted.accept(event('restart')); await restarted.settle();
    check('native delivery identity survives relay restart and Host job regeneration', host.jobs.size === 2
      && upstream.actions.length === 2 && upstream.actions[0]?.echo === upstream.actions[1]?.echo);
  } finally { await restarted.stop(); }
});
await withRelay(async (relay, upstream, host) => {
  await relay.start();
  check('rejects a peer absent from the explicit relay whitelist', !relay.accept(event('unknown', { user_id: 88 })));
  check('rejects an account absent from the explicit relay whitelist', !relay.accept(event('unknown-account', { self_id: 8 })));
  check('rejected targets never reach Host or upstream send', !host.calls.length && !upstream.actions.length);
});
await withRelay(async (relay, upstream) => {
  await relay.start(); const group = event('group', { message_type: 'group', group_id: 9,
    message: [{ type: 'at', data: { qq: '1' } }, { type: 'text', data: { text: 'Synthetic group question' } }] });
  check('admits explicitly addressed, whitelisted group text', relay.accept(group)); await relay.settle();
  check('group reply stays in the original group, never a private fallback', upstream.actions[0]?.action === 'send_group_msg'
    && upstream.actions[0].params.group_id === '9' && upstream.actions[0].params.user_id === undefined);
});
for (const mode of ['wrong-target','wrong-request','wrong-input','wrong-job','cq','empty','failed','redirect','oversize'] as const) {
  await withRelay(async (relay, upstream, host) => {
    await relay.start(); relay.accept(event()); await relay.settle();
    check('fails closed without sending on Host ' + mode, !upstream.actions.length && relay.snapshot().failed === 1);
    if (mode === 'redirect') check('never follows a redirect with the bridge credential', host.calls.length === 1);
  }, mode);
}
await withRelay(async (relay, upstream) => { await relay.start(); relay.accept(event()); await relay.settle();
  check('supports Host response without optional target by strict job/request binding', upstream.actions.length === 1); }, 'no-target');
for (const change of ['whitelist','account','self'] as const) {
  await withRelay(async (relay, upstream, host) => {
    host.onMessage = () => { if (change === 'whitelist') upstream.permits = false;
      else if (change === 'account') upstream.account = 'different-synthetic-account'; else upstream.selfId = 4; };
    await relay.start(); relay.accept(event()); await relay.settle();
    check('rechecks native identity and whitelist before sending after ' + change + ' change', !upstream.actions.length && relay.snapshot().failed === 1);
  });
}
await withRelay(async (relay, upstream) => { upstream.permits = false; await relay.start(); relay.accept(event()); await relay.settle();
  check('upstream denial prevents even creating a model job', !upstream.actions.length && relay.snapshot().lastError === 'relay_peer_denied'); });
for (const mode of ['uncertain','hang','bad-echo','bare-ret'] as const) {
  await withRelay(async (relay, upstream) => { upstream.mode = mode; await relay.start(); relay.accept(event()); await relay.settle();
    check('never retries an uncertain or timed-out send: ' + mode, upstream.actions.length === 1 && relay.snapshot().completed === 0 && relay.snapshot().failed === 1);
    check('deduplication prevents replay after native uncertainty: ' + mode, !relay.accept(event())); }, 'normal', { sendTimeoutMs: 20 });
}
await withRelay(async (relay, upstream, host) => {
  await relay.start(); relay.accept(event()); await relay.settle();
  check('job polling stops at a bounded deadline', !upstream.actions.length && host.calls.length < 50 && relay.snapshot().lastError === 'relay_timeout');
}, 'forever', { jobTimeoutMs: 20, pollMs: 5 });
await withRelay(async (relay, upstream, host) => {
  await relay.start(); relay.accept(event());
  for (let i = 0; i < 100 && !host.calls.length; i++) await delay(1);
  await relay.stop(); await relay.stop(); await relay.settle();
  check('stop aborts pending work and stops upstream exactly once', !upstream.actions.length && upstream.stopCalls === 1 && relay.snapshot().pending === 0);
  check('a stopped relay never admits a new message', !relay.accept(event('later')));
}, 'forever');
await withRelay(async (relay) => { await relay.start(); check('queue is bounded including active work', relay.accept(event('one')) && !relay.accept(event('two'))); },
  'forever', { maxQueue: 1, jobTimeoutMs: 20 });
await withRelay(async (relay) => { await relay.start(); relay.accept(event('one')); await relay.settle(); relay.accept(event('two')); await relay.settle();
  check('bounded deduplication retains recent completed messages', !relay.accept(event('two'))); }, 'normal', { maxQueue: 1, maxSeen: 1 });

// Cross the actual Host HTTP boundary, including its browser-header fence.
{
  const routes = new Map<string, WebRoute>(), jobs = new Map<string, CompanionJob>();
  const scopes: string[] = [], receivedHeaders: string[][] = [];
  const chat: CompanionApi = {
    async send(scope, input) { scopes.push(scope); const job: CompanionJob = { id: 'real-http-job', requestId: input.requestId,
      input: input.text, state: 'generating', createdAt: '2026-01-01T00:00:00.000Z' }; jobs.set(job.id, job); return job; },
    async view(scope, id) { scopes.push(scope); const prior = jobs.get(id ?? '');
      if (!prior) throw Error('Synthetic job missing');
      return { ok: true, ready: true, model: null, messages: [], job: { ...prior, state: 'completed', reply: 'Actual HTTP module reply' } }; },
    async cancel() { throw Error('Synthetic cancellation unused'); }, async clear() {},
  };
  const dispose = registerCompanionRoutes({ webServer: { register(route) { routes.set(route.path, route); return () => { routes.delete(route.path); }; } }, chat,
    bridgeAccess: async () => ({ tokenHash: createHash('sha256').update(TOKEN).digest('hex'), accounts: ['1'], peers: ['private:1:2'] }) });
  const server = createServer((req, res) => {
    receivedHeaders.push(Object.keys(req.headers)); const route = routes.get(req.url ?? '');
    if (!route) { res.writeHead(404); res.end(); return; }
    void Promise.resolve(route.handler(req, res)).catch(() => { res.destroy(); });
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address(); if (!address || typeof address === 'string') throw Error('Synthetic bridge unavailable');
  const upstream = new FakeUpstream();
  const relay = createWechatRelay({ upstream, hostBaseUrl: 'http://127.0.0.1:' + address.port, hostToken: TOKEN,
    accounts: ['1'], peers: ['private:1:2'], pollMs: 1 });
  try {
    await relay.start(); relay.accept(event('real-http')); await relay.settle();
    check('relay crosses the actual authenticated Host HTTP module end to end', relay.snapshot().completed === 1
      && upstream.actions[0]?.params.message[0]?.data.text === 'Actual HTTP module reply');
    check('machine transport sends no browser metadata headers', receivedHeaders.length === 2
      && receivedHeaders.every(headers => !headers.some(key => key.startsWith('sec-fetch-') || ['cookie','origin','referer'].includes(key))));
    check('actual routes bind send and status to the same account and chat scope', scopes.length === 2 && scopes[0] === scopes[1] && scopes[0]?.startsWith('wechat:'));
  } finally { await relay.stop(); await dispose(); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
}

const temporaryRoot = await realpath(tmpdir());
const temporary = await mkdtemp(join(temporaryRoot, 'podwhale-wechat-relay-'));
try {
  // Exercise the real normalization boundary, not a mock that echoes raw input.
  const privateFile = join(temporary, 'synthetic-companion-transcript.json');
  const engineInputs: string[] = [];
  const syntheticSecrets = ['fixture@example.test', '192.0.2.123', 'C:\\synthetic\\private-note.txt'];
  const rawText = '请查看 ' + syntheticSecrets.join('，') + '。';
  const chat = createCompanionService({ file: privateFile, engine: {
    ready: () => true, model: () => ({ provider: 'synthetic', model: 'never-a-real-model' }),
    async reply(_history, input, options) {
      engineInputs.push(input); options.generating(); await delay(1);
      return 'Synthetic response: ' + input + ' / ' + syntheticSecrets.join('，');
    },
  } });
  const actualRoutes = new Map<string, WebRoute>();
  const disposeActual = registerCompanionRoutes({ webServer: { register(route) {
    actualRoutes.set(route.path, route); return () => { actualRoutes.delete(route.path); };
  } }, chat, bridgeAccess: async () => ({ tokenHash: createHash('sha256').update(TOKEN).digest('hex'), accounts: ['1'], peers: ['private:1:2'] }) });
  const actualServer = createServer((req, res) => {
    const route = actualRoutes.get(req.url ?? '');
    if (!route) { res.writeHead(404); res.end(); return; }
    void Promise.resolve(route.handler(req, res)).catch(() => { res.destroy(); });
  });
  await new Promise<void>(done => actualServer.listen(0, '127.0.0.1', done));
  const address = actualServer.address(); if (!address || typeof address === 'string') throw Error('Synthetic service listener unavailable');
  const actualOrigin = 'http://127.0.0.1:' + address.port;
  const upstream = new FakeUpstream();
  const relay = createWechatRelay({ upstream, hostBaseUrl: actualOrigin, hostToken: TOKEN, accounts: ['1'], peers: ['private:1:2'], pollMs: 1 });
  try {
    await relay.start();
    const incoming = event('sensitive-real-service', { message: [{ type: 'text', data: { text: rawText } }] });
    const normalized = normalizeWechatRelayEvent(incoming);
    if (!normalized) throw Error('Synthetic normalized event unavailable');
    check('normalization retains original text, sender and peer before the Host privacy boundary', normalized.text === rawText
      && normalized.selfId === '1' && normalized.peerId === '2' && normalized.senderId === '2');
    check('relay admits synthetic sensitive text for the real service', relay.accept(incoming));
    await relay.settle();
    const scope = companionWechatScope(normalized), view = await chat.view(scope);
    check('real HTTP and service redaction still produce one completed relay delivery', relay.snapshot().completed === 1
      && relay.snapshot().failed === 0 && upstream.actions.length === 1 && engineInputs.length === 1);
    check('the fake engine receives exactly the service-normalized input', engineInputs[0] === field(rawText, 4000).text
      && syntheticSecrets.every(value => !engineInputs[0]?.includes(value)));
    check('redaction never changes the job request ID or original send target', view.job?.requestId === companionWechatRequestId(normalized, normalized.messageId)
      && view.job.input === field(rawText, 4000).text && upstream.actions[0]?.params.user_id === '2'
      && upstream.actions[0]?.params.group_id === undefined);
    const sentText = upstream.actions[0]?.params.message[0]?.data.text;
    check('real service strips synthetic private values from the outgoing reply', typeof sentText === 'string'
      && syntheticSecrets.every(value => !sentText.includes(value)) && sentText.includes('[邮箱]') && sentText.includes('[IP]') && sentText.includes('[路径]'));
    const stored = await readFile(privateFile, 'utf8');
    check('the real synthetic transcript contains no original private message values', syntheticSecrets.every(value => !stored.includes(value)));
    const oversizedText = 'x'.repeat(4001);
    check('relay rejects over-4000 input before queuing or creating model work', !relay.accept(event('too-long', {
      message: [{ type: 'text', data: { text: oversizedText } }],
    })) && relay.snapshot().pending === 0 && engineInputs.length === 1);
    const rejected = await relayHttpFetch(actualOrigin + '/xiaolanshu/api/companion/wechat/messages', {
      method: 'POST', headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify({ ...normalized, messageId: 'oversized-direct-event', text: oversizedText }),
    });
    const failure: unknown = await rejected.json();
    check('real HTTP service also rejects over-4000 input without scheduling the engine', rejected.status === 400
      && record(failure) && failure.code === 'companion_invalid_input' && engineInputs.length === 1
      && (await chat.view(scope)).job?.id === view.job?.id);
  } finally {
    await relay.stop(); await chat.close(); await disposeActual(); actualServer.closeAllConnections();
    await new Promise<void>(done => actualServer.close(() => done()));
  }
  const file = join(temporary, 'private-relay.json');
  const config = { enabled: true, wechatRoot: temporary, hostBaseUrl: 'http://127.0.0.1:1234', hostToken: TOKEN, accounts: ['1'], peers: ['private:1:2'] };
  await writeFile(file, JSON.stringify(config), { mode: 0o600 });
  check('loads only an explicit private config without scanning installed apps', (await readWechatRelayConfig(file)).hostToken === TOKEN);
  for (const patch of [{ enabled: false }, { accounts: [] }, { peers: ['private:other:2'] }, { hostBaseUrl: 'http://example.com' }, { unknown: true }]) {
    await writeFile(file, JSON.stringify({ ...config, ...patch }), { mode: 0o600 });
    check('invalid explicit configuration fails closed', await rejects(() => readWechatRelayConfig(file), 'relay_invalid_config'));
  }
  await mkdir(join(temporary, 'scripts'));
  await writeFile(join(temporary, 'scripts', 'hook-onebot.mjs'), 'throw Error("unreviewed code must never execute");');
  check('unreviewed upstream is rejected before importing or executing code', await rejects(() => loadReviewedWechatUpstream(temporary, new AbortController().signal), 'relay_upstream_unreviewed'));
  check('reviewed upstream hashes include entry and transitive account/send helpers', Object.keys(REVIEWED_WECHAT_FILES).length === 11
    && REVIEWED_WECHAT_FILES['scripts/hook-onebot.mjs'] === 'dd1a3932cdcf2a6ab49e144b5e07a89e13217cb4038df2b02aabce122c7a8d7a'
    && !!REVIEWED_WECHAT_FILES['scripts/wechat-account-check.mjs']);
  check('upstream rejection reveals no private path', !wechatRelayError(Error(temporary + TOKEN)).includes(temporary));
  const before = await readFile(join(temporary, 'scripts', 'hook-onebot.mjs'), 'utf8');
  await runWechatRelayCli([]);
  check('default CLI stays disabled and leaves upstream files unchanged', before === await readFile(join(temporary, 'scripts', 'hook-onebot.mjs'), 'utf8'));
  check('CLI requires an explicit absolute configuration path', await rejects(() => runWechatRelayCli(['--config','relative.json']), 'relay_invalid_arguments'));
} finally {
  const actual = await realpath(temporary);
  if (dirname(actual).toLowerCase() !== temporaryRoot.toLowerCase() || !basename(actual).startsWith('podwhale-wechat-relay-')) throw Error('Unsafe synthetic fixture cleanup');
  await rm(actual, { recursive: true, force: true });
}
console.log(`WeChat relay: ${total - failed}/${total} passed; synthetic HTTP only, no WeChat/model calls.`);
process.exitCode = failed ? 1 : 0;
