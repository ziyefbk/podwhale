/** Real HTTP regressions for task retention, participant privacy and atomic commitments. */
import { spawn, execFileSync } from 'node:child_process';
import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isRecord } from './types.mjs';
import type { Input } from './types.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const data = await mkdtemp(join(tmpdir(), 'podwhale-task-tests-'));
const tokens = { publisher: 'xlb_' + '1'.repeat(48), claimer: 'xlb_' + '2'.repeat(48), outsider: 'xlb_' + '3'.repeat(48),
  agent: 'xlb_' + '4'.repeat(48), revoked: 'xlb_' + '5'.repeat(48), agentExternal: 'xlb_' + '6'.repeat(48) };
const probe = createServer();
await new Promise<void>(done => probe.listen(0, '127.0.0.1', done));
const port = (probe.address() as AddressInfo).port;
await new Promise<void>((done, reject) => probe.close(error => error ? reject(error) : done()));
const base = `http://127.0.0.1:${port}/xiaolanshu`;
let child: ChildProcessByStdio<null, Readable, Readable> | undefined;
let passed = 0, failed = 0;
function check(name: string, condition: unknown) {
  console.log((condition ? 'ok  ' : 'FAIL') + ' ' + name);
  if (condition) passed++; else failed++;
}
function object(value: unknown): Input { if (!isRecord(value)) throw new Error('invalid fixture response'); return value; }
function items(value: unknown): Input[] { if (!Array.isArray(value) || !value.every(isRecord)) throw new Error('invalid fixture items'); return value; }
function text(value: unknown): string { if (typeof value !== 'string') throw new Error('invalid fixture string'); return value; }
async function call(path: string, token = tokens.publisher, body?: Input) {
  const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: 'Bearer ' + token, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) });
  const json: unknown = await response.json();
  return { status: response.status, json: object(json) };
}
async function detail(id: string, token = tokens.publisher) { return call('/task?taskId=' + encodeURIComponent(id), token); }
async function start() {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('XLB_')));
  child = spawn(process.execPath, [join(HERE, 'community.mjs')], { env: { ...inherited, XLB_HOST: '127.0.0.1', XLB_PORT: String(port),
    XLB_DATA: data, XLB_WRITE_LIMIT: '200', XLB_PATROL_MAX_HOURS: '0' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const current = child;
  current.stderr.resume();
  await new Promise<void>((done, reject) => {
    let tail = '';
    const timer = setTimeout(() => finish(new Error('fixture did not become ready')), 10000);
    const output = (chunk: Buffer) => { tail = (tail + chunk.toString()).slice(-1024); if (tail.includes('listening on ')) finish(); };
    const exited = () => finish(new Error('fixture exited before readiness'));
    function finish(error?: Error) {
      clearTimeout(timer); current.off('error', exited); current.off('exit', exited); current.stdout.off('data', output); current.stdout.resume();
      if (error) reject(error); else done();
    }
    current.once('error', exited); current.once('exit', exited); current.stdout.on('data', output);
  });
}
async function stop() {
  const current = child; child = undefined;
  if (!current || current.exitCode !== null) return;
  await new Promise<void>(done => { current.once('exit', () => done()); current.kill(); });
}
function database(sql: string) {
  // A separate operator process avoids retaining SQLite statements/handles in
  // this runner, including on the minimum supported Node 22.5 Windows runtime.
  execFileSync(process.execPath, ['--input-type=module', '-e',
    "import {DatabaseSync} from 'node:sqlite'; const db=new DatabaseSync(process.argv[1]); try{db.exec(process.argv[2]);}finally{db.close();}",
    join(data, 'feed.db'), sql], { timeout: 10000, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
}
function fence(collection: string) {
  if (!['tasks', 'claims', 'ratings'].includes(collection)) throw new Error('invalid fixture collection');
  database(`CREATE TRIGGER task_fault BEFORE INSERT ON entities WHEN NEW.collection='${collection}' BEGIN SELECT RAISE(ABORT,'synthetic task write failure'); END`);
}
const unfence = () => database('DROP TRIGGER task_fault');
async function publish(title: string, token = tokens.publisher) {
  const result = await call('/task', token, { title, desc: 'synthetic task description', budget: 'negotiable', period: 'one day' });
  if (result.status !== 201) throw new Error('fixture task was not published');
  return text(object(result.json.task).id);
}
async function propose(token: string, action: string, payload: Input) {
  const result = await call('/proposals', token, { action, payload });
  return { status: result.status, proposal: isRecord(result.json.proposal) ? result.json.proposal : null };
}
async function approve(proposal: Input, token = tokens.publisher) { return call('/proposals/approve', token, { id: proposal.id, digest: proposal.digest }); }

try {
  const future = new Date(Date.now() + 86400000).toISOString();
  const registry: Input = {};
  for (const [name, token] of Object.entries(tokens)) {
    const id = name === 'agent' ? 'opublisher' : name === 'agentExternal' ? 'ooutsider' : 'o' + name;
    registry[createHash('sha256').update(token).digest('hex')] = { id, name: 'Synthetic ' + name, handle: name,
      createdAt: '2026-01-01T00:00:00.000Z', revoked: name === 'revoked', credential: { role: name.startsWith('agent') ? 'agent' : 'human', expiresAt: future } };
  }
  await writeFile(join(data, 'owners.json'), JSON.stringify(registry));
  const tasks: Input[] = Array.from({ length: 205 }, (_, index) => ({ id: 'fixture-' + index, ownerId: 'opublisher',
    title: 'Retained task ' + index, desc: 'synthetic retained work', source: 'user', createdAt: new Date(Date.UTC(2026, 0, 1) + Math.min(index, 203) * 1000).toISOString() }));
  tasks.push({ id: 'legacy-active', ownerId: 'opublisher', title: 'Private delivery fixture', source: 'user', createdAt: '2026-01-02T00:00:00.000Z', privateFutureField: 'must not be public' },
    { id: 'legacy-self', ownerId: 'opublisher', title: 'Grandfathered self claim', source: 'user', createdAt: '2026-01-03T00:00:00.000Z' },
    { id: 'legacy-demo', title: 'Demonstration only', source: 'seed' });
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
  const first = items(initial.json.items)[0]!;
  check('legacy task defaults do not invent acceptance, deadlines or revisions', first.acceptanceCriteria === '' && first.deadlineAt === null && first.revision === 0 && Array.isArray((await detail(text(first.id))).json.history));
  const defaultFeed = await call('/feed');
  check('feed contains the first task page with an independent task cursor', items(defaultFeed.json.tasks).length === 20
    && defaultFeed.json.tasksTotal === 207 && typeof defaultFeed.json.tasksNextCursor === 'string');
  check('task limit is capped at fifty', items((await call('/tasks?limit=100')).json.items).length === 50);
  const seen = new Set<string>(); let cursor: string | null = null;
  do {
    const page = await call('/tasks?limit=50' + (cursor ? '&before=' + encodeURIComponent(cursor) : ''));
    for (const task of items(page.json.items)) { const id = text(task.id); if (seen.has(id)) throw new Error('task cursor repeated an item'); seen.add(id); }
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
  const self = await call('/claim', tokens.publisher, { taskId: raceId, ownerId: 'oclaimer' });
  check('owner cannot claim a new task even with a forged owner field', self.status === 409 && self.json.error === 'task_self_claim');
  const race = await Promise.all([call('/claim', tokens.claimer, { taskId: raceId }), call('/claim', tokens.outsider, { taskId: raceId })]);
  check('concurrent different owners obtain exactly one commitment', race.filter(result => result.status === 201).length === 1 && race.filter(result => result.status === 409).length === 1);
  const winningToken = race[0]!.status === 201 ? tokens.claimer : tokens.outsider;
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
  if (!requested.proposal) throw new Error('missing pending fixture');
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
  await stop(); await start();
  check('restart preserves more than two hundred tasks and original work', (await call('/tasks')).json.total === 209 && (await detail('fixture-0')).status === 200
    && object((await detail(atomicId)).json.claim).confirmedAt);
  const tiedAfterRestart = await call('/tasks?q=Retained%20task%2020&limit=1&before=' + encodeURIComponent(tiedCursor));
  check('same-time cursor ordering survives persistence and restart', items(tiedAfterRestart.json.items)[0]?.id === 'fixture-203');
  const hidden = await detail(atomicId, tokens.outsider);
  check('restart does not relax delivery privacy', Object.keys(object(hidden.json.claim)).length === 2 && !JSON.stringify(hidden.json).includes('atomic delivery'));
} catch (error) {
  check('task regression completes without an unexpected exception', false);
  console.error(error instanceof Error ? error.message : 'unexpected fixture error');
} finally {
  await stop();
  const target = await realpath(data), parent = await realpath(tmpdir());
  if (dirname(target).toLowerCase() !== parent.toLowerCase() || !basename(target).startsWith('podwhale-task-tests-')) throw new Error('unsafe task fixture cleanup');
  await rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
