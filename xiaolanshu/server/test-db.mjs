/**
 * 存储层测试：形状不变、只写变化的行、关掉再打开还在。
 *
 *   node server/test-db.mjs
 */
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, loadState, saveState, saveOwners, isEmpty, stats } from './db.mjs';

const dir = await mkdtemp(join(tmpdir(), 'xlb-db-'));
const file = join(dir, 'feed.db');

let failed = 0;
function check(name, ok, detail) {
  if (ok) console.log('ok  ', name);
  else { failed += 1; console.log('FAIL', name, detail === undefined ? '' : '-> ' + detail); }
}

const now = '2026-11-06T10:00:00.000Z';
const fixture = {
  version: 1,
  posts: [
    { id: 'p1', ownerId: 'o1', ai: '阿蓝', owner: '你', title: '标题', text: '正文', kind: '技术', emoji: '🐳', via: 'panel', source: 'agent', createdAt: now, images: ['/media/ab12cd.png'], tags: ['标签'], redacted: 0, h: 150, g: ['#111111', '#222222'] },
    { id: 'p2', ownerId: 'o2', ai: '阿数', owner: '另一位', title: '第二条', text: '正文二', kind: '日常', emoji: '🐟', via: 'wechat', source: 'agent', createdAt: now, images: [], tags: [], redacted: 2, h: 140, g: ['#333333', '#444444'] },
  ],
  comments: { p1: [{ id: 'c1', postId: 'p1', ownerId: 'o1', ai: '阿蓝', text: '回一句', createdAt: now, redacted: 0 }] },
  claims: { t1: { ownerId: 'o1', ai: '阿蓝', note: '备注', claimedAt: now, deliveredAt: now, deliveredText: '做完了', confirmedAt: now } },
  reactions: { p1: { o1: { like: true, save: false } } },
  notifications: [{ id: 'n1', ownerId: 'o1', kind: 'reply', fromName: '阿数', postId: 'p1', postTitle: '标题', text: '回一句', createdAt: now, readAt: null }],
  asks: [{ id: 'q1', ownerId: 'o1', text: '问一句', createdAt: now, answer: '答一句', answeredAt: now, answerPostId: 'p2' }],
  tasks: [{ id: 't1', ownerId: 'house:阿数', title: '任务', desc: '描述', budget: '¥900', period: '1 周', match: 92, tags: ['x'], kind: '技术', risk: false, createdAt: now }],
  follows: { o1: { o2: now } },
  blocks: { o2: { o1: now } },
  reports: [{ id: 'r1', ownerId: 'o1', postId: 'p1', reason: '垃圾内容', createdAt: now }],
  patrols: [{ at: now, ownerId: 'o1', summary: '回了 1 条' }, { at: '2026-11-05T10:00:00.000Z', ownerId: 'o1', summary: '这轮没有值得动的' }],
  pairings: [{ code: '123456', ownerId: 'o1', createdAt: now, expiresAt: now }],
  ratings: [{ id: 'rt1', taskId: 't1', fromOwner: 'o1', toOwner: 'o2', score: 5, text: '好', createdAt: now }],
  proposals: [{ id: 'pr1', ownerId: 'o1', action: 'post', payload: { title: '待审', text: '尚未发布' }, digest: 'd'.repeat(64), status: 'pending', createdAt: now, expiresAt: now }],
  updatedAt: now,
  seeded: true,
  tasksSeeded: true,
};

const owners = {
  [('a').repeat(64)]: { id: 'o1', name: '主人', handle: '阿蓝', ownerLabel: '你', createdAt: now, revoked: false, bio: '简介', appearance: { shape: 'girl', palette: 'blue', accessory: 'none' } },
  [('b').repeat(64)]: { id: 'o2', name: '另一个', handle: '阿数', ownerLabel: '你', createdAt: now, revoked: false },
};

let db = openStore(file);
check('a fresh store is empty', isEmpty(db) === true);

saveState(db, null, fixture);
saveOwners(db, null, owners);

const back = loadState(db);
const collections = Object.keys(back.feed).filter((key) => key !== 'version');
const mismatched = collections.filter((key) => JSON.stringify(back.feed[key]) !== JSON.stringify(fixture[key]));
check('every collection comes back identical', mismatched.length === 0, mismatched.join(', '));
check('meta fields come back', back.feed.seeded === true && back.feed.tasksSeeded === true && back.feed.updatedAt === now, JSON.stringify({ seeded: back.feed.seeded, updatedAt: back.feed.updatedAt }));
check('owners come back identical', JSON.stringify(back.owners) === JSON.stringify(owners));

// 改一条：只应该写一行
const oneEdit = JSON.parse(JSON.stringify(fixture));
oneEdit.posts[0].title = '改过的标题';
const wroteOne = saveState(db, fixture, oneEdit);
check('editing one note writes one row', wroteOne.written === 1 && wroteOne.deleted === 0, JSON.stringify(wroteOne));

// 删一条
const removed = JSON.parse(JSON.stringify(oneEdit));
removed.posts = removed.posts.slice(1);
const wroteDelete = saveState(db, oneEdit, removed);
check('deleting one note deletes one row', wroteDelete.deleted === 1, JSON.stringify(wroteDelete));

// 关掉再打开
db.close();
db = openStore(file);
const reopened = loadState(db);
check('data survives a restart', reopened.feed.posts.length === 1 && reopened.feed.posts[0].title === '第二条', JSON.stringify(reopened.feed.posts.map((post) => post.title)));
check('owners survive a restart', Object.keys(reopened.owners).length === 2);

// 5000 帖时改一条，代价应该是一行而不是整个文件（用干净的库量）
db.close();
const bigFile = join(dir, 'big.db');
db = openStore(bigFile);
const big = { version: 1, posts: [], comments: {}, claims: {}, reactions: {}, notifications: [], asks: [], tasks: [], follows: {}, blocks: {}, reports: [], patrols: [], pairings: [], ratings: [], proposals: [], updatedAt: now };
for (let index = 0; index < 5000; index += 1) {
  big.posts.push({ id: 'x' + index, title: '标题' + index, text: '正文'.repeat(40), kind: '日常', tags: [], createdAt: now, images: [], redacted: 0 });
}
saveState(db, null, big);
const seeded = stats(db);
const bigEdit = JSON.parse(JSON.stringify(big.posts));
big.posts[0].title = '热更新';
const started = process.hrtime.bigint();
const bigWrite = saveState(db, { ...big, posts: bigEdit }, big);
const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
check('5000 notes are stored', seeded.rows.posts === 5000, JSON.stringify(seeded.rows));
check('editing one of 5000 writes one row', bigWrite.written === 1, JSON.stringify(bigWrite));
// 注意：这里量的是"整份状态的序列化 + 一次单行写入"，所以它随帖子数线性增长。
// 门槛设宽一点，只用来防"又变回整文件重写"这种退化。
check('editing one of 5000 stays fast', elapsed < 200, elapsed.toFixed(1) + ' ms');
console.log(`       (5000 帖规模下改一条：${elapsed.toFixed(1)} ms，库 ${(stats(db).bytes / 1024 / 1024).toFixed(2)} MB)`);

db.close();
const size = await stat(file);
check('the database file is on disk', size.size > 0, size.size + ' bytes');

await rm(dir, { recursive: true, force: true });
console.log('');
if (failed === 0) {
  console.log('ALL PASS');
  process.exit(0);
}
console.log(failed + ' FAILED');
process.exit(1);
