/**
 * 存储层测试：形状不变、只写变化的行、关掉再打开还在。
 *
 *   node server/test-db.mjs
 */
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, basename } from 'node:path';
import { openStore, loadState, saveState, saveOwners, isEmpty, stats } from './db.mjs';
import { feedState, ownerRegistry, isRecord } from './types.mjs';
import type { Post } from './types.mjs';

const temporaryRoot = resolve(tmpdir());
const dir = await mkdtemp(join(temporaryRoot, 'xlb-db-'));
const file = join(dir, 'feed.db');

let failed = 0;
function check(name: string, ok: unknown, detail: unknown = "") {
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
const expectedFields: Record<string, unknown> = { ...fixture };
const mismatched = collections.filter((key) => JSON.stringify(back.feed[key]) !== JSON.stringify(expectedFields[key]));
check('every collection comes back identical', mismatched.length === 0, mismatched.join(', '));
check('meta fields come back', back.feed.seeded === true && back.feed.tasksSeeded === true && back.feed.updatedAt === now, JSON.stringify({ seeded: back.feed.seeded, updatedAt: back.feed.updatedAt }));
check('owners come back identical', JSON.stringify(back.owners) === JSON.stringify(owners));

// 改一条：只应该写一行
const oneEdit = structuredClone(fixture);
const firstEditedPost = oneEdit.posts[0];
if (!firstEditedPost) throw new Error('Missing first post fixture');
firstEditedPost.title = '改过的标题';
const wroteOne = saveState(db, fixture, oneEdit);
check('editing one note writes one row', wroteOne.written === 1 && wroteOne.deleted === 0, JSON.stringify(wroteOne));

// 删一条
const removed = structuredClone(oneEdit);
removed.posts = removed.posts.slice(1);
const wroteDelete = saveState(db, oneEdit, removed);
check('deleting one note deletes one row', wroteDelete.deleted === 1, JSON.stringify(wroteDelete));

// 关掉再打开
db.close();
db = openStore(file);
const reopened = loadState(db);
const reopenedPosts = reopened.feed.posts;
if (!Array.isArray(reopenedPosts) || !reopenedPosts.every((post: unknown): post is { title: string } => isRecord(post) && typeof post.title === 'string')) throw new Error('Unexpected reopened fixture posts');
check('data survives a restart', reopenedPosts.length === 1 && reopenedPosts[0]?.title === '第二条', JSON.stringify(reopenedPosts.map((post) => post.title)));
check('owners survive a restart', Object.keys(reopened.owners).length === 2);

// 5000 帖时改一条，代价应该是一行而不是整个文件（用干净的库量）
db.close();
const bigFile = join(dir, 'big.db');
db = openStore(bigFile);
const bigPosts: Post[] = [];
const big = { version: 1, posts: bigPosts, comments: {}, claims: {}, reactions: {}, notifications: [], asks: [], tasks: [], follows: {}, blocks: {}, reports: [], patrols: [], pairings: [], ratings: [], proposals: [], updatedAt: now };
for (let index = 0; index < 5000; index += 1) {
  big.posts.push({ id: 'x' + index, title: '标题' + index, text: '正文'.repeat(40), kind: '日常', tags: [], createdAt: now, images: [], redacted: 0 });
}
saveState(db, null, big);
const seeded = stats(db);
const bigEdit = structuredClone(big.posts);
const firstBigPost = big.posts[0];
if (!firstBigPost) throw new Error('Missing first large fixture post');
firstBigPost.title = '热更新';
const started = process.hrtime.bigint();
const bigWrite = saveState(db, { ...big, posts: bigEdit }, big);
const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
check('5000 notes are stored', seeded.rows.posts === 5000, JSON.stringify(seeded.rows));
check('editing one of 5000 writes one row', bigWrite.written === 1, JSON.stringify(bigWrite));
// 注意：这里量的是"整份状态的序列化 + 一次单行写入"，所以它随帖子数线性增长。
// 门槛设宽一点，只用来防"又变回整文件重写"这种退化。
check('editing one of 5000 stays fast', elapsed < 200, elapsed.toFixed(1) + ' ms');
console.log(`       (5000 帖规模下改一条：${elapsed.toFixed(1)} ms，库 ${(stats(db).bytes / 1024 / 1024).toFixed(2)} MB)`);

const legacy = structuredClone(fixture);
const rawLegacy: Record<string, unknown> = { ...legacy, extensionMetadata: { source: 'legacy-fixture', retained: true },
  comments: { p1: [{ id: 'legacy-reply', legacyExtension: 7 }] },
  asks: [{ id: 'legacy-ask', ownerId: 'o1', text: 'legacy question', createdAt: now }],
  notifications: [{ id: 'legacy-notification', kind: 'reply' }],
};
const normalizedLegacy = feedState(rawLegacy);
check('stored decoding retains unknown metadata and default-free legacy fields', normalizedLegacy.extensionMetadata === rawLegacy.extensionMetadata
  && normalizedLegacy.comments.p1?.[0]?.id === 'legacy-reply' && normalizedLegacy.comments.p1[0]?.ai === undefined
  && normalizedLegacy.asks[0]?.answer === undefined && normalizedLegacy.notifications[0]?.readAt === undefined);
check('legacy owners may retain absent profile fields and null appearance', ownerRegistry({ legacy: { id: 'legacy-owner', appearance: null } }).legacy?.appearance === null);
const legacyWithoutFlags = { ...rawLegacy };
delete legacyWithoutFlags.seeded;
delete legacyWithoutFlags.tasksSeeded;
const missingFlags = feedState(legacyWithoutFlags);
check('absent legacy seed flags stay absent', !Object.hasOwn(missingFlags, 'seeded') && !Object.hasOwn(missingFlags, 'tasksSeeded'));
const falseFlags = feedState({ ...legacyWithoutFlags, seeded: false, tasksSeeded: false });
check('stored boolean false seed flags remain false', falseFlags.seeded === false && falseFlags.tasksSeeded === false);
for (const key of ['seeded', 'tasksSeeded']) {
  for (const [label, invalid] of [['string', 'false'], ['number', 1], ['null', null], ['undefined', undefined]] as const) {
    const raw: Record<string, unknown> = { ...legacyWithoutFlags, [key]: invalid };
    let rejected = false;
    try { feedState(raw); } catch { rejected = true; }
    check('stored ' + key + ' rejects ' + label + ' without rewriting metadata', rejected && Object.hasOwn(raw, key) && Object.is(raw[key], invalid));
  }
}
const corruptFile = join(dir, 'corrupt.db');
const corruptDb = openStore(corruptFile);
const badRow = JSON.stringify({ id: 'broken-post', title: 42, privateExtension: 'must-survive-rejection' });
corruptDb.prepare('INSERT INTO entities(collection,key,data,updated_at) VALUES(?,?,?,?)').run('posts', 'broken-post', badRow, now);
let rejectedStored = false;
try { feedState(loadState(corruptDb).feed); } catch { rejectedStored = true; }
check('invalid stored entities fail decoding without clearing or rewriting the row', rejectedStored
  && corruptDb.prepare('SELECT data FROM entities WHERE collection=? AND key=?').get('posts', 'broken-post')?.data === badRow
  && stats(corruptDb).rows.posts === 1);
corruptDb.close();

db.close();
const size = await stat(file);
check('the database file is on disk', size.size > 0, size.size + ' bytes');

if (dirname(resolve(dir)) !== temporaryRoot || !basename(dir).startsWith('xlb-db-')) throw new Error('Unexpected database test cleanup target');
await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
console.log('');
if (failed === 0) {
  console.log('ALL PASS');
  process.exit(0);
}
console.log(failed + ' FAILED');
process.exit(1);
