/** Real HTTP regressions for task retention, participant privacy and atomic commitments. */
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isRecord } from './types.mjs';
const HERE = fileURLToPath(new URL('.', import.meta.url));
const data = await mkdtemp(join(tmpdir(), 'podwhale-task-tests-'));
const tokens = { publisher: 'xlb_' + '1'.repeat(48), claimer: 'xlb_' + '2'.repeat(48), outsider: 'xlb_' + '3'.repeat(48),
    agent: 'xlb_' + '4'.repeat(48), revoked: 'xlb_' + '5'.repeat(48), agentExternal: 'xlb_' + '6'.repeat(48), agentClaimer: 'xlb_' + '7'.repeat(48) };
const probe = createServer();
await new Promise(done => probe.listen(0, '127.0.0.1', done));
const port = probe.address().port;
await new Promise((done, reject) => probe.close(error => error ? reject(error) : done()));
const base = `http://127.0.0.1:${port}/xiaolanshu`;
let child;
let passed = 0, failed = 0;
function check(name, condition) {
    console.log((condition ? 'ok  ' : 'FAIL') + ' ' + name);
    if (condition)
        passed++;
    else
        failed++;
}
function object(value) { if (!isRecord(value))
    throw new Error('invalid fixture response'); return value; }
function items(value) { if (!Array.isArray(value) || !value.every(isRecord))
    throw new Error('invalid fixture items'); return value; }
function text(value) { if (typeof value !== 'string')
    throw new Error('invalid fixture string'); return value; }
async function call(path, token = tokens.publisher, body) {
    const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST',
        headers: { authorization: 'Bearer ' + token, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) });
    const json = await response.json();
    return { status: response.status, json: object(json) };
}
async function detail(id, token = tokens.publisher) { return call('/task?taskId=' + encodeURIComponent(id), token); }
async function start() {
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('XLB_')));
    child = spawn(process.execPath, [join(HERE, 'community.mjs')], { env: { ...inherited, XLB_HOST: '127.0.0.1', XLB_PORT: String(port),
            XLB_DATA: data, XLB_WRITE_LIMIT: '200', XLB_PATROL_MAX_HOURS: '0' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const current = child;
    current.stderr.resume();
    await new Promise((done, reject) => {
        let tail = '';
        const timer = setTimeout(() => finish(new Error('fixture did not become ready')), 10000);
        const output = (chunk) => { tail = (tail + chunk.toString()).slice(-1024); if (tail.includes('listening on '))
            finish(); };
        const exited = () => finish(new Error('fixture exited before readiness'));
        function finish(error) {
            clearTimeout(timer);
            current.off('error', exited);
            current.off('exit', exited);
            current.stdout.off('data', output);
            current.stdout.resume();
            if (error)
                reject(error);
            else
                done();
        }
        current.once('error', exited);
        current.once('exit', exited);
        current.stdout.on('data', output);
    });
}
async function stop() {
    const current = child;
    child = undefined;
    if (!current || current.exitCode !== null)
        return;
    await new Promise(done => { current.once('exit', () => done()); current.kill(); });
}
function database(sql) {
    // A separate operator process avoids retaining SQLite statements/handles in
    // this runner, including on the minimum supported Node 22.5 Windows runtime.
    execFileSync(process.execPath, ['--input-type=module', '-e',
        "import {DatabaseSync} from 'node:sqlite'; const db=new DatabaseSync(process.argv[1]); try{db.exec(process.argv[2]);}finally{db.close();}",
        join(data, 'feed.db'), sql], { timeout: 10000, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
}
function fence(collection) {
    if (!['tasks', 'claims', 'ratings'].includes(collection))
        throw new Error('invalid fixture collection');
    database(`CREATE TRIGGER task_fault BEFORE INSERT ON entities WHEN NEW.collection='${collection}' BEGIN SELECT RAISE(ABORT,'synthetic task write failure'); END`);
}
const unfence = () => database('DROP TRIGGER task_fault');
async function publish(title, token = tokens.publisher) {
    const result = await call('/task', token, { title, desc: 'synthetic task description', budget: 'negotiable', period: 'one day' });
    if (result.status !== 201)
        throw new Error('fixture task was not published');
    return text(object(result.json.task).id);
}
async function propose(token, action, payload) {
    const result = await call('/proposals', token, { action, payload });
    return { status: result.status, proposal: isRecord(result.json.proposal) ? result.json.proposal : null };
}
async function approve(proposal, token = tokens.publisher) { return call('/proposals/approve', token, { id: proposal.id, digest: proposal.digest }); }
async function basis(id, token = tokens.publisher) {
    const value = (await detail(id, token)).json, task = object(value.task), claim = isRecord(value.claim) ? value.claim : null;
    return { taskId: id, expectedRevision: task.revision, claimId: claim?.claimId ?? null, deliveryVersion: claim?.deliveryVersion ?? 0 };
}
async function reviewed(id, action, agent, human, extra = {}) {
    const current = await basis(id, human);
    const payload = action === 'claim' ? { taskId: id, expectedRevision: current.expectedRevision, ...extra } : { ...current, ...extra };
    const pending = await propose(agent, action, payload);
    if (pending.status !== 201 || !pending.proposal)
        throw new Error('lifecycle proposal failed: ' + action + '/' + pending.status);
    const result = await approve(pending.proposal, human);
    if (result.status !== 200)
        throw new Error('lifecycle approval failed: ' + action + '/' + result.status);
    return result;
}
try {
    const future = new Date(Date.now() + 86400000).toISOString();
    const registry = {};
    for (const [name, token] of Object.entries(tokens)) {
        const id = name === 'agent' ? 'opublisher' : name === 'agentExternal' ? 'ooutsider' : name === 'agentClaimer' ? 'oclaimer' : 'o' + name;
        registry[createHash('sha256').update(token).digest('hex')] = { id, name: 'Synthetic ' + name, handle: name,
            createdAt: '2026-01-01T00:00:00.000Z', revoked: name === 'revoked', credential: { role: name.startsWith('agent') ? 'agent' : 'human', expiresAt: future } };
    }
    await writeFile(join(data, 'owners.json'), JSON.stringify(registry));
    const tasks = Array.from({ length: 205 }, (_, index) => ({ id: 'fixture-' + index, ownerId: 'opublisher',
        title: 'Retained task ' + index, desc: 'synthetic retained work', source: 'user', createdAt: new Date(Date.UTC(2026, 0, 1) + Math.min(index, 203) * 1000).toISOString() }));
    tasks.push({ id: 'legacy-active', ownerId: 'opublisher', title: 'Private delivery fixture', source: 'user', createdAt: '2026-01-02T00:00:00.000Z', privateFutureField: 'must not be public' }, { id: 'legacy-self', ownerId: 'opublisher', title: 'Grandfathered self claim', source: 'user', createdAt: '2026-01-03T00:00:00.000Z' }, { id: 'legacy-demo', title: 'Demonstration only', source: 'seed' });
    // Deliberately omit the later tasksSeeded marker: a legitimate older
    // snapshot must retain its tasks when sample data is initialized.
    await writeFile(join(data, 'feed.json'), JSON.stringify({ version: 1, posts: [], tasks,
        claims: { 'legacy-active': { taskId: 'legacy-active', ownerId: 'oclaimer', ai: 'claimer', note: 'private note fixture',
                delivery: 'private delivery fixture', deliveredAt: '2026-01-02T01:00:00.000Z', futurePrivateField: 'must not leak' },
            'legacy-self': { taskId: 'legacy-self', ownerId: 'opublisher', createdAt: '2026-01-03T01:00:00.000Z' } } }));
    await start();
    const initial = await call('/tasks');
    check('legacy snapshot without a seed marker retains real tasks and hides demos', initial.status === 200 && items(initial.json.items).length === 20
        && initial.json.total === 207 && items(initial.json.items).every(task => task.demo === false));
    check('task page declares current owner and a continuation cursor', initial.json.me === 'opublisher' && typeof initial.json.nextCursor === 'string');
    const first = items(initial.json.items)[0];
    check('legacy task defaults do not invent acceptance, deadlines or revisions', first.acceptanceCriteria === '' && first.deadlineAt === null && first.revision === 0 && Array.isArray((await detail(text(first.id))).json.history));
    const defaultFeed = await call('/feed');
    check('feed contains the first task page with an independent task cursor', items(defaultFeed.json.tasks).length === 20
        && defaultFeed.json.tasksTotal === 207 && typeof defaultFeed.json.tasksNextCursor === 'string');
    check('task limit is capped at fifty', items((await call('/tasks?limit=100')).json.items).length === 50);
    const seen = new Set();
    let cursor = null;
    do {
        const page = await call('/tasks?limit=50' + (cursor ? '&before=' + encodeURIComponent(cursor) : ''));
        for (const task of items(page.json.items)) {
            const id = text(task.id);
            if (seen.has(id))
                throw new Error('task cursor repeated an item');
            seen.add(id);
        }
        cursor = typeof page.json.nextCursor === 'string' ? page.json.nextCursor : null;
    } while (cursor);
    check('every real task beyond two hundred remains reachable exactly once', seen.size === 207 && seen.has('fixture-0'));
    const tiedFirst = await call('/tasks?q=Retained%20task%2020&limit=1');
    const tiedCursor = text(items(tiedFirst.json.items)[0]?.id);
    const tiedSecond = await call('/tasks?q=Retained%20task%2020&limit=1&before=' + encodeURIComponent(tiedCursor));
    check('same-time tasks use a deterministic id boundary across pages', tiedCursor === 'fixture-204' && items(tiedSecond.json.items)[0]?.id === 'fixture-203');
    const oldest = await call('/tasks?sort=oldest&limit=1');
    check('oldest sorting returns the oldest retained task', items(oldest.json.items)[0]?.id === 'fixture-0');
    check('task search filters public task text', (await call('/tasks?q=Private%20delivery')).json.total === 1);
    check('claimed scope uses authenticated ownership', (await call('/tasks?scope=claimed', tokens.claimer)).json.total === 1);
    check('published scope does not accept another owner from query fields', (await call('/tasks?scope=published', tokens.outsider)).json.total === 0
        && (await call('/tasks?scope=published&ownerId=opublisher', tokens.outsider)).status === 400);
    check('status filtering follows persisted delivery state', (await call('/tasks?status=delivered')).json.total === 1);
    check('invalid filters, duplicate fields and unknown cursors fail explicitly', (await call('/tasks?status=invalid')).status === 400
        && (await call('/tasks?limit=2&limit=3')).status === 400 && (await call('/tasks?before=missing')).status === 400);
    check('task detail requires an exact known id', (await call('/task')).status === 400 && (await detail('missing')).status === 404);
    const demo = await detail('legacy-demo');
    check('legacy demo remains readable and cannot be newly claimed', object(demo.json.task).demo === true
        && object(object(demo.json.task).viewer).canClaim === false && (await call('/claim', tokens.claimer, { taskId: 'legacy-demo' })).status === 409);
    const outsiders = [tokens.outsider, tokens.agentExternal];
    for (const token of outsiders) {
        const result = await detail('legacy-active', token), claim = object(result.json.claim);
        check('nonparticipant detail contains public claim status only', JSON.stringify(Object.keys(claim).sort()) === JSON.stringify(['status', 'taskId']) && claim.status === 'delivered');
        check('nonparticipant task never exposes unrecognized stored fields or private history', !JSON.stringify(result.json).includes('private note fixture')
            && !JSON.stringify(result.json).includes('must not') && items(result.json.history).length === 0 && items(result.json.events).length === 0);
        const feed = await call('/feed', token), publicClaim = object(object(feed.json.claims)['legacy-active']);
        check('feed uses the same public projection for nonparticipants', Object.keys(publicClaim).length === 2 && !JSON.stringify(feed.json.claims).includes('private delivery fixture'));
    }
    for (const token of [tokens.publisher, tokens.claimer]) {
        const result = await detail('legacy-active', token), claim = object(result.json.claim);
        check('task participants retain their private note and delivery', claim.note === 'private note fixture' && claim.delivery === 'private delivery fixture'
            && !Object.hasOwn(claim, 'futurePrivateField') && object(object(result.json.task).viewer).participant === true);
    }
    check('old self claim remains idempotent without deleting history', (await call('/claim', tokens.publisher, { taskId: 'legacy-self' })).json.repeated === true);
    const raceId = await publish('Concurrent claim fixture');
    check('publishing one more task does not truncate historical work', (await call('/tasks')).json.total === 208 && (await detail('fixture-0')).status === 200);
    const self = await call('/claim', tokens.publisher, { taskId: raceId });
    check('owner cannot claim a new task', self.status === 409 && self.json.error === 'task_self_claim');
    check('task mutations reject forged identity fields', (await call('/claim', tokens.publisher, { taskId: raceId, ownerId: 'oclaimer' })).status === 400);
    const race = await Promise.all([call('/claim', tokens.claimer, { taskId: raceId }), call('/claim', tokens.outsider, { taskId: raceId })]);
    check('concurrent different owners obtain exactly one commitment', race.filter(result => result.status === 201).length === 1 && race.filter(result => result.status === 409).length === 1);
    const winningToken = race[0].status === 201 ? tokens.claimer : tokens.outsider;
    const winningClaim = object((await detail(raceId, winningToken)).json.claim);
    check('winner retries remain idempotent', (await call('/claim', winningToken, { taskId: raceId })).json.repeated === true);
    check('server owns the claimant identity', winningClaim.ownerId === (winningToken === tokens.claimer ? 'oclaimer' : 'ooutsider'));
    check('agents cannot directly commit task writes or forge approval', (await call('/claim', tokens.agent, { taskId: 'fixture-0', approved: true })).status === 403
        && (await call('/deliver', tokens.agent, { taskId: raceId, text: 'forged' })).status === 403);
    const selfProposal = await propose(tokens.agent, 'claim', { taskId: 'fixture-0' });
    check('proposal dry run also rejects a new self commitment', selfProposal.status === 409);
    const requested = await propose(tokens.agent, 'confirm', { taskId: 'legacy-active' });
    check('participant agent confirmation remains pending', requested.status === 201 && requested.proposal?.status === 'pending'
        && !object((await detail('legacy-active')).json.claim).confirmedAt);
    if (!requested.proposal)
        throw new Error('missing pending fixture');
    check('only the independent human approves the frozen target', (await approve(requested.proposal, tokens.claimer)).status === 404
        && (await approve(requested.proposal)).status === 200 && object((await detail('legacy-active')).json.claim).confirmedAt);
    check('revoked credentials cannot read task details or claim', (await detail(raceId, tokens.revoked)).status === 401
        && (await call('/claim', tokens.revoked, { taskId: 'fixture-0' })).status === 401);
    const atomicId = await publish('Atomic commitment fixture');
    fence('claims');
    check('storage failure rejects a claim without a ghost commitment', (await call('/claim', tokens.claimer, { taskId: atomicId })).status >= 500
        && (await detail(atomicId)).json.claim === null);
    unfence();
    check('claim can genuinely retry after storage recovery', (await call('/claim', tokens.claimer, { taskId: atomicId })).json.repeated === false);
    fence('claims');
    check('storage failure cannot leak an uncommitted delivery into reads', (await call('/deliver', tokens.claimer, { taskId: atomicId, text: 'atomic delivery' })).status >= 500
        && !object((await detail(atomicId)).json.claim).deliveredAt);
    unfence();
    check('delivery succeeds once storage recovers', (await call('/deliver', tokens.claimer, { taskId: atomicId, text: 'atomic delivery' })).status === 200);
    fence('claims');
    check('storage failure cannot record a false acceptance', (await call('/confirm', tokens.publisher, { taskId: atomicId })).status >= 500
        && !object((await detail(atomicId)).json.claim).confirmedAt);
    unfence();
    check('publisher acceptance succeeds after recovery', (await call('/confirm', tokens.publisher, { taskId: atomicId })).status === 200);
    fence('tasks');
    check('failed publication does not enter the task list', (await call('/task', tokens.publisher, { title: 'Must not persist' })).status >= 500
        && (await call('/tasks?q=Must%20not%20persist')).json.total === 0);
    unfence();
    await stop();
    await start();
    check('restart preserves more than two hundred tasks and original work', (await call('/tasks')).json.total === 209 && (await detail('fixture-0')).status === 200
        && object((await detail(atomicId)).json.claim).confirmedAt);
    const tiedAfterRestart = await call('/tasks?q=Retained%20task%2020&limit=1&before=' + encodeURIComponent(tiedCursor));
    check('same-time cursor ordering survives persistence and restart', items(tiedAfterRestart.json.items)[0]?.id === 'fixture-203');
    const hidden = await detail(atomicId, tokens.outsider);
    check('restart does not relax delivery privacy', Object.keys(object(hidden.json.claim)).length === 2 && !JSON.stringify(hidden.json).includes('atomic delivery'));
    // Phase 2: all new state transitions still require a frozen agent proposal
    // and an independent human approval, never an actor/approved flag in JSON.
    for (const deadlineAt of ['not-a-date', '2000-01-01T00:00:00.000Z', '2099-02-30T00:00:00.000Z']) {
        check('new tasks reject invalid or past deadlines', (await call('/task', tokens.publisher, { title: 'Invalid deadline', deadlineAt })).status === 400);
    }
    const deadlineAt = new Date(Date.now() + 3 * 86400000).toISOString();
    const versioned = await call('/task', tokens.publisher, { title: 'Versioned delivery fixture', acceptanceCriteria: 'A reproducible table, contact fixture@example.org', deadlineAt });
    const versionId = text(object(versioned.json.task).id);
    check('acceptance criteria are redacted and the actual deadline is stored', object(versioned.json.task).deadlineAt === deadlineAt
        && !String(object(versioned.json.task).acceptanceCriteria).includes('fixture@example.org'));
    await reviewed(versionId, 'claim', tokens.agentClaimer, tokens.claimer, { note: 'scope of work' });
    const claimedVersion = object((await detail(versionId, tokens.claimer)).json.claim), startBasis = await basis(versionId, tokens.claimer);
    check('a new claim has a unique round and a twenty-four-hour reservation', typeof claimedVersion.claimId === 'string'
        && claimedVersion.deliveryVersion === 0 && Date.parse(text(claimedVersion.reservedUntil)) - Date.parse(text(claimedVersion.createdAt)) === 86400000);
    const startPending = await propose(tokens.agentClaimer, 'task_start', startBasis);
    check('starting work is pending until the claimer human approves', startPending.status === 201 && !object((await detail(versionId, tokens.claimer)).json.claim).startedAt);
    if (!startPending.proposal)
        throw new Error('missing start fixture');
    check('publisher cannot approve another owners start proposal', (await approve(startPending.proposal, tokens.publisher)).status === 404);
    check('the claimer human can start the reviewed round', (await approve(startPending.proposal, tokens.claimer)).status === 200
        && object((await detail(versionId, tokens.claimer)).json.task).status === 'in_progress');
    check('stale task revisions cannot request a different transition', (await propose(tokens.agentClaimer, 'task_withdraw', { ...startBasis, reason: 'stale' })).status === 409);
    check('new task transitions require their exact claim and version', (await propose(tokens.agentClaimer, 'task_withdraw', { taskId: versionId, reason: 'missing target' })).status === 400);
    await reviewed(versionId, 'deliver', tokens.agentClaimer, tokens.claimer, { text: 'delivery-v1-evidence',
        artifacts: [{ label: 'Report fixture@example.org', url: 'https://artifacts.example.org/version-one' }] });
    const firstVersion = (await detail(versionId, tokens.publisher)).json;
    check('a delivery records evidence metadata without fetching it', items(object(firstVersion.claim).deliveries).length === 1
        && items(object(firstVersion.claim).deliveries)[0]?.version === 1);
    check('artifact labels are redacted while valid URLs remain valid', !JSON.stringify(object(firstVersion.claim).deliveries).includes('fixture@example.org')
        && JSON.stringify(object(firstVersion.claim).deliveries).includes('https://artifacts.example.org/version-one'));
    for (const url of ['http://example.org/file', 'https://u:p@example.org/file', 'https://127.0.0.1/file', 'https://[::1]/file',
        'https://host.internal/file', 'https://example.org/file?token=private', 'https://example.org/file#secret', 'javascript:alert(1)']) {
        check('unsafe artifact URLs cannot enter a proposal', (await propose(tokens.agentClaimer, 'deliver', {
            ...await basis(versionId, tokens.claimer), text: 'bad artifact', artifacts: [{ label: 'result', url }]
        })).status === 400);
    }
    check('ratings require publisher acceptance rather than mere delivery', (await call('/rate', tokens.publisher, { taskId: versionId, score: 5 })).status === 409);
    const staleConfirmation = await basis(versionId);
    await reviewed(versionId, 'task_rework', tokens.agent, tokens.publisher, { reason: 'Include the missing second row' });
    check('requesting rework preserves the first delivery and changes the state', object((await detail(versionId)).json.task).status === 'changes_requested'
        && items(object((await detail(versionId)).json.claim).deliveries)[0]?.text === 'delivery-v1-evidence');
    check('an old version cannot be confirmed after a rework request', (await propose(tokens.agent, 'confirm', staleConfirmation)).status === 409
        && (await call('/confirm', tokens.publisher, { taskId: versionId })).status === 409);
    await reviewed(versionId, 'deliver', tokens.agentClaimer, tokens.claimer, { text: 'delivery-v2-evidence',
        artifacts: [{ label: 'Revised report', url: 'https://artifacts.example.org/version-two' }] });
    const secondVersion = object((await detail(versionId)).json.claim);
    check('resubmission appends version two without overwriting version one', secondVersion.deliveryVersion === 2 && items(secondVersion.deliveries).length === 2
        && items(secondVersion.deliveries)[0]?.text === 'delivery-v1-evidence' && secondVersion.delivery === 'delivery-v2-evidence');
    await reviewed(versionId, 'confirm', tokens.agent, tokens.publisher);
    check('acceptance closes the reviewed version exactly once', object((await detail(versionId)).json.task).status === 'completed'
        && (await call('/confirm', tokens.publisher, { taskId: versionId })).json.repeated === true);
    for (const score of [null, '5', 'not-a-score', 0, 6, 1.5])
        check('invalid scores are rejected rather than coerced to one', (await call('/rate', tokens.publisher, { taskId: versionId, score })).status === 400);
    check('accepted task participants may rate exactly once', (await call('/rate', tokens.publisher, { taskId: versionId, score: 5 })).status === 201
        && (await call('/rate', tokens.publisher, { taskId: versionId, score: 4 })).status === 409
        && (await call('/rate', tokens.claimer, { taskId: versionId, score: 4 })).status === 201);
    check('outsiders cannot rate even an accepted task', (await call('/rate', tokens.outsider, { taskId: versionId, score: 5 })).status === 403);
    const privateId = await publish('Withdraw and reclaim private fixture');
    await reviewed(privateId, 'claim', tokens.agentClaimer, tokens.claimer, { note: 'former-private-note' });
    await reviewed(privateId, 'deliver', tokens.agentClaimer, tokens.claimer, { text: 'former-private-delivery',
        artifacts: [{ label: 'former-private-label', url: 'https://artifacts.example.org/former-private-result' }] });
    await reviewed(privateId, 'task_withdraw', tokens.agentClaimer, tokens.claimer, { reason: 'former-private-withdrawal' });
    const formerHistory = (await detail(privateId, tokens.claimer)).json;
    check('withdrawing delivered work retains the full former claimant history', object(formerHistory.task).status === 'open' && formerHistory.claim === null
        && items(formerHistory.history).length === 1 && JSON.stringify(formerHistory.history).includes('former-private-result'));
    const reclaimed = await reviewed(privateId, 'claim', tokens.agentExternal, tokens.outsider);
    const safeReply = (value) => !JSON.stringify(value).includes('former-private-');
    check('approving a new claimant never returns the former private history', safeReply(reclaimed.json));
    check('direct repeated claim responses also omit former private history', safeReply((await call('/claim', tokens.outsider, { taskId: privateId })).json));
    const startedReply = await reviewed(privateId, 'task_start', tokens.agentExternal, tokens.outsider);
    check('start approval receipts cannot carry former private history', safeReply(startedReply.json));
    const newDelivery = await call('/deliver', tokens.outsider, { ...await basis(privateId, tokens.outsider), text: 'new claimant delivery' });
    check('direct delivery receipts cannot carry former private history', newDelivery.status === 200 && safeReply(newDelivery.json));
    const newView = (await detail(privateId, tokens.outsider)).json, formerView = (await detail(privateId, tokens.claimer)).json;
    check('the new claimant has only their own round and history', items(newView.history).length === 0 && safeReply(newView)
        && object(newView.claim).deliveryVersion === 1);
    check('a former claimant sees their own archive but only public current status', items(formerView.history).length === 1
        && Object.keys(object(formerView.claim)).length === 2 && object(object(formerView.task).viewer).participant === false);
    check('publisher retains both archived evidence and the current round', JSON.stringify((await detail(privateId)).json.history).includes('former-private-delivery')
        && object((await detail(privateId)).json.claim).delivery === 'new claimant delivery');
    const cancelId = await publish('Bilateral cancellation fixture');
    await reviewed(cancelId, 'claim', tokens.agentClaimer, tokens.claimer);
    await reviewed(cancelId, 'task_start', tokens.agentClaimer, tokens.claimer);
    const requestCancellation = await reviewed(cancelId, 'task_cancel', tokens.agent, tokens.publisher, { reason: 'publisher cancellation request' });
    check('publisher approval alone only requests cancellation after start', object(requestCancellation.json.result).awaitingOtherParty === true
        && object((await detail(cancelId)).json.task).status === 'in_progress' && isRecord((await detail(cancelId)).json.claim));
    const repeatCancellation = await reviewed(cancelId, 'task_cancel', tokens.agent, tokens.publisher, { reason: 'same side again' });
    check('the same party cannot supply both sides of cancellation', object(repeatCancellation.json.result).awaitingOtherParty === true
        && object((await detail(cancelId)).json.task).status === 'in_progress');
    await reviewed(cancelId, 'task_cancel', tokens.agentClaimer, tokens.claimer, { reason: 'claimer accepts cancellation' });
    check('the other independent owner closes cancellation and retains history', object((await detail(cancelId)).json.task).status === 'cancelled'
        && (await detail(cancelId)).json.claim === null && items((await detail(cancelId)).json.history).length === 1);
    check('cancelled tasks cannot be newly claimed', (await call('/claim', tokens.outsider, { taskId: cancelId })).status === 409);
    const openCancelId = await publish('Open cancellation fixture');
    await reviewed(openCancelId, 'task_cancel', tokens.agent, tokens.publisher, { reason: 'no longer needed' });
    check('publisher can cancel an unclaimed task with a null claim target', object((await detail(openCancelId)).json.task).status === 'cancelled');
    const leaseId = await publish('Unstarted expiry fixture'), startedId = await publish('Started expiry fixture'), deliveredId = await publish('Delivered expiry fixture');
    const leaseCancelId = await publish('Expired reservation cancellation fixture');
    const dueTask = await call('/task', tokens.publisher, { title: 'Actual deadline fixture', deadlineAt });
    const dueId = text(object(dueTask.json.task).id);
    for (const id of [leaseId, startedId, deliveredId, leaseCancelId])
        await reviewed(id, 'claim', tokens.agentClaimer, tokens.claimer, { note: 'lease-private-note' });
    await reviewed(startedId, 'task_start', tokens.agentClaimer, tokens.claimer);
    await reviewed(deliveredId, 'deliver', tokens.agentClaimer, tokens.claimer, { text: 'retained completed effort' });
    const beforeExpiry = await basis(leaseId, tokens.claimer), expiringStart = await propose(tokens.agentClaimer, 'task_start', beforeExpiry);
    if (!expiringStart.proposal)
        throw new Error('missing expiring fixture');
    const literal = (value) => "'" + value.replaceAll("'", "''") + "'";
    await stop();
    for (const id of [leaseId, startedId, deliveredId, leaseCancelId])
        database("UPDATE entities SET data=json_set(data,'$.reservedUntil','2000-01-01T00:00:00.000Z') WHERE collection='claims' AND key=" + literal(id));
    database("UPDATE entities SET data=json_set(data,'$.deadlineAt','2000-01-01T00:00:00.000Z') WHERE collection='tasks' AND key=" + literal(dueId));
    await start();
    const expiredView = (await detail(leaseId, tokens.outsider)).json;
    check('elapsed unstarted reservation reads as open with no foreign claim basis', object(expiredView.task).status === 'open'
        && object(object(expiredView.task).viewer).canClaim === true && expiredView.claim === null);
    check('status changes cannot invalidate an existing task cursor', (await call('/tasks?status=claimed&before=' + encodeURIComponent(leaseId))).status === 200);
    check('a changed lease invalidates an already-reviewed start target', (await approve(expiringStart.proposal, tokens.claimer)).status === 409);
    const oldLeaseId = beforeExpiry.claimId;
    await reviewed(leaseId, 'claim', tokens.agentExternal, tokens.outsider);
    const newLease = (await detail(leaseId, tokens.outsider)).json;
    check('reclaim creates a new round without disclosing an expired private note', object(newLease.claim).claimId !== oldLeaseId
        && !JSON.stringify(newLease).includes('lease-private-note') && items(newLease.history).length === 0);
    check('the previous owner retains their expired reservation history', items((await detail(leaseId, tokens.claimer)).json.history)[0]?.status === 'expired');
    for (const id of [startedId, deliveredId])
        check('elapsed reservations cannot release started or delivered work', (await call('/claim', tokens.outsider, { taskId: id })).status === 409);
    await reviewed(leaseCancelId, 'task_cancel', tokens.agent, tokens.publisher, { reason: 'close the expired reservation' });
    check('publisher can close an expired unstarted reservation', object((await detail(leaseCancelId)).json.task).status === 'cancelled');
    check('an actual deadline prevents claiming an unstarted task', object((await detail(dueId)).json.task).status === 'expired'
        && (await call('/claim', tokens.outsider, { taskId: dueId })).status === 409);
    check('legacy claims without reservation timestamps are never timed out', (await call('/claim', tokens.outsider, { taskId: 'legacy-self' })).status === 409);
}
catch (error) {
    check('task regression completes without an unexpected exception', false);
    console.error(error instanceof Error ? error.message : 'unexpected fixture error');
}
finally {
    await stop();
    const target = await realpath(data), parent = await realpath(tmpdir());
    if (dirname(target).toLowerCase() !== parent.toLowerCase() || !basename(target).startsWith('podwhale-task-tests-'))
        throw new Error('unsafe task fixture cleanup');
    await rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
console.log(`\n${passed} passed, ${failed} failed`);
if (failed)
    process.exitCode = 1;
