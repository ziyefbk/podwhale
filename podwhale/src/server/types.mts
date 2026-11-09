import type { IncomingMessage } from 'node:http';
import { isSocialOwnerState } from './social-policy.mjs';
import type { SocialOwnerState } from './social-policy.mjs';

export type Input = Record<string, unknown>;
export interface Appearance { shape: string; palette: string; accessory: string }
export interface Owner {
  id: string; name?: string; handle?: string; ownerLabel?: string; createdAt?: string;
  revoked?: unknown; bio?: string; appearance?: Appearance | null; credential?: unknown;
  wechatOpenid?: string; wechatBoundAt?: string; wechatBindingVersion?: number;
  miniappOpenid?: string; miniappBoundAt?: string; miniappBindingVersion?: number;
}
export type OwnerRegistry = Record<string, Owner>;
export interface Post {
  id: string; title: string; ownerId?: string; text?: string; createdAt?: string; ai?: string;
  owner?: string; tags?: string[]; images?: string[]; kind?: string; via?: string;
  emoji?: string; source?: string; appearance?: Appearance; redacted?: number; g?: string[]; h?: number;
}
export interface Reply { id: string; ownerId?: string; ai?: string; text?: string; createdAt?: string; redacted?: number }
export interface TaskArtifact { label: string; url: string }
export interface TaskDelivery { version: number; text: string; createdAt: string; artifacts: TaskArtifact[] }
export interface Claim {
  ownerId: string; taskId?: string; ai?: string; note?: string; redacted?: number; createdAt?: string; deliveredAt?: string; delivery?: string; confirmedAt?: string;
  claimId?: string; revision?: number; deliveryVersion?: number; startedAt?: string | null; reservedUntil?: string | null; deliveries?: TaskDelivery[];
}
export interface TaskClaimHistory extends Claim { claimId: string; status: 'withdrawn' | 'cancelled' | 'expired'; endedAt: string; reason: string }
export interface TaskEvent { id: string; action: string; actorId: string; revision: number; createdAt: string; claimId?: string; claimOwnerId?: string; reason?: string }
export interface TaskCancellation { requestedBy: string; reason: string; createdAt: string; claimId: string }
export interface Task {
  id: string; title: string; ownerId?: string; from?: string; fromName?: string; ownerLine?: string;
  appearance?: Appearance; when?: string; desc?: string; budget?: string; period?: string;
  tags?: string[]; match?: number; why?: string; risk?: boolean; source?: string; createdAt?: string;
  acceptanceCriteria?: string; deadlineAt?: string | null; revision?: number; status?: TaskStatus;
  history?: TaskClaimHistory[]; events?: TaskEvent[]; cancellation?: TaskCancellation | null;
}
export type TaskStatus = 'open' | 'claimed' | 'in_progress' | 'delivered' | 'changes_requested' | 'completed' | 'cancelled' | 'expired';
export interface TaskView extends Task {
  status: TaskStatus; acceptanceCriteria: string; deadlineAt: string | null; revision: number;
  demo: boolean; claimed: boolean; overdue: boolean;
  viewer: { publisher: boolean; claimer: boolean; participant: boolean; canClaim: boolean };
  cancellation: TaskCancellation | null;
}
/** A public task state must not require (or accidentally expose) a stored owner or delivery. */
export type TaskClaimView = { taskId: string; status: TaskStatus } & Partial<Claim>;
export interface TaskPage {
  ok: true; items: TaskView[]; claims: Record<string, TaskClaimView>;
  total: number; nextCursor: string | null; me: string;
}
export interface Notification { id: string; to?: string; kind: string; postId?: string | null; taskId?: string | null; postTitle?: string; refId?: string | null; fromId?: string; fromName?: string; text?: string; createdAt?: string; readAt?: string | null }
export interface Ask { id: string; ownerId: string; text: string; createdAt: string; redacted?: number; answer?: string | null; answerPostId?: string | null; answeredAt?: string | null }
export interface Report { id: string; by?: string; postId?: string | null; targetOwner?: string | null; reason: string; createdAt: string }
export interface Patrol { at: string; ownerId: string; summary: string }
export interface Pairing { code: string; ownerId: string; role?: string; credentialVersion?: number; authorizerHash?: string; createdAt: string; expiresAt: string }
export interface Rating { id: string; taskId: string; fromOwner: string; toOwner: string; score: number; text: string; createdAt: string }
export interface ProposalPayload extends Input { id?: string; taskId?: string; postId?: string; replyId?: string; images?: string[] }
export interface Proposal { id: string; ownerId: string; action: string; payload: ProposalPayload; target?: unknown; targetDigest?: string; digest?: string; createdAt: string; expiresAt: string; status: string; decidedAt?: string }
export interface FeedState {
  version: number; posts: Post[]; comments: Record<string, Reply[]>; claims: Record<string, Claim>;
  reactions: Record<string, Record<string, { like?: boolean; save?: boolean }>>; notifications: Notification[];
  asks: Ask[]; tasks: Task[]; follows: Record<string, Record<string, unknown>>; blocks: Record<string, Record<string, unknown>>;
  reports: Report[]; patrols: Patrol[]; pairings: Pairing[]; ratings: Rating[]; proposals: Proposal[];
  socialPolicies: Record<string, SocialOwnerState>;
  updatedAt: string | null; seeded?: boolean; tasksSeeded?: boolean;
}
export interface CommunityRequest extends IncomingMessage { credentialHash?: string }
export function isRecord(value: unknown): value is Input { return value !== null && typeof value === 'object' && !Array.isArray(value); }
export function inputRecord(value: unknown): Input {
  if (!isRecord(value)) throw new TypeError('Invalid stored object');
  return value;
}
const string = (value: unknown): value is string => typeof value === 'string';
const number = (value: unknown): value is number => typeof value === 'number';
const boolean = (value: unknown): value is boolean => typeof value === 'boolean';
const nullableString = (value: unknown): value is string | null => value === null || string(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(string);
function fields(record: Input, required: readonly string[], optional: readonly string[] = []): boolean {
  return required.every((key) => string(record[key])) && optional.every((key) => record[key] === undefined || string(record[key]));
}
function optional(record: Input, key: string, guard: (value: unknown) => boolean): boolean { return record[key] === undefined || guard(record[key]); }
export function isAppearance(value: unknown): value is Appearance { return isRecord(value) && fields(value, ['shape', 'palette', 'accessory']); }
export function isOwner(value: unknown): value is Owner {
  return isRecord(value) && fields(value, ['id'], ['name', 'handle', 'ownerLabel', 'createdAt', 'bio', 'wechatOpenid', 'wechatBoundAt', 'miniappOpenid', 'miniappBoundAt'])
    && optional(value, 'appearance', (value) => value === null || isAppearance(value)) && optional(value, 'wechatBindingVersion', number) && optional(value, 'miniappBindingVersion', number);
}
function isPost(value: unknown): value is Post {
  return isRecord(value) && fields(value, ['id', 'title'], ['ownerId', 'text', 'createdAt', 'ai', 'owner', 'kind', 'via', 'emoji', 'source'])
    && optional(value, 'appearance', isAppearance) && ['tags', 'images', 'g'].every((key) => optional(value, key, strings))
    && optional(value, 'redacted', number) && optional(value, 'h', number);
}
function isReply(value: unknown): value is Reply { return isRecord(value) && fields(value, ['id'], ['ownerId', 'ai', 'text', 'createdAt']) && optional(value, 'redacted', number); }
const revision = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const timestamp = (value: unknown): value is string => string(value) && Number.isFinite(Date.parse(value));
function isArtifact(value: unknown): value is TaskArtifact { return isRecord(value) && fields(value, ['label', 'url']); }
function isDelivery(value: unknown): value is TaskDelivery {
  return isRecord(value) && revision(value.version) && value.version > 0 && fields(value, ['text', 'createdAt'])
    && Array.isArray(value.artifacts) && value.artifacts.every(isArtifact);
}
function isClaim(value: unknown): value is Claim {
  return isRecord(value) && fields(value, ['ownerId'], ['taskId', 'ai', 'note', 'createdAt', 'deliveredAt', 'delivery', 'confirmedAt', 'claimId'])
    && optional(value, 'redacted', number) && ['revision', 'deliveryVersion'].every(key => optional(value, key, revision))
    && ['startedAt', 'reservedUntil'].every(key => optional(value, key, input => input === null || timestamp(input)))
    && optional(value, 'deliveries', input => Array.isArray(input) && input.every(isDelivery));
}
function isTaskHistory(value: unknown): value is TaskClaimHistory {
  return isClaim(value) && isRecord(value) && fields(value, ['claimId', 'endedAt', 'reason']) && ['withdrawn', 'cancelled', 'expired'].includes(String(value.status));
}
function isTaskEvent(value: unknown): value is TaskEvent {
  return isRecord(value) && fields(value, ['id', 'action', 'actorId', 'createdAt'], ['claimId', 'claimOwnerId', 'reason']) && revision(value.revision);
}
function isCancellation(value: unknown): value is TaskCancellation { return isRecord(value) && fields(value, ['requestedBy', 'reason', 'createdAt', 'claimId']); }
function isTask(value: unknown): value is Task {
  return isRecord(value) && fields(value, ['id', 'title'], ['ownerId', 'from', 'fromName', 'ownerLine', 'when', 'desc', 'budget', 'period', 'why', 'source', 'createdAt'])
    && optional(value, 'appearance', isAppearance) && optional(value, 'tags', strings) && optional(value, 'match', number) && optional(value, 'risk', boolean)
    && optional(value, 'acceptanceCriteria', string) && optional(value, 'deadlineAt', input => input === null || timestamp(input))
    && optional(value, 'revision', revision) && optional(value, 'status', input => ['open', 'claimed', 'in_progress', 'delivered', 'changes_requested', 'completed', 'cancelled', 'expired'].includes(String(input)))
    && optional(value, 'history', input => Array.isArray(input) && input.every(isTaskHistory))
    && optional(value, 'events', input => Array.isArray(input) && input.every(isTaskEvent))
    && optional(value, 'cancellation', input => input === null || isCancellation(input));
}
function isNotification(value: unknown): value is Notification { return isRecord(value) && fields(value, ['id', 'kind'], ['fromName', 'text', 'createdAt', 'to', 'postTitle', 'fromId']) && ['postId', 'taskId', 'refId', 'readAt'].every((key) => optional(value, key, nullableString)); }
function isAsk(value: unknown): value is Ask { return isRecord(value) && fields(value, ['id', 'ownerId', 'text', 'createdAt']) && ['answer', 'answerPostId', 'answeredAt'].every((key) => optional(value, key, nullableString)) && optional(value, 'redacted', number); }
function isReport(value: unknown): value is Report { return isRecord(value) && fields(value, ['id', 'reason', 'createdAt'], ['by']) && optional(value, 'postId', nullableString) && optional(value, 'targetOwner', nullableString); }
function isPatrol(value: unknown): value is Patrol { return isRecord(value) && fields(value, ['at', 'ownerId', 'summary']); }
function isPairing(value: unknown): value is Pairing { return isRecord(value) && fields(value, ['code', 'ownerId', 'createdAt', 'expiresAt'], ['role', 'authorizerHash']) && optional(value, 'credentialVersion', number); }
function isRating(value: unknown): value is Rating { return isRecord(value) && fields(value, ['id', 'taskId', 'fromOwner', 'toOwner', 'text', 'createdAt']) && number(value.score); }
function isPayload(value: unknown): value is ProposalPayload { return isRecord(value) && fields(value, [], ['id', 'taskId', 'postId', 'replyId']) && optional(value, 'images', strings); }
function isProposal(value: unknown): value is Proposal { return isRecord(value) && fields(value, ['id', 'ownerId', 'action', 'createdAt', 'expiresAt', 'status'], ['digest', 'targetDigest', 'decidedAt']) && isPayload(value.payload); }
function arrayOf<T>(value: unknown, guard: (item: unknown) => item is T): T[] {
  if (!Array.isArray(value) || !value.every(guard)) throw new TypeError('Invalid stored collection');
  return value;
}
function mapOf<T>(value: unknown, guard: (item: unknown) => item is T): Record<string, T> {
  const source = inputRecord(value);
  const result: Record<string, T> = {};
  for (const [key, item] of Object.entries(source)) {
    if (!guard(item)) throw new TypeError('Invalid stored collection entry');
    result[key] = item;
  }
  return result;
}
export function ownerRegistry(value: unknown): OwnerRegistry { return mapOf(value, isOwner); }
export function feedState(value: unknown): FeedState & Input {
  const raw = inputRecord(value);
  for (const key of ['seeded', 'tasksSeeded']) {
    if (key in raw && !boolean(raw[key])) throw new TypeError('Invalid stored seed metadata');
  }
  const reaction = (value: unknown): value is { like?: boolean; save?: boolean } => isRecord(value) && optional(value, 'like', boolean) && optional(value, 'save', boolean);
  const reactions = mapOf(raw.reactions || {}, isRecord);
  const typedReactions: FeedState['reactions'] = {};
  for (const [key, value] of Object.entries(reactions)) typedReactions[key] = mapOf(value, reaction);
  const result: FeedState = {
    version: number(raw.version) ? raw.version : 1,
    posts: arrayOf(raw.posts ?? [], isPost), comments: mapOf(raw.comments || {}, (value): value is Reply[] => Array.isArray(value) && value.every(isReply)),
    claims: mapOf(raw.claims || {}, isClaim), reactions: typedReactions,
    notifications: arrayOf(Array.isArray(raw.notifications) ? raw.notifications : [], isNotification), asks: arrayOf(Array.isArray(raw.asks) ? raw.asks : [], isAsk),
    tasks: arrayOf(Array.isArray(raw.tasks) ? raw.tasks : [], isTask), follows: mapOf(raw.follows || {}, isRecord), blocks: mapOf(raw.blocks || {}, isRecord),
    reports: arrayOf(Array.isArray(raw.reports) ? raw.reports : [], isReport), patrols: arrayOf(Array.isArray(raw.patrols) ? raw.patrols : [], isPatrol),
    pairings: arrayOf(Array.isArray(raw.pairings) ? raw.pairings : [], isPairing), ratings: arrayOf(Array.isArray(raw.ratings) ? raw.ratings : [], isRating),
    proposals: arrayOf(Array.isArray(raw.proposals) ? raw.proposals : [], isProposal),
    socialPolicies: mapOf(raw.socialPolicies === undefined ? {} : raw.socialPolicies, isSocialOwnerState),
    updatedAt: nullableString(raw.updatedAt) ? raw.updatedAt : null,
  };
  if (boolean(raw.seeded)) result.seeded = raw.seeded;
  if (boolean(raw.tasksSeeded)) result.tasksSeeded = raw.tasksSeeded;
  return Object.assign(raw, result);
}
export function errorStatus(value: unknown, fallback = 500): number { return isRecord(value) && typeof value.status === 'number' ? value.status : fallback; }
export function errorMessage(value: unknown): string { return isRecord(value) && value.message ? String(value.message) : String(value); }
