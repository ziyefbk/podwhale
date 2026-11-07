/** Real private-file scheduling tests. No community, model, or user configuration. */
import { mkdtemp, readFile, realpath, rm, mkdir, writeFile, readdir, symlink, unlink } from 'node:fs/promises';
import { promises as filesystem } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createSocialController, DEFAULT_SOCIAL_PREFERENCES, normalizeSocialPreferences } from './social-controller.mjs';
let passed = 0, failures = 0;
const homes = [], controllers = [];
function check(name, value) { console.log((value ? 'ok  ' : 'FAIL') + ' ' + name); if (value)
    passed += 1;
else
    failures += 1; }
function record(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
async function rejects(name, work, status = 400) {
    try {
        await work();
        check(name, false);
    }
    catch (error) {
        check(name, record(error) && error.status === status && typeof error.message === 'string'
            && !error.message.includes('SENSITIVE_SENTINEL'));
    }
}
const success = () => ({ type: 'patrol_summary', status: 'completed', executed: false, feedReads: 1, proposals: [], receipts: [] });
async function until(test) {
    const end = Date.now() + 3500;
    while (!(await test())) {
        if (Date.now() >= end)
            throw new Error('social fixture timeout');
        await new Promise(resolve => setTimeout(resolve, 5));
    }
}
async function fixture(options = {}) {
    const home = options.homeDir?.() ?? await mkdtemp(join(tmpdir(), 'podwhale-social-test-'));
    if (!homes.includes(home))
        homes.push(home);
    let at = Date.parse('2026-11-08T01:02:00.000Z'), ready = true;
    const runs = [];
    const controller = createSocialController({ homeDir: () => home, now: () => at, ready: () => ready,
        run: async (settings, signal) => { runs.push({ settings, signal }); return success(); }, ...options });
    controllers.push(controller);
    await controller.init();
    return { home, controller, runs, advance: (minutes) => { at += minutes * 60000; }, setTime: (value) => { at = Date.parse(value); },
        unavailable: () => { ready = false; }, available: () => { ready = true; }, idle: () => until(async () => !(await controller.status()).running) };
}
async function withRename(replacement, work) {
    const original = filesystem.rename;
    filesystem.rename = replacement;
    syncBuiltinESMExports();
    try {
        return await work();
    }
    finally {
        filesystem.rename = original;
        syncBuiltinESMExports();
    }
}
try {
    const base = normalizeSocialPreferences(DEFAULT_SOCIAL_PREFERENCES);
    check('default plan is disabled without publication authority', !base.enabled && base.intervalMinutes === 60 && base.readLimit === 10);
    for (const [name, patch] of Object.entries({ intervalLow: { intervalMinutes: 14 }, intervalHigh: { intervalMinutes: 1441 }, fractional: { readLimit: 1.5 },
        readLow: { readLimit: 0 }, readHigh: { readLimit: 21 }, overnight: { startHour: 22, endHour: 9 }, invalidZone: { timeZone: 'SENSITIVE_SENTINEL' },
        topicCount: { topics: Array.from({ length: 9 }, () => 'topic') }, longTopic: { topics: ['x'.repeat(25)] }, malformedTopic: { topics: [{}] },
        authority: { approved: true }, boolean: { enabled: 'true' }, version: { version: 2 }, control: { topics: ['a\nb'] } })) {
        await rejects('invalid preferences reject ' + name, () => normalizeSocialPreferences({ ...base, ...patch }));
    }
    const redacted = normalizeSocialPreferences({ ...base, topics: ['127.0.0.1', 'person@example.com', 'science', 'science'] });
    check('topics are redacted and deduplicated before persistence', redacted.topics.join('|') === '[IP]|[邮箱]|science');
    check('valid IANA time zones with digits remain usable', normalizeSocialPreferences({ ...base, timeZone: 'Etc/GMT-8' }).timeZone === 'Etc/GMT-8');
    await rejects('a numeric but nonexistent IANA zone still fails Intl validation', () => normalizeSocialPreferences({ ...base, timeZone: 'Etc/GMT-99' }));
    const disabled = await fixture();
    const initial = await disabled.controller.status();
    check('init has no model side effect and unconfigured status', !initial.configured && !initial.running && disabled.runs.length === 0 && initial.nextRunAt === null);
    await disabled.controller.start();
    await disabled.controller.tick();
    check('disabled scheduler remains idle', disabled.runs.length === 0);
    const first = await disabled.controller.runNow();
    check('manual run works while automatic scheduling is disabled', first.running && !first.settings.enabled);
    await disabled.idle();
    const completed = await disabled.controller.status();
    check('completion stores only structured bounded metadata', completed.lastResult?.status === 'completed' && completed.activity.length === 1
        && completed.activity[0]?.status === 'completed' && completed.activity[0]?.feedReads === 1 && !!completed.activity[0]?.finishedAt);
    const clone = await disabled.controller.status();
    clone.settings.topics.push('mutation');
    clone.activity[0].feedReads = 999;
    check('status cannot mutate controller settings or activity', !(await disabled.controller.status()).settings.topics.length && (await disabled.controller.status()).activity[0]?.feedReads === 1);
    await disabled.controller.update({ topics: ['person@example.com'], readLimit: 4 });
    const diskText = await readFile(join(disabled.home, 'xiaolanshu', 'social.json'), 'utf8');
    check('saved settings are real redacted JSON without raw topic', diskText.includes('[邮箱]') && !diskText.includes('person@example.com'));
    const restored = await fixture({ homeDir: () => disabled.home });
    check('restart restores settings and activity without model work', (await restored.controller.status()).settings.readLimit === 4
        && (await restored.controller.status()).activity.length === 1 && restored.runs.length === 0);
    await disabled.controller.close();
    await restored.controller.close();
    const schedule = await fixture();
    const scheduled = await schedule.controller.update({ enabled: true, intervalMinutes: 15 });
    check('enable schedules the next boundary without immediately catching up', schedule.runs.length === 0 && scheduled.nextRunAt === '2026-11-08T01:15:00.000Z');
    await schedule.controller.tick();
    schedule.advance(13);
    await schedule.controller.tick();
    await schedule.idle();
    check('entering a new eligible slot runs once', schedule.runs.length === 1);
    await Promise.all([schedule.controller.tick(), schedule.controller.tick(), schedule.controller.tick()]);
    await schedule.idle();
    check('concurrent ticks cannot replay the same durable slot', schedule.runs.length === 1);
    const existing = await fixture({ homeDir: () => schedule.home });
    existing.setTime('2026-11-08T01:15:00.000Z');
    await existing.controller.tick();
    await existing.idle();
    check('second controller cannot claim a slot already executed by another process', existing.runs.length === 0);
    await existing.controller.close();
    schedule.advance(265);
    await schedule.controller.tick();
    await schedule.idle();
    check('a missed interval jump runs only the current slot rather than backfilling', schedule.runs.length === 2);
    schedule.setTime('2026-11-08T01:15:00.000Z');
    await schedule.controller.tick();
    check('clock rollback cannot replay an earlier slot', schedule.runs.length === 2);
    schedule.setTime('2026-11-08T14:00:00.000Z');
    await schedule.controller.tick();
    check('end hour excludes automatic activity', schedule.runs.length === 2);
    schedule.setTime('2026-11-08T23:59:00.000Z');
    await schedule.controller.tick();
    schedule.setTime('2026-11-09T01:00:00.000Z');
    await schedule.controller.tick();
    await schedule.idle();
    check('the next local day receives its own slot', schedule.runs.length === 3);
    await schedule.controller.close();
    const restart = await fixture({ homeDir: () => schedule.home });
    restart.setTime('2026-11-09T01:00:00.000Z');
    await restart.controller.tick();
    await restart.idle();
    check('restart does not repeat an old claimed daily slot', restart.runs.length === 0);
    await restart.controller.close();
    const readiness = await fixture();
    await readiness.controller.update({ enabled: true, intervalMinutes: 15 });
    readiness.unavailable();
    readiness.advance(13);
    await readiness.controller.tick();
    readiness.available();
    await readiness.controller.tick();
    check('a runtime becoming ready does not backfill the already observed slot', readiness.runs.length === 0);
    readiness.advance(15);
    await readiness.controller.tick();
    await readiness.idle();
    check('ready runtime resumes on the next new slot', readiness.runs.length === 1);
    readiness.unavailable();
    await rejects('manual execution rejects unavailable runtime', () => readiness.controller.runNow(), 503);
    await readiness.controller.close();
    let finish = () => { };
    let runningSignal;
    const pending = await fixture({ run: async (_settings, signal) => { runningSignal = signal; return new Promise(resolve => { finish = resolve; }); } });
    await pending.controller.update({ enabled: true });
    await pending.controller.runNow();
    await until(() => !!runningSignal);
    await rejects('overlapping manual runs return conflict', () => pending.controller.runNow(), 409);
    const paused = await pending.controller.pause();
    check('pause persists disabled and aborts the current run', !paused.settings.enabled && paused.stopping && runningSignal?.aborted);
    finish(success());
    await pending.idle();
    check('a late completed result after pause is recorded as cancelled', (await pending.controller.status()).lastResult?.status === 'cancelled'
        && (await pending.controller.status()).activity[0]?.status === 'cancelled');
    await pending.controller.close();
    const pausedReload = await fixture({ homeDir: () => pending.home });
    check('paused state survives process restart', !(await pausedReload.controller.status()).settings.enabled);
    await pausedReload.controller.close();
    let observedSignal;
    const hanging = await fixture({ run: async (_settings, signal) => { observedSignal = signal; return new Promise(() => { }); } });
    await hanging.controller.runNow();
    await until(() => !!observedSignal);
    const closeAt = Date.now();
    await hanging.controller.close();
    check('close aborts and finishes within its bound even for an uncooperative runner', observedSignal?.aborted && Date.now() - closeAt < 1900);
    check('cancelled uncooperative run does not retain an active slot', !(await hanging.controller.status()).running);
    await rejects('closed controller cannot start another run', () => hanging.controller.runNow(), 503);
    const external = new AbortController();
    const abortable = await fixture({ run: async (_settings, signal) => { await new Promise(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); return success(); } });
    const waiting = abortable.controller.runAndWait(external.signal);
    await until(async () => (await abortable.controller.status()).running);
    external.abort();
    check('main-session cancellation returns only a structured cancelled result', (await waiting).status === 'cancelled');
    await abortable.controller.close();
    const metadata = await fixture({ run: async () => ({ ...success(), transcript: 'SENSITIVE_SENTINEL', error: 'SENSITIVE_SENTINEL' }) });
    const safe = await metadata.controller.runAndWait();
    check('untrusted result fields cannot escape through local status or disk', !JSON.stringify(safe).includes('SENSITIVE_SENTINEL')
        && !(await readFile(join(metadata.home, 'xiaolanshu', 'social.json'), 'utf8')).includes('SENSITIVE_SENTINEL'));
    await metadata.controller.close();
    const invalidReceipt = await fixture({ run: async () => ({ ...success(), executed: true, receipts: [{ id: 'receipt-x', action: 'post', status: 'published', executed: true, targetId: 'p1', text: 'SENSITIVE_SENTINEL' }] }) });
    check('a receipt carrying message text fails closed', (await invalidReceipt.controller.runAndWait()).code === 'run_failed');
    await invalidReceipt.controller.close();
    const published = await fixture({ run: async () => ({ ...success(), executed: true, receipts: [{ id: 'socialreceipt-x', action: 'reply', status: 'published', executed: true, targetId: 'r1' }] }) });
    const actual = await published.controller.runAndWait();
    check('server-confirmed publication remains accurate in structured activity', actual.executed && (await published.controller.status()).activity[0]?.published === 1);
    await published.controller.close();
    const bounded = await fixture();
    for (let index = 0; index < 33; index += 1)
        await bounded.controller.runAndWait();
    check('activity history is bounded across real completed runs', (await bounded.controller.status()).activity.length === 30);
    await bounded.controller.close();
    const transient = await fixture();
    await transient.controller.update({ readLimit: 2 });
    const transientFile = join(transient.home, 'xiaolanshu', 'social.json'), originalRename = filesystem.rename;
    const originalBytes = await readFile(transientFile, 'utf8');
    let attempts = 0, oldPreserved = true;
    await withRename(async (source, target) => {
        if (String(target) === transientFile && ++attempts <= 2) {
            oldPreserved &&= await readFile(transientFile, 'utf8') === originalBytes;
            throw Object.assign(new Error('SENSITIVE_SENTINEL'), { code: 'EACCES' });
        }
        return originalRename(source, target);
    }, async () => {
        if (process.platform === 'win32') {
            await transient.controller.update({ readLimit: 7 });
            check('transient Windows replacement locks retry the atomic rename', attempts === 3 && (await transient.controller.status()).settings.readLimit === 7);
        }
        else {
            await rejects('non-Windows permission errors are not treated as transient locks', () => transient.controller.update({ readLimit: 7 }), 503);
            check('non-Windows permission errors attempt replacement only once', attempts === 1);
        }
    });
    check('replacement retries preserve the previous JSON until an atomic commit', oldPreserved);
    const transientReload = await fixture({ homeDir: () => transient.home });
    check('successful replacement survives restart without a lossy persistence fallback', (await transientReload.controller.status()).settings.readLimit === (process.platform === 'win32' ? 7 : 2));
    await transient.controller.close();
    await transientReload.controller.close();
    const permanent = await fixture();
    await permanent.controller.update({ readLimit: 2 });
    const permanentFile = join(permanent.home, 'xiaolanshu', 'social.json'), savedBytes = await readFile(permanentFile, 'utf8');
    attempts = 0;
    let causeSafe = false;
    await withRename(async () => { attempts += 1; throw Object.assign(new Error('SENSITIVE_SENTINEL'), { code: 'EACCES' }); }, async () => {
        try {
            await permanent.controller.update({ enabled: true });
        }
        catch (error) {
            causeSafe = record(error) && error.status === 503 && record(error.cause) && error.cause.operation === 'rename'
                && error.cause.systemCode === 'EACCES' && !JSON.stringify(error).includes('SENSITIVE_SENTINEL');
        }
    });
    check('persistent replacement locks fail after a bounded number of attempts', attempts === (process.platform === 'win32' ? 6 : 1) && causeSafe);
    check('permanent replacement failure preserves both prior disk and disabled memory settings', await readFile(permanentFile, 'utf8') === savedBytes
        && !(await permanent.controller.status()).settings.enabled);
    check('failed replacement cleans only its temporary file', (await readdir(join(permanent.home, 'xiaolanshu'))).join(',') === 'social.json');
    attempts = 0;
    await withRename(async () => { attempts += 1; throw Object.assign(new Error('SENSITIVE_SENTINEL'), { code: 'ENOSPC' }); }, async () => {
        await rejects('non-transient storage failure is surfaced rather than retried or overwritten', () => permanent.controller.update({ readLimit: 3 }), 503);
    });
    check('non-transient failure performs exactly one replacement attempt', attempts === 1 && await readFile(permanentFile, 'utf8') === savedBytes);
    await permanent.controller.close();
    const failedFinish = await fixture();
    let replacements = 0;
    const finishFile = join(failedFinish.home, 'xiaolanshu', 'social.json');
    await withRename(async (source, target) => {
        if (String(target) === finishFile && ++replacements >= 2)
            throw Object.assign(new Error('SENSITIVE_SENTINEL'), { code: 'ENOSPC' });
        return originalRename(source, target);
    }, async () => {
        const result = await failedFinish.controller.runAndWait();
        check('completion persistence failures remain visible as a blocked result', result.status === 'blocked' && result.code === 'run_failed'
            && (await failedFinish.controller.status()).activity[0]?.status === 'blocked');
    });
    const interrupted = await fixture({ homeDir: () => failedFinish.home });
    check('restart recovers an uncommitted completion as interrupted without repeating the run', interrupted.runs.length === 0
        && (await interrupted.controller.status()).activity[0]?.status === 'cancelled' && (await interrupted.controller.status()).activity[0]?.code === 'interrupted');
    await failedFinish.controller.close();
    await interrupted.controller.close();
    const linked = await fixture(), outside = await fixture();
    await mkdir(join(outside.home, 'target'));
    await symlink(join(outside.home, 'target'), join(linked.home, 'xiaolanshu'), process.platform === 'win32' ? 'junction' : 'dir');
    const linkedController = createSocialController({ homeDir: () => linked.home, ready: () => true, run: async () => success() });
    controllers.push(linkedController);
    await rejects('initialization rejects a symlink or junction private directory', () => linkedController.init(), 503);
    await rejects('persistence rejects a directory swapped for a symlink after initialization', () => linked.controller.update({ enabled: true }), 503);
    check('a rejected linked directory does not create data in its target', (await readdir(join(outside.home, 'target'))).length === 0);
    await unlink(join(linked.home, 'xiaolanshu'));
    await linked.controller.close();
    await linkedController.close();
    const fileLink = await fixture();
    await fileLink.controller.update({ enabled: false });
    const fileLinkPath = join(fileLink.home, 'xiaolanshu', 'social.json'), originalStat = filesystem.lstat;
    let reads = 0;
    const originalRead = filesystem.readFile;
    async function linkedStat(path, options) {
        const info = await originalStat(path, options);
        if (String(path) !== fileLinkPath)
            return info;
        Object.defineProperty(info, 'isSymbolicLink', { value: () => true });
        return info;
    }
    filesystem.lstat = linkedStat;
    filesystem.readFile = new Proxy(originalRead, { apply(target, self, args) { if (String(args[0]) === fileLinkPath)
            reads += 1; return Reflect.apply(target, self, args); } });
    syncBuiltinESMExports();
    try {
        const linkedFileController = createSocialController({ homeDir: () => fileLink.home, ready: () => true, run: async () => success() });
        controllers.push(linkedFileController);
        await rejects('initialization rejects symlink file metadata before reading its contents', () => linkedFileController.init(), 503);
        await rejects('persistence rejects a symlink file instead of replacing its target', () => fileLink.controller.update({ enabled: true }), 503);
        check('a symlink file is never read by initialization or persistence', reads === 0);
    }
    finally {
        filesystem.lstat = originalStat;
        filesystem.readFile = originalRead;
        syncBuiltinESMExports();
    }
    await fileLink.controller.close();
    const slotLink = await fixture();
    await slotLink.controller.update({ enabled: true, intervalMinutes: 15 });
    await symlink(join(outside.home, 'target'), join(slotLink.home, 'xiaolanshu', 'social-slots'), process.platform === 'win32' ? 'junction' : 'dir');
    slotLink.advance(13);
    await rejects('slot claims reject a symlink ledger directory without invoking the model', () => slotLink.controller.tick(), 503);
    check('linked slot rejection leaves both the model and external directory unchanged', slotLink.runs.length === 0 && (await readdir(join(outside.home, 'target'))).length === 0);
    await unlink(join(slotLink.home, 'xiaolanshu', 'social-slots'));
    await slotLink.controller.close();
    await outside.controller.close();
    const broken = await mkdtemp(join(tmpdir(), 'podwhale-social-test-'));
    homes.push(broken);
    await mkdir(join(broken, 'xiaolanshu'));
    await writeFile(join(broken, 'xiaolanshu', 'social.json'), '{SENSITIVE_SENTINEL');
    const corrupt = createSocialController({ homeDir: () => broken, ready: () => true, run: async () => success() });
    controllers.push(corrupt);
    await rejects('corrupt persisted JSON fails closed without resetting to an enabled plan', () => corrupt.init(), 503);
    const writeFailure = await fixture();
    await mkdir(join(writeFailure.home, 'xiaolanshu'));
    await mkdir(join(writeFailure.home, 'xiaolanshu', 'social.json'));
    await rejects('persistence failure rejects a settings change', () => writeFailure.controller.update({ enabled: true }), 503);
    check('failed settings persistence does not enable activity', !(await writeFailure.controller.status()).settings.enabled && writeFailure.runs.length === 0);
    await writeFailure.controller.close();
}
catch (error) {
    check('social controller suite completes without unexpected exceptions', false);
    console.error(error);
}
finally {
    await Promise.allSettled(controllers.map(controller => controller.close()));
    const base = await realpath(tmpdir());
    for (const home of homes) {
        const actual = await realpath(home);
        if (dirname(actual).toLowerCase() !== base.toLowerCase() || !basename(actual).startsWith('podwhale-social-test-'))
            throw new Error('unsafe fixture cleanup');
        await rm(actual, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
    }
}
console.log(`\n${passed} passed, ${failures} failed`);
if (failures)
    process.exitCode = 1;
