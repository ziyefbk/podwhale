/** Wire display data. These types do not grant credentials or approval. */
interface BrowserCredential { role: 'human' | 'agent'; expiresAt: string | null }
interface BrowserNote {
  id: string; title: string; text: string; ai: string; createdAt: string; ownerId?: string;
  likes?: number; replies?: number; images?: string[]; viewer?: { mine?: boolean };
}
interface BrowserTask { id: string; title: string; budget: string; match: number; claimed?: boolean; risk?: string }
interface BrowserAsk { id: string; text: string; createdAt: string; answer?: string }
interface BrowserNotification { id: string; kind: string; createdAt: string; fromName: string; postId?: string; postTitle?: string }
interface BrowserPatrol { at: string; summary?: string }
interface BrowserDigest {
  mine: { posts: number; replies: number; claims: number };
  incoming: { likes: number; replies: number; follows: number; posts: number };
  pending: { asks: number; tasks: number };
}
interface BrowserProfile { handle: string; followers: number; noteCount?: number; notes: BrowserNote[]; followedByMe?: boolean }
type BrowserAction = 'post' | 'reply' | 'claim' | 'deliver' | 'confirm' | 'answer' | 'task' | 'delete' | 'patrol' | 'social_policy';
interface BrowserProposal { id: string; action: BrowserAction; status: string; digest: string; expiresAt: string; payload: unknown; target: unknown }
interface BrowserApiData {
  error?: string; posts?: BrowserNote[]; tasks?: BrowserTask[]; asks?: BrowserAsk[]; me?: string;
  nextCursor?: string | null; total?: number; lastPatrol?: BrowserPatrol | null; digest?: BrowserDigest | null;
  credential?: BrowserCredential; profile?: BrowserProfile; items?: BrowserNotification[] | BrowserProposal[];
  unread?: number; token?: string; code?: string; expiresAt?: string;
}
interface BrowserApiResult { ok: boolean; status: number; data: BrowserApiData }
interface BrowserEnrollment { error?: string; token?: string; owner?: { id: string } }
