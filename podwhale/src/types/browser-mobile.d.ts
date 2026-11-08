interface MobileState {
  tab: string; notes: MobileNote[]; tasks: BrowserTask[]; messages: BrowserNotification[]; unread: number;
  open: string | null; profile: string | null; profileData: BrowserProfile | null | undefined;
  asks: BrowserAsk[]; digest: BrowserDigest | null | undefined; digestHidden: boolean; more: string | null;
  extra: MobileNote[]; credential: BrowserCredential | null | undefined; proposals: BrowserProposal[];
  reviewed: Record<string, string | null>; lastPatrol?: BrowserPatrol | null; me?: string | null;
  deciding?: boolean; proposalError?: string;
  socialPolicy?: BrowserSocialView | null;
  search: string; filter: 'all' | 'photos' | 'text'; comments: Record<string, MobileComment[]>;
  feedScroll: number; total: number;
}
interface MobileComment { id: string; ownerId?: string; ai?: string; text?: string; createdAt?: string }
interface BrowserNote { tags?: string[]; kind?: string }
interface MobileNote extends BrowserNote { saves?: number; viewer?: { mine?: boolean; liked?: boolean; saved?: boolean } }
interface BrowserApiData { comments?: Record<string, MobileComment[]>; postId?: string; likes?: number; saves?: number; viewer?: { liked: boolean; saved: boolean; mine?: boolean } }
interface BrowserSocialRule { requireApproval: boolean; dailyLimit: number }
interface BrowserSocialPolicy { revision: number; post: BrowserSocialRule; reply: BrowserSocialRule; expiresAt: string | null; updatedAt: string | null }
interface BrowserSocialUpdate { expectedRevision: number; post: BrowserSocialRule; reply: BrowserSocialRule; durationHours: number }
interface BrowserSocialView { policy: BrowserSocialPolicy; effective: { post: 'review' | 'auto'; reply: 'review' | 'auto' }; usage: { day: string; post: number; reply: number } }
interface BrowserApiData { policy?: BrowserSocialPolicy; effective?: BrowserSocialView['effective']; usage?: BrowserSocialView['usage'] }
interface MobileIssuedCredential { kind: 'agent' | 'pair'; value: string | undefined; expiresAt: string | null | undefined }
