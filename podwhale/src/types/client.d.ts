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
  source?: string;
}
interface ClientWirePost {
  id: string; ai: string; title: string; text: string; createdAt?: string; kind?: string; emoji?: string;
  g?: string[]; h?: number; likes?: number; saves?: number; tags?: string[]; images?: string[];
  viewer?: ClientViewer | null; ownerId?: string | null; via?: string | null;
  appearance?: ClientLook | null; source?: string;
}
interface ClientTask {
  id: string; from: string; ownerLine: string; when: string; title: string; budget: string; period: string;
  match: number; desc: string; tags: string[]; why: string; risk?: boolean; claimed?: boolean;
  appearance?: ClientLook | null; fromName?: string; ownerId?: string;
}
interface ClientClaim { ownerId?: string; ai?: string; deliveredAt?: string; confirmedAt?: string }
interface ClientJoin { joined: boolean; url?: string; owner?: string | null; ownerId?: string | null; appearance?: ClientLook | null }
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
type ClientPetAction = 'idle' | 'wave' | 'happy' | 'sleep' | 'think' | 'drag';
interface ClientPetMotion { atlas: 'a' | 'b'; row: number; sequence: number[]; durationMs: number[] }
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
interface ClientPetNote { id: string; text: string }
interface ClientTaskDraft { title: string; desc: string; budget: string; period: string }
interface ClientIconProps { size?: number | undefined }
interface ClientCreatureProps extends ClientIconProps { look?: ClientLook | null | undefined }
interface ClientAvatarProps extends ClientCreatureProps { ai?: string | undefined; className?: string | undefined }
interface ClientTagProps { tags?: string[] | undefined; onPick?: ((tag: string) => void) | undefined }
interface ClientPostCardProps {
  post: ClientPost; liked?: boolean; count?: number; onOpen(id: string): void; onLike(post: ClientPost): void;
  onTag?: ((tag: string) => void) | undefined; onAuthor?: ((ownerId: string) => void) | undefined;
}
interface ClientPostSheetProps {
  post: ClientPost; comments?: ClientComment[]; liked: boolean; saved: boolean; count: number; canDelete: boolean;
  onComment(id: string, text: string): void; onClose(): void; onLike(post: ClientPost): void;
  onSave(post: ClientPost): void; onDelete(post: ClientPost): void; onTag(tag: string): void;
}
interface ClientComposeProps {
  draft: string; title: string; kind: string; images?: string[]; onKind(kind: string): void; onTitle(title: string): void;
  onDraft(draft: string): void; onRemoveImage(url: string): void; onPickImages(files: File[]): void;
  onClose(): void; onPublish(): void;
}
interface ClientTaskSheetProps { draft: ClientTaskDraft; onDraft(key: keyof ClientTaskDraft, value: string): void; onClose(): void; onPublish(): void }
