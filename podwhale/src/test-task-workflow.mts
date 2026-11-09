/** A real Host-to-community task workflow with three isolated fixture owners. */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { humanSession } from './server/test-human-session.mjs';
import type { CompanionConnection } from './companion-types.mjs';
import type { Dispose, EffectContext, HostContext, PatrolRuntimeContext, RegisteredTool,
  ScheduleService, WebRoute, WebServer } from './host-types.mjs';

interface Reply { status: number; body: Record<string, unknown>; raw: string; connection: string | null }
interface Account { id: string; agent: string; human: string }
interface Proposal { id: string; digest: string; action: string; ownerId: string; payload: Record<string, unknown> }
type RuntimeInjection = [names: ['agents', 'agentPresets', 'agentDefaultModel'],
  activate: (context: PatrolRuntimeContext) => void | Promise<void>];
type ScheduleInjection = [names: ['schedule'],
  activate: (context: EffectContext & { schedule: ScheduleService }) => void | Promise<void>];
type ToolsInjection = [names: ['tools'],
  activate: (context: { tools: { register(tool: RegisteredTool): Dispose } }) => void];
type WebInjection = [names: ['webServer'], activate: (context: { webServer: WebServer }) => void];
type ConnectionInjection = [names: ['webServer', 'connection'],
  activate: (context: EffectContext & { webServer: WebServer; connection: CompanionConnection }) => void | Promise<void>];
type CompanionInjection = [names: ['webServer', 'connection', 'agents', 'agentPresets', 'agentDefaultModel'],
  activate: (context: PatrolRuntimeContext & { webServer: WebServer; connection: CompanionConnection }) => void | Promise<void>];
type Injection = RuntimeInjection | ScheduleInjection | ToolsInjection | WebInjection | ConnectionInjection | CompanionInjection;
const isTools = (value: Injection): value is ToolsInjection => value[0][0] === 'tools';
const isWeb = (value: Injection): value is WebInjection => value[0][0] === 'webServer' && value[0].length === 1;
const isConnection = (value: Injection): value is ConnectionInjection => value[0][0] === 'webServer' && value[0].length === 2;

const HERE = fileURLToPath(new URL('.', import.meta.url));
const previousHome = process.env.DSH_HOME;
const fixture = await mkdtemp(join(tmpdir(), 'xlb-task-workflow-'));
const data = join(fixture, 'community');
const home = join(fixture, 'desktop');
const remoteFile = join(home, 'xiaolanshu', 'remote.json');
const cookie = 'task_fixture=synthetic-desktop';
const claimNote = 'TASK_PRIVATE_CLAIM_NOTE_SENTINEL';
const deliveryText = 'TASK_PRIVATE_DELIVERY_SENTINEL';
const title = '三个合成账号的独立审批任务';
const failures: string[] = [];
const cleanups: Dispose[] = [];
const carriers: Server[] = [];
let checks = 0;
let child: ChildProcess | undefined;
let community = '';
let origin = '';
let currentAgent = '';
let authorityCalls = 0;
let connectionActivations = 0;
let hostSerial = 0;

function check(name: string, ok: unknown, status?: number) {
  checks += 1;
  if (!ok) failures.push(name);
  console.log((ok ? 'ok  ' : 'FAIL') + ' ' + name + (status === undefined ? '' : ' [HTTP ' + status + ']'));
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid fixture response object');
  return value as Record<string, unknown>;
}
function records(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error('Invalid fixture response list');
  const entries: unknown[] = value;
  return entries.map(record);
}
function string(value: unknown): string {
  if (typeof value !== 'string' || !value) throw new Error('Missing fixture response identity');
  return value;
}
function claimOf(reply: Reply): Record<string, unknown> | null {
  return reply.body.claim === null ? null : record(reply.body.claim);
}
async function pending(reply: Reply, action: string, account: Account): Promise<Proposal> {
  check(action + ' Host request returns a nonexecuted pending 202', reply.status === 202
    && reply.body.status === 'pending' && reply.body.executed === false && reply.body.action === action, reply.status);
  const receiptId = string(reply.body.proposalId);
  check(action + ' Host receipt contains no approval digest or private proposal body', !Object.hasOwn(reply.body, 'digest')
    && !Object.hasOwn(reply.body, 'proposal') && !Object.hasOwn(reply.body, 'payload'));
  // This is an independent human read in the parent test process. The Host
  // receives only its restricted agent token and the minimal pending receipt.
  const proposals = records((await remote('/proposals', account.human)).body.items);
  const proposal = proposals.find(value => value.id === receiptId);
  if (!proposal) throw new Error('Pending receipt missing from independent approval list');
  const id = string(proposal.id), digest = string(proposal.digest);
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('Missing immutable proposal digest');
  check(action + ' pending receipt binds its immutable proposal', receiptId === id
    && proposal.status === 'pending' && proposal.action === action);
  return { id, digest, action, ownerId: string(proposal.ownerId), payload: record(proposal.payload) };
}
async function request(url: string, options: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<Reply> {
  const response = await fetch(url, {
    method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
    headers: { accept: 'application/json', ...(options.body === undefined ? {} : { 'content-type': 'application/json' }), ...options.headers },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    redirect: 'error', signal: AbortSignal.timeout(8000),
  });
  const raw = await response.text();
  const value: unknown = JSON.parse(raw);
  return { status: response.status, body: record(value), raw, connection: response.headers.get('connection') };
}
function remote(path: string, token?: string, body?: unknown) {
  return request(community + path, { ...(body === undefined ? {} : { body }),
    headers: token ? { authorization: 'Bearer ' + token } : {} });
}
async function desktop(account: Account, path: string, body?: unknown,
  options: { anonymous?: boolean; foreign?: boolean; method?: string; contentType?: string } = {}) {
  // One synthetic desktop changes accounts sequentially. No human credential
  // ever enters its configuration, tool arguments, or HTTP carrier.
  if (currentAgent !== account.agent) {
    await writeFile(remoteFile, JSON.stringify({ url: community, token: account.agent }));
    currentAgent = account.agent;
  }
  return request(origin + '/xiaolanshu/api' + path, {
    ...(body === undefined ? {} : { body }), ...(options.method ? { method: options.method } : {}),
    headers: { ...(options.anonymous ? {} : { cookie }), origin: options.foreign ? 'https://foreign.invalid' : origin,
      ...(options.contentType ? { 'content-type': options.contentType } : {}) },
  });
}
function decide(account: Account, proposal: Proposal) {
  return remote('/proposals/approve', account.human, { id: proposal.id, digest: proposal.digest });
}
async function enroll(name: string, handle: string): Promise<Account> {
  const response = await remote('/enroll', undefined, { name, handle });
  if (response.status !== 201) throw new Error('Cannot enroll fixture owner');
  const id = string(record(response.body.owner).id), agent = string(response.body.token);
  check('public enrollment grants only the agent role: ' + handle, record(response.body.credential).role === 'agent');
  return { id, agent, human: await humanSession(data, id, community) };
}
async function startCommunity() {
  await mkdir(data, { recursive: true });
  let output = '', spawnFailed = false;
  child = spawn(process.execPath, [join(HERE, 'server', 'community.mjs')], {
    cwd: HERE, stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, XLB_HOST: '127.0.0.1', XLB_PORT: '0', XLB_DATA: data,
      XLB_DB: join(data, 'feed.db'), XLB_BACKUP_DIR: join(fixture, 'backups'),
      XLB_INVITE: '', XLB_WECHAT_TOKEN: '', XLB_WECHAT_APPID: '', XLB_WECHAT_SECRET: '',
      XLB_ENROLL_PER_HOUR: '10', XLB_WRITE_LIMIT: '100', XLB_HTTP_TRUST_PROXY: '0' },
  });
  child.on('error', () => { spawnFailed = true; });
  child.stdout?.on('data', (chunk: unknown) => {
    if (Buffer.isBuffer(chunk)) output = (output + chunk.toString()).slice(-8192);
  });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const port = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(output)?.[1];
    if (port) {
      community = 'http://127.0.0.1:' + port + '/xiaolanshu';
      if ((await remote('/health')).status === 200) return;
    }
    if (spawnFailed || child.exitCode !== null) throw new Error('Temporary community failed to start');
    await new Promise(resolve => setTimeout(resolve, 80));
  }
  throw new Error('Temporary community startup timed out');
}
async function startHost(options: { withoutConnection?: boolean } = {}) {
  await mkdir(join(home, 'xiaolanshu'), { recursive: true });
  process.env.DSH_HOME = home;
  const routes: WebRoute[] = [], tools = new Map<string, RegisteredTool>();
  const carrier = createServer((req, res) => {
    const path = new URL(req.url || '/', 'http://localhost').pathname;
    const route = routes.find(item => item.kind === 'prefix' ? path.startsWith(item.path + '/') : path === item.path);
    if (!route) { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"ok":false}'); return; }
    Promise.resolve(route.handler(req, res)).catch(() => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      if (!res.writableEnded) res.end('{"ok":false}');
    });
  });
  carriers.push(carrier);
  carrier.listen(0, '127.0.0.1');
  await once(carrier, 'listening');
  const address = carrier.address();
  if (!address || typeof address === 'string') throw new Error('Missing Host listening address');
  const hostOrigin = 'http://127.0.0.1:' + address.port;
  origin = hostOrigin;
  const webServer: WebServer = {
    getOrigin: () => hostOrigin,
    register(route) { routes.push(route); return () => { const index = routes.indexOf(route); if (index >= 0) routes.splice(index, 1); }; },
  };
  const connection: CompanionConnection = {
    requestRejection(req) {
      authorityCalls += 1;
      if (this !== connection || req.headers.host !== new URL(hostOrigin).host
        || req.headers.origin && req.headers.origin !== hostOrigin || req.headers['sec-fetch-site'] === 'cross-site') return 403;
      return req.headers.cookie === cookie ? undefined : 403;
    },
  };
  const effect: EffectContext['effect'] = create => { cleanups.push(create()); };
  const activations: Promise<unknown>[] = [];
  const previousActivations = connectionActivations;
  const context: HostContext = {
    inject(...value: Injection) {
      if (isTools(value)) value[1]({ tools: { register(tool) { tools.set(tool.name, tool); return () => { tools.delete(tool.name); }; } } });
      if (isWeb(value)) value[1]({ webServer });
      if (isConnection(value) && !options.withoutConnection) {
        connectionActivations += 1;
        activations.push(Promise.resolve(value[1]({ webServer, connection, effect })));
      }
      // The fixture provides no agents/presets/model services, so it cannot
      // create a model session or run automatic social/patrol work.
    }, effect,
  };
  const moduleUrl = new URL('./index.js?task-workflow=' + (++hostSerial), import.meta.url).href;
  const { apply }: typeof import('./index.js') = await import(moduleUrl);
  apply(context);
  await Promise.all(activations);
  if (options.withoutConnection) check('legacy web-only Host fixture supplies no connection authority', connectionActivations === previousActivations);
  else check('real Host activates its authenticated HTTP carrier', connectionActivations > previousActivations);
  const expected = ['xlb_answer', 'xlb_claim', 'xlb_confirm', 'xlb_deliver', 'xlb_feed', 'xlb_patrol', 'xlb_post', 'xlb_reply'];
  check('task UI adds no model tool or automatic task capability', JSON.stringify([...tools.keys()].sort()) === JSON.stringify(expected));
  let forbidden = true;
  for (const name of expected.filter(value => value !== 'xlb_feed')) {
    const tool = tools.get(name);
    if (!tool) throw new Error('Missing original tool fixture');
    try { await tool.execute({ taskId: 'forged', role: 'human', approved: true, isolated: true }, { name, callId: 'forged-' + name }); forbidden = false; }
    catch (error) { forbidden = forbidden && record(error).status === 403; }
  }
  check('forged model arguments cannot invoke any original write tool outside isolation', forbidden);
}

async function cleanup() {
  let failed = false;
  for (const dispose of cleanups.reverse()) {
    try { await dispose(); } catch { failed = true; }
  }
  for (const server of carriers) {
    try {
      await new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
    } catch { failed = true; }
  }
  if (child?.pid !== undefined && child.exitCode === null && child.signalCode === null) {
    const processToStop = child;
    const exited = once(processToStop, 'exit').then(() => true);
    const waitForExit = async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { return await Promise.race([exited, new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), 4000); })]); }
      finally { if (timer) clearTimeout(timer); }
    };
    try {
      processToStop.kill();
      if (!await waitForExit()) {
        processToStop.kill('SIGKILL');
        if (!await waitForExit()) failed = true;
      }
    } catch { failed = true; }
  }
  if (previousHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = previousHome;
  const target = await realpath(fixture), parent = await realpath(tmpdir());
  if (dirname(target).toLowerCase() !== parent.toLowerCase() || !basename(target).startsWith('xlb-task-workflow-')) {
    throw new Error('Refusing to remove an unbounded fixture path');
  }
  await rm(target, { recursive: true, force: true });
  if (failed) throw new Error('Fixture cleanup failed');
}

try {
  await startCommunity();
  const publisher = await enroll('任务发布测试主人', '发布助手');
  const claimer = await enroll('任务认领测试主人', '交付助手');
  const outsider = await enroll('任务旁观测试主人', '旁观助手');
  await startHost();
  const taskInput = { title, desc: '仅用于本地真实 HTTP 验证的合成公开需求', budget: '合成积分', period: '一天', tags: ['测试'] };

  for (const [path, body] of [['/task', taskInput], ['/claim', { taskId: 'unknown' }],
    ['/deliver', { taskId: 'unknown', text: deliveryText }], ['/confirm', { taskId: 'unknown' }]] as const) {
    check('anonymous Host ' + path + ' is denied before any task request', (await desktop(publisher, path, body, { anonymous: true })).status === 403);
    check('foreign-origin Host ' + path + ' is denied before any task request', (await desktop(publisher, path, body, { foreign: true })).status === 403);
    check('agent cannot directly execute community ' + path, (await remote(path, publisher.agent, body)).status === 403);
  }
  check('anonymous task list is protected by the Host connection', (await desktop(publisher, '/tasks', undefined, { anonymous: true })).status === 403);
  check('anonymous legacy feed is protected by the Host connection', (await desktop(publisher, '/feed', undefined, { anonymous: true })).status === 403);
  check('foreign-origin legacy feed is protected by the Host connection', (await desktop(publisher, '/feed', undefined, { foreign: true })).status === 403);
  check('legacy feed permits GET only', (await desktop(publisher, '/feed', {})).status === 405);
  check('legacy feed rejects unknown query parameters', (await desktop(publisher, '/feed?ownerId=' + publisher.id)).status === 400);
  for (const path of ['/claim', '/deliver', '/confirm']) {
    check('Host rejects GET on mutation-only ' + path, (await desktop(publisher, path)).status === 405);
  }
  check('Host task route rejects PUT rather than creating a proposal', (await desktop(publisher, '/task', taskInput, { method: 'PUT' })).status === 405);
  check('Host task list rejects POST', (await desktop(publisher, '/tasks', {})).status === 405);
  check('Host rejects forged identity and approval fields', (await desktop(publisher, '/task', { ...taskInput,
    ownerId: outsider.id, ai: '伪造身份', role: 'human', approved: true })).status === 400);
  const nonJson = await desktop(publisher, '/task', taskInput, { contentType: 'text/plain' });
  check('authenticated non-JSON task input is rejected before upstream work', nonJson.status === 415 && nonJson.body.code === 'task_json_required');
  check('authenticated JSON array is rejected as task input', (await desktop(publisher, '/task', [])).status === 400);
  const oversized = await desktop(publisher, '/task', { ...taskInput, desc: 'x'.repeat(64 * 1024) });
  check('task input over 64 KiB is rejected and its connection closed', oversized.status === 413
    && oversized.body.code === 'task_body_too_large' && oversized.connection?.toLowerCase() === 'close');
  const afterRejectedBodies = await desktop(publisher, '/tasks');
  check('a fresh legal read remains available after rejected request bodies', afterRejectedBodies.status === 200
    && records(afterRejectedBodies.body.items).length === 0);
  check('rejected requests create no task or proposal', records((await remote('/tasks', publisher.human)).body.items).length === 0
    && records((await remote('/proposals', publisher.human)).body.items).length === 0);

  const taskProposal = await pending(await desktop(publisher, '/task', taskInput), 'task', publisher);
  check('task proposal uses authenticated owner and discards identity/approval arguments', taskProposal.ownerId === publisher.id
    && !['ownerId', 'ai', 'role', 'approved'].some(key => Object.hasOwn(taskProposal.payload, key)));
  check('unapproved task is absent from the public board', records((await desktop(outsider, '/tasks')).body.items).length === 0);
  check('an agent cannot approve even its own task proposal', (await remote('/proposals/approve', publisher.agent,
    { id: taskProposal.id, digest: taskProposal.digest })).status === 403);
  check('another human cannot approve the publisher proposal', (await decide(outsider, taskProposal)).status === 404);
  check('changed approval digest is rejected', (await remote('/proposals/approve', publisher.human,
    { id: taskProposal.id, digest: '0'.repeat(64) })).status === 409);
  check('rejected approvals leave the board unchanged', records((await desktop(publisher, '/tasks')).body.items).length === 0);
  const created = await decide(publisher, taskProposal);
  check('publisher independent human approval creates the task', created.status === 200 && record(created.body.proposal).status === 'approved', created.status);
  const published = await desktop(publisher, '/tasks?scope=published');
  const tasks = records(published.body.items), task = tasks.find(value => value.title === title);
  if (!task) throw new Error('Approved task missing from board');
  const taskId = string(task.id), detailPath = '/task?taskId=' + encodeURIComponent(taskId);
  check('new task is open and attributed to the credential owner', tasks.length === 1 && task.status === 'open'
    && task.ownerId === publisher.id && record(task.viewer).publisher === true && record(task.viewer).canClaim === false);
  check('publisher cannot create a self-claim proposal', (await desktop(publisher, '/claim', { taskId })).status === 409);

  const claimProposal = await pending(await desktop(claimer, '/claim', { taskId, note: claimNote }), 'claim', claimer);
  const beforeClaim = await desktop(claimer, detailPath);
  check('pending claim neither reserves the task nor exposes private claim data', record(beforeClaim.body.task).status === 'open' && beforeClaim.body.claim === null);
  check('claimer proposal cannot be approved by the task publisher', (await decide(publisher, claimProposal)).status === 404);
  check('claimer independent human approval claims the task', (await decide(claimer, claimProposal)).status === 200);
  const publisherView = await desktop(publisher, detailPath), claimerView = await desktop(claimer, detailPath);
  check('publisher and claimer receive their actual task roles', record(record(publisherView.body.task).viewer).publisher === true
    && record(record(publisherView.body.task).viewer).claimer === false && record(record(claimerView.body.task).viewer).claimer === true
    && record(record(claimerView.body.task).viewer).publisher === false);
  check('claim identity and private note belong to the approved claimant', claimOf(claimerView)?.ownerId === claimer.id
    && claimOf(publisherView)?.note === claimNote && record(claimerView.body.task).status === 'claimed');
  const publicClaim = claimOf(await desktop(outsider, detailPath));
  check('third-party detail exposes only public taskId and claim status', publicClaim?.taskId === taskId
    && publicClaim.status === 'claimed' && Object.keys(publicClaim).sort().join(',') === 'status,taskId');

  check('publisher cannot propose a delivery for another claimant', (await desktop(publisher, '/deliver', { taskId, text: deliveryText })).status === 403);
  check('third party cannot propose a delivery', (await desktop(outsider, '/deliver', { taskId, text: deliveryText })).status === 403);
  check('claimer cannot confirm before delivering', (await desktop(claimer, '/confirm', { taskId })).status === 409);
  const deliveryProposal = await pending(await desktop(claimer, '/deliver', { taskId, text: deliveryText }), 'deliver', claimer);
  const beforeDelivery = await desktop(publisher, detailPath);
  check('pending delivery leaves deliveredAt and delivery text absent', record(beforeDelivery.body.task).status === 'claimed'
    && claimOf(beforeDelivery)?.deliveredAt === undefined && claimOf(beforeDelivery)?.delivery === undefined);
  check('publisher cannot approve the claimant delivery', (await decide(publisher, deliveryProposal)).status === 404);
  check('claimer independent human approval records the delivery', (await decide(claimer, deliveryProposal)).status === 200);
  const delivered = await desktop(publisher, detailPath);
  check('approved delivery is visible to the publisher but is not completion', record(delivered.body.task).status === 'delivered'
    && claimOf(delivered)?.delivery === deliveryText && typeof claimOf(delivered)?.deliveredAt === 'string'
    && claimOf(delivered)?.confirmedAt === undefined);
  for (const account of [publisher, claimer]) {
    const response = await desktop(account, '/feed');
    const ownClaim = record(record(response.body.claims)[taskId]);
    check('authenticated participant feed preserves private task details: ' + (account === publisher ? 'publisher' : 'claimer'),
      response.status === 200 && ownClaim.note === claimNote && ownClaim.delivery === deliveryText && ownClaim.ownerId === claimer.id);
  }
  check('anonymous feed cannot retrieve an existing private delivery', (await desktop(publisher, '/feed', undefined, { anonymous: true })).status === 403);
  check('foreign-origin feed cannot retrieve an existing private delivery', (await desktop(publisher, '/feed', undefined, { foreign: true })).status === 403);
  for (const path of [detailPath, '/tasks', '/feed']) {
    const response = await desktop(outsider, path);
    check('third party cannot obtain claim note or delivery through Host ' + path.split('?')[0], response.status === 200
      && !response.raw.includes(claimNote) && !response.raw.includes(deliveryText));
  }
  const outsiderClaims = record((await desktop(outsider, '/tasks')).body.claims);
  check('third-party list claim metadata stays restricted after delivery', Object.keys(record(outsiderClaims[taskId])).sort().join(',') === 'status,taskId');

  check('claimant cannot propose publisher confirmation', (await desktop(claimer, '/confirm', { taskId })).status === 403);
  check('third party cannot propose publisher confirmation', (await desktop(outsider, '/confirm', { taskId })).status === 403);
  check('denied third-party operations create no proposal', records((await remote('/proposals', outsider.agent)).body.items).length === 0);
  const confirmProposal = await pending(await desktop(publisher, '/confirm', { taskId }), 'confirm', publisher);
  const beforeConfirm = await desktop(claimer, detailPath);
  check('pending confirmation leaves task delivered and unconfirmed', record(beforeConfirm.body.task).status === 'delivered'
    && claimOf(beforeConfirm)?.confirmedAt === undefined);
  check('claimant human cannot approve publisher confirmation', (await decide(claimer, confirmProposal)).status === 404);
  check('publisher independent human approval completes the task', (await decide(publisher, confirmProposal)).status === 200);
  const completed = await desktop(claimer, detailPath);
  check('completion requires and records the publisher decision', record(completed.body.task).status === 'completed'
    && typeof claimOf(completed)?.confirmedAt === 'string');
  check('the same approval cannot execute twice', (await decide(publisher, confirmProposal)).status === 409);
  check('Host task routes repeatedly consult the bound connection authority', authorityCalls >= 20);
  await startHost({ withoutConnection: true });
  for (const path of ['/feed', '/tasks', detailPath]) {
    check('Host without connection authority exposes no private task route: ' + path.split('?')[0],
      (await desktop(publisher, path)).status === 404);
  }
} catch {
  check('task workflow fixture completes without an unexpected exception', false);
} finally {
  try { await cleanup(); } catch { check('task workflow cleans up its own processes and bounded directory', false); }
}

console.log('\n' + (checks - failures.length) + '/' + checks + ' task workflow checks passed');
if (failures.length) process.exitCode = 1;
