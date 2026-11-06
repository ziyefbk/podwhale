import { randomBytes } from 'node:crypto';
export const AGENT_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_AGENT_TTL_MS = 7 * AGENT_TTL_MS;
export const HUMAN_TTL_MS = 30 * AGENT_TTL_MS;
function property(value, key) {
    if (value == null)
        return undefined;
    const boxed = Object(value);
    return Reflect.get(boxed, key);
}
/** Missing credential metadata is a legacy reader, never a human approval. */
export function credentialOf(record) {
    const value = property(record, 'credential');
    if (!record || !value)
        return { role: 'agent', expiresAt: null };
    return { role: property(value, 'role'), expiresAt: property(value, 'expiresAt') || null };
}
export function credentialActive(record, now = Date.now()) {
    if (!record || property(record, 'revoked'))
        return false;
    const value = property(record, 'credential');
    if (!value)
        return true;
    const role = property(value, 'role');
    if ((role !== 'human' && role !== 'agent') || property(value, 'revokedAt'))
        return false;
    const expiry = Date.parse(String(property(value, 'expiresAt')));
    return Number.isFinite(expiry) && expiry > now;
}
export function isHuman(record) {
    return credentialActive(record) && credentialOf(record).role === 'human';
}
export function newCredential(role, ttl = role === 'human' ? HUMAN_TTL_MS : AGENT_TTL_MS) {
    if ((role !== 'human' && role !== 'agent') || !Number.isFinite(ttl) || ttl <= 0) {
        throw new Error('invalid credential');
    }
    const now = Date.now();
    return {
        id: randomBytes(12).toString('hex'), role,
        issuedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + ttl).toISOString(),
    };
}
/** A credential is per token, even though the public profile is shared. */
export function withCredential(record, role, ttl) {
    return Object.assign(structuredClone(record), { credential: newCredential(role, ttl), revoked: false });
}
export function clearBindings(record) {
    for (const key of ['wechatOpenid', 'wechatBoundAt', 'wechatBindingVersion',
        'miniappOpenid', 'miniappBoundAt', 'miniappBindingVersion']) {
        if (!Reflect.deleteProperty(record, key))
            throw new TypeError('Cannot delete credential binding');
    }
    return record;
}
