/** Narrow community transport for policies and idempotent social actions. */
import { communityRequest } from './community-endpoint.mjs';
import type { CommunityConfig } from './community-endpoint.mjs';
import { parseSocialPolicyUpdate } from './social-http.mjs';
import type { SocialCommunityStatus, SocialPolicyUpdate, SocialPolicyView } from './social-types.mjs';

function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function fault(code = 'social_policy_unavailable', status = 503) { return Object.assign(new Error(code), { code, status }); }
function id(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value); }
function date(value: unknown): value is string { return typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value)); }
function integer(value: unknown, min: number, max: number) { return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max; }

/** Automatic public socializing must never receive the owner's private asks or task deliveries. */
export function socialFeedView(value: unknown) {
  if (!object(value) || !Array.isArray(value.notes) || value.notes.length > 20 || !value.notes.every(object)) throw fault('social_feed_invalid');
  return { trust: 'untrusted' as const, source: 'community' as const, notes: structuredClone(value.notes), remote: true };
}

export function parseSocialPolicyView(value: unknown): SocialPolicyView {
  if (!object(value) || value.ok !== true || !object(value.policy) || !object(value.effective) || !object(value.usage)
    || !integer(value.policy.revision, 0, Number.MAX_SAFE_INTEGER) || !Array.isArray(value.pendingRequests) || value.pendingRequests.length > 100) throw fault();
  const source = value.policy, effective = value.effective, usage = value.usage;
  const action = (input: unknown, max: number) => {
    if (!object(input) || typeof input.requireApproval !== 'boolean' || !integer(input.dailyLimit, 0, max)) throw fault();
    return { requireApproval: input.requireApproval, dailyLimit: Number(input.dailyLimit) };
  };
  const post = action(source.post, 5), reply = action(source.reply, 20);
  if (source.expiresAt !== null && !date(source.expiresAt) || source.updatedAt !== null && !date(source.updatedAt)
    || !['review', 'auto'].includes(String(effective.post)) || !['review', 'auto'].includes(String(effective.reply))
    || typeof usage.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(usage.day) || !integer(usage.post, 0, 1000000) || !integer(usage.reply, 0, 1000000)) throw fault();
  for (const [name, policy] of [['post', post], ['reply', reply]] as const) {
    if (effective[name] === 'auto' && (policy.requireApproval || !policy.dailyLimit || typeof source.expiresAt !== 'string'
      || Date.parse(source.expiresAt) <= Date.now() || Number(usage[name]) >= policy.dailyLimit)) throw fault();
  }
  const pendingRequests = (value.pendingRequests as unknown[]).map(item => {
    if (!object(item) || !id(item.id) || item.action !== 'social_policy' || item.status !== 'pending' || !date(item.createdAt) || !date(item.expiresAt)) throw fault();
    return { id: item.id, action: 'social_policy' as const, status: 'pending' as const,
      createdAt: item.createdAt, expiresAt: item.expiresAt, payload: parseSocialPolicyUpdate(item.payload) };
  });
  return { ok: true, policy: { revision: Number(source.revision), post, reply,
    expiresAt: source.expiresAt as string | null, updatedAt: source.updatedAt as string | null },
    effective: { post: effective.post as 'review' | 'auto', reply: effective.reply as 'review' | 'auto' },
    usage: { day: usage.day, post: Number(usage.post), reply: Number(usage.reply) }, pendingRequests };
}

export function createSocialCommunity({ configuration }: { configuration(): Promise<CommunityConfig | null> }) {
  async function config() {
    const current = await configuration();
    if (!current) throw fault('social_not_joined', 409);
    return current;
  }
  async function view(signal?: AbortSignal): Promise<SocialCommunityStatus> {
    let current: CommunityConfig | null;
    try { current = await configuration(); } catch { return { connected: false, available: false, policy: null, code: 'social_configuration_unavailable' }; }
    if (!current) return { connected: false, available: false, policy: null, code: 'social_not_joined' };
    try {
      const result = await communityRequest(current, '/social/policy', undefined, signal ? { signal } : {});
      return { connected: true, available: true, policy: parseSocialPolicyView(result), approvalUrl: current.url + '/m' };
    } catch { return { connected: true, available: false, policy: null, code: 'social_policy_unavailable' }; }
  }
  async function requestPolicy(input: SocialPolicyUpdate) {
    try {
      const response: unknown = await communityRequest(await config(), '/social/policy-request', input);
      const proposal = object(response) && response.proposal;
      if (!object(response) || response.ok !== true || !object(proposal) || !id(proposal.id) || proposal.status !== 'pending') throw fault();
      return { id: proposal.id, status: 'pending' as const };
    } catch (error) {
      if (object(error) && error.status === 409) throw fault('social_conflict', 409);
      if (object(error) && error.status === 429) throw fault('social_limit', 429);
      throw fault();
    }
  }
  async function action(input: { requestId: string; action: 'post' | 'reply'; payload: Record<string, unknown> }, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted();
    const current = await config(); signal.throwIfAborted();
    const result: unknown = await communityRequest(current, '/social/actions', input, { signal });
    if (!object(result) || result.ok !== true || !object(result.receipt)) throw fault('social_action_unavailable');
    // The native patrol validates the exact receipt against the actual tool call
    // before recording it or returning any metadata to the main conversation.
    return result.receipt;
  }
  return { view, requestPolicy, action };
}
