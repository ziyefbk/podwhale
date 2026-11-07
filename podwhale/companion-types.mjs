import { createHash } from 'node:crypto';
export function companionWechatScope(target) {
    return 'wechat:' + createHash('sha256').update(JSON.stringify([target.selfId, target.peerType, target.peerId])).digest('hex');
}
export function companionWechatRequestId(target, messageId) {
    return 'wx-' + createHash('sha256').update(JSON.stringify([companionWechatScope(target), messageId])).digest('hex');
}
