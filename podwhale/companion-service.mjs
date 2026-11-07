/** Private local transcripts and idempotent jobs; never the community database. */
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { field } from './redact.js';
const fault = (code, status, cause) => Object.assign(new Error(code, { cause }), { code, status });
const states = new Set(['preparing', 'generating', 'completed', 'failed', 'cancelled']);
const MAX_FILE = 8 * 1024 * 1024;
function record(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
function scopeValid(value) { return value === 'desktop' || /^wechat:[a-f0-9]{64}$/.test(value); }
function key(value) { return typeof value === 'string' && /^[A-Za-z0-9_-]{8,100}$/.test(value); }
function date(value) { return typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value)); }
function hash(value) { return createHash('sha256').update(value).digest('hex'); }
function publicJob(job) {
    const { inputHash: _hash, ...view } = job;
    return structuredClone(view);
}
export function createCompanionService({ file, engine }) {
    const conversations = new Map();
    const receipts = new Map();
    const active = new Map();
    let loaded = false, closed = false;
    let tail = Promise.resolve();
    function locked(fn) {
        const next = tail.then(fn, fn);
        tail = next.catch(() => { });
        return next;
    }
    async function persist() {
        const bytes = JSON.stringify({ version: 1, conversations: [...conversations.values()], receipts: [...receipts] });
        if (Buffer.byteLength(bytes) > MAX_FILE)
            throw fault('companion_limit', 429);
        try {
            await mkdir(dirname(file), { recursive: true });
            const info = await lstat(file).catch((error) => {
                if (record(error) && error.code === 'ENOENT')
                    return null;
                throw error;
            });
            if (info && (!info.isFile() || info.isSymbolicLink()))
                throw new Error('invalid private transcript');
            const temporary = file + '.' + process.pid + '.tmp';
            await writeFile(temporary, bytes, { mode: 0o600 });
            await rename(temporary, file);
        }
        catch (error) {
            throw fault('companion_store_unavailable', 503, error);
        }
    }
    async function load() {
        if (loaded)
            return;
        let raw;
        try {
            const info = await lstat(file);
            if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_FILE)
                throw new Error('invalid private transcript');
            raw = JSON.parse(await readFile(file, 'utf8'));
        }
        catch (error) {
            if (record(error) && error.code === 'ENOENT') {
                loaded = true;
                return;
            }
            throw fault('companion_store_unavailable', 503);
        }
        try {
            if (!record(raw) || raw.version !== 1 || !Array.isArray(raw.conversations) || raw.conversations.length > 16)
                throw new Error();
            if (raw.receipts !== undefined) {
                if (!Array.isArray(raw.receipts) || raw.receipts.length > 5000)
                    throw new Error();
                for (const entry of raw.receipts) {
                    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || !/^[a-f0-9]{64}$/.test(entry[0])
                        || typeof entry[1] !== 'string' || !/^[a-f0-9]{64}$/.test(entry[1]) || receipts.has(entry[0]))
                        throw new Error();
                    receipts.set(entry[0], entry[1]);
                }
            }
            const restored = new Map();
            for (const item of raw.conversations) {
                if (!record(item) || typeof item.scope !== 'string' || !scopeValid(item.scope) || restored.has(item.scope)
                    || !Array.isArray(item.messages) || item.messages.length > 12 || item.messages.length % 2
                    || !Array.isArray(item.jobs) || item.jobs.length > 8)
                    throw new Error();
                const messages = [];
                for (const [index, message] of item.messages.entries()) {
                    if (!record(message) || !key(message.id) || message.role !== (index % 2 ? 'assistant' : 'user')
                        || typeof message.text !== 'string' || !message.text || message.text.length > 8000 || !date(message.createdAt))
                        throw new Error();
                    messages.push({ id: message.id, role: index % 2 ? 'assistant' : 'user', text: field(message.text, 8000).text, createdAt: message.createdAt });
                }
                const jobs = [];
                for (const job of item.jobs) {
                    if (!record(job) || !key(job.id) || !key(job.requestId) || typeof job.inputHash !== 'string' || !/^[a-f0-9]{64}$/.test(job.inputHash)
                        || typeof job.state !== 'string' || !states.has(job.state) || typeof job.input !== 'string' || job.input.length > 4000
                        || !date(job.createdAt) || (job.reply !== undefined && (typeof job.reply !== 'string' || job.reply.length > 8000)))
                        throw new Error();
                    const state = job.state === 'preparing' || job.state === 'generating' ? 'cancelled' : job.state;
                    jobs.push({ id: job.id, requestId: job.requestId, state, inputHash: job.inputHash, input: field(job.input, 4000).text, createdAt: job.createdAt,
                        ...(typeof job.reply === 'string' ? { reply: field(job.reply, 8000).text } : {}),
                        ...(state === 'cancelled' ? { error: 'companion_interrupted' } : state === 'failed' ? { error: 'companion_failed' } : {}) });
                }
                restored.set(item.scope, { scope: item.scope, messages, jobs });
            }
            for (const [scope, item] of restored)
                conversations.set(scope, item);
            loaded = true;
            // Persist the interrupted state before admitting any new work.
            if ([...restored.values()].some(item => item.jobs.some(job => job.error === 'companion_interrupted')))
                await persist();
        }
        catch {
            conversations.clear();
            receipts.clear();
            loaded = false;
            throw fault('companion_store_unavailable', 503);
        }
    }
    function conversation(scope) {
        if (!scopeValid(scope))
            throw fault('companion_invalid_input', 400);
        let item = conversations.get(scope);
        if (!item) {
            const limit = scope === 'desktop' || conversations.has('desktop') ? 16 : 15;
            if (conversations.size >= limit)
                throw fault('companion_limit', 429);
            item = { scope, messages: [], jobs: [] };
            conversations.set(scope, item);
        }
        return item;
    }
    async function execute(item, job, control) {
        try {
            if (closed)
                control.abort();
            control.signal.throwIfAborted();
            const output = await engine.reply(structuredClone(item.messages), job.input, { signal: control.signal,
                generating: () => { if (!control.signal.aborted && job.state === 'preparing')
                    job.state = 'generating'; } });
            control.signal.throwIfAborted();
            if (typeof output !== 'string' || !output.trim() || output.length > 8000)
                throw new Error();
            const reply = field(output, 8000).text;
            await locked(async () => {
                if (control.signal.aborted || job.state === 'cancelled')
                    return;
                const previous = structuredClone(item.messages);
                const at = new Date().toISOString();
                item.messages.push({ id: 'user-' + randomUUID(), role: 'user', text: job.input, createdAt: job.createdAt }, { id: 'reply-' + randomUUID(), role: 'assistant', text: reply, createdAt: at });
                while (item.messages.length > 12 || Buffer.byteLength(JSON.stringify(item.messages)) > 64 * 1024)
                    item.messages.splice(0, 2);
                job.state = 'completed';
                job.reply = reply;
                try {
                    await persist();
                }
                catch (error) {
                    item.messages = previous;
                    delete job.reply;
                    throw error;
                }
            });
        }
        catch {
            await locked(async () => {
                job.state = control.signal.aborted ? 'cancelled' : 'failed';
                job.error = control.signal.aborted ? 'companion_cancelled' : 'companion_failed';
                delete job.reply;
                await persist().catch(() => { });
            });
        }
        finally {
            active.delete(item.scope);
        }
    }
    async function view(scope, jobId) {
        return locked(async () => {
            await load();
            const item = conversation(scope);
            const job = jobId ? item.jobs.find(job => job.id === jobId) : item.jobs.at(-1);
            if (jobId && !job)
                throw fault('companion_job_not_found', 404);
            return { ok: true, ready: !closed && engine.ready(), model: engine.model(), messages: structuredClone(item.messages), job: job ? publicJob(job) : null };
        });
    }
    async function send(scope, input) {
        return locked(async () => {
            await load();
            if (!key(input.requestId) || typeof input.text !== 'string' || !input.text.trim() || input.text.length > 4000)
                throw fault('companion_invalid_input', 400);
            const text = field(input.text, 4000).text;
            const item = conversation(scope), prior = item.jobs.find(job => job.requestId === input.requestId);
            if (prior) {
                if (prior.inputHash !== hash(text))
                    throw fault('companion_conflict', 409);
                return publicJob(prior);
            }
            const receipt = hash(scope + '\0' + input.requestId);
            if (receipts.has(receipt))
                throw fault('companion_conflict', 409);
            if (closed || !engine.ready())
                throw fault('companion_not_ready', 503);
            if (active.has(scope))
                throw fault('companion_busy', 409);
            if (active.size >= 2)
                throw fault('companion_limit', 429);
            const job = { id: 'chatjob-' + randomUUID(), requestId: input.requestId, inputHash: hash(text), input: text,
                state: 'preparing', createdAt: new Date().toISOString() };
            const oldJobs = [...item.jobs];
            item.jobs.push(job);
            if (item.jobs.length > 8)
                item.jobs.shift();
            const oldReceipts = new Map(receipts);
            receipts.set(receipt, job.inputHash);
            if (receipts.size > 5000)
                receipts.delete(receipts.keys().next().value);
            try {
                await persist();
            }
            catch (error) {
                item.jobs = oldJobs;
                receipts.clear();
                for (const [id, value] of oldReceipts)
                    receipts.set(id, value);
                throw error;
            }
            if (closed) {
                job.state = 'cancelled';
                job.error = 'companion_cancelled';
                await persist();
                return publicJob(job);
            }
            const controller = new AbortController();
            const entry = { controller };
            active.set(scope, entry);
            queueMicrotask(() => { entry.task = execute(item, job, controller); });
            return publicJob(job);
        });
    }
    async function cancel(scope, jobId) {
        return locked(async () => {
            await load();
            const item = conversation(scope), job = item.jobs.find(job => job.id === jobId);
            if (!job)
                throw fault('companion_job_not_found', 404);
            if (job.state === 'preparing' || job.state === 'generating') {
                active.get(scope)?.controller.abort();
                job.state = 'cancelled';
                job.error = 'companion_cancelled';
                await persist();
            }
            return publicJob(job);
        });
    }
    async function clear(scope) {
        return locked(async () => {
            await load();
            if (active.has(scope))
                throw fault('companion_busy', 409);
            const item = conversation(scope), previous = structuredClone(item);
            item.messages = [];
            item.jobs = [];
            try {
                await persist();
            }
            catch (error) {
                conversations.set(scope, previous);
                throw error;
            }
        });
    }
    async function close() {
        closed = true;
        await tail;
        for (const entry of active.values())
            entry.controller.abort();
        await Promise.allSettled([...active.values()].map(entry => entry.task));
        await tail;
    }
    return { view, send, cancel, clear, close };
}
