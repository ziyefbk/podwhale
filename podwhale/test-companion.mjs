import { mkdtemp, mkdir, readFile, writeFile, realpath, rm } from 'node:fs/promises';
import { join, resolve, dirname, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createCompanionRuntime, COMPANION_SYSTEM, assertCompanionRequest } from './companion-runtime.mjs';
import { createCompanionService } from './companion-service.mjs';
import { setupCompanionWechat, setCompanionWechatEnabled } from './companion-setup.mjs';
let failed = 0;
function check(name, value) { console.log((value ? 'ok   ' : 'FAIL ') + name); if (!value)
    failed++; }
async function rejects(fn, code) { try {
    await fn();
    return false;
}
catch (error) {
    return !code || error instanceof Error && error.message === code;
} }
function record(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
await mkdir(join(root, '.tmp'), { recursive: true });
const temp = await mkdtemp(join(root, '.tmp', 'companion-test-'));
const services = [];
function fixture(options = {}) {
    const hooks = new Map();
    const mounted = new WeakMap();
    const presets = new Set();
    const requests = [];
    const created = [];
    let disposed = 0, cancelled = 0;
    function listen(event, callback) {
        if (typeof callback !== 'function')
            throw new Error('fixture callback');
        const handler = (...args) => Reflect.apply(callback, undefined, args);
        const handlers = hooks.get(event) ?? new Set();
        hooks.set(event, handlers);
        handlers.add(handler);
        return () => { handlers.delete(handler); };
    }
    async function emit(event, ...args) {
        for (const callback of hooks.get(event) ?? [])
            await callback(...args);
    }
    const runtime = {
        effect() { }, on: listen,
        agentDefaultModel: { currentSelection: () => options.modelMissing ? null : { provider: 'fixture', model: 'chat' } },
        agentPresets: {
            register: async (value) => { presets.add(value.id); return () => { presets.delete(value.id); }; },
            list: async () => [...presets].map(id => ({ id })),
            mount: async (context, id) => { mounted.set(context, id); return { id }; },
            composedPreset: context => mounted.get(context),
        },
        agents: { create: async (input) => {
                created.push(input);
                if (options.hangCreate)
                    return new Promise(() => { });
                const sections = [], contexts = new Map();
                const promptHooks = [];
                let restricted = false;
                let user;
                const agentContext = {
                    tools: {
                        restrict: () => { if (!options.ignoreRestriction)
                            restricted = true; }, guard() { },
                        definitions: () => restricted ? [] : [{ name: 'private-file', description: 'must never leak', parameters: {} }],
                        selectExecutor: () => ({ describe: definitions => ({ schemas: definitions.map(({ name, description, parameters }) => ({ name, description, parameters })) }) }),
                    },
                    on: (_event, handler) => { promptHooks.push(handler); return () => { const i = promptHooks.indexOf(handler); if (i >= 0)
                        promptHooks.splice(i, 1); }; },
                    systemPrompt: {
                        section: part => { sections.push(part); }, context: part => { contexts.set(part.name, part); }, suppressRuntimeContext() { },
                        refreshContext: assembly => assembly,
                        assemble: async (info) => {
                            if (options.hangPrompt)
                                return new Promise(() => { });
                            const assembly = { sections: [...sections], contexts: [...contexts.values(),
                                    ...(options.extraContext ? [{ name: 'private-workspace', text: 'fixture-private-secret' }] : []),
                                    ...(options.knownCwd ? [{ name: 'working-directory:current', text: 'fixture-private-cwd' }] : [])], tools: [] };
                            let run = async () => assembly;
                            for (const handler of promptHooks) {
                                const next = run;
                                run = () => handler(assembly, info, next);
                            }
                            return run();
                        },
                    },
                };
                const session = { id: input.sessionId };
                const agent = {
                    ctx: agentContext, session, followup: value => { user = value; },
                    cancel: () => { cancelled++; },
                    whenIdle: async () => {
                        if (options.hang)
                            await new Promise((_done, reject) => { input.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }); });
                        const route = input.agentOptions;
                        const request = { sessionId: input.sessionId, provider: route.provider, model: route.model,
                            tools: [], toolHistory: { tools: [], updates: [] }, messages: [{ id: 'system-id', role: 'system', source: { kind: 'system-prompt' }, content: [{ type: 'text', text: sections[0]?.text }] }, user] };
                        options.tamper?.(request);
                        await emit('session/event', session, { type: 'turn/start', data: { turn: 1 } });
                        await emit('llm/stream', request, async () => { requests.push(structuredClone(request)); });
                        if (options.repeatRequest)
                            await emit('llm/stream', request, async () => { requests.push(structuredClone(request)); });
                        const message = { role: 'assistant', content: [{ type: 'reasoning', text: 'private-reasoning-never-visible' },
                                ...(options.empty ? [] : [{ type: options.toolOutput ? 'tool-call' : 'text', text: '你好，我是大肥鱼。' }])] };
                        await emit('session/event', options.foreignSession ? { id: input.sessionId } : session, { type: 'assistant/message', data: { turn: 1, message } });
                        await emit('session/event', session, { type: 'turn/end', data: { turn: 1, reason: { kind: options.failedTurn ? 'error' : 'completed' } } });
                    },
                };
                await input.setup(agentContext, agent);
                if (options.lateHandle)
                    await new Promise(done => { input.signal.addEventListener('abort', () => done(), { once: true }); });
                return { agent, dispose: () => { disposed++; if (options.hangDispose)
                        return new Promise(() => { }); } };
            } },
    };
    return { runtime, requests, created, hooks, get disposed() { return disposed; }, get cancelled() { return cancelled; } };
}
try {
    const good = fixture(), engine = createCompanionRuntime();
    check('a detached runtime cannot claim chat readiness', !engine.ready());
    const stop = await engine.attach(good.runtime);
    check('the model route comes from DSH default selection', engine.ready() && engine.model()?.provider === 'fixture');
    let generating = 0;
    const reply = await engine.reply([], '你好', { signal: new AbortController().signal, generating: () => generating++ });
    check('a committed completed native assistant message becomes the reply', reply === '你好，我是大肥鱼。');
    check('reasoning is never returned to the UI', !reply.includes('private-reasoning'));
    check('generating starts only after the final request passes admission', generating === 1 && good.requests.length === 1);
    const options = good.created[0];
    check('every turn uses an isolated fresh session and empty temporary workspace', options?.sessionId.startsWith('podwhale-companion-') && options.meta.cwd.includes('podwhale-companion-')
        && !Object.hasOwn(options, 'parentAgent') && !Object.hasOwn(options, 'resumeSessionId'));
    check('the native handle is cancelled and disposed after delivery', good.disposed === 1 && good.cancelled >= 1);
    await stop();
    check('detach removes native listeners and readiness', !engine.ready() && [...good.hooks.values()].every(set => set.size === 0));
    const cwdFixture = fixture({ knownCwd: true }), cwdRuntime = createCompanionRuntime(), cwdStop = await cwdRuntime.attach(cwdFixture.runtime);
    check('the known SDK cwd context is removed before model admission', await cwdRuntime.reply([], 'hello', { signal: new AbortController().signal, generating() { } }) === '你好，我是大肥鱼。'
        && cwdFixture.requests.length === 1 && !JSON.stringify(cwdFixture.requests).includes('fixture-private-cwd'));
    await cwdStop();
    const omittedTools = fixture({ tamper: request => { delete request.tools; } }), omittedRuntime = createCompanionRuntime();
    const omittedStop = await omittedRuntime.attach(omittedTools.runtime);
    check('official SDK omission of zero tool schemas still admits only a tool-free turn', await omittedRuntime.reply([], 'hello', { signal: new AbortController().signal, generating() { } }) === '你好，我是大肥鱼。'
        && omittedTools.requests.length === 1 && !Object.hasOwn(omittedTools.requests[0], 'tools'));
    await omittedStop();
    for (const [label, scenario] of [
        ['required private context', { extraContext: true }], ['unrestricted tools', { ignoreRestriction: true }],
        ['foreign session events', { foreignSession: true }], ['uncommitted turn', { failedTurn: true }],
        ['tool output', { toolOutput: true }], ['reasoning-only output', { empty: true }],
        ['wrong provider', { tamper: (r) => { r.provider = 'other'; } }],
        ['wrong session route', { tamper: (r) => { r.sessionId = 'main-chat'; } }],
        ['extra inherited message', { tamper: (r) => { if (Array.isArray(r.messages))
                    r.messages.push({ role: 'user', content: [{ type: 'text', text: 'workspace-secret' }] }); } }],
        ['extra network tool', { tamper: (r) => { r.tools = [{ name: 'file' }]; } }],
        ['invalid null tool schemas', { tamper: (r) => { r.tools = null; } }],
        ['a repeated model request', { repeatRequest: true }],
    ]) {
        const f = fixture(scenario), runtime = createCompanionRuntime();
        const dispose = await runtime.attach(f.runtime);
        check('chat fails closed for ' + label, await rejects(() => runtime.reply([], '测试', { signal: new AbortController().signal, generating() { } })));
        if (scenario.extraContext || scenario.ignoreRestriction || scenario.tamper)
            check('rejected context does not reach the model: ' + label, f.requests.length === 0);
        await dispose();
    }
    const hanging = fixture({ hang: true }), short = createCompanionRuntime({ timeoutMs: 50 });
    const stopShort = await short.attach(hanging.runtime);
    check('a hung native turn is timed out and cancelled', await rejects(() => short.reply([], 'hello', { signal: new AbortController().signal, generating() { } })) && hanging.cancelled > 0);
    await stopShort();
    for (const [label, scenario] of [['native initialization', { hangCreate: true }], ['prompt assembly', { hangPrompt: true }]]) {
        const f = fixture(scenario), runtime = createCompanionRuntime({ timeoutMs: 50 }), dispose = await runtime.attach(f.runtime);
        const result = await Promise.race([rejects(() => runtime.reply([], 'hello', { signal: new AbortController().signal, generating() { } })), delay(2000, false)]);
        check('the deadline covers uncooperative ' + label, result && f.requests.length === 0);
        await dispose();
    }
    const hangingCleanup = fixture({ hangDispose: true }), cleanupRuntime = createCompanionRuntime({ timeoutMs: 100 });
    const cleanupStop = await cleanupRuntime.attach(hangingCleanup.runtime);
    const cleanupResult = await Promise.race([cleanupRuntime.reply([], 'hello', { signal: new AbortController().signal, generating() { } }), delay(2000, 'cleanup-timeout')]);
    check('uncooperative cleanup cannot retain a completed conversation slot', cleanupResult === '你好，我是大肥鱼。' && hangingCleanup.disposed === 1);
    await cleanupStop();
    const late = fixture({ lateHandle: true }), lateRuntime = createCompanionRuntime({ timeoutMs: 50 });
    const lateStop = await lateRuntime.attach(late.runtime);
    check('a handle resolving during abort is disposed exactly once without generating', await rejects(() => lateRuntime.reply([], 'hello', { signal: new AbortController().signal, generating() { } }))
        && late.disposed === 1 && late.requests.length === 0);
    await lateStop();
    const noModel = createCompanionRuntime(), noModelStop = await noModel.attach(fixture({ modelMissing: true }).runtime);
    check('an unconfigured model cannot initiate a chat turn', !noModel.ready() && await rejects(() => noModel.reply([], 'hello', { signal: new AbortController().signal, generating() { } })));
    await noModelStop();
    const calls = [];
    const model = { ready: () => true, model: () => ({ provider: 'fixture', model: 'chat' }),
        reply: (history, text, options) => new Promise((resolve, reject) => {
            calls.push({ history, text, generating: options.generating, resolve, reject });
            options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }) };
    const file = join(temp, 'companion.json'), service = createCompanionService({ file, engine: model });
    services.push(service);
    const initial = await service.view('desktop');
    check('opening chat does not invoke a model or fabricate a reply', initial.ready && !initial.messages.length && calls.length === 0);
    const first = await service.send('desktop', { requestId: 'request-0001', text: '邮箱 a@example.com，密钥 sk-12345678901234567890' });
    check('input is redacted before model admission and persistence', first.input.includes('[邮箱]') && first.input.includes('[密钥]') && !calls[0]?.text.includes('a@example.com'));
    check('preparing does not masquerade as active generation', first.state === 'preparing' && (await service.view('desktop')).job?.state === 'preparing');
    check('retrying the same request does not start a second turn', (await service.send('desktop', { requestId: 'request-0001', text: first.input })).id === first.id && calls.length === 1);
    check('the same request identifier cannot change input', await rejects(() => service.send('desktop', { requestId: 'request-0001', text: 'changed input' }), 'companion_conflict'));
    check('a conversation admits only one active job', await rejects(() => service.send('desktop', { requestId: 'request-0002', text: 'second' }), 'companion_busy'));
    check('clearing cannot race an active job', await rejects(() => service.clear('desktop'), 'companion_busy'));
    calls[0].generating();
    check('only native admission transitions a job into generating', (await service.view('desktop')).job?.state === 'generating');
    calls[0].resolve('回复 a@example.com');
    for (let i = 0; i < 100 && (await service.view('desktop')).job?.state !== 'completed'; i++)
        await delay(10);
    const complete = await service.view('desktop', first.id);
    check('only successful paired turns are saved as conversation context', complete.job?.state === 'completed' && complete.messages.map(m => m.role).join(',') === 'user,assistant');
    check('assistant text is also redacted before it is shown or saved', complete.job?.reply?.includes('[邮箱]') && !(await readFile(file, 'utf8')).includes('a@example.com'));
    const reloaded = createCompanionService({ file, engine: model });
    services.push(reloaded);
    check('chat history survives a host restart without invoking a model', (await reloaded.view('desktop')).messages.length === 2 && calls.length === 1);
    await reloaded.close();
    const second = await service.send('desktop', { requestId: 'request-0002', text: 'remember this turn' });
    check('the next prompt contains only this conversation history', calls[1]?.history.length === 2 && calls[1]?.history[0]?.text.includes('[邮箱]'));
    await service.cancel('desktop', second.id);
    check('cancelled work cannot append a late reply', (await service.view('desktop', second.id)).job?.state === 'cancelled' && (await service.view('desktop')).messages.length === 2);
    for (let i = 0; i < 100 && await rejects(() => service.clear('desktop'), 'companion_busy'); i++)
        await delay(5);
    check('clearing visible history does not replay an already admitted request', await rejects(() => service.send('desktop', { requestId: 'request-0001', text: first.input }), 'companion_conflict'));
    const wechatScope = 'wechat:' + 'a'.repeat(64);
    const third = await service.send(wechatScope, { requestId: 'request-wechat-1', text: '微信对话' });
    check('WeChat receives an isolated empty context', calls.at(-1)?.history.length === 0 && (await service.view(wechatScope)).messages.length === 0);
    check('job identifiers cannot read another conversation', await rejects(() => service.view('desktop', third.id), 'companion_job_not_found'));
    await service.cancel(wechatScope, third.id);
    await delay(10);
    check('bad input is rejected without model calls', await rejects(() => service.send('desktop', { requestId: 'bad', text: 'x' }), 'companion_invalid_input')
        && await rejects(() => service.send('desktop', { requestId: 'request-large', text: 'x'.repeat(4001) }), 'companion_invalid_input'));
    const parallelA = await service.send('desktop', { requestId: 'request-parallel-a', text: 'desktop pending' });
    const parallelB = await service.send(wechatScope, { requestId: 'request-parallel-b', text: 'wechat pending' });
    const callsBeforeLimit = calls.length;
    check('two conversations are the global admission limit', await rejects(() => service.send('wechat:' + 'b'.repeat(64), { requestId: 'request-parallel-c', text: 'third pending' }), 'companion_limit') && calls.length === callsBeforeLimit);
    const interruptedFile = join(temp, 'interrupted.json');
    await writeFile(interruptedFile, await readFile(file, 'utf8'));
    const interrupted = createCompanionService({ file: interruptedFile, engine: model });
    services.push(interrupted);
    const restoredJob = (await interrupted.view('desktop', parallelA.id)).job;
    check('host restart cancels pending work without replaying the model', restoredJob?.state === 'cancelled'
        && restoredJob.error === 'companion_interrupted' && calls.length === callsBeforeLimit);
    check('interrupted state is durable before new work is admitted', JSON.parse(await readFile(interruptedFile, 'utf8')).conversations
        .find((item) => item.scope === 'desktop').jobs.at(-1).state === 'cancelled');
    check('a restarted request remains idempotent instead of calling the model', (await interrupted.send('desktop', { requestId: 'request-parallel-a', text: 'desktop pending' })).id === parallelA.id
        && calls.length === callsBeforeLimit);
    await interrupted.close();
    await service.cancel('desktop', parallelA.id);
    await service.cancel(wechatScope, parallelB.id);
    await service.close();
    check('a disposed service cannot start new work', await rejects(() => service.send('desktop', { requestId: 'request-closed', text: 'hello' }), 'companion_not_ready'));
    const capacity = createCompanionService({ file: join(temp, 'capacity.json'), engine: model });
    services.push(capacity);
    for (let index = 1; index <= 15; index++)
        await capacity.view('wechat:' + index.toString(16).padStart(64, '0'));
    check('WeChat cannot consume the reserved desktop conversation slot', await rejects(() => capacity.view('wechat:' + 'f'.repeat(64)), 'companion_limit') && (await capacity.view('desktop')).ok);
    const badFile = join(temp, 'broken.json');
    await writeFile(badFile, '{"version": 99}');
    const broken = createCompanionService({ file: badFile, engine: model });
    services.push(broken);
    check('corrupt private storage is not silently reset', await rejects(() => broken.view('desktop'), 'companion_store_unavailable') && (await readFile(badFile, 'utf8')).includes('99'));
    check('the fixed system prompt describes a tool-free local companion', COMPANION_SYSTEM.includes('没有任何工具'));
    check('request validator rejects absent carrier data', await rejects(async () => assertCompanionRequest({}, { sessionId: 'session', provider: 'fixture', model: 'chat', input: 'hello' })));
    const setupHome = join(temp, 'setup-home');
    const configured = await setupCompanionWechat({ home: setupHome, wechatRoot: temp, hostBaseUrl: 'http://127.0.0.1:9911', accounts: ['100'], peers: ['private:100:200'] });
    const access = JSON.parse(await readFile(configured.accessFile, 'utf8'));
    const client = JSON.parse(await readFile(configured.clientFile, 'utf8'));
    check('server bridge credentials contain only a hash and explicit allowlists', record(access) && record(client) && typeof client.hostToken === 'string'
        && access.tokenHash === createHash('sha256').update(client.hostToken).digest('hex') && !Object.hasOwn(access, 'hostToken'));
    check('setup never rotates existing credentials implicitly', await rejects(() => setupCompanionWechat({ home: setupHome, wechatRoot: temp, hostBaseUrl: 'http://127.0.0.1:9911', accounts: ['100'], peers: ['private:100:200'] })));
    check('setup rejects public network hosts', await rejects(() => setupCompanionWechat({ home: join(temp, 'bad-home'), wechatRoot: temp, hostBaseUrl: 'http://example.com', accounts: ['100'], peers: ['private:100:200'] })));
    check('setup rejects a peer from a different account', await rejects(() => setupCompanionWechat({ home: join(temp, 'bad-home'), wechatRoot: temp, hostBaseUrl: 'http://127.0.0.1:9911', accounts: ['100'], peers: ['private:999:200'] })));
    check('setup rejects placeholder and self-chat IDs that the relay cannot use', await rejects(() => setupCompanionWechat({ home: join(temp, 'bad-home'), wechatRoot: temp, hostBaseUrl: 'http://127.0.0.1:9911', accounts: ['SELF_ID'], peers: ['private:SELF_ID:200'] }))
        && await rejects(() => setupCompanionWechat({ home: join(temp, 'bad-home'), wechatRoot: temp, hostBaseUrl: 'http://127.0.0.1:9911', accounts: ['100'], peers: ['private:100:100'] })));
    check('setup reserves a desktop slot within the private conversation limit', await rejects(() => setupCompanionWechat({
        home: join(temp, 'bad-home'), wechatRoot: temp, hostBaseUrl: 'http://127.0.0.1:9911', accounts: ['100'],
        peers: Array.from({ length: 16 }, (_unused, index) => 'private:100:' + (200 + index)),
    })));
    await setCompanionWechatEnabled(setupHome, false);
    check('disabling the bridge preserves its hash while closing admission', JSON.parse(await readFile(configured.accessFile, 'utf8')).enabled === false);
    await setCompanionWechatEnabled(setupHome, true);
    check('re-enabling uses the existing credential instead of silently rotating', record(access) && JSON.parse(await readFile(configured.accessFile, 'utf8')).tokenHash === access.tokenHash);
}
catch (error) {
    check('companion integration completes without an unexpected exception', false);
    console.error(error instanceof Error ? error : 'test failed');
}
finally {
    await Promise.allSettled(services.map(service => service.close()));
    const actual = await realpath(temp), parent = await realpath(join(root, '.tmp'));
    if (dirname(actual).toLowerCase() !== parent.toLowerCase() || !basename(actual).startsWith('companion-test-'))
        throw new Error('unsafe companion fixture cleanup');
    await rm(actual, { recursive: true, force: true });
}
console.log(failed ? `${failed} FAILED` : 'ALL PASS');
process.exitCode = failed ? 1 : 0;
