/** Explicitly started, loopback-only adapter for a separately installed WeChatAgent. */
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isIP } from 'node:net';
import { request as httpRequest } from 'node:http';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { companionWechatRequestId, companionWechatScope } from './companion-types.mjs';
import { field } from './redact.js';
export const REVIEWED_WECHAT_COMMIT = '38c1060ce500a294d69a4a2f9e07ca1b63a08b06';
/** Actual file SHA256 values, not Git's blob IDs. Includes the entry's JS import closure. */
export const REVIEWED_WECHAT_FILES = Object.freeze({
    'components/qq-bridge/src/core/proactive-policy.js': 'd30349ca67dc2431d4cd99a6a9b1d5a1c2dce9bb5a6246b340a71045199f838b',
    'components/qq-bridge/src/core/sticker-policy.js': 'ce0b8de3ef3dbe0a45dd0399017177c25107d07e3fabf22bb1cd456e2fea5bc1',
    'components/qq-bridge/src/core/wechat-events.js': 'a429a9c9324f8df7ebb3bb06993e7f82a5039264a22271f8527d6f83c9ab2d57',
    'packages/dsh-social-bridge-plugin/assistant-policy.mjs': 'e6a7e13a1a917dbc342897abd01c0fa0e80d2c768dac7028a8ca356906dce6b2',
    'packages/dsh-social-bridge-plugin/file-transfers.mjs': '6e8ed10653c78cfd95f24f9893c9a0b843b5a58ba2e922ce27858c6f0dc76e66',
    'scripts/file-delivery-worker.mjs': 'df05276d66c24898ec98383230d3978794b27aa0b5523c041d663cafd1a4ec8b',
    'scripts/hook-onebot.mjs': 'dd1a3932cdcf2a6ab49e144b5e07a89e13217cb4038df2b02aabce122c7a8d7a',
    'scripts/hook-profiles.mjs': 'cf55a52f7b66a7f9396f66f39e2df030b406822278692f9fb16f6fefee9ddf17',
    'scripts/reader-account-state.mjs': '728fdab0c4caca4cd5e203be209f97657b9edb6ac9e270aba6f2ef1616b1ed82',
    'scripts/text-delivery-store.mjs': 'e640469137935720aa30727bf2e2ed637ea2fbfce79859da16323d40e22d3c6c',
    'scripts/wechat-account-check.mjs': 'a77b0f8b16dde3c4b3a8e8807daa0f2badb60ac61aac31548064f094a82adef8',
});
const API = '/xiaolanshu/api/companion/wechat/';
const numericId = (value) => {
    const text = typeof value === 'number' || typeof value === 'string' ? String(value) : '';
    return /^[1-9]\d{0,9}$/.test(text) && Number(text) <= 2147483647 ? text : undefined;
};
function object(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
class RelayFault extends Error {
    constructor(code) { super(code); }
}
function fault(code) { throw new RelayFault(code); }
export function wechatRelayError(value) {
    return value instanceof RelayFault ? value.message : 'relay_unavailable';
}
function text(value) {
    return typeof value === 'string' && !!value.trim() && Buffer.byteLength(value) <= 12000
        && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value) && !/\[CQ:/i.test(value);
}
export function relayHostOrigin(value) {
    if (typeof value !== 'string')
        fault('relay_invalid_config');
    let url;
    try {
        url = new URL(value);
    }
    catch {
        return fault('relay_invalid_config');
    }
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const local = host === 'localhost' || host === '::1' || isIP(host) === 4 && host.startsWith('127.');
    if (!local || url.protocol !== 'http:' || url.username || url.password || url.search || url.hash
        || url.pathname !== '/')
        fault('relay_invalid_config');
    return url.origin;
}
/** Node fetch adds Sec-Fetch-Mode. The machine-only Host API deliberately rejects it. */
export const relayHttpFetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    relayHostOrigin(url.origin);
    if (url.username || url.password || url.hash || init.body !== undefined && typeof init.body !== 'string')
        fault('relay_invalid_config');
    // Never resolve a configurable DNS name when forwarding a bridge credential.
    if (url.hostname === 'localhost')
        url.hostname = '127.0.0.1';
    const headers = new Headers(init.headers);
    return new Promise((done, reject) => {
        const req = httpRequest(url, { method: init.method ?? 'GET', headers: Object.fromEntries(headers), agent: false,
            signal: init.signal ?? AbortSignal.timeout(10000) }, res => {
            const chunks = [];
            let size = 0;
            res.on('data', (chunk) => {
                if (!Buffer.isBuffer(chunk)) {
                    req.destroy(new RelayFault('relay_host_invalid'));
                    return;
                }
                size += chunk.length;
                if (size > 65536) {
                    req.destroy(new RelayFault('relay_host_invalid'));
                    return;
                }
                chunks.push(chunk);
            });
            res.on('error', reject);
            res.on('end', () => {
                const responseHeaders = new Headers();
                for (const [key, value] of Object.entries(res.headers)) {
                    if (typeof value === 'string')
                        responseHeaders.set(key, value);
                    else if (Array.isArray(value))
                        for (const item of value)
                            responseHeaders.append(key, item);
                }
                try {
                    done(new Response(chunks.length ? Buffer.concat(chunks).toString('utf8') : null, { status: res.statusCode ?? 500, headers: responseHeaders }));
                }
                catch {
                    reject(new RelayFault('relay_host_invalid'));
                }
            });
        });
        req.on('error', reject);
        req.end(init.body);
    });
};
function peerKey(event) { return `${event.peerType}:${event.selfId}:${event.peerId}`; }
function limits(value, fallback, max) {
    if (value === undefined)
        return fallback;
    if (!Number.isSafeInteger(value) || value < 1 || value > max)
        fault('relay_invalid_config');
    return value;
}
function lists(accounts, peers) {
    if (!Array.isArray(accounts) || !accounts.length || accounts.length > 50
        || !accounts.every((id) => typeof id === 'string' && numericId(id) === id)
        || new Set(accounts).size !== accounts.length || !Array.isArray(peers) || !peers.length || peers.length > 200
        || !peers.every((entry) => {
            if (typeof entry !== 'string')
                return false;
            const [kind, self, peer, extra] = entry.split(':');
            return (kind === 'private' || kind === 'group') && !!self && !!peer && extra === undefined
                && numericId(self) === self && numericId(peer) === peer && self !== peer && accounts.includes(self);
        }) || new Set(peers).size !== peers.length)
        fault('relay_invalid_config');
    return { accounts: [...accounts], peers: [...peers] };
}
/** Accept only incoming text. Groups must explicitly mention this account. */
export function normalizeWechatRelayEvent(value) {
    if (!object(value) || value.post_type !== 'message' || value.isSend === true || value.sub_type === 'self'
        || !['private', 'group'].includes(String(value.message_type)))
        return;
    const selfId = numericId(value.self_id), senderId = numericId(value.user_id);
    const peerType = value.message_type === 'group' ? 'group' : 'private';
    const peerId = peerType === 'group' ? numericId(value.group_id) : senderId;
    const rawId = typeof value.message_id === 'number' || typeof value.message_id === 'string' ? String(value.message_id) : '';
    if (typeof value.message_id === 'number' && (!Number.isSafeInteger(value.message_id) || value.message_id < 1))
        return;
    if (!selfId || !senderId || !peerId || senderId === selfId || peerId === selfId || !rawId
        || Buffer.byteLength(rawId) > 256 || /[\x00-\x1f\x7f]/.test(rawId) || !Array.isArray(value.message)
        || !value.message.length || value.message.length > 32)
        return;
    let joined = '', addressed = false;
    for (const segment of value.message) {
        if (!object(segment) || !object(segment.data))
            return;
        if (segment.type === 'text' && typeof segment.data.text === 'string')
            joined += segment.data.text;
        else if (peerType === 'group' && segment.type === 'at' && numericId(segment.data.qq) === selfId)
            addressed = true;
        else
            return;
    }
    const message = joined.trim();
    if (peerType === 'group' && !addressed || !text(joined) || message.length > 4000)
        return;
    return Object.freeze({ selfId, peerType, peerId, senderId,
        messageId: 'ob-' + createHash('sha256').update(rawId).digest('hex'), text: message });
}
function sameTarget(value, expected) {
    return object(value) && value.selfId === expected.selfId && value.peerType === expected.peerType
        && value.peerId === expected.peerId && value.senderId === expected.senderId;
}
async function bounded(work, timeout, signal) {
    signal.throwIfAborted();
    let timer;
    let cancel;
    try {
        return await Promise.race([work, new Promise((_, reject) => {
                timer = setTimeout(() => reject(new RelayFault('relay_timeout')), timeout);
                cancel = () => reject(new RelayFault('relay_stopped'));
                signal.addEventListener('abort', cancel, { once: true });
                if (signal.aborted)
                    cancel();
            })]);
    }
    finally {
        clearTimeout(timer);
        if (cancel)
            signal.removeEventListener('abort', cancel);
    }
}
/** Creation is inert. start() must succeed before an event can be queued. */
export function createWechatRelay(options) {
    const origin = relayHostOrigin(options.hostBaseUrl);
    const allowed = lists(options.accounts, options.peers);
    if (typeof options.hostToken !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/.test(options.hostToken))
        fault('relay_invalid_config');
    const token = options.hostToken, upstream = options.upstream, transport = options.fetchImpl ?? relayHttpFetch;
    const pollMs = limits(options.pollMs, 300, 10000), timeout = limits(options.jobTimeoutMs, 120000, 600000);
    const requestTimeout = limits(options.requestTimeoutMs, 10000, 60000);
    const sendTimeout = limits(options.sendTimeoutMs, 30000, 60000);
    const maxQueue = limits(options.maxQueue, 32, 200), maxSeen = limits(options.maxSeen, 4096, 10000);
    const concurrency = limits(options.concurrency, 2, 4);
    if (maxSeen < maxQueue)
        fault('relay_invalid_config');
    const control = new AbortController();
    const signal = options.signal ? AbortSignal.any([control.signal, options.signal]) : control.signal;
    const queues = new Map(), active = new Set();
    const workers = new Set(), seen = new Map();
    let ready = false, stopped = false, starting = false, boundAccount = '', boundSelf = '', pendingCount = 0;
    let completed = 0, failed = 0, lastError = null, stopping;
    async function identity(event) {
        signal.throwIfAborted();
        upstream.reload();
        const value = await bounded(upstream.checkNative(), requestTimeout, signal);
        if (!object(value) || typeof value.account !== 'string' || !value.account || value.account.length > 1024)
            fault('relay_account_invalid');
        const self = numericId(value.selfId);
        if (!self || !allowed.accounts.includes(self) || event && event.selfId !== self)
            fault('relay_account_denied');
        if (boundAccount && (boundAccount !== value.account || boundSelf !== self))
            fault('relay_account_changed');
        if (event && (!allowed.peers.includes(peerKey(event)) || !upstream.allowed(event.peerType, event.peerId)))
            fault('relay_peer_denied');
        signal.throwIfAborted();
        return { account: value.account, self };
    }
    async function request(route, body, expectedStatus) {
        const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(requestTimeout)]);
        const response = await transport(origin + API + route, { method: 'POST', redirect: 'error', signal: requestSignal,
            headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) });
        if (response.status !== expectedStatus || !response.headers.get('content-type')?.startsWith('application/json'))
            fault('relay_host_rejected');
        const reader = response.body?.getReader();
        if (!reader)
            fault('relay_host_invalid');
        const chunks = [];
        let size = 0;
        try {
            for (;;) {
                const chunk = await reader.read();
                if (chunk.done)
                    break;
                size += chunk.value.byteLength;
                if (size > 65536)
                    fault('relay_host_invalid');
                chunks.push(chunk.value);
            }
            const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (!object(value) || value.ok !== true)
                fault('relay_host_invalid');
            return value;
        }
        finally {
            await reader.cancel().catch(() => { });
            reader.releaseLock();
        }
    }
    function job(value, event, expectedId) {
        if (!object(value) || typeof value.id !== 'string' || !/^[A-Za-z0-9_.@-]{1,256}$/.test(value.id)
            || value.requestId !== companionWechatRequestId(event, event.messageId) || value.input !== field(event.text, 4000).text
            || typeof value.state !== 'string' || !['preparing', 'generating', 'completed', 'failed', 'cancelled'].includes(value.state)
            || expectedId !== undefined && value.id !== expectedId)
            fault('relay_job_mismatch');
        return value;
    }
    async function run(event) {
        const deadline = Date.now() + timeout;
        await identity(event);
        const accepted = await request('messages', event, 202);
        if (accepted.target !== undefined && !sameTarget(accepted.target, event))
            fault('relay_job_mismatch');
        let current = job(accepted.job, event);
        const jobId = String(current.id);
        for (;;) {
            signal.throwIfAborted();
            if (Date.now() >= deadline)
                fault('relay_timeout');
            if (current.state === 'failed' || current.state === 'cancelled')
                fault('relay_job_failed');
            if (current.state === 'completed')
                break;
            await delay(Math.min(pollMs, Math.max(1, deadline - Date.now())), undefined, { signal });
            const view = await request('status', { selfId: event.selfId, peerType: event.peerType, peerId: event.peerId,
                senderId: event.senderId, jobId }, 200);
            if (view.target !== undefined && !sameTarget(view.target, event))
                fault('relay_job_mismatch');
            current = job(view.job, event, jobId);
        }
        if (!text(current.reply))
            fault('relay_reply_invalid');
        await identity(event);
        if (Date.now() >= deadline)
            fault('relay_timeout');
        // Stable across relay restarts and Host job regeneration. The upstream's
        // durable delivery store rejects a changed reply instead of sending twice.
        const deliveryId = createHash('sha256').update(JSON.stringify([companionWechatScope(event), event.messageId])).digest('hex');
        const response = await bounded(upstream.action({ action: event.peerType === 'group' ? 'send_group_msg' : 'send_private_msg',
            params: { ...(event.peerType === 'group' ? { group_id: event.peerId } : { user_id: event.peerId }),
                message: [{ type: 'text', data: { text: current.reply } }], wechatagent_delivery_id: deliveryId }, echo: deliveryId }), sendTimeout, signal);
        if (!object(response) || response.echo !== deliveryId || response.status !== 'ok' || response.retcode !== 0
            || !object(response.data) || response.data.receipt !== 'wechat-server-id'
            || response.data.delivered !== 'database-confirmed')
            fault('relay_send_unconfirmed');
        completed++;
    }
    function pump() {
        if (!ready || stopped || signal.aborted)
            return;
        for (const [key, queue] of queues) {
            if (active.size >= concurrency)
                break;
            if (active.has(key))
                continue;
            const event = queue.shift();
            if (!event) {
                queues.delete(key);
                continue;
            }
            active.add(key);
            const worker = run(event).catch((error) => {
                failed++;
                lastError = wechatRelayError(error);
                try {
                    options.onError?.(lastError);
                }
                catch { /* Diagnostics cannot turn a failed job into a retry. */ }
            })
                .finally(() => { active.delete(key); pendingCount--; seen.set(companionWechatRequestId(event, event.messageId), true); workers.delete(worker); pump(); });
            workers.add(worker);
        }
    }
    const abort = () => { ready = false; queues.clear(); void stop(); };
    signal.addEventListener('abort', abort, { once: true });
    async function stop() {
        if (stopping)
            return stopping;
        stopped = true;
        ready = false;
        signal.removeEventListener('abort', abort);
        control.abort();
        queues.clear();
        stopping = (async () => {
            try {
                await upstream.stop();
            }
            catch {
                lastError = 'relay_upstream_failed';
            }
            await Promise.allSettled([...workers]);
            pendingCount = 0;
        })();
        return stopping;
    }
    return {
        async start() {
            if (ready || stopped || starting || signal.aborted)
                fault('relay_not_startable');
            starting = true;
            try {
                const first = await identity();
                boundAccount = first.account;
                boundSelf = first.self;
                ready = true;
            }
            finally {
                starting = false;
            }
        },
        accept(value) {
            if (!ready || stopped || signal.aborted || pendingCount >= maxQueue)
                return false;
            const event = normalizeWechatRelayEvent(value);
            if (!event || event.selfId !== boundSelf || !allowed.accounts.includes(event.selfId) || !allowed.peers.includes(peerKey(event)))
                return false;
            const id = companionWechatRequestId(event, event.messageId);
            if (seen.has(id))
                return false;
            while (seen.size >= maxSeen) {
                const old = [...seen].find(([, settled]) => settled);
                if (!old)
                    return false;
                seen.delete(old[0]);
            }
            seen.set(id, false);
            pendingCount++;
            const key = companionWechatScope(event), queue = queues.get(key) ?? [];
            queue.push(event);
            queues.set(key, queue);
            pump();
            return true;
        },
        async settle() { while (workers.size)
            await Promise.allSettled([...workers]); },
        stop,
        snapshot() { return { ready: ready && !signal.aborted, stopped, pending: pendingCount, completed, failed, lastError }; },
    };
}
export async function readWechatRelayConfig(filename) {
    try {
        if (!isAbsolute(filename))
            fault('relay_invalid_config');
        const info = await lstat(filename);
        if (!info.isFile() || info.isSymbolicLink() || info.size > 16384 || process.platform !== 'win32' && (info.mode & 0o077) !== 0)
            fault('relay_invalid_config');
        const value = JSON.parse(await readFile(filename, 'utf8'));
        if (!object(value) || Object.keys(value).some(key => !['enabled', 'wechatRoot', 'hostBaseUrl', 'hostToken', 'accounts', 'peers'].includes(key))
            || value.enabled !== true || typeof value.wechatRoot !== 'string' || !isAbsolute(value.wechatRoot)
            || typeof value.hostToken !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/.test(value.hostToken))
            fault('relay_invalid_config');
        return { enabled: true, wechatRoot: value.wechatRoot, hostBaseUrl: relayHostOrigin(value.hostBaseUrl),
            hostToken: value.hostToken, ...lists(value.accounts, value.peers) };
    }
    catch {
        return fault('relay_invalid_config');
    }
}
function hookConstructor(value) {
    if (typeof value !== 'function')
        return false;
    const prototype = value.prototype;
    return object(prototype) && ['reload', 'allowed', 'checkNative', 'action', 'receiveSse', 'stop', 'flush'].every(key => typeof prototype[key] === 'function');
}
export async function loadReviewedWechatUpstream(directory, signal) {
    try {
        const root = await realpath(directory);
        for (const [name, hash] of Object.entries(REVIEWED_WECHAT_FILES)) {
            const filename = join(root, ...name.split('/')), actual = await realpath(filename), info = await lstat(filename);
            if (relative(root, actual).replaceAll('\\', '/').toLowerCase() !== name.toLowerCase()
                || !info.isFile() || info.isSymbolicLink() || info.size > 1048576
                || createHash('sha256').update(await readFile(filename)).digest('hex') !== hash)
                fault('relay_upstream_unreviewed');
        }
        const module = await import(pathToFileURL(join(root, 'scripts', 'hook-onebot.mjs')).href);
        if (!object(module) || !hookConstructor(module.HookOneBot))
            fault('relay_upstream_unreviewed');
        const Constructor = module.HookOneBot;
        let receiver;
        class RelayHook extends Constructor {
            flush() { while (this.pending.length) {
                const event = this.pending.shift();
                receiver?.(event);
            } }
        }
        const instance = new RelayHook({ directory: root, fetchImpl: (input, init = {}) => {
                const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
                relayHostOrigin(url.origin);
                if (url.username || url.password || url.hash)
                    fault('relay_invalid_config');
                return fetch(input, { ...init, redirect: 'error', signal: AbortSignal.any([signal, ...(init.signal ? [init.signal] : [])]) });
            } });
        if (!Array.isArray(instance.pending))
            fault('relay_upstream_unreviewed');
        return { upstream: instance, read(onEvent) {
                if (receiver || signal.aborted)
                    fault('relay_not_startable');
                receiver = onEvent;
                // Deliberately never call start/connectOneBot: the existing upstream keeps its own OneBot connection.
                const reading = instance.receiveSse();
                instance.tasks = [reading];
                return reading;
            } };
    }
    catch {
        return fault('relay_upstream_unreviewed');
    }
}
export async function runWechatRelayCli(args) {
    if (!args.length) {
        console.log('WeChat relay is disabled. Explicit start: node wechat-relay.mjs --config <private absolute JSON file>');
        return;
    }
    if (args.length !== 2 || args[0] !== '--config' || !args[1] || !isAbsolute(args[1]))
        fault('relay_invalid_arguments');
    const config = await readWechatRelayConfig(args[1]);
    const control = new AbortController(), source = await loadReviewedWechatUpstream(config.wechatRoot, control.signal);
    const relay = createWechatRelay({ ...config, upstream: source.upstream, signal: control.signal,
        onError: code => console.error(code) });
    const stop = () => control.abort();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    try {
        await relay.start();
        void source.read(event => { relay.accept(event); }).then(() => {
            if (!control.signal.aborted) {
                console.error('relay_upstream_stopped');
                control.abort();
            }
        }, () => { console.error('relay_upstream_failed'); control.abort(); });
        console.log('WeChat relay ready; explicit account and peer allowlists verified.');
        await new Promise(done => { control.signal.addEventListener('abort', () => done(), { once: true }); if (control.signal.aborted)
            done(); });
    }
    finally {
        control.abort();
        await relay.stop();
        process.removeListener('SIGINT', stop);
        process.removeListener('SIGTERM', stop);
    }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
    try {
        await runWechatRelayCli(process.argv.slice(2));
    }
    catch (error) {
        console.error(wechatRelayError(error));
        process.exitCode = 1;
    }
}
