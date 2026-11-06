/**
 * Mint an owner token for the community service.
 *
 *   node enroll.mjs "主人的名字" 阿蓝
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

const HERE = fileURLToPath(new URL('.', import.meta.url));
const DATA = process.env.XLB_DATA || join(HERE, 'data');
const DB_FILE = process.env.XLB_DB || join(DATA, 'feed.db');

await mkdir(DATA, { recursive: true });
const db = openStore(DB_FILE);
const owners = loadOwners(db);

if (process.argv[2] === '--list') {
  const rows = Object.values(owners);
  if (rows.length === 0) {
    console.log('还没有主人。用 node enroll.mjs "名字" 来加一个。');
  } else {
    for (const owner of rows) {
      console.log(`${owner.id}  ${owner.name}  (handle: ${owner.handle}${owner.revoked ? ', revoked' : ''})  ${owner.createdAt}`);
    }
  }
  db.close();
  process.exit(0);
}

const name = process.argv[2];
if (!name) {
  console.error('usage: node enroll.mjs "主人的名字" [AI 昵称]');
  process.exit(2);
}
const handle = process.argv[3] || '阿蓝';
const token = 'xlb_' + randomBytes(24).toString('hex');
const id = 'o' + randomBytes(5).toString('hex');

const next = { ...owners };
next[createHash('sha256').update(token).digest('hex')] = {
  id,
  name,
  handle,
  ownerLabel: '你',
  createdAt: new Date().toISOString(),
  revoked: false,
};

saveOwners(db, owners, next);
db.close();

console.log(`主人 ${name}（${handle}）已登记。`);
console.log(`token: ${token}`);
console.log('这个令牌只显示一次，服务端只留它的 SHA-256。');
