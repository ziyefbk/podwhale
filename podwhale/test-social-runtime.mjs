/** Fresh-agent contracts with synthetic native ports; no provider or community requests. */
import { createPatrolController, PATROL_TOOLS, LEGACY_PATROL_PROMPT } from './patrol-runtime.mjs';
import { DEFAULT_SOCIAL_PREFERENCES } from './social-controller.mjs';
import { mkdtemp, mkdir, writeFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
let passed = 0, failures = 0;
function check(name, value) { console.log((value ? 'ok  ' : 'FAIL') + ' ' + name); if (value)
    passed += 1;
else
    failures += 1; }
function object(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
function errorStatus(error) { return object(error) ? error.status : undefined; }
async function until(test) { const end = Date.now() + 2500; while (!test()) {
    if (Date.now() > end)
        throw new Error('runtime fixture timeout');
    await new Promise(resolve => setTimeout(resolve, 5));
} }
const prefs = (patch = {}) => ({ ...DEFAULT_SOCIAL_PREFERENCES, topics: [], ...patch });
async function fixture(program, faults = {}) {
    const home = await mkdtemp(join(tmpdir(), 'podwhale-social-runtime-test-'));
    const controller = createPatrolController({ homeDir: () => home });
    const definitions = PATROL_TOOLS.map(name => ({ name, description: 'Synthetic capability ' + name, parameters: { type: 'object', properties: {}, additionalProperties: false } }));
    const presets = new Map(), mounted = new WeakMap();
    const network = [];
    const metadata = [], calls = [];
    const created = [];
    let agent, latestExecution, followups = 0, disposed = 0, cancelled = 0;
    let releaseCreate, releaseMount;
    let fixedInput = '', fixedSystem = '', call = 0;
    const runtime = {
        effect() { }, on(_event, guard) { network.push(guard); return () => { }; },
        agentDefaultModel: { currentSelection: () => ({ provider: 'synthetic', model: 'synthetic-model' }) },
        agentPresets: {
            async register(value) { presets.set(value.id, value); return () => { presets.delete(value.id); }; },
            async list() { return [...presets.keys()].map(id => ({ id })); },
            async mount(context, id) { if (faults.mountNever)
                await new Promise(resolve => { releaseMount = resolve; }); mounted.set(context, id); return { id }; },
            composedPreset(context) { return mounted.get(context); },
        },
        agents: { async create(options) {
                created.push(options);
                const guards = [];
                const executor = { describe: () => ({ schemas: definitions.map(item => ({ ...item })) }) };
                const context = {
                    tools: { restrict(filter) { if (filter.allow.length !== 8)
                            throw new Error('invalid fixture restriction'); },
                        guard(value) { guards.push(value); }, definitions: () => definitions, selectExecutor: () => executor },
                    systemPrompt: { section(value) { fixedSystem = value.text; }, context() { }, suppressRuntimeContext() { },
                        async assemble() { if (faults.assembleNever)
                            return new Promise(() => { }); return { sections: [{ name: 'fixed', text: fixedSystem }], contexts: [], tools: definitions }; },
                        refreshContext: value => value },
                    on() { return () => { }; },
                };
                let pending = Promise.resolve();
                const current = { ctx: context, cancel() { cancelled += 1; },
                    followup(message) {
                        followups += 1;
                        fixedInput = message.content[0]?.text ?? '';
                        pending = Promise.resolve().then(async () => {
                            const schemas = definitions.map(item => ({ ...item }));
                            const messages = [{ id: 'system', role: 'system', source: { kind: 'system-prompt' }, content: [{ type: 'text', text: fixedSystem }] }, message];
                            async function admit() {
                                const request = { sessionId: options.sessionId, provider: options.agentOptions.provider, model: options.agentOptions.model,
                                    tools: schemas, toolHistory: { tools: schemas, updates: [] }, messages };
                                for (const guard of network)
                                    await guard(request, () => undefined);
                            }
                            await admit();
                            const invoke = async (name, args = {}) => {
                                const execution = { agent: current, name, callId: 'call-' + (++call) };
                                latestExecution = execution;
                                for (const guard of guards) {
                                    const denied = guard(execution);
                                    if (denied)
                                        throw Object.assign(new Error(denied), { status: 403 });
                                }
                                const policy = controller.executionPolicy(execution);
                                metadata.push(policy);
                                calls.push(name);
                                let result;
                                if (name === 'xlb_feed') {
                                    controller.recordFeed(execution);
                                    result = { text: 'COMMUNITY_SENTINEL' };
                                }
                                else if (policy.kind === 'social')
                                    result = controller.recordReceipt(execution, faults.receipt ? faults.receipt(name.slice(4))
                                        : { id: 'socialreceipt-' + call, action: name.slice(4), status: 'published', executed: true, targetId: 'target-' + call });
                                else {
                                    result = { proposalId: 'proposal-' + call, action: name.slice(4), status: 'pending', executed: false };
                                    controller.recordProposal(execution, result);
                                }
                                const value = faults.resultExtra && name !== 'xlb_feed' && object(result) ? { ...result, text: 'COMMUNITY_SENTINEL' } : result;
                                messages.push({ id: 'assistant-' + call, role: 'assistant', source: { kind: 'model', provider: 'synthetic', model: 'synthetic-model' },
                                    content: [{ type: 'tool-call', id: String(execution.callId), name, arguments: JSON.stringify(args) }] }, { id: 'tool-' + call, role: 'tool', source: { kind: 'tool', callId: execution.callId }, toolCallId: execution.callId,
                                    isError: false, content: [{ type: 'text', text: JSON.stringify(value) }] });
                                await admit();
                                return result;
                            };
                            await program(invoke, controller.executionPolicy);
                            return 'CHILD_NATURAL_LANGUAGE_SENTINEL';
                        });
                    }, whenIdle() { return faults.idleNever ? new Promise(() => { }) : pending; }, };
                agent = current;
                const handle = { agent: current, async dispose() { disposed += 1; if (faults.disposeNever)
                        await new Promise(() => { }); } };
                if (faults.createNever)
                    return new Promise(resolve => { releaseCreate = () => resolve(handle); });
                await options.setup(context, current);
                return handle;
            } },
    };
    const dispose = await controller.attach(runtime);
    return { controller, home, metadata, calls, created, input: () => fixedInput, system: () => fixedSystem, followups: () => followups,
        disposed: () => disposed, cancelled: () => cancelled, releaseCreate: () => releaseCreate?.(), releaseMount: () => releaseMount?.(),
        hasCreate: () => !!releaseCreate, hasMount: () => !!releaseMount,
        execution: () => { if (!latestExecution)
            throw new Error('missing synthetic execution'); return latestExecution; },
        agent: () => { if (!agent)
            throw new Error('missing synthetic agent'); return agent; }, close: async () => {
            await dispose();
            const actual = await realpath(home), base = await realpath(tmpdir());
            if (dirname(actual).toLowerCase() !== base.toLowerCase() || !basename(actual).startsWith('podwhale-social-runtime-test-'))
                throw new Error('unsafe fixture cleanup');
            await rm(actual, { recursive: true, force: true });
        } };
}
const normal = await fixture(async (invoke) => { await invoke('xlb_feed'); await invoke('xlb_post', { title: 'public title', text: 'public text' }); });
const published = await normal.controller.runSocial(prefs({ topics: ['person@example.com'], readLimit: 3 }), new AbortController().signal);
check('social execution uses a fresh default-model session with no parent history', normal.created.length === 1 && !Object.hasOwn(normal.created[0], 'parentAgent')
    && normal.created[0]?.agentOptions.provider === 'synthetic');
check('settings reach the child only through the fixed Host JSON envelope', normal.input().includes('"readLimit":3') && normal.input().includes('[邮箱]') && !normal.input().includes('person@example.com'));
check('social prompt accurately defers publication authority to the server', normal.system().includes('server independently determines') && !normal.system().includes('All writes are pending'));
check('published server receipts are represented accurately without child text', published.status === 'completed' && published.executed && published.receipts?.[0]?.status === 'published'
    && !JSON.stringify(published).includes('COMMUNITY_SENTINEL') && !JSON.stringify(published).includes('CHILD_NATURAL_LANGUAGE_SENTINEL'));
check('trusted execution metadata contains a frozen local snapshot and shared abort signal', normal.metadata.every(item => item.kind === 'social' && Object.isFrozen(item.preferences)
    && Object.isFrozen(item.preferences?.topics)) && normal.metadata[0]?.signal === normal.metadata[1]?.signal);
const socialId = normal.metadata[1]?.requestId;
check('write request IDs use a timestamp UUID rather than model arguments', typeof socialId === 'string' && /^social-\d{13}-[0-9a-f-]{36}$/.test(socialId));
let retired = false;
try {
    normal.controller.executionPolicy(normal.execution());
}
catch (error) {
    retired = errorStatus(error) === 403;
}
check('retired execution metadata cannot authorize a later request', retired);
await normal.close();
let stable = false, spoofed = false, flags = false;
const restricted = await fixture(async (invoke, policy) => {
    await invoke('xlb_feed', { approved: true, draftPosts: true });
    for (const name of ['xlb_post', 'xlb_claim', 'xlb_deliver', 'xlb_confirm', 'xlb_answer', 'xlb_patrol']) {
        try {
            await invoke(name, { approved: true, role: 'human' });
        }
        catch (error) {
            if (errorStatus(error) === 403)
                flags = true;
        }
    }
    await invoke('xlb_reply');
    const exec = restricted.execution(), first = policy(exec), second = policy(exec);
    stable = !!first.requestId && first.requestId === second.requestId;
    try {
        policy({ ...exec, agent: { ...restricted.agent() } });
    }
    catch (error) {
        spoofed = errorStatus(error) === 403;
    }
});
const restrictionResult = await restricted.controller.runSocial(prefs({ draftPosts: false, draftReplies: true }), new AbortController().signal);
check('local flags and social mode deny post and every non-social write', flags && restricted.calls.join(',') === 'xlb_feed,xlb_reply' && restrictionResult.status === 'completed');
check('the same admitted call keeps one request ID across transport retries', stable);
check('copying agent fields cannot forge the private execution identity', spoofed);
await restricted.close();
const readOnly = await fixture(async (invoke) => { await invoke('xlb_feed'); try {
    await invoke('xlb_reply');
}
catch { } });
const readOnlyResult = await readOnly.controller.runSocial(prefs({ draftPosts: false, draftReplies: false }), new AbortController().signal);
check('both drafting flags disabled produces a read-only social run', readOnlyResult.status === 'completed' && readOnly.calls.length === 1 && !readOnlyResult.executed);
await readOnly.close();
const pending = await fixture(async (invoke) => { await invoke('xlb_feed'); await invoke('xlb_reply'); }, { receipt: action => ({ id: 'socialreceipt-pending', action, status: 'pending', executed: false, proposalId: 'proposal-pending' }) });
const pendingResult = await pending.controller.runSocial(prefs(), new AbortController().signal);
check('pending receipts preserve approval links and do not claim execution', pendingResult.status === 'completed' && !pendingResult.executed
    && pendingResult.proposals[0]?.id === 'proposal-pending' && pendingResult.receipts?.[0]?.status === 'pending');
await pending.close();
const approved = await fixture(async (invoke) => { await invoke('xlb_feed'); await invoke('xlb_post'); }, { receipt: action => ({ id: 'socialreceipt-approved', action, status: 'published', executed: true, proposalId: 'proposal-approved', targetId: 'p1' }) });
check('a human-approved publication may preserve its original proposal link', (await approved.controller.runSocial(prefs(), new AbortController().signal)).status === 'completed');
await approved.close();
for (const [name, changes] of Object.entries({ falseExecution: { executed: false }, missingTarget: { targetId: undefined }, wrongAction: { action: 'confirm' },
    bodyAuthority: { approved: true }, externalText: { text: 'COMMUNITY_SENTINEL' }, malformedId: { id: 'url://SENSITIVE' }, wrongProposal: { proposalId: 'owner-secret' } })) {
    const bad = await fixture(async (invoke) => { await invoke('xlb_feed'); await invoke('xlb_post'); }, { receipt: action => ({ id: 'socialreceipt-invalid', action, status: 'published', executed: true, targetId: 'p1', ...changes }) });
    const result = await bad.controller.runSocial(prefs(), new AbortController().signal);
    check('malformed publication receipt fails closed: ' + name, result.status === 'blocked' && !result.executed && !JSON.stringify(result).includes('COMMUNITY_SENTINEL'));
    await bad.close();
}
const rendering = await fixture(async (invoke) => { await invoke('xlb_feed'); await invoke('xlb_post'); }, { resultExtra: true });
check('final provider boundary rejects result text added after Host receipt recording', (await rendering.controller.runSocial(prefs(), new AbortController().signal)).status === 'blocked'
    && rendering.controller.status().networkPolicyFailure === 'tool_message');
await rendering.close();
const budget = await fixture(async (invoke) => { await invoke('xlb_feed'); for (let index = 0; index < 4; index += 1) {
    try {
        await invoke('xlb_post');
    }
    catch { }
} });
check('social runtime enforces the three-write budget before network admission', (await budget.controller.runSocial(prefs(), new AbortController().signal)).receipts?.length === 3 && budget.calls.length === 4);
await budget.close();
const calls = await fixture(async (invoke) => { for (let index = 0; index < 9; index += 1) {
    try {
        await invoke('xlb_feed');
    }
    catch { }
} });
check('social runtime reads at most one feed so readLimit is a per-run limit', (await calls.controller.runSocial(prefs(), new AbortController().signal)).feedReads === 1 && calls.calls.length === 1);
await calls.close();
const legacyCalls = await fixture(async (invoke) => { for (let index = 0; index < 9; index += 1) {
    try {
        await invoke('xlb_feed');
    }
    catch { }
} });
check('legacy runtime retains the existing eight-call budget', (await legacyCalls.controller.run()).feedReads === 8 && legacyCalls.calls.length === 8);
await legacyCalls.close();
for (const stage of ['createNever', 'mountNever', 'assembleNever', 'idleNever', 'disposeNever']) {
    const lifecycle = await fixture(async (invoke) => { await invoke('xlb_feed'); }, { [stage]: true });
    const abort = new AbortController(), result = lifecycle.controller.runSocial(prefs(), abort.signal);
    await until(() => lifecycle.created.length === 1);
    if (stage === 'mountNever')
        await until(lifecycle.hasMount);
    if (stage !== 'createNever' && stage !== 'mountNever')
        await new Promise(resolve => setTimeout(resolve, 10));
    const started = Date.now();
    abort.abort();
    const done = await result;
    check('abort has a bounded outcome during ' + stage, (done.status === 'cancelled' || stage === 'disposeNever' && done.status === 'completed') && Date.now() - started < 1600);
    if (stage === 'createNever') {
        lifecycle.releaseCreate();
        await until(() => lifecycle.disposed() === 1);
        check('late SDK create is disposed exactly once without starting a model', lifecycle.disposed() === 1 && lifecycle.followups() === 0);
    }
    if (stage === 'mountNever') {
        lifecycle.releaseMount();
        await new Promise(resolve => setTimeout(resolve, 10));
        check('late preset mount cannot restore an aborted tool boundary', lifecycle.followups() === 0);
    }
    await lifecycle.close();
}
const overlap = await fixture(async () => new Promise(() => { }), { idleNever: true });
const stop = new AbortController(), firstRun = overlap.controller.runSocial(prefs(), stop.signal);
await until(() => overlap.followups() === 1);
check('a second run cannot share or replace the live restricted agent', (await overlap.controller.runSocial(prefs(), new AbortController().signal)).status === 'busy');
stop.abort();
await firstRun;
await overlap.close();
let legacyPaused = false, migrationEdits = 0;
const migration = await fixture(async (invoke) => { await invoke('xlb_feed'); });
migration.controller.setSocialScheduling();
await mkdir(join(migration.home, 'xiaolanshu'));
await writeFile(join(migration.home, 'xiaolanshu', 'security.json'), JSON.stringify({ legacyPatrolScheduleId: 'schedule-synthetic', hours: [9], minute: 0, timeZone: 'Asia/Shanghai' }));
await migration.controller.attachSchedule({ async view() { return { status: legacyPaused ? 'paused' : 'active', prompt: legacyPaused ? LEGACY_PATROL_PROMPT : 'unsafe old reminder' }; },
    async edit() { legacyPaused = true; migrationEdits += 1; return {}; } });
check('social scheduling still pauses unsafe legacy reminders while suppressing their timer', !migration.controller.status().timerEnabled && migrationEdits === 1
    && migration.controller.status().scheduleMigration.status === 'migrated');
await migration.close();
console.log(`\n${passed} passed, ${failures} failed`);
if (failures)
    process.exitCode = 1;
