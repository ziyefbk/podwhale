/** Successful payload contracts for the controlled HTTP test fixtures.
 * Tests still assert the real status, shape, values and error behavior.
 */
import type { TaskView, TaskClaimView } from './types.mjs';
export interface FixtureAppearance { shape: string; palette: string; accessory: string }
export interface FixtureOwner { id: string; name: string; handle: string; bio?: string; appearance: FixtureAppearance }
export interface FixtureCredential { role: string; expiresAt: string | null }
export interface FixturePost {
  id: string; ownerId: string; ai: string; owner: string; title: string; text: string;
  kind: string; via: string; tags: string[]; images: string[]; createdAt: string;
  redacted: number;
}
export interface FixtureFeedPost extends Omit<FixturePost, 'images' | 'via'> {
  images?: string[]; via?: string; replies: number;
  appearance: FixtureAppearance; viewer: { liked: boolean; saved: boolean; mine: boolean };
}
export interface FixtureReply { id: string; ownerId: string; ai: string; text: string; createdAt: string }
export interface FixtureClaim { ownerId: string; ai: string; createdAt: string; deliveredAt?: string; confirmedAt?: string }
export interface FixtureTask { id: string; title: string; fromName?: string; appearance?: FixtureAppearance; claimed?: boolean }
export interface FixturePublishedTask extends FixtureTask { fromName: string; appearance: FixtureAppearance }
export interface FixtureAsk { id: string; ownerId: string; text: string; answer: string | null; answerPostId: string | null }
export interface FixturePatrol { at: string; ownerId: string; summary: string }
export interface FixtureNotification { id: string; kind: string; to: string; postId: string | null; taskId: string | null; readAt: string | null }
export interface FixtureFeed {
  posts: FixtureFeedPost[]; tasks: TaskView[]; comments: Record<string, FixtureReply[]>; claims: Record<string, TaskClaimView>;
  asks: FixtureAsk[]; me: string; following: string[]; blocked: string[]; ratingsByMe: string[];
  lastPatrol: FixturePatrol | null; patrols: FixturePatrol[]; myProfile: { handle: string; bio: string };
  total: number; nextCursor: string | null;
}
export interface FixtureHealth {
  ok: boolean; counts: { posts: number; owners: number }; backup: { files: number; ageHours: number | null };
  warnings: string[]; lastPatrol: { at: string } | null;
}
export interface FixtureReputation { count: number; average: number | null }
export interface FixturePublicProfile { followers: number; following: number; followedByMe: boolean; reputation: FixtureReputation }
export interface FixtureActivity { id: string; kind: string; ref: string }
export interface FixtureSession { token?: string; needBind?: boolean; credential?: FixtureCredential }
export interface FixtureEnrollment { token: string; owner: { id: string; name: string; handle: string } }
export interface FixtureUpload { url: string }
export interface FixtureRoutes {
  '/health': FixtureHealth;
  '/feed': FixtureFeed;
  '/post': { ok: boolean; post: FixturePost };
  '/reply': { ok: boolean; reply: FixtureReply; postId: string };
  '/react': { likes: number; saves: number };
  '/patrol': FixturePatrol;
  '/whoami': { owner: FixtureOwner; credential: FixtureCredential };
  '/appearance': { appearance: FixtureAppearance };
  '/notifications': { items: FixtureNotification[]; unread: number };
  '/read': { marked: number };
  '/claim': { repeated: boolean; claim: FixtureClaim; task: FixtureTask };
  '/task': { task: FixturePublishedTask };
  '/deliver': { repeated: boolean; confirmed: boolean };
  '/confirm': { repeated: boolean; confirmed: boolean };
  '/rate': { rating: { id: string; score: number; to: string } };
  '/profile': { owner: { id: string; name: string; handle: string; bio: string } };
  '/follow': { on: boolean };
  '/block': { on: boolean };
  '/report': { report: { id: string } };
  '/reports': { items: { id: string; reason: string }[] };
  '/activity': { items: FixtureActivity[] };
  '/ask': { ask: FixtureAsk };
  '/answer': { postId: string | null; repeated: boolean };
  '/ask/delete': { id: string };
  '/delete': { deleted: boolean };
  '/digest': { digest: { windowHours: number; mine: { posts: number }; incoming: { likes: number }; pending: { asks: number } } };
  '/wxapp/login': FixtureSession;
  '/wxapp/bind': FixtureSession;
  '/pair': { code?: string };
  '/pair/redeem': FixtureSession;
  '/rotate': FixtureSession;
  '/enroll': FixtureEnrollment;
}
export type FixtureResponse<Path extends string> = Path extends `/profile?${string}` ? { profile: FixturePublicProfile }
  : Path extends `${infer Route}?${string}` ? Route extends keyof FixtureRoutes ? FixtureRoutes[Route] : unknown
  : Path extends keyof FixtureRoutes ? FixtureRoutes[Path] : unknown;
