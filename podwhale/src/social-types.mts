/** Shared JSON contracts. Authority lives on the community server, never in UI settings. */
export interface SocialPreferences {
  version: 1;
  enabled: boolean;
  intervalMinutes: number;
  startHour: number;
  endHour: number;
  timeZone: string;
  readLimit: number;
  topics: string[];
  draftPosts: boolean;
  draftReplies: boolean;
}
export interface SocialActionReceipt {
  id: string;
  action: 'post' | 'reply';
  status: 'pending' | 'published';
  executed: boolean;
  proposalId?: string;
  targetId?: string;
}
export interface SocialRunSummary {
  type: 'patrol_summary';
  status: string;
  code?: string;
  executed: boolean;
  feedReads: number;
  proposals: { id: string; action: string; status: 'pending' }[];
  receipts?: SocialActionReceipt[];
}
export interface SocialActivity {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  status: 'running' | 'completed' | 'blocked' | 'cancelled';
  feedReads: number;
  published: number;
  pending: number;
  code?: string;
}
export interface SocialStatus {
  settings: SocialPreferences;
  configured: boolean;
  ready: boolean;
  running: boolean;
  stopping: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastResult: SocialRunSummary | null;
  activity: SocialActivity[];
}
export interface SocialActionPolicy { requireApproval: boolean; dailyLimit: number }
export interface SocialPolicy {
  revision: number;
  post: SocialActionPolicy;
  reply: SocialActionPolicy;
  expiresAt: string | null;
  updatedAt: string | null;
}
export interface SocialPolicyUpdate {
  expectedRevision: number;
  post: SocialActionPolicy;
  reply: SocialActionPolicy;
  durationHours: number;
}
export interface SocialPolicyRequest {
  id: string;
  action: 'social_policy';
  payload: SocialPolicyUpdate;
  status: 'pending';
  createdAt: string;
  expiresAt: string;
}
export interface SocialPolicyView {
  ok: true;
  policy: SocialPolicy;
  effective: { post: 'review' | 'auto'; reply: 'review' | 'auto' };
  usage: { day: string; post: number; reply: number };
  pendingRequests: SocialPolicyRequest[];
}
export interface SocialCommunityStatus {
  connected: boolean;
  available: boolean;
  policy: SocialPolicyView | null;
  approvalUrl?: string;
  code?: string;
}
export interface SocialView {
  ok: true;
  local: SocialStatus;
  community: SocialCommunityStatus;
  request?: { id: string; status: 'pending' };
}
