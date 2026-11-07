/** Owner-authorized post/reply automation. Authority and receipts commit together. */
import { randomUUID } from 'node:crypto';
const HOUR = 3600000;
const WINDOW = 24 * HOUR;
const RETENTION = 25 * HOUR;
const REQUEST = /^social-(\d{13})-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value, max = Number.MAX_SAFE_INTEGER) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max;
const date = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value));
function exact(value, keys) {
    if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key)))
        fail('invalid social policy fields');
}
function rule(value, max) {
    return record(value) && Object.keys(value).length === 2 && typeof value.requireApproval === 'boolean' && integer(value.dailyLimit, max);
}
function storedPolicy(value) {
    return record(value) && integer(value.revision) && rule(value.post, 5) && rule(value.reply, 20)
        && (value.expiresAt === null || date(value.expiresAt)) && (value.updatedAt === null || date(value.updatedAt))
        && ((value.post.requireApproval && value.reply.requireApproval) || value.expiresAt !== null);
}
function receipt(value) {
    return record(value) && typeof value.id === 'string' && !!value.id && (value.action === 'post' || value.action === 'reply')
        && (value.status === 'pending' || value.status === 'published') && typeof value.executed === 'boolean'
        && (value.status === 'published' ? value.executed && typeof value.targetId === 'string' : !value.executed && typeof value.proposalId === 'string')
        && (value.proposalId === undefined || typeof value.proposalId === 'string') && (value.targetId === undefined || typeof value.targetId === 'string');
}
export function isSocialOwnerState(value) {
    if (!record(value) || !storedPolicy(value.policy) || !(value.authorizerHash === null || typeof value.authorizerHash === 'string' && /^[a-f0-9]{64}$/.test(value.authorizerHash))
        || !record(value.usage) || !Array.isArray(value.receipts) || value.receipts.length > 512)
        return false;
    if (Object.keys(value.usage).length > 32 || Object.entries(value.usage).some(([day, used]) => !/^\d{4}-\d{2}-\d{2}$/.test(day)
        || !record(used) || !integer(used.post, 1000000) || !integer(used.reply, 1000000)))
        return false;
    const seen = new Set();
    const items = value.receipts;
    return items.every(item => {
        if (!record(item) || typeof item.requestId !== 'string' || !REQUEST.test(item.requestId) || seen.has(item.requestId)
            || !integer(item.issuedAt) || Number(REQUEST.exec(item.requestId)?.[1]) !== item.issuedAt
            || typeof item.digest !== 'string' || !/^[a-f0-9]{64}$/.test(item.digest) || !receipt(item.receipt))
            return false;
        seen.add(item.requestId);
        return true;
    });
}
export function defaultSocialPolicy() {
    return { revision: 0, post: { requireApproval: true, dailyLimit: 1 }, reply: { requireApproval: true, dailyLimit: 3 }, expiresAt: null, updatedAt: null };
}
function publicPolicy(policy) {
    return { revision: policy.revision, post: { requireApproval: policy.post.requireApproval, dailyLimit: policy.post.dailyLimit },
        reply: { requireApproval: policy.reply.requireApproval, dailyLimit: policy.reply.dailyLimit }, expiresAt: policy.expiresAt, updatedAt: policy.updatedAt };
}
function publicReceipt(value) {
    return { id: value.id, action: value.action, status: value.status, executed: value.executed,
        ...(value.proposalId === undefined ? {} : { proposalId: value.proposalId }), ...(value.targetId === undefined ? {} : { targetId: value.targetId }) };
}
function owner(store, ownerId) {
    return store[ownerId] ??= { policy: defaultSocialPolicy(), authorizerHash: null, usage: {}, receipts: [] };
}
export function socialDay(now = Date.now()) { return new Date(now + 8 * HOUR).toISOString().slice(0, 10); }
export function normalizeSocialPolicy(input) {
    if (!record(input))
        return fail('social policy must be an object');
    exact(input, ['expectedRevision', 'post', 'reply', 'durationHours']);
    if (!integer(input.expectedRevision) || !rule(input.post, 5) || !rule(input.reply, 20)
        || !integer(input.durationHours, 168) || ((!input.post.requireApproval || !input.reply.requireApproval) && input.durationHours < 1)) {
        return fail('invalid social policy limits or duration');
    }
    return { expectedRevision: input.expectedRevision, post: { ...input.post }, reply: { ...input.reply }, durationHours: input.durationHours };
}
export function socialPolicyTarget(store, ownerId) {
    return { ownerId, revision: store[ownerId]?.policy.revision ?? 0 };
}
export function validateSocialPolicy(store, ownerId, input) {
    const update = normalizeSocialPolicy(input);
    if ((store[ownerId]?.policy.revision ?? 0) !== update.expectedRevision)
        fail('social policy revision changed', 409);
    return update;
}
export function setSocialPolicy(store, ownerId, input, authorizerHash, now = Date.now()) {
    const update = validateSocialPolicy(store, ownerId, input);
    if (update.expectedRevision >= Number.MAX_SAFE_INTEGER)
        fail('social policy revision limit reached', 409);
    const automated = !update.post.requireApproval || !update.reply.requireApproval;
    if (automated && (!authorizerHash || !/^[a-f0-9]{64}$/.test(authorizerHash)))
        fail('human authorization required', 403);
    const item = owner(store, ownerId);
    item.authorizerHash = automated ? authorizerHash ?? null : null;
    item.policy = { revision: update.expectedRevision + 1, post: { ...update.post }, reply: { ...update.reply },
        expiresAt: update.post.requireApproval && update.reply.requireApproval ? null : new Date(now + update.durationHours * HOUR).toISOString(),
        updatedAt: new Date(now).toISOString() };
    return publicPolicy(item.policy);
}
export function socialPolicyView(store, ownerId, pendingRequests = [], now = Date.now(), authorizerActive = () => false) {
    const item = store[ownerId], policy = item?.policy ?? defaultSocialPolicy();
    const day = socialDay(now), used = item?.usage[day] ?? { post: 0, reply: 0 };
    const mode = (action) => !!item?.authorizerHash && authorizerActive(item.authorizerHash) && !policy[action].requireApproval && policy.expiresAt !== null
        && Date.parse(policy.expiresAt) > now && used[action] < policy[action].dailyLimit ? 'auto' : 'review';
    return { ok: true, policy: publicPolicy(policy), effective: { post: mode('post'), reply: mode('reply') },
        usage: { day, post: used.post, reply: used.reply }, pendingRequests: structuredClone(pendingRequests) };
}
export function normalizeSocialAction(input) {
    if (!record(input))
        return fail('social action must be an object');
    exact(input, ['requestId', 'action', 'payload']);
    if (typeof input.requestId !== 'string' || (input.action !== 'post' && input.action !== 'reply') || !record(input.payload))
        return fail('invalid social action');
    return { requestId: input.requestId, action: input.action, payload: input.payload };
}
export function executeSocialAction(store, ownerId, request, effects, now = Date.now()) {
    const issuedAt = Number(REQUEST.exec(request.requestId)?.[1]);
    if (!Number.isSafeInteger(issuedAt) || issuedAt < now - WINDOW || issuedAt > now + 60000)
        fail('social request expired or invalid', 409);
    const item = owner(store, ownerId);
    item.receipts = item.receipts.filter(entry => entry.issuedAt >= now - RETENTION);
    const previous = item.receipts.find(entry => entry.requestId === request.requestId);
    if (previous) {
        if (previous.digest !== request.digest || previous.receipt.action !== request.action)
            fail('social request payload changed', 409);
        if (previous.receipt.status === 'pending') {
            const proposal = effects.proposal(previous.receipt.proposalId ?? '');
            if (!proposal || proposal.status !== 'pending' || !(Date.parse(proposal.expiresAt) > now))
                fail('social request is no longer pending', 409);
        }
        return publicReceipt(previous.receipt);
    }
    if (item.receipts.length >= 512)
        fail('social receipt capacity reached', 429);
    const day = socialDay(now), used = item.usage[day] ??= { post: 0, reply: 0 };
    const policy = item.policy, automatic = item.authorizerHash !== null && effects.authorizerActive(item.authorizerHash) && !policy[request.action].requireApproval && policy.expiresAt !== null
        && Date.parse(policy.expiresAt) > now && used[request.action] < policy[request.action].dailyLimit;
    const result = automatic
        ? { id: 'socialreceipt-' + randomUUID(), action: request.action, status: 'published', executed: true, targetId: effects.publish() }
        : { id: 'socialreceipt-' + randomUUID(), action: request.action, status: 'pending', executed: false, proposalId: effects.propose() };
    if (automatic)
        used[request.action]++;
    for (const old of Object.keys(item.usage).sort().slice(0, -14))
        delete item.usage[old];
    item.receipts.push({ requestId: request.requestId, issuedAt, digest: request.digest, receipt: result });
    return publicReceipt(result);
}
export function approveSocialReceipt(store, ownerId, proposalId, targetId) {
    for (const entry of store[ownerId]?.receipts ?? []) {
        if (entry.receipt.status === 'pending' && entry.receipt.proposalId === proposalId) {
            entry.receipt = { ...entry.receipt, status: 'published', executed: true, targetId };
        }
    }
}
