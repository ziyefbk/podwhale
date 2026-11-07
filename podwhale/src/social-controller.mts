/** Local scheduling only. Server-owned policy remains the sole publication authority. */
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { field } from './redact.js';
import type { SocialActionReceipt, SocialActivity, SocialPreferences, SocialRunSummary, SocialStatus } from './social-types.mjs';

const KEYS = ['version', 'enabled', 'intervalMinutes', 'startHour', 'endHour', 'timeZone', 'readLimit', 'topics', 'draftPosts', 'draftReplies'];
const RESULT_CODES = new Set(['isolation_unavailable', 'cancelled', 'run_failed', 'interrupted', 'not_ready']);
const RESULT_STATES = new Set(['completed', 'blocked', 'cancelled', 'busy', 'ready']);
const MAX_ACTIVITY = 30;
const MAX_STORE_BYTES = 128 * 1024;
const RETRYABLE_WINDOWS_ERRORS = new Set(['EBUSY', 'EPERM', 'EACCES']);
const SYSTEM_CODES = new Set(['ENOENT', 'ENOTDIR', 'EISDIR', 'EEXIST', 'EBUSY', 'EPERM', 'EACCES', 'ENOSPC', 'EROFS', 'EIO', 'ELOOP']);
const defaultTopics: string[] = [];
Object.freeze(defaultTopics);
export const DEFAULT_SOCIAL_PREFERENCES: Readonly<SocialPreferences> = Object.freeze({ version: 1, enabled: false,
  intervalMinutes: 60, startHour: 9, endHour: 22, timeZone: 'Asia/Shanghai', readLimit: 10,
  topics: defaultTopics, draftPosts: true, draftReplies: true });
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function fault(code = 'social_settings_invalid', status = 400, cause?: unknown) { return Object.assign(new Error(code, { cause }), { code, status }); }
function storageFault(operation: string, error: unknown) {
  if (record(error) && error.code === 'social_store_invalid' && error.status === 503) return error;
  // Diagnostics deliberately retain only operation and an allowlisted OS code.
  // Native error objects may contain private paths or serialized configuration.
  const systemCode = record(error) && typeof error.code === 'string' && SYSTEM_CODES.has(error.code) ? error.code : 'INVALID';
  return fault('social_store_invalid', 503, { operation, systemCode });
}
async function retryWindows<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try { return await operation(); }
    catch (error) {
      if (process.platform !== 'win32' || attempt >= 5 || !record(error) || typeof error.code !== 'string'
        || !RETRYABLE_WINDOWS_ERRORS.has(error.code)) throw error;
      await delay(Math.min(100, 25 * 2 ** attempt));
    }
  }
}
function integer(value: unknown, min: number, max: number): value is number { return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max; }
function safeId(value: unknown): value is string { return typeof value === 'string' && /^[a-z0-9_-]{1,160}$/i.test(value); }
function date(value: unknown): value is string { return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value; }
function cloneSettings(settings: SocialPreferences): SocialPreferences { return { ...settings, topics: [...settings.topics] }; }
function failed(code: 'run_failed' | 'cancelled' = 'run_failed'): SocialRunSummary {
  return { type: 'patrol_summary', status: code === 'cancelled' ? 'cancelled' : 'blocked', code, executed: false, feedReads: 0, proposals: [], receipts: [] };
}

/** Reject undeclared authority fields; topics are data, redacted before persistence and prompt assembly. */
export function normalizeSocialPreferences(value: unknown): SocialPreferences {
  if (!record(value) || Object.keys(value).some(key => !KEYS.includes(key)) || KEYS.some(key => !Object.hasOwn(value, key))
    || value.version !== 1 || typeof value.enabled !== 'boolean' || !integer(value.intervalMinutes, 15, 1440)
    || !integer(value.startHour, 0, 23) || !integer(value.endHour, 1, 24) || value.startHour >= value.endHour
    || typeof value.timeZone !== 'string' || value.timeZone.length > 80 || !/^[A-Za-z0-9_+/-]+$/.test(value.timeZone)
    || !integer(value.readLimit, 1, 20) || !Array.isArray(value.topics) || value.topics.length > 8
    || typeof value.draftPosts !== 'boolean' || typeof value.draftReplies !== 'boolean') throw fault();
  try { new Intl.DateTimeFormat('en', { timeZone: value.timeZone }).format(); } catch { throw fault(); }
  const topics: string[] = [];
  for (const topic of value.topics as unknown[]) {
    if (typeof topic !== 'string' || !topic.trim() || topic.length > 24 || /[\x00-\x1f\x7f]/.test(topic)) throw fault();
    const text = field(topic, 24).text;
    if (text && !topics.includes(text)) topics.push(text);
  }
  return { version: 1, enabled: value.enabled, intervalMinutes: value.intervalMinutes,
    startHour: value.startHour, endHour: value.endHour, timeZone: value.timeZone, readLimit: value.readLimit,
    topics, draftPosts: value.draftPosts, draftReplies: value.draftReplies };
}
function receipt(value: unknown): SocialActionReceipt {
  if (!record(value) || Object.keys(value).some(key => !['id', 'action', 'status', 'executed', 'proposalId', 'targetId'].includes(key))
    || !safeId(value.id) || (value.action !== 'post' && value.action !== 'reply') || (value.status !== 'pending' && value.status !== 'published')
    || value.executed !== (value.status === 'published') || (value.proposalId !== undefined && (typeof value.proposalId !== 'string' || !/^proposal[a-z0-9_-]{1,100}$/i.test(value.proposalId)))
    || (value.targetId !== undefined && !safeId(value.targetId)) || (value.status === 'pending' && !value.proposalId) || (value.status === 'published' && !value.targetId)) throw fault('social_result_invalid', 503);
  return { id: value.id, action: value.action, status: value.status, executed: value.executed,
    ...(typeof value.proposalId === 'string' ? { proposalId: value.proposalId } : {}), ...(typeof value.targetId === 'string' ? { targetId: value.targetId } : {}) };
}
function summary(value: unknown): SocialRunSummary {
  if (!record(value) || value.type !== 'patrol_summary' || typeof value.status !== 'string' || !RESULT_STATES.has(value.status)
    || typeof value.executed !== 'boolean' || !integer(value.feedReads, 0, 8) || !Array.isArray(value.proposals) || value.proposals.length > 3
    || (value.code !== undefined && (typeof value.code !== 'string' || !RESULT_CODES.has(value.code)))
    || (value.receipts !== undefined && (!Array.isArray(value.receipts) || value.receipts.length > 3))) throw fault('social_result_invalid', 503);
  const receipts = value.receipts === undefined ? [] : (value.receipts as unknown[]).map(receipt);
  const proposals = (value.proposals as unknown[]).map(item => {
    if (!record(item) || typeof item.id !== 'string' || !/^proposal[a-z0-9_-]{1,100}$/i.test(item.id)
      || (item.action !== 'post' && item.action !== 'reply') || item.status !== 'pending') throw fault('social_result_invalid', 503);
    return { id: item.id, action: item.action, status: 'pending' as const };
  });
  if (value.executed !== receipts.some(item => item.status === 'published')) throw fault('social_result_invalid', 503);
  return { type: 'patrol_summary', status: value.status, ...(typeof value.code === 'string' ? { code: value.code } : {}),
    executed: value.executed, feedReads: value.feedReads, proposals, receipts };
}
function activity(value: unknown): SocialActivity {
  if (!record(value) || !safeId(value.id) || !date(value.startedAt) || (value.finishedAt !== null && !date(value.finishedAt))
    || !['running', 'completed', 'blocked', 'cancelled'].includes(String(value.status)) || !integer(value.feedReads, 0, 8)
    || !integer(value.published, 0, 3) || !integer(value.pending, 0, 3)
    || (value.code !== undefined && (typeof value.code !== 'string' || !RESULT_CODES.has(value.code)))) throw fault('social_store_invalid', 503);
  return { id: value.id, startedAt: value.startedAt, finishedAt: value.finishedAt,
    status: value.status === 'completed' ? 'completed' : value.status === 'blocked' ? 'blocked' : value.status === 'cancelled' ? 'cancelled' : 'running',
    feedReads: value.feedReads, published: value.published, pending: value.pending, ...(typeof value.code === 'string' ? { code: value.code } : {}) };
}
interface LocalTime { day: string; minute: number }
function localTime(at: number, settings: SocialPreferences): LocalTime {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: settings.timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(at)).map(part => [part.type, part.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, minute: Number(parts.hour) * 60 + Number(parts.minute) };
}
function slot(at: number, settings: SocialPreferences): string | null {
  const local = localTime(at, settings), start = settings.startHour * 60;
  if (local.minute < start || local.minute >= settings.endHour * 60) return null;
  // A schedule change cannot grant a second execution of the same wall-clock slot.
  const minute = start + Math.floor((local.minute - start) / settings.intervalMinutes) * settings.intervalMinutes;
  return `${local.day}T${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}@${settings.timeZone}`;
}
interface ActiveRun { controller: AbortController; completion: Promise<SocialRunSummary>; entry: SocialActivity }
async function runWithCancellation(run: SocialControllerOptions['run'], prefs: SocialPreferences, signal: AbortSignal): Promise<SocialRunSummary> {
  let abort: (() => void) | undefined, deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([run(prefs, signal), new Promise<SocialRunSummary>(resolve => {
      abort = () => { deadline = setTimeout(() => resolve(failed('cancelled')), 1250); };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    })]);
  } finally { if (abort) signal.removeEventListener('abort', abort); clearTimeout(deadline); }
}
export interface SocialControllerOptions {
  homeDir(): string;
  run(settings: SocialPreferences, signal: AbortSignal): Promise<SocialRunSummary>;
  ready(): boolean;
  now?: () => number;
}
export function createSocialController({ homeDir, run, ready, now = Date.now }: SocialControllerOptions) {
  let settings = cloneSettings(DEFAULT_SOCIAL_PREFERENCES), configured = false, closed = false;
  let entries: SocialActivity[] = [], lastRunAt: string | null = null, lastResult: SocialRunSummary | null = null;
  let active: ActiveRun | null = null, stopping = false, timer: ReturnType<typeof setInterval> | undefined;
  let initialized: Promise<void> | undefined, serial: Promise<unknown> = Promise.resolve();
  let observedSlot: string | null = null, observedAt = 0;
  let revision = 0;
  const home = resolve(homeDir()), directory = join(home, 'xiaolanshu'), file = join(directory, 'social.json');
  const root = () => directory;
  const path = () => file;
  const clock = () => { const at = now(); if (!Number.isFinite(at) || !Number.isFinite(new Date(at).getTime())) throw fault('social_clock_invalid', 503); return at; };
  const isReady = () => { try { return !closed && ready() === true; } catch { return false; } };
  function lock<T>(work: () => Promise<T>): Promise<T> { const operation = serial.then(work, work); serial = operation.catch(() => {}); return operation; }
  function observe() { observedAt = clock(); observedSlot = slot(observedAt, settings); }
  async function inspect(target: string, kind: 'file' | 'directory') {
    const info = await retryWindows(() => lstat(target)).catch((error: unknown) => {
      if (record(error) && error.code === 'ENOENT') return null;
      throw storageFault('lstat', error);
    });
    if (info && (info.isSymbolicLink() || (kind === 'file' ? !info.isFile() : !info.isDirectory())
      || kind === 'file' && info.size > MAX_STORE_BYTES)) throw storageFault('path', null);
    return info;
  }
  async function safeDirectory(create: boolean): Promise<boolean> {
    let homeInfo = await inspect(home, 'directory');
    if (!homeInfo && create) { await mkdir(home, { recursive: true, mode: 0o700 }); homeInfo = await inspect(home, 'directory'); }
    if (!homeInfo) return false;
    let rootInfo = await inspect(root(), 'directory');
    if (!rootInfo && create) { await mkdir(root(), { mode: 0o700 }).catch((error: unknown) => { if (!record(error) || error.code !== 'EEXIST') throw error; }); rootInfo = await inspect(root(), 'directory'); }
    if (!rootInfo) return false;
    const actualHome = await realpath(home), actualRoot = await realpath(root());
    if (dirname(actualRoot).toLowerCase() !== actualHome.toLowerCase()) throw storageFault('path', null);
    return true;
  }
  async function persist() {
    const temporary = path() + '.' + randomUUID() + '.tmp';
    let operation = 'directory', failure: unknown;
    try {
      await safeDirectory(true);
      await inspect(path(), 'file');
      const bytes = JSON.stringify({ version: 1, settings, activity: entries, lastRunAt, lastResult });
      if (Buffer.byteLength(bytes) > MAX_STORE_BYTES) throw storageFault('size', null);
      operation = 'write';
      const handle = await open(temporary, 'wx', 0o600);
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      operation = 'rename';
      await retryWindows(async () => {
        await safeDirectory(false);
        await inspect(path(), 'file');
        await rename(temporary, path());
      });
      configured = true;
    } catch (error) { failure = storageFault(operation, error); throw failure; }
    finally {
      try { if (await safeDirectory(false)) await retryWindows(() => unlink(temporary)); }
      catch (error) { if (!failure && (!record(error) || error.code !== 'ENOENT')) throw storageFault('cleanup', error); }
    }
  }
  async function init(): Promise<void> {
    initialized ??= (async () => {
      let raw: string;
      try {
        if (!await safeDirectory(false) || !await inspect(path(), 'file')) { observe(); return; }
        raw = await retryWindows(() => readFile(path(), 'utf8'));
      } catch (error) { throw storageFault('read', error); }
      try {
        if (Buffer.byteLength(raw, 'utf8') > MAX_STORE_BYTES) throw fault();
        const value: unknown = JSON.parse(raw);
        if (!record(value) || value.version !== 1 || !Array.isArray(value.activity) || value.activity.length > MAX_ACTIVITY
          || (value.lastRunAt !== null && !date(value.lastRunAt))) throw fault();
        settings = normalizeSocialPreferences(value.settings);
        entries = (value.activity as unknown[]).map(activity).map(entry => entry.status === 'running'
          ? { ...entry, status: 'cancelled' as const, finishedAt: new Date(clock()).toISOString(), code: 'interrupted' } : entry);
        lastRunAt = value.lastRunAt;
        lastResult = value.lastResult === null ? null : summary(value.lastResult);
        configured = true; observe();
      } catch (error) { throw storageFault('decode', error); }
    })();
    return initialized;
  }
  function nextRunAt(): string | null {
    if (!settings.enabled || !isReady() || stopping) return null;
    const at = clock(), first = Math.floor(at / 60000) * 60000 + 60000;
    // Scan absolute minutes so DST gaps and repeated hours cannot produce an invalid local date.
    for (let candidate = first; candidate <= first + 49 * 60 * 60000; candidate += 60000) {
      const local = localTime(candidate, settings);
      if (local.minute >= settings.startHour * 60 && local.minute < settings.endHour * 60
        && (local.minute - settings.startHour * 60) % settings.intervalMinutes === 0) return new Date(candidate).toISOString();
    }
    return null;
  }
  function snapshot(): SocialStatus { return { settings: cloneSettings(settings), configured, ready: isReady(), running: active !== null,
    stopping, nextRunAt: nextRunAt(), lastRunAt, lastResult: lastResult ? structuredClone(lastResult) : null, activity: entries.map(entry => ({ ...entry })) }; }
  async function status(): Promise<SocialStatus> { await init(); await serial; return snapshot(); }
  async function startRun(signal?: AbortSignal, expected?: { slot: string; revision: number }): Promise<{ status: SocialStatus; completion: Promise<SocialRunSummary> }> {
    await init();
    return lock(async () => {
      if (closed) throw fault('social_closed', 503);
      if (active || stopping) throw fault('social_busy', 409);
      if (expected && (!settings.enabled || expected.revision !== revision || slot(clock(), settings) !== expected.slot)) throw fault('social_schedule_changed', 409);
      if (!isReady()) throw fault('social_not_ready', 503);
      if (signal?.aborted) throw fault('social_cancelled', 409);
      const controller = new AbortController(), startedAt = new Date(clock()).toISOString(), previousLastRunAt = lastRunAt;
      const entry: SocialActivity = { id: 'socialrun-' + randomUUID(), startedAt, finishedAt: null, status: 'running', feedReads: 0, published: 0, pending: 0 };
      let complete: (value: SocialRunSummary) => void = () => {};
      const completion = new Promise<SocialRunSummary>(resolve => { complete = resolve; });
      const current: ActiveRun = { controller, completion, entry };
      active = current; entries = [entry, ...entries].slice(0, MAX_ACTIVITY); lastRunAt = startedAt;
      const abort = () => { stopping = true; controller.abort(); };
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      try { await persist(); }
      catch (error) { active = null; stopping = false; lastRunAt = previousLastRunAt; entries = entries.filter(item => item !== entry); signal?.removeEventListener('abort', abort); throw storageFault('start', error); }
      const prefs = cloneSettings(settings);
      void Promise.resolve().then(async () => {
        if (controller.signal.aborted) return failed('cancelled');
        try { return summary(await runWithCancellation(run, prefs, controller.signal)); } catch { return failed(controller.signal.aborted ? 'cancelled' : 'run_failed'); }
      }).then(async result => {
        let final = controller.signal.aborted ? { ...result, status: 'cancelled', code: 'cancelled' } : result;
        await lock(async () => {
          entry.finishedAt = new Date(clock()).toISOString();
          entry.status = final.status === 'completed' ? 'completed' : final.status === 'cancelled' ? 'cancelled' : 'blocked';
          entry.feedReads = final.feedReads; entry.published = final.receipts?.filter(item => item.status === 'published').length ?? 0;
          entry.pending = final.receipts?.filter(item => item.status === 'pending').length ?? 0;
          if (final.code) entry.code = final.code;
          lastResult = final;
          if (active === current) { active = null; stopping = false; }
          try { await persist(); }
          catch { entry.code = 'run_failed'; entry.status = 'blocked'; final = { ...final, status: 'blocked', code: 'run_failed' }; lastResult = final; }
        });
        signal?.removeEventListener('abort', abort); complete(structuredClone(final));
      }).catch(() => {
        if (active === current) { active = null; stopping = false; }
        signal?.removeEventListener('abort', abort); complete(failed());
      });
      return { status: snapshot(), completion };
    });
  }
  async function runNow(): Promise<SocialStatus> { return (await startRun()).status; }
  async function runAndWait(signal?: AbortSignal): Promise<SocialRunSummary> { return (await startRun(signal)).completion; }
  async function update(patch: unknown): Promise<SocialStatus> {
    await init();
    return lock(async () => {
      if (closed) throw fault('social_closed', 503);
      if (!record(patch) || Object.keys(patch).length === 0 || Object.keys(patch).some(key => !KEYS.includes(key))) throw fault();
      const next = normalizeSocialPreferences({ ...settings, ...patch }), previous = settings;
      settings = next;
      try { await persist(); } catch (error) { settings = previous; throw storageFault('update', error); }
      configured = true; revision += 1; observe();
      if (active) { stopping = true; active.controller.abort(); }
      return snapshot();
    });
  }
  async function pause(): Promise<SocialStatus> { return update({ enabled: false }); }
  async function claim(key: string): Promise<boolean> {
    const directory = join(root(), 'social-slots');
    await safeDirectory(true);
    if (!await inspect(directory, 'directory')) await mkdir(directory, { mode: 0o700 }).catch((error: unknown) => { if (!record(error) || error.code !== 'EEXIST') throw error; });
    await inspect(directory, 'directory');
    let handle;
    try { handle = await open(join(directory, createHash('sha256').update(key).digest('hex') + '.json'), 'wx', 0o600); }
    catch (error) { if (record(error) && error.code === 'EEXIST') return false; throw storageFault('claim', error); }
    try { await handle.writeFile(JSON.stringify({ slot: key, claimedAt: new Date(clock()).toISOString() })); await handle.sync(); }
    finally { await handle.close(); }
    return true;
  }
  async function tick(): Promise<void> {
    await init();
    const eligible = await lock(async () => {
      if (closed) return null;
      const at = clock(), current = slot(at, settings), previous = observedSlot;
      if (at < observedAt) return null;
      observedAt = at; observedSlot = current;
      if (!settings.enabled || !current || current === previous || active || stopping || !isReady()) return null;
      return await claim(current) ? { slot: current, revision } : null;
    });
    if (eligible) { try { await startRun(undefined, eligible); } catch { /* A concurrent manual run or pause owns this slot now. */ } }
  }
  async function start(): Promise<void> { await init(); if (closed || timer) return; timer = setInterval(() => { void tick().catch(() => {}); }, 15000); timer.unref?.(); }
  async function close(): Promise<void> {
    closed = true; clearInterval(timer); timer = undefined;
    const current = active;
    if (!current) return;
    stopping = true; current.controller.abort();
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([current.completion, new Promise<void>(resolve => { deadline = setTimeout(resolve, 1500); })]); }
    finally { clearTimeout(deadline); }
  }
  return { init, start, status, update, runNow, runAndWait, pause, close, tick };
}
