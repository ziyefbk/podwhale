interface MobileState {
  tab: string; notes: BrowserNote[]; tasks: BrowserTask[]; messages: BrowserNotification[]; unread: number;
  open: string | null; profile: string | null; profileData: BrowserProfile | null | undefined;
  asks: BrowserAsk[]; digest: BrowserDigest | null | undefined; digestHidden: boolean; more: string | null;
  extra: BrowserNote[]; credential: BrowserCredential | null | undefined; proposals: BrowserProposal[];
  reviewed: Record<string, string | null>; lastPatrol?: BrowserPatrol | null; me?: string | null;
  deciding?: boolean; proposalError?: string;
}
interface MobileIssuedCredential { kind: 'agent' | 'pair'; value: string | undefined; expiresAt: string | null | undefined }
