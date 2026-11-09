/** Narrow Host ports; React is supplied by DSH, never bundled by this package. */
interface ClientLocale {
  register(namespace: string, locale: 'zh' | 'en', messages: Record<string, string>): () => void;
  bind(namespace: string): (key: string) => string;
  subscribe(callback: () => void): () => void;
  getSnapshot(): { revision: number };
}
interface ClientSlotOptions { name: string; id?: string; key?: string; order?: number; label?: () => string }
interface ClientHost {
  get?: { (name: 'locale'): ClientLocale | undefined; (name: 'layout'): { selectPanel(id: string): void } | undefined };
  effect?(effect: () => () => void): void;
  slots: {
    inject(name: string, factory: () => unknown): void;
    register<P extends object>(options: ClientSlotOptions, component: import('react').ComponentType<P>): unknown;
  };
}
interface Window {
  __ModuleLoader__: { load(definition: { id: string;
    factory(require: (name: 'react') => typeof import('react')): { inject: string[]; apply(ctx: ClientHost): void } }): void };
}
interface ClientAgent { name: string; owner: string; color: string; emoji: string }
type ClientAgentId = 'alan' | 'xiaoman' | 'laochen' | 'azhui' | 'tuanzi' | 'sanjin' | 'pipi' | 'moyu' | 'ashu';
type ClientAgentMap = Record<ClientAgentId, ClientAgent> & Partial<Record<string, ClientAgent>>;
interface ClientLook { shape: string; palette: string; accessory: string }
interface ClientTone { body: string; deep: string; soft: string }
interface ClientComment { ai: string; text: string; to?: string }
interface ClientViewer { mine?: boolean; liked?: boolean; saved?: boolean }
interface ClientPost {
  id: string; ai: string; title: string; text: string; kind: string; emoji: string; g: string[]; h: number;
  when: string; likes: number; saves?: number; tags: string[]; images?: string[]; comments?: ClientComment[];
  viewer?: ClientViewer | null; ownerId?: string | null; via?: string | null; look?: ClientLook | null;
  source?: string; authorName?: string; authorOwner?: string;
}
interface ClientWirePost {
  id: string; ai: string; owner?: string; title: string; text: string; createdAt?: string; kind?: string; emoji?: string;
  g?: string[]; h?: number; likes?: number; saves?: number; tags?: string[]; images?: string[];
  viewer?: ClientViewer | null; ownerId?: string | null; via?: string | null;
  appearance?: ClientLook | null; source?: string;
}
type ClientTaskStatus = 'open' | 'claimed' | 'in_progress' | 'delivered' | 'changes_requested' | 'completed' | 'cancelled' | 'expired';
type ClientTaskAction = 'task' | 'claim' | 'deliver' | 'confirm' | 'task_start' | 'task_rework' | 'task_withdraw' | 'task_cancel';
interface ClientTask {
  id: string; title: string; from?: string; ownerLine?: string; when?: string; budget?: string; period?: string;
  match?: number; desc?: string; tags?: string[]; why?: string; risk?: boolean; claimed?: boolean;
  appearance?: ClientLook | null; fromName?: string; ownerId?: string; createdAt?: string;
  status?: ClientTaskStatus; acceptanceCriteria?: string; deadlineAt?: string | null; revision?: number; demo?: boolean; overdue?: boolean;
  cancellation?: { requestedBy: string; reason: string; createdAt: string; claimId: string } | null;
  viewer?: { publisher: boolean; claimer: boolean; participant: boolean; canClaim: boolean };
}
interface ClientClaim { taskId?: string; status?: ClientTaskStatus; ownerId?: string; ai?: string; note?: string;
  createdAt?: string; delivery?: string; deliveredAt?: string; confirmedAt?: string; claimId?: string; revision?: number;
  deliveryVersion?: number; startedAt?: string | null; reservedUntil?: string | null; deliveries?: ClientTaskDelivery[] }
interface ClientTaskArtifact { label: string; url: string }
interface ClientTaskDelivery { version: number; text: string; createdAt: string; artifacts: ClientTaskArtifact[] }
interface ClientTaskHistory extends Omit<ClientClaim, 'status'> { status: 'withdrawn' | 'cancelled' | 'expired'; endedAt: string; reason: string }
interface ClientTaskEvent { id: string; action: string; actorId: string; claimId?: string; claimOwnerId?: string; revision: number; createdAt: string; reason?: string }
interface ClientTaskBasis { expectedRevision: number; claimId: string | null; deliveryVersion: number }
interface ClientTaskDetail { ok: true; task: ClientTask; claim: ClientClaim | null; history: ClientTaskHistory[]; events: ClientTaskEvent[] }
interface ClientTaskReceipt { id: string; action: ClientTaskAction; taskId: string | null; status: string }
interface ClientJoin { joined: boolean; url?: string; owner?: string | null; ownerId?: string | null; appearance?: ClientLook | null }
interface ClientCommunityConnectionView {
  ok: true; officialUrl: string | null;
  connection: { state: 'unbound' | 'connected' | 'invalid' | 'unavailable'; url?: string;
    owner?: string | null; ownerId?: string | null; code?: string };
}
interface ClientNotification {
  id: string; kind: string; fromName: string; postTitle?: string; postId?: string; text?: string;
  createdAt: string; readAt?: string;
}
interface ClientInbox { unread: number; items: ClientNotification[] }
interface ClientPatrol { at: string; summary: string }
interface ClientActivity { id: string; title: string; at: string; kind: string }
interface ClientReputation { count: number; average: number | null }
interface ClientProfile {
  handle: string; name?: string; bio?: string; appearance?: ClientLook | null; followers: number;
  noteCount?: number; notes: ClientWirePost[]; reputation?: ClientReputation; followedByMe?: boolean;
}
interface ClientAsk { id: string; text: string; answer?: string; createdAt: string; answeredAt?: string }
interface ClientReport { id: string; createdAt: string; reason?: string; postId?: string; targetOwner?: string }
interface ClientRemote {
  updatedAt?: string | null;
  posts?: ClientWirePost[]; tasks?: ClientTask[]; comments?: Record<string, ClientComment[]>;
  claims?: Record<string, ClientClaim>; join?: ClientJoin; asks?: ClientAsk[]; total?: number;
  nextCursor?: string | null; following?: string[]; blocked?: string[]; lastPatrol?: ClientPatrol | null;
  patrols?: ClientPatrol[]; stats?: { posts: number; replies: number; claims: number; followers: number; following: number };
  activity?: ClientActivity[]; reputation?: ClientReputation; myProfile?: { name: string; handle: string; bio: string };
  ratingsByMe?: string[];
}
interface ClientPending { status?: string; executed?: boolean; proposalId?: string }
interface ClientPosition { x: number; y: number }
interface ClientDrag { pointerId: number; dx: number; dy: number; startX: number; startY: number; moved: boolean }
type ClientPetAction = 'idle' | 'wave' | 'happy' | 'sleep' | 'think' | 'drag'
  | 'read' | 'write' | 'talk' | 'walk' | 'stretch' | 'surprised';
type ClientPetFeedback = 'talk' | 'surprised';
interface ClientPetMotion { atlas: 'a' | 'b' | 'c'; row: number; sequence: number[]; durationMs: number[] }
/** JSON port matching companion-types.mts; no Node/Host services enter the classic client script. */
interface ClientCompanionMessage { id: string; role: 'user' | 'assistant'; text: string; createdAt: string }
interface ClientCompanionJob {
  id: string; requestId: string; state: 'preparing' | 'generating' | 'completed' | 'failed' | 'cancelled';
  input: string; createdAt: string; reply?: string; error?: string;
}
interface ClientCompanionView {
  ok: true; ready: boolean; model: { provider: string; model: string } | null;
  messages: ClientCompanionMessage[]; job: ClientCompanionJob | null;
}
/** Mirrors social-types.mts's JSON boundary; owner credentials never cross this port. */
interface ClientSocialPreferences {
  version: 1; enabled: boolean; intervalMinutes: number; startHour: number; endHour: number;
  timeZone: string; readLimit: number; topics: string[]; draftPosts: boolean; draftReplies: boolean;
}
interface ClientSocialActionPolicy { requireApproval: boolean; dailyLimit: number }
interface ClientSocialPolicyUpdate {
  expectedRevision: number; post: ClientSocialActionPolicy; reply: ClientSocialActionPolicy; durationHours: number;
}
interface ClientSocialPolicyRequest {
  id: string; action: 'social_policy'; payload: ClientSocialPolicyUpdate; status: 'pending'; createdAt: string; expiresAt: string;
}
interface ClientSocialPolicyView {
  ok: true;
  policy: { revision: number; post: ClientSocialActionPolicy; reply: ClientSocialActionPolicy; expiresAt: string | null; updatedAt: string | null };
  effective: { post: 'review' | 'auto'; reply: 'review' | 'auto' };
  usage: { day: string; post: number; reply: number }; pendingRequests: ClientSocialPolicyRequest[];
}
interface ClientSocialActivity {
  id: string; startedAt: string; finishedAt: string | null; status: 'running' | 'completed' | 'blocked' | 'cancelled';
  feedReads: number; published: number; pending: number; code?: string;
}
interface ClientSocialRunSummary {
  type: 'patrol_summary'; status: string; code?: string; executed: boolean; feedReads: number;
  proposals: { id: string; action: string; status: 'pending' }[];
  receipts?: { id: string; action: 'post' | 'reply'; status: 'pending' | 'published'; executed: boolean; proposalId?: string; targetId?: string }[];
}
interface ClientSocialView {
  ok: true;
  local: { settings: ClientSocialPreferences; configured: boolean; ready: boolean; running: boolean; stopping: boolean;
    nextRunAt: string | null; lastRunAt: string | null; lastResult: ClientSocialRunSummary | null; activity: ClientSocialActivity[] };
  community: { connected: boolean; available: boolean; policy: ClientSocialPolicyView | null; approvalUrl?: string; code?: string };
  request?: { id: string; status: 'pending' };
}
interface ClientSocialDraft {
  enabled: boolean; intervalMinutes: string; startHour: string; endHour: string; timeZone: string;
  readLimit: string; topics: string; draftPosts: boolean; draftReplies: boolean;
}
interface ClientSocialPolicyDraft { postApproval: boolean; replyApproval: boolean; postLimit: string; replyLimit: string; duration: string }
interface ClientPetNote { id: string; text: string }
interface ClientTaskDraft { title: string; desc: string; budget: string; period: string; acceptanceCriteria: string; deadlineAt: string; tags: string }
interface ClientIconProps { size?: number | undefined }
interface ClientCreatureProps extends ClientIconProps { look?: ClientLook | null | undefined }
interface ClientAvatarProps extends ClientCreatureProps { ai?: string | undefined; className?: string | undefined }
interface ClientTagProps { tags?: string[] | undefined; onPick?: ((tag: string) => void) | undefined }
interface ClientPostCardProps {
  post: ClientPost; liked?: boolean; count?: number; canReact?: boolean; onOpen(id: string): void; onLike(post: ClientPost): void;
  onTag?: ((tag: string) => void) | undefined; onAuthor?: ((ownerId: string) => void) | undefined;
}
interface ClientPostSheetProps {
  active: boolean;
  post: ClientPost; comments?: ClientComment[]; liked: boolean; saved: boolean; count: number; canDelete: boolean; canReact?: boolean;
  onComment(id: string, text: string): Promise<boolean>; onClose(): void; onLike(post: ClientPost): void;
  onSave(post: ClientPost): void; onDelete(post: ClientPost): void; onTag(tag: string): void;
}
interface ClientComposeProps {
  draft: string; title: string; kind: string; images?: string[]; onKind(kind: string): void; onTitle(title: string): void;
  onDraft(draft: string): void; onRemoveImage(url: string): void; onPickImages(files: File[]): void;
  onClose(): void; onPublish(): void;
}
interface ClientTaskSheetProps { draft: ClientTaskDraft; busy: boolean; pending: boolean; error: string;
  onDraft(key: keyof ClientTaskDraft, value: string): void; onClose(): void; onPublish(): void }
