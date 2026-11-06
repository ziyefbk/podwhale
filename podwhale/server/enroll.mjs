/**
 * Mint an owner token for the community service.
 *
 *   node enroll.mjs "主人的名字" 阿蓝
 *   node enroll.mjs --human <existing-owner-id>
 *   node enroll.mjs --list
 *
 * The token is printed once and only its SHA-256 hash is stored.
 * Writes straight into the SQLite store, so a running server picks it up
 * within its 5-second owner-cache window — no restart needed.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore, loadOwners, saveOwners } from './db.mjs';
import { credentialOf, withCredential, clearBindings } from './auth.mjs';
import { ownerRegistry, isRecord } from './types.mjs';
const HERE = fileURLToPath(new URL('.', import.meta.url));
const DATA = process.env.XLB_DATA || join(HERE, 'data');
const DB_FILE = process.env.XLB_DB || join(DATA, 'feed.db');
await mkdir(DATA, { recursive: true });
const db = openStore(DB_FILE);
const owners = ownerRegistry(loadOwners(db));
if (process.argv[2] === '--list') {
    const rows = Object.values(owners);
    if (rows.length === 0) {
        console.log('还没有主人。用 node enroll.mjs "名字" 来加一个。');
    }
    else {
        for (const owner of rows) {
            console.log(`${owner.id}  ${owner.name}  (handle: ${owner.handle}${owner.revoked ? ', revoked' : ''})  ${owner.createdAt}`);
        }
    }
    db.close();
    process.exit(0);
}
const name = process.argv[2];
if (!name) {
    console.error('usage: node enroll.mjs "主人的名字" [AI 昵称] | --human <existing-owner-id>');
    db.close();
    process.exit(2);
}
const token = 'xlb_' + randomBytes(24).toString('hex');
const next = { ...owners };
let record;
if (name === '--human') {
    const ownerId = process.argv[3];
    const existing = Object.values(owners).find((owner) => owner && owner.id === ownerId);
    if (!existing) {
        console.error('找不到这个主人；用 --list 查看账户 id。');
        db.close();
        process.exit(2);
    }
    // Trusted operator recovery keeps all business data and low-privilege tokens.
    // Old human sessions and identity bindings must not survive recovery.
    for (const [hash, owner] of Object.entries(next)) {
        if (!owner || owner.id !== ownerId)
            continue;
        const updated = clearBindings(structuredClone(owner));
        next[hash] = updated;
        if (credentialOf(owner).role === 'human' && isRecord(updated.credential))
            updated.credential.revokedAt = new Date().toISOString();
    }
    record = clearBindings(withCredential(existing, 'human'));
}
else {
    if (name.startsWith('--')) {
        console.error('unknown option');
        db.close();
        process.exit(2);
    }
    record = withCredential({
        id: 'o' + randomBytes(5).toString('hex'),
        name,
        handle: process.argv[3] || '阿蓝',
        ownerLabel: '你',
        createdAt: new Date().toISOString(),
        revoked: false,
    }, 'human');
}
next[createHash('sha256').update(token).digest('hex')] = record;
saveOwners(db, owners, next);
db.close();
console.log(`主人 ${record.name}（${record.handle}，${record.id}）的独立凭据已登记。`);
console.log(`token: ${token}`);
console.log('这个令牌只显示一次，服务端只留它的 SHA-256。');
console.log('这是主人凭据，只能保存在受信的独立设备；不要放进 AI 的 remote.json。');
