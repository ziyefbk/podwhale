/** Task lifecycle and private evidence. No network access or read-time mutations. */
import { createHash, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { field } from '../redact.js';
const DAY = 86400000;
export const TASK_ACTIONS = ['claim', 'deliver', 'confirm', 'task_start', 'task_rework', 'task_withdraw', 'task_cancel'];
export const TASK_STATUSES = ['open', 'claimed', 'in_progress', 'delivered', 'changes_requested', 'completed', 'cancelled', 'expired'];
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const iso = (now) => new Date(now).toISOString();
export function taskDemo(task) { return !task.ownerId || task.source === 'seed' || task.source === 'demo'; }
export function claimIdentity(task, claim) {
    return claim.claimId || 'legacy-' + createHash('sha256').update(JSON.stringify([task.id, claim.ownerId, claim.createdAt ?? null])).digest('hex').slice(0, 32);
}
export function claimDeliveryVersion(claim) { return claim?.deliveryVersion ?? (claim?.deliveredAt ? 1 : 0); }
function deliveryView(value) {
    return { version: value.version, text: value.text, createdAt: value.createdAt,
        artifacts: value.artifacts.map(item => ({ label: item.label, url: item.url })) };
}
function deliveries(claim) {
    if (claim.deliveries)
        return claim.deliveries.map(deliveryView);
    return claim.deliveredAt ? [{ version: 1, text: claim.delivery || '', createdAt: claim.deliveredAt, artifacts: [] }] : [];
}
function privateClaim(task, claim) {
    return { taskId: task.id, ownerId: claim.ownerId, claimId: claimIdentity(task, claim), revision: claim.revision ?? 0,
        deliveryVersion: claimDeliveryVersion(claim), startedAt: claim.startedAt ?? null, reservedUntil: claim.reservedUntil ?? null,
        deliveries: deliveries(claim),
        ...(claim.ai !== undefined ? { ai: claim.ai } : {}), ...(claim.note !== undefined ? { note: claim.note } : {}),
        ...(claim.redacted !== undefined ? { redacted: claim.redacted } : {}), ...(claim.createdAt !== undefined ? { createdAt: claim.createdAt } : {}),
        ...(claim.deliveredAt !== undefined ? { deliveredAt: claim.deliveredAt } : {}), ...(claim.delivery !== undefined ? { delivery: claim.delivery } : {}),
        ...(claim.confirmedAt !== undefined ? { confirmedAt: claim.confirmedAt } : {}) };
}
export function reservationExpired(task, claim, now = Date.now()) {
    // Legacy claims have no lease. Never invent one and silently release work.
    return !!claim?.reservedUntil && !claim.startedAt && !claim.deliveredAt
        && (Date.parse(claim.reservedUntil) <= now || !!task.deadlineAt && Date.parse(task.deadlineAt) <= now);
}
export function taskStatus(task, claim, now = Date.now()) {
    if (task.status === 'cancelled')
        return 'cancelled';
    if (task.status === 'completed')
        return 'completed';
    if (claim?.confirmedAt)
        return 'completed';
    if (claim?.deliveredAt)
        return task.status === 'changes_requested' ? 'changes_requested' : 'delivered';
    if (claim?.startedAt)
        return 'in_progress';
    if (claim && !reservationExpired(task, claim, now))
        return 'claimed';
    return task.status === 'expired' || task.deadlineAt && Date.parse(task.deadlineAt) <= now ? 'expired' : 'open';
}
export function taskView(task, claim, viewerId, now = Date.now()) {
    const publisher = task.ownerId === viewerId, claimer = claim?.ownerId === viewerId, demo = taskDemo(task), status = taskStatus(task, claim, now);
    return { id: task.id, title: task.title,
        ...(task.ownerId !== undefined ? { ownerId: task.ownerId } : {}), ...(task.from !== undefined ? { from: task.from } : {}),
        ...(task.fromName !== undefined ? { fromName: task.fromName } : {}), ...(task.ownerLine !== undefined ? { ownerLine: task.ownerLine } : {}),
        ...(task.appearance !== undefined ? { appearance: { ...task.appearance } } : {}), ...(task.when !== undefined ? { when: task.when } : {}),
        ...(task.createdAt !== undefined ? { createdAt: task.createdAt } : {}), desc: task.desc || '', budget: task.budget || '面议',
        period: task.period || '待定', tags: [...(task.tags || [])], match: task.match ?? 70, why: task.why || '', risk: task.risk ?? false,
        source: task.source || (demo ? 'seed' : 'user'), status, acceptanceCriteria: task.acceptanceCriteria || '', deadlineAt: task.deadlineAt ?? null,
        revision: task.revision ?? 0, demo, claimed: !!claim && !reservationExpired(task, claim, now),
        overdue: !!task.deadlineAt && Date.parse(task.deadlineAt) <= now && !['completed', 'cancelled', 'expired', 'open'].includes(status),
        cancellation: (publisher || claimer) && task.cancellation ? { requestedBy: task.cancellation.requestedBy,
            reason: task.cancellation.reason, createdAt: task.cancellation.createdAt, claimId: task.cancellation.claimId } : null,
        viewer: { publisher, claimer, participant: publisher || claimer, canClaim: !demo && !publisher && status === 'open' } };
}
export function taskClaimView(task, claim, viewerId, now = Date.now()) {
    if (!claim)
        return null;
    if (reservationExpired(task, claim, now) && task.ownerId !== viewerId && claim.ownerId !== viewerId)
        return null;
    const publicState = { taskId: task.id, status: taskStatus(task, claim, now) };
    return task.ownerId === viewerId || claim.ownerId === viewerId ? { ...privateClaim(task, claim), ...publicState } : publicState;
}
export function taskHistory(task, viewerId) {
    return (task.history || []).filter(claim => task.ownerId === viewerId || claim.ownerId === viewerId)
        .map(claim => ({ ...privateClaim(task, claim), status: claim.status, endedAt: claim.endedAt, reason: claim.reason }));
}
export function taskEvents(task, viewerId) {
    return (task.events || []).filter(event => task.ownerId === viewerId || event.claimOwnerId === viewerId)
        .map(event => ({ id: event.id, action: event.action, actorId: event.actorId, revision: event.revision, createdAt: event.createdAt,
        ...(event.claimId !== undefined ? { claimId: event.claimId } : {}), ...(event.claimOwnerId !== undefined ? { claimOwnerId: event.claimOwnerId } : {}),
        ...(event.reason !== undefined ? { reason: event.reason } : {}) }));
}
/** Approval binds stored facts, never a clock-dependent view or another claimant's history. */
export function taskTarget(task, claim, viewerId) {
    const view = taskView(task, claim, viewerId, Number.NEGATIVE_INFINITY);
    const { viewer: _viewer, overdue: _overdue, claimed: _claimed, demo: _demo, ...publicTask } = view;
    return { task: publicTask, claim: taskClaimView(task, claim, viewerId, Number.NEGATIVE_INFINITY),
        claimDigest: createHash('sha256').update(JSON.stringify(claim ?? null)).digest('hex') };
}
function allowed(input, keys) {
    if (Object.keys(input).some(key => !keys.includes(key)))
        fail('invalid task payload fields');
}
function text(input, max, name, required = false) {
    if (input !== undefined && typeof input !== 'string' || typeof input === 'string' && input.length > max)
        fail('invalid task ' + name);
    const value = field(input, max).text;
    if (required && !value)
        fail('task ' + name + ' is required');
    return value;
}
function deadline(value, now) {
    if (value === undefined || value === null || value === '')
        return null;
    if (typeof value !== 'string')
        return fail('deadlineAt must be a future ISO UTC timestamp');
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
        || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value.replace(/Z$/, value.includes('.') ? 'Z' : '.000Z')
        || Date.parse(value) <= now)
        fail('deadlineAt must be a future ISO UTC timestamp');
    return new Date(value).toISOString();
}
export function normalizeTask(input, now = Date.now()) {
    allowed(input, ['title', 'desc', 'description', 'budget', 'period', 'tags', 'match', 'acceptanceCriteria', 'deadlineAt']);
    const match = Number(input.match);
    return { title: text(input.title, 120, 'title', true), desc: text(input.desc ?? input.description, 1000, 'description'),
        budget: text(input.budget, 24, 'budget') || '面议', period: text(input.period, 16, 'period') || '待定',
        tags: Array.isArray(input.tags) ? input.tags.map(tag => text(tag, 20, 'tag')).filter(Boolean).slice(0, 5) : [],
        match: Number.isFinite(match) ? Math.min(100, Math.max(0, Math.round(match))) : 70,
        acceptanceCriteria: text(input.acceptanceCriteria, 2000, 'acceptance criteria'), deadlineAt: deadline(input.deadlineAt, now) };
}
function artifacts(value) {
    if (value === undefined)
        return [];
    if (!Array.isArray(value) || value.length > 5)
        return fail('invalid task artifacts');
    return value.map((item) => {
        if (!record(item))
            return fail('invalid task artifact');
        allowed(item, ['label', 'url']);
        const label = text(item.label, 100, 'artifact label', true);
        if (typeof item.url !== 'string' || item.url.length > 2048 || /[\s\x00-\x1f\x7f]/.test(item.url))
            return fail('invalid task artifact URL');
        let url;
        try {
            url = new URL(item.url);
        }
        catch {
            return fail('invalid task artifact URL');
        }
        const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.+$/, '').toLowerCase();
        if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || isIP(host) || !host.includes('.')
            || /(?:^|\.)(?:localhost|local|internal|lan|home|corp|localdomain|home\.arpa|test|invalid)$/.test(host) || field(item.url, 2048).text !== item.url)
            return fail('invalid task artifact URL');
        return { label, url: url.href };
    });
}
export function normalizeTaskAction(action, input) {
    const extra = action === 'claim' ? ['note'] : action === 'deliver' ? ['text', 'artifacts']
        : ['task_rework', 'task_withdraw', 'task_cancel'].includes(action) ? ['reason'] : [];
    allowed(input, ['taskId', 'expectedRevision', 'claimId', 'deliveryVersion', ...extra]);
    if (typeof input.taskId !== 'string' || !input.taskId || input.taskId.length > 100)
        fail('taskId is required');
    const strict = action.startsWith('task_');
    if ((strict || input.expectedRevision !== undefined) && !integer(input.expectedRevision))
        fail('expectedRevision is required');
    if ((strict || input.claimId !== undefined) && !(typeof input.claimId === 'string' && !!input.claimId && input.claimId.length <= 100 || action === 'task_cancel' && input.claimId === null))
        fail('claimId is required');
    if ((strict || input.deliveryVersion !== undefined) && !integer(input.deliveryVersion))
        fail('deliveryVersion is required');
    return { taskId: input.taskId, ...(input.expectedRevision !== undefined ? { expectedRevision: input.expectedRevision } : {}),
        ...(input.claimId !== undefined ? { claimId: input.claimId } : {}), ...(input.deliveryVersion !== undefined ? { deliveryVersion: input.deliveryVersion } : {}),
        ...(action === 'claim' ? { note: text(input.note, 300, 'claim note') } : {}),
        ...(action === 'deliver' ? { text: text(input.text, 2000, 'delivery', true), artifacts: artifacts(input.artifacts) } : {}),
        ...(['task_rework', 'task_withdraw', 'task_cancel'].includes(action) ? { reason: text(input.reason, 1000, 'reason', true) } : {}) };
}
function bump(task, claim) {
    if ((task.revision ?? 0) >= Number.MAX_SAFE_INTEGER || (claim?.revision ?? 0) >= Number.MAX_SAFE_INTEGER)
        fail('task revision limit reached', 409);
    task.revision = (task.revision ?? 0) + 1;
    if (claim)
        claim.revision = (claim.revision ?? 0) + 1;
}
export function taskEvent(task, action, actorId, claim, reason, now = Date.now()) {
    const entry = { id: 'taskevent-' + randomUUID(), action, actorId, revision: task.revision ?? 0, createdAt: iso(now),
        ...(claim ? { claimId: claimIdentity(task, claim), claimOwnerId: claim.ownerId } : {}), ...(reason ? { reason } : {}) };
    (task.events ??= []).push(entry);
}
function archive(task, claim, status, reason, now) {
    (task.history ??= []).push({ ...privateClaim(task, claim), status, endedAt: iso(now), reason });
}
function expected(task, claim, input) {
    if (input.expectedRevision !== undefined && input.expectedRevision !== (task.revision ?? 0)
        || input.claimId !== undefined && input.claimId !== (claim ? claimIdentity(task, claim) : null)
        || input.deliveryVersion !== undefined && input.deliveryVersion !== claimDeliveryVersion(claim))
        fail('task target changed; refresh and review again', 409);
}
export function executeTaskAction(state, action, raw, owner, now = Date.now()) {
    const input = normalizeTaskAction(action, raw), task = state.tasks.find(item => item.id === input.taskId);
    if (!task)
        return fail('unknown task', action === 'claim' ? 400 : 404);
    let claim = state.claims[task.id];
    const publisher = task.ownerId === owner.id, claimer = claim?.ownerId === owner.id;
    // Refuse another participant's action before exposing terminal/version facts.
    if (action === 'deliver' && claim && !claimer)
        fail('only the claimer may deliver', 403);
    if (action === 'confirm' && claim?.deliveredAt && !publisher)
        fail('only the publisher may confirm', 403);
    if (['task_start', 'task_withdraw'].includes(action) && !claimer)
        fail('only the claimer may perform this action', 403);
    if (action === 'task_rework' && !publisher)
        fail('only the publisher may request rework', 403);
    if (action === 'task_cancel' && !publisher && !claimer)
        fail('only task participants may cancel', 403);
    expected(task, claim, input);
    if (action === 'claim') {
        if (claim && !reservationExpired(task, claim, now)) {
            if (!claimer)
                fail('task already claimed', 409);
            return { task, claim, repeated: true };
        }
        if (taskDemo(task))
            fail('demo tasks cannot be claimed', 409);
        if (publisher)
            fail('task_self_claim', 409);
        if (taskStatus(task, claim, now) !== 'open')
            fail('task is not open', 409);
        if (claim) {
            bump(task, claim);
            archive(task, claim, 'expired', 'reservation expired before work started', now);
            taskEvent(task, 'reservation_expired', 'system', claim, undefined, now);
            delete state.claims[task.id];
        }
        claim = { taskId: task.id, ownerId: owner.id, ai: owner.handle || '阿蓝', note: String(input.note), createdAt: iso(now),
            claimId: 'claim-' + randomUUID(), revision: 0, deliveryVersion: 0, deliveries: [], startedAt: null, reservedUntil: iso(now + DAY) };
        state.claims[task.id] = claim;
        task.status = 'claimed';
        task.cancellation = null;
        bump(task, claim);
        taskEvent(task, action, owner.id, claim, undefined, now);
        return { task, claim, repeated: false };
    }
    if (action === 'task_cancel' && !claim) {
        if (!publisher || taskDemo(task))
            fail('only the publisher may cancel this task', 403);
        if (task.status === 'cancelled')
            return { task, claim: null, repeated: true };
        if (taskStatus(task, undefined, now) === 'completed')
            fail('completed task cannot be cancelled', 409);
        task.status = 'cancelled';
        task.cancellation = null;
        bump(task);
        taskEvent(task, action, owner.id, undefined, String(input.reason), now);
        return { task, claim: null, repeated: false };
    }
    if (!claim)
        return fail('task has no current claim', action === 'deliver' ? 404 : 409);
    if (taskDemo(task))
        fail('demo tasks are read-only', 409);
    if (task.status === 'cancelled')
        fail('task is cancelled', 409);
    if (action === 'confirm' && publisher && claim.confirmedAt)
        return { task, claim, repeated: true };
    if (action === 'deliver' && claimer && claim.deliveredAt && task.status !== 'changes_requested'
        && input.expectedRevision === undefined && input.claimId === undefined && input.deliveryVersion === undefined)
        return { task, claim, repeated: true };
    if (claim.confirmedAt)
        fail('task is already completed', 409);
    if (reservationExpired(task, claim, now)) {
        if (action !== 'task_cancel' || !publisher)
            fail('reservation expired; claim the task again', 409);
        bump(task, claim);
        archive(task, claim, 'expired', 'reservation expired before work started', now);
        taskEvent(task, action, owner.id, claim, String(input.reason), now);
        delete state.claims[task.id];
        task.status = 'cancelled';
        task.cancellation = null;
        return { task, claim: null, repeated: false };
    }
    const status = taskStatus(task, claim, now);
    if (action === 'task_start') {
        if (!claimer)
            fail('only the claimer may start work', 403);
        if (claim.startedAt)
            return { task, claim, repeated: true };
        if (status !== 'claimed')
            fail('task cannot be started', 409);
        claim.startedAt = iso(now);
        claim.reservedUntil = null;
        task.status = 'in_progress';
    }
    else if (action === 'deliver') {
        if (!claimer)
            fail('only the claimer may deliver', 403);
        if (status === 'delivered') {
            if (input.expectedRevision === undefined && input.deliveryVersion === undefined && input.claimId === undefined)
                return { task, claim, repeated: true };
            fail('request rework before another delivery', 409);
        }
        if (!['claimed', 'in_progress', 'changes_requested'].includes(status))
            fail('task cannot be delivered', 409);
        const prior = deliveries(claim);
        if (prior.length >= 50)
            fail('task delivery version capacity reached', 429);
        const version = claimDeliveryVersion(claim) + 1;
        const uploaded = artifacts(input.artifacts);
        claim.deliveries = [...prior, { version, text: String(input.text), createdAt: iso(now), artifacts: uploaded }];
        claim.delivery = String(input.text);
        claim.deliveredAt = iso(now);
        claim.deliveryVersion = version;
        claim.startedAt ??= iso(now);
        claim.reservedUntil = null;
        task.status = 'delivered';
    }
    else if (action === 'confirm') {
        if (status !== 'delivered')
            fail('no delivered version to confirm', 409);
        if (!publisher)
            fail('only the publisher may confirm', 403);
        claim.confirmedAt = iso(now);
        task.status = 'completed';
        task.cancellation = null;
    }
    else if (action === 'task_rework') {
        if (!publisher)
            fail('only the publisher may request rework', 403);
        if (status !== 'delivered')
            fail('only a delivery may be returned for rework', 409);
        task.status = 'changes_requested';
    }
    else if (action === 'task_withdraw') {
        if (!claimer)
            fail('only the claimer may withdraw', 403);
        bump(task, claim);
        archive(task, claim, 'withdrawn', String(input.reason), now);
        taskEvent(task, action, owner.id, claim, String(input.reason), now);
        delete state.claims[task.id];
        task.status = task.deadlineAt && Date.parse(task.deadlineAt) <= now ? 'expired' : 'open';
        task.cancellation = null;
        return { task, claim: null, repeated: false };
    }
    else if (action === 'task_cancel') {
        if (!publisher && !claimer)
            fail('only task participants may cancel', 403);
        if (!claim.startedAt && !claim.deliveredAt && !publisher)
            fail('withdraw an unstarted claim instead', 403);
        if (claim.startedAt || claim.deliveredAt) {
            if (!task.cancellation) {
                task.cancellation = { requestedBy: owner.id, reason: String(input.reason), createdAt: iso(now), claimId: claimIdentity(task, claim) };
                bump(task, claim);
                taskEvent(task, action, owner.id, claim, String(input.reason), now);
                return { task, claim, repeated: false, awaitingOtherParty: true };
            }
            if (task.cancellation.requestedBy === owner.id)
                return { task, claim, repeated: true, awaitingOtherParty: true };
            if (task.cancellation.claimId !== claimIdentity(task, claim))
                fail('cancellation target changed', 409);
        }
        bump(task, claim);
        archive(task, claim, 'cancelled', String(input.reason), now);
        taskEvent(task, action, owner.id, claim, String(input.reason), now);
        delete state.claims[task.id];
        task.status = 'cancelled';
        task.cancellation = null;
        return { task, claim: null, repeated: false };
    }
    bump(task, claim);
    taskEvent(task, action, owner.id, claim, typeof input.reason === 'string' ? input.reason : undefined, now);
    return { task, claim, repeated: false };
}
