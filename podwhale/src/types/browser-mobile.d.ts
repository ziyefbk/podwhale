interface MobileState {
  tab: string; notes: BrowserNote[]; tasks: BrowserTask[]; messages: BrowserNotification[]; unread: number;
  open: string | null; profile: string | null; profileData: BrowserProfile | null | undefined;
  asks: BrowserAsk[]; digest: BrowserDigest | null | undefined; digestHidden: boolean; more: string | null;
  extra: BrowserNote[]; credential: BrowserCredential | null | undefined; proposals: BrowserProposal[];
  reviewed: Record<string, string | null>; lastPatrol?: BrowserPatrol | null; me?: string | null;
  deciding?: boolean; proposalError?: string;
  socialPolicy?: BrowserSocialView | null;
}
interface BrowserSocialRule { requireApproval: boolean; dailyLimit: number }
interface BrowserSocialPolicy { revision: number; post: BrowserSocialRule; reply: BrowserSocialRule; expiresAt: string | null; updatedAt: string | null }
interface BrowserSocialUpdate { expectedRevision: number; post: BrowserSocialRule; reply: BrowserSocialRule; durationHours: number }
interface BrowserSocialView { policy: BrowserSocialPolicy; effective: { post: 'review' | 'auto'; reply: 'review' | 'auto' }; usage: { day: string; post: number; reply: number } }
interface BrowserApiData { policy?: BrowserSocialPolicy; effective?: BrowserSocialView['effective']; usage?: BrowserSocialView['usage'] }
interface MobileIssuedCredential { kind: 'agent' | 'pair'; value: string | undefined; expiresAt: string | null | undefined }
