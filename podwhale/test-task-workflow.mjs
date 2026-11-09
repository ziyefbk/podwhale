/** A real Host-to-community task workflow with three isolated fixture owners. */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { humanSession } from './server/test-human-session.mjs';
import { registerTaskRoutes } from './task-http.mjs';
const isTools = (value) => value[0][0] === 'tools';
const isWeb = (value) => value[0][0] === 'webServer' && value[0].length === 1;
const isConnection = (value) => value[0][0] === 'webServer' && value[0].length === 2;
const HERE = fileURLToPath(new URL('.', import.meta.url));
const previousHome = process.env.DSH_HOME;
const fixture = await mkdtemp(join(tmpdir(), 'xlb-task-workflow-'));
const data = join(fixture, 'community');
const home = join(fixture, 'desktop');
const remoteFile = join(home, 'xiaolanshu', 'remote.json');
const cookie = 'task_fixture=synthetic-desktop';
const claimNote = 'TASK_PRIVATE_CLAIM_NOTE_SENTINEL';
const deliveryText = 'TASK_PRIVATE_DELIVERY_SENTINEL';
const revisedDelivery = 'TASK_PRIVATE_REVISED_DELIVERY_SENTINEL';
const title = '三个合成账号的独立审批任务';
const failures = [];
const cleanups = [];
const carriers = [];
let checks = 0;
let child;
let community = '';
let origin = '';
let currentAgent = '';
let authorityCalls = 0;
let connectionActivations = 0;
let hostSerial = 0;
function check(name, ok, status) {
    checks += 1;
    if (!ok)
        failures.push(name);
    console.log((ok ? 'ok  ' : 'FAIL') + ' ' + name + (status === undefined ? '' : ' [HTTP ' + status + ']'));
}
function record(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('Invalid fixture response object');
    return value;
}
function records(value) {
    if (!Array.isArray(value))
        throw new Error('Invalid fixture response list');
    const entries = value;
    return entries.map(record);
}
function string(value) {
    if (typeof value !== 'string' || !value)
        throw new Error('Missing fixture response identity');
    return value;
}
function claimOf(reply) {
    return reply.body.claim === null ? null : record(reply.body.claim);
}
function expectation(reply) {
    const task = record(reply.body.task), claim = claimOf(reply);
    if (typeof task.revision !== 'number' || !Number.isSafeInteger(task.revision) || task.revision < 0
        || claim && (typeof claim.deliveryVersion !== 'number' || !Number.isSafeInteger(claim.deliveryVersion) || claim.deliveryVersion < 0)) {
        throw new Error('Missing fixture task or delivery version');
    }
    return { expectedRevision: task.revision, claimId: claim ? string(claim.claimId) : null,
        deliveryVersion: claim ? claim.deliveryVersion : 0 };
}
async function pending(reply, action, account) {
    check(action + ' Host request returns a nonexecuted pending 202', reply.status === 202
        && reply.body.status === 'pending' && reply.body.executed === false && reply.body.action === action, reply.status);
    const receiptId = string(reply.body.proposalId);
    check(action + ' Host receipt contains no approval digest or private proposal body', !Object.hasOwn(reply.body, 'digest')
        && !Object.hasOwn(reply.body, 'proposal') && !Object.hasOwn(reply.body, 'payload'));
    // This is an independent human read in the parent test process. The Host
    // receives only its restricted agent token and the minimal pending receipt.
    const proposals = records((await remote('/proposals', account.human)).body.items);
    const proposal = proposals.find(value => value.id === receiptId);
    if (!proposal)
        throw new Error('Pending receipt missing from independent approval list');
    const id = string(proposal.id), digest = string(proposal.digest);
    if (!/^[a-f0-9]{64}$/.test(digest))
        throw new Error('Missing immutable proposal digest');
    check(action + ' pending receipt binds its immutable proposal', receiptId === id
        && proposal.status === 'pending' && proposal.action === action);
    return { id, digest, action, ownerId: string(proposal.ownerId), payload: record(proposal.payload) };
}
async function request(url, options = {}) {
    const response = await fetch(url, {
        method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
        headers: { accept: 'application/json', ...(options.body === undefined ? {} : { 'content-type': 'application/json' }), ...options.headers },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        redirect: 'error', signal: AbortSignal.timeout(8000),
    });
    const raw = await response.text();
    const value = JSON.parse(raw);
    return { status: response.status, body: record(value), raw, connection: response.headers.get('connection') };
}
function remote(path, token, body) {
    return request(community + path, { ...(body === undefined ? {} : { body }),
        headers: token ? { authorization: 'Bearer ' + token } : {} });
}
async function desktop(account, path, body, options = {}) {
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
function decide(account, proposal) {
    return remote('/proposals/approve', account.human, { id: proposal.id, digest: proposal.digest });
}
async function enroll(name, handle) {
    const response = await remote('/enroll', undefined, { name, handle });
    if (response.status !== 201)
        throw new Error('Cannot enroll fixture owner');
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
    child.stdout?.on('data', (chunk) => {
        if (Buffer.isBuffer(chunk))
            output = (output + chunk.toString()).slice(-8192);
    });
    for (let attempt = 0; attempt < 100; attempt += 1) {
        const port = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(output)?.[1];
        if (port) {
            community = 'http://127.0.0.1:' + port + '/xiaolanshu';
            if ((await remote('/health')).status === 200)
                return;
        }
        if (spawnFailed || child.exitCode !== null)
            throw new Error('Temporary community failed to start');
        await new Promise(resolve => setTimeout(resolve, 80));
    }
    throw new Error('Temporary community startup timed out');
}
async function startHost(options = {}) {
    await mkdir(join(home, 'xiaolanshu'), { recursive: true });
    process.env.DSH_HOME = home;
    const routes = [], tools = new Map();
    const carrier = createServer((req, res) => {
        const path = new URL(req.url || '/', 'http://localhost').pathname;
        const route = routes.find(item => item.kind === 'prefix' ? path.startsWith(item.path + '/') : path === item.path);
        if (!route) {
            res.writeHead(404, { 'content-type': 'application/json' });
            res.end('{"ok":false}');
            return;
        }
        Promise.resolve(route.handler(req, res)).catch(() => {
            if (!res.headersSent)
                res.writeHead(500, { 'content-type': 'application/json' });
            if (!res.writableEnded)
                res.end('{"ok":false}');
        });
    });
    carriers.push(carrier);
    carrier.listen(0, '127.0.0.1');
    await once(carrier, 'listening');
    const address = carrier.address();
    if (!address || typeof address === 'string')
        throw new Error('Missing Host listening address');
    const hostOrigin = 'http://127.0.0.1:' + address.port;
    origin = hostOrigin;
    const webServer = {
        getOrigin: () => hostOrigin,
        register(route) { routes.push(route); return () => { const index = routes.indexOf(route); if (index >= 0)
            routes.splice(index, 1); }; },
    };
    const connection = {
        requestRejection(req) {
            authorityCalls += 1;
            if (this !== connection || req.headers.host !== new URL(hostOrigin).host
                || req.headers.origin && req.headers.origin !== hostOrigin || req.headers['sec-fetch-site'] === 'cross-site')
                return 403;
            return req.headers.cookie === cookie ? undefined : 403;
        },
    };
    const effect = create => { cleanups.push(create()); };
    const activations = [];
    const previousActivations = connectionActivations;
    const context = {
        inject(...value) {
            if (isTools(value))
                value[1]({ tools: { register(tool) { tools.set(tool.name, tool); return () => { tools.delete(tool.name); }; } } });
            if (isWeb(value))
                value[1]({ webServer });
            if (isConnection(value) && !options.withoutConnection) {
                connectionActivations += 1;
                activations.push(Promise.resolve(value[1]({ webServer, connection, effect })));
            }
            // The fixture provides no agents/presets/model services, so it cannot
            // create a model session or run automatic social/patrol work.
        }, effect,
    };
    const moduleUrl = new URL('./index.js?task-workflow=' + (++hostSerial), import.meta.url).href;
    const { apply } = await import(moduleUrl);
    apply(context);
    await Promise.all(activations);
    if (options.withoutConnection)
        check('legacy web-only Host fixture supplies no connection authority', connectionActivations === previousActivations);
    else
        check('real Host activates its authenticated HTTP carrier', connectionActivations > previousActivations);
    const expected = ['xlb_answer', 'xlb_claim', 'xlb_confirm', 'xlb_deliver', 'xlb_feed', 'xlb_patrol', 'xlb_post', 'xlb_reply'];
    check('task UI adds no model tool or automatic task capability', JSON.stringify([...tools.keys()].sort()) === JSON.stringify(expected));
    let forbidden = true;
    for (const name of expected.filter(value => value !== 'xlb_feed')) {
        const tool = tools.get(name);
        if (!tool)
            throw new Error('Missing original tool fixture');
        try {
            await tool.execute({ taskId: 'forged', role: 'human', approved: true, isolated: true }, { name, callId: 'forged-' + name });
            forbidden = false;
        }
        catch (error) {
            forbidden = forbidden && record(error).status === 403;
        }
    }
    check('forged model arguments cannot invoke any original write tool outside isolation', forbidden);
}
async function receiptBoundary() {
    const routes = [];
    const carrier = createServer((req, res) => {
        const path = new URL(req.url || '/', 'http://localhost').pathname;
        const route = routes.find(value => value.path === path);
        if (!route) {
            res.writeHead(404, { 'content-type': 'application/json' });
            res.end('{"ok":false}');
            return;
        }
        Promise.resolve(route.handler(req, res)).catch(() => {
            if (!res.headersSent)
                res.writeHead(500, { 'content-type': 'application/json' });
            if (!res.writableEnded)
                res.end('{"ok":false}');
        });
    });
    carriers.push(carrier);
    carrier.listen(0, '127.0.0.1');
    await once(carrier, 'listening');
    const address = carrier.address();
    if (!address || typeof address === 'string')
        throw new Error('Missing receipt carrier address');
    const base = 'http://127.0.0.1:' + address.port;
    const diagnostic = 'TASK_UPSTREAM_PRIVATE_DIAGNOSTIC_SENTINEL';
    let upstream = {};
    const connection = {
        requestRejection(req) {
            return this === connection && req.headers.host === new URL(base).host
                && req.headers.origin === base && req.headers.cookie === cookie ? undefined : 403;
        },
    };
    cleanups.push(registerTaskRoutes({ connection,
        webServer: { getOrigin: () => base, register(route) { routes.push(route); return () => { const index = routes.indexOf(route); if (index >= 0)
                routes.splice(index, 1); }; } },
        async request() { if (upstream instanceof Error)
            throw upstream; return upstream; },
        async readFeed() { return { posts: [], tasks: [], claims: {} }; },
    }));
    const call = () => request(base + '/xiaolanshu/api/task', { body: { title: '合成回执校验' }, headers: { cookie, origin: base } });
    const valid = { ok: true, status: 'pending', executed: false, action: 'task', proposalId: 'proposal-fixture-safe' };
    for (const [name, altered] of [
        ['an executed operation', { executed: true }],
        ['a mismatched action', { action: 'reply' }],
        ['an invalid proposal identity', { proposalId: 'invalid/identity' }],
    ]) {
        upstream = { ...valid, ...altered, payload: { text: diagnostic }, digest: diagnostic };
        const response = await call();
        check('Host rejects ' + name + ' instead of claiming pending success', response.status === 502
            && response.body.code === 'task_receipt_invalid' && !response.raw.includes(diagnostic));
    }
    for (const [status, code] of [[503, 'task_unavailable'], [409, 'task_conflict']]) {
        upstream = Object.assign(new Error(diagnostic), { ...(status === 409 ? { status } : {}), code: diagnostic });
        const response = await call();
        check('upstream failure exposes only the fixed Host code at status ' + status, response.status === status
            && response.body.code === code && response.body.error === code && !response.raw.includes(diagnostic));
    }
    upstream = { ...valid, payload: { title: '完整合成内容', text: diagnostic }, digest: 'c'.repeat(64),
        proposal: { id: valid.proposalId, payload: { text: diagnostic }, target: { delivery: diagnostic } } };
    const response = await call();
    check('a legitimate pending receipt publishes exactly five safe fields', response.status === 202
        && response.body.ok === true && response.body.status === 'pending' && response.body.executed === false
        && response.body.action === 'task' && response.body.proposalId === valid.proposalId
        && Object.keys(response.body).sort().join(',') === 'action,executed,ok,proposalId,status' && !response.raw.includes(diagnostic));
}
async function cleanup() {
    let failed = false;
    for (const dispose of cleanups.reverse()) {
        try {
            await dispose();
        }
        catch {
            failed = true;
        }
    }
    for (const server of carriers) {
        try {
            await new Promise((resolve, reject) => {
                server.close(error => error ? reject(error) : resolve());
                server.closeAllConnections();
            });
        }
        catch {
            failed = true;
        }
    }
    if (child?.pid !== undefined && child.exitCode === null && child.signalCode === null) {
        const processToStop = child;
        const exited = once(processToStop, 'exit').then(() => true);
        const waitForExit = async () => {
            let timer;
            try {
                return await Promise.race([exited, new Promise(resolve => { timer = setTimeout(() => resolve(false), 4000); })]);
            }
            finally {
                if (timer)
                    clearTimeout(timer);
            }
        };
        try {
            processToStop.kill();
            if (!await waitForExit()) {
                processToStop.kill('SIGKILL');
                if (!await waitForExit())
                    failed = true;
            }
        }
        catch {
            failed = true;
        }
    }
    if (previousHome === undefined)
        delete process.env.DSH_HOME;
    else
        process.env.DSH_HOME = previousHome;
    const target = await realpath(fixture), parent = await realpath(tmpdir());
    if (dirname(target).toLowerCase() !== parent.toLowerCase() || !basename(target).startsWith('xlb-task-workflow-')) {
        throw new Error('Refusing to remove an unbounded fixture path');
    }
    await rm(target, { recursive: true, force: true });
    if (failed)
        throw new Error('Fixture cleanup failed');
}
try {
    await startCommunity();
    const publisher = await enroll('任务发布测试主人', '发布助手');
    const claimer = await enroll('任务认领测试主人', '交付助手');
    const outsider = await enroll('任务旁观测试主人', '旁观助手');
    await startHost();
    const taskInput = { title, desc: '仅用于本地真实 HTTP 验证的合成公开需求', budget: '合成积分', period: '一天', tags: ['测试'] };
    for (const [path, body] of [['/task', taskInput], ['/claim', { taskId: 'unknown' }],
        ['/deliver', { taskId: 'unknown', text: deliveryText }], ['/confirm', { taskId: 'unknown' }]]) {
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
    check('an agent cannot approve even its own task proposal', (await remote('/proposals/approve', publisher.agent, { id: taskProposal.id, digest: taskProposal.digest })).status === 403);
    check('another human cannot approve the publisher proposal', (await decide(outsider, taskProposal)).status === 404);
    check('changed approval digest is rejected', (await remote('/proposals/approve', publisher.human, { id: taskProposal.id, digest: '0'.repeat(64) })).status === 409);
    check('rejected approvals leave the board unchanged', records((await desktop(publisher, '/tasks')).body.items).length === 0);
    const created = await decide(publisher, taskProposal);
    check('publisher independent human approval creates the task', created.status === 200 && record(created.body.proposal).status === 'approved', created.status);
    const published = await desktop(publisher, '/tasks?scope=published');
    const tasks = records(published.body.items), task = tasks.find(value => value.title === title);
    if (!task)
        throw new Error('Approved task missing from board');
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
    const ownProposals = await desktop(claimer, '/proposals');
    check('authorized proposal reads preserve the claimant private delivery evidence', ownProposals.status === 200
        && ownProposals.raw.includes(deliveryText) && ownProposals.raw.includes(claimNote));
    const ownNotifications = await desktop(publisher, '/notifications');
    check('authorized publisher notifications preserve the actual delivery notice', ownNotifications.status === 200
        && ownNotifications.raw.includes(deliveryText));
    for (const path of ['/proposals', '/notifications']) {
        for (const options of [{ anonymous: true }, { foreign: true }]) {
            const response = await desktop(claimer, path, undefined, options);
            check((options.anonymous ? 'anonymous' : 'foreign-origin') + ' private Host read is denied: ' + path, response.status === 403 && !response.raw.includes(claimNote) && !response.raw.includes(deliveryText));
        }
        check('private Host view allows GET only: ' + path, (await desktop(claimer, path, {})).status === 405);
        check('private Host view rejects injected query fields: ' + path, (await desktop(claimer, path + '?ownerId=' + publisher.id)).status === 400);
    }
    for (const account of [publisher, claimer]) {
        const response = await desktop(account, '/feed');
        const ownClaim = record(record(response.body.claims)[taskId]);
        check('authenticated participant feed preserves private task details: ' + (account === publisher ? 'publisher' : 'claimer'), response.status === 200 && ownClaim.note === claimNote && ownClaim.delivery === deliveryText && ownClaim.ownerId === claimer.id);
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
    const reworkProposal = await pending(await desktop(publisher, '/task_rework', { taskId, ...expectation(delivered),
        reason: '请按照验收标准补齐合成结果' }), 'task_rework', publisher);
    check('pending rework does not change the delivered task', record((await desktop(publisher, detailPath)).body.task).status === 'delivered');
    check('publisher independent approval requests rework', (await decide(publisher, reworkProposal)).status === 200);
    const rework = await desktop(claimer, detailPath);
    check('rework preserves the first delivered version', record(rework.body.task).status === 'changes_requested'
        && records(claimOf(rework)?.deliveries).some(entry => entry.version === 1 && entry.text === deliveryText));
    const secondDelivery = await pending(await desktop(claimer, '/deliver', { taskId, ...expectation(rework), text: revisedDelivery,
        artifacts: [{ label: '合成结果附件记录', url: 'https://artifacts.example.org/fixture-result.txt' }] }), 'deliver', claimer);
    check('pending revised delivery does not erase the rework requirement', record((await desktop(publisher, detailPath)).body.task).status === 'changes_requested');
    check('claimer independent approval records a second delivery', (await decide(claimer, secondDelivery)).status === 200);
    const redelivered = await desktop(publisher, detailPath);
    const versions = records(claimOf(redelivered)?.deliveries);
    check('redelivery appends the new version and preserves the original', claimOf(redelivered)?.deliveryVersion === 2 && versions.length === 2
        && versions[0]?.text === deliveryText && versions[1]?.text === revisedDelivery
        && records(versions[1]?.artifacts)[0]?.url === 'https://artifacts.example.org/fixture-result.txt');
    check('outsider cannot read either version after rework', !(await desktop(outsider, detailPath)).raw.includes(revisedDelivery));
    check('claimant cannot propose publisher confirmation', (await desktop(claimer, '/confirm', { taskId })).status === 403);
    check('third party cannot propose publisher confirmation', (await desktop(outsider, '/confirm', { taskId })).status === 403);
    check('denied third-party operations create no proposal', records((await remote('/proposals', outsider.agent)).body.items).length === 0);
    const confirmProposal = await pending(await desktop(publisher, '/confirm', { taskId, ...expectation(redelivered) }), 'confirm', publisher);
    const beforeConfirm = await desktop(claimer, detailPath);
    check('pending confirmation leaves task delivered and unconfirmed', record(beforeConfirm.body.task).status === 'delivered'
        && claimOf(beforeConfirm)?.confirmedAt === undefined);
    check('claimant human cannot approve publisher confirmation', (await decide(claimer, confirmProposal)).status === 404);
    check('publisher independent human approval completes the task', (await decide(publisher, confirmProposal)).status === 200);
    const completed = await desktop(claimer, detailPath);
    check('completion requires and records the publisher decision', record(completed.body.task).status === 'completed'
        && typeof claimOf(completed)?.confirmedAt === 'string');
    check('the same approval cannot execute twice', (await decide(publisher, confirmProposal)).status === 409);
    const cancelTitle = '合成任务的双方取消审批';
    const newTask = await pending(await desktop(publisher, '/task', { title: cancelTitle, desc: '用于验证真实开工、退出与双方取消',
        acceptanceCriteria: '两位主人分别批准后才结束', deadlineAt: new Date(Date.now() + 86400000).toISOString() }), 'task', publisher);
    check('independent approval creates the cancellation workflow fixture', (await decide(publisher, newTask)).status === 200);
    const cancelTask = records((await desktop(publisher, '/tasks?scope=published')).body.items).find(value => value.title === cancelTitle);
    if (!cancelTask)
        throw new Error('Missing cancellation fixture task');
    const cancelId = string(cancelTask.id), cancelPath = '/task?taskId=' + encodeURIComponent(cancelId);
    const claimCancellation = async () => {
        const proposal = await pending(await desktop(claimer, '/claim', { taskId: cancelId, note: '合成任务认领' }), 'claim', claimer);
        check('independent claimant approval records a cancellation-test claim', (await decide(claimer, proposal)).status === 200);
    };
    await claimCancellation();
    const withdrawal = await pending(await desktop(claimer, '/task_withdraw', { taskId: cancelId,
        ...expectation(await desktop(claimer, cancelPath)), reason: '本轮合成测试退出认领' }), 'task_withdraw', claimer);
    check('pending withdrawal preserves the current claim', record((await desktop(publisher, cancelPath)).body.task).status === 'claimed');
    check('claimant independent approval withdraws the current round', (await decide(claimer, withdrawal)).status === 200);
    const withdrawn = await desktop(claimer, cancelPath);
    check('withdrawal reopens the task while retaining participant history', record(withdrawn.body.task).status === 'open'
        && withdrawn.body.claim === null && records(withdrawn.body.history).length === 1);
    await claimCancellation();
    const start = await pending(await desktop(claimer, '/task_start', { taskId: cancelId,
        ...expectation(await desktop(claimer, cancelPath)) }), 'task_start', claimer);
    check('pending start does not mark the work as in progress', record((await desktop(publisher, cancelPath)).body.task).status === 'claimed');
    check('claimant independent approval starts the actual claim round', (await decide(claimer, start)).status === 200);
    const started = await desktop(publisher, cancelPath);
    check('approved start records the in-progress state', record(started.body.task).status === 'in_progress'
        && typeof claimOf(started)?.startedAt === 'string');
    const cancelReason = 'TASK_PRIVATE_CANCEL_REASON_SENTINEL';
    const firstCancel = await pending(await desktop(publisher, '/task_cancel', { taskId: cancelId, ...expectation(started), reason: cancelReason }), 'task_cancel', publisher);
    const beforeCancel = await desktop(publisher, cancelPath);
    check('pending cancellation creates neither cancellation request nor cancellation', record(beforeCancel.body.task).status === 'in_progress'
        && record(beforeCancel.body.task).cancellation === null);
    check('publisher independent approval submits its cancellation request', (await decide(publisher, firstCancel)).status === 200);
    const requested = await desktop(claimer, cancelPath);
    check('one side cancellation approval leaves the work running', record(requested.body.task).status === 'in_progress'
        && record(record(requested.body.task).cancellation).requestedBy === publisher.id);
    check('third party cannot obtain the participants cancellation reason', !(await desktop(outsider, cancelPath)).raw.includes(cancelReason));
    const secondCancel = await pending(await desktop(claimer, '/task_cancel', { taskId: cancelId, ...expectation(requested), reason: '另一方核对后同意取消' }), 'task_cancel', claimer);
    check('second cancellation proposal alone still leaves the work running', record((await desktop(publisher, cancelPath)).body.task).status === 'in_progress');
    check('the other independent human approves the second cancellation', (await decide(claimer, secondCancel)).status === 200);
    check('only both approved cancellation requests cancel the started task', record((await desktop(publisher, cancelPath)).body.task).status === 'cancelled');
    check('Host task routes repeatedly consult the bound connection authority', authorityCalls >= 20);
    await startHost({ withoutConnection: true });
    for (const path of ['/feed', '/proposals', '/notifications', '/tasks', detailPath]) {
        check('Host without connection authority exposes no private task route: ' + path.split('?')[0], (await desktop(publisher, path)).status === 404);
    }
    await receiptBoundary();
}
catch {
    check('task workflow fixture completes without an unexpected exception', false);
}
finally {
    try {
        await cleanup();
    }
    catch {
        check('task workflow cleans up its own processes and bounded directory', false);
    }
}
console.log('\n' + (checks - failures.length) + '/' + checks + ' task workflow checks passed');
if (failures.length)
    process.exitCode = 1;
