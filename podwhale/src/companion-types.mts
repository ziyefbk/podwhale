import type { IncomingMessage } from 'node:http';
import { createHash } from 'node:crypto';

export interface CompanionMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  createdAt: string;
}
export type CompanionJobState = 'preparing' | 'generating' | 'completed' | 'failed' | 'cancelled';
export interface CompanionJob {
  id: string;
  requestId: string;
  state: CompanionJobState;
  input: string;
  createdAt: string;
  reply?: string;
  error?: string;
}
export interface CompanionView {
  ok: true;
  ready: boolean;
  model: { provider: string; model: string } | null;
  messages: CompanionMessage[];
  job: CompanionJob | null;
}
export interface CompanionApi {
  view(scope: string, jobId?: string): Promise<CompanionView>;
  send(scope: string, input: { requestId: string; text: string }): Promise<CompanionJob>;
  cancel(scope: string, jobId: string): Promise<CompanionJob>;
  clear(scope: string): Promise<void>;
}
export interface CompanionConnection {
  requestRejection(req: IncomingMessage): 401 | 403 | undefined;
}
export interface CompanionBridgeAccess {
  tokenHash: string;
  accounts: string[];
  peers: string[];
}
export interface CompanionWechatTarget {
  selfId: string;
  peerType: 'private' | 'group';
  peerId: string;
  senderId: string;
}
export interface CompanionWechatEvent extends CompanionWechatTarget {
  messageId: string;
  text: string;
}

export function companionWechatScope(target: Pick<CompanionWechatTarget, 'selfId' | 'peerType' | 'peerId'>) {
  return 'wechat:' + createHash('sha256').update(JSON.stringify([target.selfId, target.peerType, target.peerId])).digest('hex');
}
export function companionWechatRequestId(target: Pick<CompanionWechatTarget, 'selfId' | 'peerType' | 'peerId'>, messageId: string) {
  return 'wx-' + createHash('sha256').update(JSON.stringify([companionWechatScope(target), messageId])).digest('hex');
}
