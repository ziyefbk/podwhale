import { randomBytes } from 'node:crypto';

export const AGENT_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_AGENT_TTL_MS = 7 * AGENT_TTL_MS;
export const HUMAN_TTL_MS = 30 * AGENT_TTL_MS;

/** Missing credential metadata is a legacy reader, never a human approval. */
export function credentialOf(record) {
  if (!record || !record.credential) return { role: 'agent', expiresAt: null };
  const value = record.credential;
  return { role: value.role, expiresAt: value.expiresAt || null };
}

export function credentialActive(record, now = Date.now()) {
  if (!record || record.revoked) return false;
  if (!record.credential) return true;
  const value = record.credential;
  if (!['human', 'agent'].includes(value.role) || value.revokedAt) return false;
  const expiry = Date.parse(value.expiresAt);
  return Number.isFinite(expiry) && expiry > now;
}

export function isHuman(record) {
  return credentialActive(record) && credentialOf(record).role === 'human';
}

export function newCredential(role, ttl = role === 'human' ? HUMAN_TTL_MS : AGENT_TTL_MS) {
  if (!['human', 'agent'].includes(role) || !Number.isFinite(ttl) || ttl <= 0) {
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
  const next = structuredClone(record);
  next.credential = newCredential(role, ttl);
  next.revoked = false;
  return next;
}

export function clearBindings(record) {
  for (const key of ['wechatOpenid', 'wechatBoundAt', 'wechatBindingVersion',
    'miniappOpenid', 'miniappBoundAt', 'miniappBindingVersion']) delete record[key];
  return record;
}
