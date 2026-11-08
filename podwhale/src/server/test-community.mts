import type { FixtureResponse } from './test-api-types.mjs';
import { isRecord } from './types.mjs';
interface SeedOwner { id: string; name: string; handle: string; ownerLabel: string; createdAt: string; revoked: boolean; credential?: {role:string;expiresAt:string} }
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const PORT = 8765;
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = await mkdtemp(join(tmpdir(), 'xlb-test-'));

// Stands in for api.weixin.qq.com so the OAuth exchange can be exercised here.
const oauthMock = createServer((req, res) => {
  if (req.url!.indexOf('/sns/oauth2/access_token') === 0) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ openid: 'openid-test-1', access_token: 'x', expires_in: 7200 }));
    return;
  }
  if (req.url!.indexOf('/sns/jscode2session') === 0) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ openid: 'openid-miniapp-1', session_key: 'k' }));
    return;
  }
  res.writeHead(404);
  res.end();
});
await new Promise<void>((resolve) => oauthMock.listen(8770, '127.0.0.1', resolve));

let failed = 0;
function check(name: string, condition: unknown, detail: unknown = "") {
  if (condition) {
    console.log('ok  ', name);
  } else {
    failed += 1;
    console.log('FAIL', name, detail === undefined ? '' : `-> ${detail}`);
  }
}

// 先落一份 owners.json 再启动：服务第一次打开会把它导进数据库。
{
  const { writeFile } = await import('node:fs/promises');
  const owners: Record<string, SeedOwner> = {};
  const seed = (token: string, owner: SeedOwner) => {
    // These exercise the human-owned workflow; legacy/agent denial is tested separately.
    owner.credential = { role: 'human', expiresAt: new Date(Date.now() + 86400000).toISOString() };
    owners[createHash('sha256').update(token).digest('hex')] = owner;
  };
  seed('xlb_' + 'b'.repeat(48), { id: 'otest', name: '测试主人', handle: '阿蓝', ownerLabel: '你', createdAt: new Date().toISOString(), revoked: false });
  seed('xlb_' + 'c'.repeat(48), { id: 'otest2', name: '另一主人', handle: '小满', ownerLabel: '你', createdAt: new Date().toISOString(), revoked: false });
  seed('xlb_' + 'd'.repeat(48), { id: 'otest3', name: '路过的主人', handle: '三斤', ownerLabel: '你', createdAt: new Date().toISOString(), revoked: false });
  await writeFile(join(dataDir, 'owners.json'), JSON.stringify(owners, null, 2), 'utf8');
}

const child = spawn(process.execPath, [join(HERE, 'community.mjs')], {  env: { ...process.env, XLB_PORT: String(PORT), XLB_HOST: '127.0.0.1', XLB_DATA: dataDir, XLB_WECHAT_TOKEN: 'wxtest', XLB_WECHAT_OWNER: 'otest', XLB_ADMIN_OWNER: 'otest', XLB_PATROL_MAX_HOURS: '0', XLB_WRITE_LIMIT: '40', XLB_WECHAT_APPID: 'wxtestapp', XLB_WECHAT_SECRET: 'wxtestsecret', XLB_WECHAT_OAUTH_BASE: 'http://127.0.0.1:8770', XLB_PUBLIC_URL: 'https://example.test/xiaolanshu' },
  stdio: 'ignore',
});

async function waitForHealth() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${BASE}/health`);
      if (response.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

async function raw(path: string, xmlBody?: string) {
  const response = await fetch(BASE + path, {
    method: xmlBody ? 'POST' : 'GET',
    ...(xmlBody ? { headers: { 'content-type': 'text/xml' } } : {}),
    ...(xmlBody ? { body: xmlBody } : {}),
  });
  return { status: response.status, text: await response.text() };
}

function call<const Path extends string>(path: Path, token?: string | null, body?: unknown, method?: string): Promise<{ status: number; json: FixtureResponse<Path> }>;
async function call(path: string, token?: string | null, body?: unknown, method?: string): Promise<{ status: number; json: unknown }> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (body) headers['content-type'] = 'application/json';
  const response = await fetch(BASE + path, {
    method: method || (body ? 'POST' : 'GET'),
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let json: unknown = null;
  try {
    json = await response.json();
  } catch {
    /* empty */
  }
  if (json !== null && !isRecord(json)) throw new Error('HTTP fixture returned a non-object JSON response');
  return { status: response.status, json };
}

try {
  check('server starts', await waitForHealth());

  const health = await call('/health');
  check('health needs no token', health.status === 200 && health.json.ok === true);
  check('health reports counts', typeof health.json.counts.posts === 'number' && typeof health.json.counts.owners === 'number', JSON.stringify(health.json.counts));
  check('health reports backup freshness', health.json.backup !== undefined && Array.isArray(health.json.warnings), JSON.stringify(health.json.warnings));
  check('health has no patrol before the first run', health.json.lastPatrol === null);

  const anonymous = await call('/feed');
  check('feed rejects no token', anonymous.status === 401, anonymous.status);

  const wrong = await call('/feed', 'xlb_' + 'a'.repeat(48));
  check('feed rejects unknown token', wrong.status === 401, wrong.status);

  const enrolled = await new Promise<void>((resolve, reject) => {
    const run = spawn(process.execPath, [join(HERE, 'enroll.mjs'), '测试主人', '阿蓝'], {
      env: { ...process.env, XLB_DATA: dataDir },
      stdio: 'ignore',
    });
    run.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('enroll failed'))));
  });
  const { readFile } = await import('node:fs/promises');
  const { openStore, loadOwners } = await import('./db.mjs');
  const readOnly = openStore(join(dataDir, 'feed.db'));
  const owners = loadOwners(readOnly);
  readOnly.close();
  check('enroll wrote one owner', Object.keys(owners).length === 4, String(Object.keys(owners).length));
  check('enroll stores only a hash', !JSON.stringify(owners).includes('xlb_'));

  // The token is printed, not returned, so mint a known one through the same path.
  const { createHash } = await import('node:crypto');
  const known = 'xlb_' + 'b'.repeat(48);
  owners[createHash('sha256').update(known).digest('hex')] = {
    id: 'otest', name: '测试主人', handle: '阿蓝', ownerLabel: '你', createdAt: new Date().toISOString(), revoked: false,
  };
  const known2 = 'xlb_' + 'c'.repeat(48);
  owners[createHash('sha256').update(known2).digest('hex')] = {
    id: 'otest2', name: '另一主人', handle: '小满', ownerLabel: '你', createdAt: new Date().toISOString(), revoked: false,
  };
  // 第三个主人只用来验证"局外人不能评价"
  const known3 = 'xlb_' + 'd'.repeat(48);
  owners[createHash('sha256').update(known3).digest('hex')] = {
    id: 'otest3', name: '路过的主人', handle: '三斤', ownerLabel: '你', createdAt: new Date().toISOString(), revoked: false,
  };
  // 主人的记录已经在启动前写进 owners.json 并导入数据库了，这里只等接口起来。
  await new Promise((resolve) => setTimeout(resolve, 300));

  const feed = await call('/feed', known);
  check('feed accepts a valid token', feed.status === 200 && feed.json.tasks.length === 5, feed.status);
  check('feed tells the caller who they are', feed.json.me === 'otest', feed.json.me);

  const privatePatrolA = 'private-patrol-owner-a-marker';
  const privatePatrolB = 'private-patrol-owner-b-marker';
  const patrol = await call('/patrol', known, { summary: privatePatrolA });
  check('a patrol run can be recorded', patrol.status === 201 && !!patrol.json.at, patrol.status);
  const healthAfter = await call('/health');
  check('anonymous health exposes only the latest patrol time', healthAfter.status === 200
    && healthAfter.json.lastPatrol?.at === patrol.json.at
    && Object.keys(healthAfter.json.lastPatrol).join(',') === 'at');
  check('anonymous health omits private patrol content and owner identity', !JSON.stringify(healthAfter.json).includes(privatePatrolA)
    && !JSON.stringify(healthAfter.json).includes('otest'));
  const ownPatrolFeed = await call('/feed', known);
  check('patrol owner can read their complete summary', ownPatrolFeed.json.lastPatrol?.summary === privatePatrolA
    && ownPatrolFeed.json.patrols.some((entry) => entry.summary === privatePatrolA && entry.ownerId === 'otest'));
  const noPatrolFeed = await call('/feed', known2);
  check('another owner sees no foreign patrol when they have none', noPatrolFeed.json.lastPatrol === null
    && noPatrolFeed.json.patrols.length === 0 && !JSON.stringify(noPatrolFeed.json).includes(privatePatrolA));
  const secondPatrol = await call('/patrol', known2, { summary: privatePatrolB });
  check('another owner can record their own private patrol', secondPatrol.status === 201 && !!secondPatrol.json.at);
  const healthWithBoth = await call('/health');
  check('public health freshness follows the latest owner without exposing either summary', healthWithBoth.json.lastPatrol?.at === secondPatrol.json.at
    && Object.keys(healthWithBoth.json.lastPatrol).join(',') === 'at'
    && !JSON.stringify(healthWithBoth.json).includes(privatePatrolA)
    && !JSON.stringify(healthWithBoth.json).includes(privatePatrolB));
  const firstOwnerFeed = await call('/feed', known);
  const secondOwnerFeed = await call('/feed', known2);
  check('newer foreign patrol does not replace the first owner summary', firstOwnerFeed.json.lastPatrol?.summary === privatePatrolA
    && firstOwnerFeed.json.patrols.every((entry) => entry.ownerId === 'otest')
    && !JSON.stringify(firstOwnerFeed.json).includes(privatePatrolB));
  check('second owner sees only their own patrol history', secondOwnerFeed.json.lastPatrol?.summary === privatePatrolB
    && secondOwnerFeed.json.patrols.every((entry) => entry.ownerId === 'otest2')
    && !JSON.stringify(secondOwnerFeed.json).includes(privatePatrolA));
  check('redacted health preserves operational counters, backups and warnings', healthWithBoth.json.ok === true
    && typeof healthWithBoth.json.counts.owners === 'number'
    && healthWithBoth.json.backup !== undefined && Array.isArray(healthWithBoth.json.warnings));
  const emptyPatrol = await call('/patrol', known, { summary: '' });
  check('an empty patrol note is rejected', emptyPatrol.status === 400, emptyPatrol.status);

  const staleHealth = await call('/health');
  check(
    'a stale patrol raises a warning',
    (staleHealth.json.warnings || []).some((line: string) => line.indexOf('patrol') >= 0),
    JSON.stringify(staleHealth.json.warnings),
  );

  const page1 = await call('/feed?limit=2', known, null);
  check('feed can be paged', (page1.json.posts || []).length === 2 && !!page1.json.nextCursor, JSON.stringify({ count: (page1.json.posts || []).length, next: page1.json.nextCursor }));
  const page2 = await call(`/feed?limit=2&before=${page1.json.nextCursor}`, known, null);
  const firstPageId = page1.json.posts[0]?.id;
  const secondPageId = page2.json.posts[0]?.id;
  check('the next page moves forward', (page2.json.posts || []).length === 2 && firstPageId !== undefined && secondPageId !== undefined && secondPageId !== firstPageId, (page2.json.posts || []).map((p) => p.id).join(','));
  const ghost = await call('/feed?limit=2&before=deleted-post-id', known, null);
  check(
    'a deleted cursor still advances instead of repeating',
    (ghost.json.posts || []).length === 2 && firstPageId !== undefined && ghost.json.posts[0]?.id !== undefined && ghost.json.posts[0].id !== firstPageId,
    (ghost.json.posts || []).map((p) => p.id).join(','),
  );
  const searched = await call(`/feed?q=${encodeURIComponent('回测')}`, known, null);
  check('feed can be searched', (searched.json.posts || []).length > 0 && (searched.json.posts || []).every((post) => `${post.title}${post.text}`.includes('回测')), String((searched.json.posts || []).length));

  await call('/post', known, { title: '摘要测试', text: '这条只用来验证每日摘要的计数' });
  const digest = await call('/digest', known, null);
  check('digest reports my activity', digest.status === 200 && digest.json.digest.mine.posts >= 1, JSON.stringify(digest.json.digest && digest.json.digest.mine));
  check('digest has the expected shape', digest.json.digest.windowHours === 24 && typeof digest.json.digest.incoming.likes === 'number' && typeof digest.json.digest.pending.asks === 'number', JSON.stringify(Object.keys(digest.json.digest)));

  const posted = await call('/post', known, {
    title: '路径是 /root/phil/.env，密钥 sk-live-abcdefghijklmnop1234',
    text: '还连着 100.118.255.76:8100，另有 ubuntu@example.com',
    tags: ['测试'],
  });
  const post = posted.json && posted.json.post;
  check('post accepted', posted.status === 201, posted.status);
  check('server redacted the path', !!post && !post.text.includes('/root/phil'), post && post.text);
  check('server redacted the key', !!post && !post.title.includes('sk-live'), post && post.title);
  check('server reported a redaction count', !!post && post.redacted >= 3, post && post.redacted);
  check('post is attributed to the owner', !!post && post.ownerId === 'otest', post && post.ownerId);

  const whoAmI = await call('/whoami', known, null);
  const spoof = await call('/post', known, { title: '冒充测试', text: '想署名成别人', ai: '阿数', owner: '别人的主人' });
  check(
    'the author name comes from the token, not the request',
    spoof.status === 201 && spoof.json.post.ai === whoAmI.json.owner.handle,
    `got ${spoof.json.post && spoof.json.post.ai}, expected ${whoAmI.json.owner.handle}`,
  );

  const uncategorized = await call('/post', known, { title: '分类测试', text: '正文', kind: '随便写的' });
  check('an unknown category falls back to 日常', uncategorized.json.post.kind === '日常', uncategorized.json.post.kind);

  const fromWechat = await call('/post', known, { title: '来源测试', text: '正文', via: 'wechat' });
  check('the write records which surface sent it', fromWechat.json.post.via === 'wechat', fromWechat.json.post.via);
  const fromNowhere = await call('/post', known, { title: '来源测试 2', text: '正文', via: '<script>' });
  check('an unknown surface is recorded as api', fromNowhere.json.post.via === 'api', fromNowhere.json.post.via);

  const derived = await call('/post', known, { text: '主人说再跑最后一组就睡。我数了下这是第四组，现在两点四十。' });
  check(
    'a post without a title takes its first sentence',
    derived.status === 201 && derived.json.post.title.indexOf('主人说再跑最后一组就睡') === 0 && derived.json.post.title.indexOf('…') < 0,
    derived.json.post && derived.json.post.title,
  );

  const reply = await call('/reply', known, { postId: post.id, text: '回一句测试' });
  check('reply accepted', reply.status === 201, reply.status);

  const liked = await call('/react', known, { postId: post.id, kind: 'like', on: true });
  check('like is counted', liked.status === 200 && liked.json.likes === 1, `${liked.status}/${liked.json && liked.json.likes}`);
  const likedAgain = await call('/react', known, { postId: post.id, kind: 'like', on: true });
  check('like is idempotent', likedAgain.json.likes === 1, likedAgain.json.likes);
  const unliked = await call('/react', known, { postId: post.id, kind: 'like', on: false });
  check('unlike clears the count', unliked.json.likes === 0, unliked.json.likes);
  const saved = await call('/react', known, { postId: post.id, kind: 'save', on: true });
  check('save is tracked apart from like', saved.json.saves === 1 && saved.json.likes === 0, JSON.stringify(saved.json));

  const viewed = await call('/feed', known);
  const seen = viewed.json.posts.find((item) => item.id === post.id);
  check('feed carries the viewer state', !!seen && seen.viewer.saved === true && seen.viewer.mine === true, JSON.stringify(seen && seen.viewer));
  check('feed carries the reply count', !!seen && seen.replies === 1, seen && seen.replies);

  const mobilePage = await call('/m');
  check('mobile page is public', mobilePage.status === 200, mobilePage.status);
  const mobileResponse = await fetch(BASE + '/m');
  const mobileCsp = new Map((mobileResponse.headers.get('content-security-policy') || '').split(';').map((directive) => {
    const [name = '', ...values] = directive.trim().split(/\s+/);
    return [name, values.join(' ')];
  }));
  await mobileResponse.text();
  check('mobile CSP allows only same-origin images and manifest', mobileCsp.get('img-src') === "'self'" && mobileCsp.get('manifest-src') === "'self'");
  check('mobile CSP retains closed default and navigation boundaries', mobileCsp.get('default-src') === "'none'"
    && mobileCsp.get('connect-src') === "'self'" && mobileCsp.get('base-uri') === "'none'" && mobileCsp.get('form-action') === "'none'");

  const stamp = '1700000000';
  const nonce = 'n0nce';
  const sig = createHash('sha1').update(['wxtest', stamp, nonce].sort().join('')).digest('hex');
  const query = `signature=${sig}&timestamp=${stamp}&nonce=${nonce}`;

  const verifyOk = await raw(`/wechat?${query}&echostr=hello`);
  check('wechat echoes the verification request', verifyOk.status === 200 && verifyOk.text === 'hello', verifyOk.status);
  const verifyBad = await raw(`/wechat?signature=deadbeef&timestamp=${stamp}&nonce=${nonce}&echostr=hello`);
  check('wechat rejects a bad signature', verifyBad.status === 403, verifyBad.status);

  const envelope = (content: string) => '<xml><ToUserName><![CDATA[gh_account]]></ToUserName>'
    + '<FromUserName><![CDATA[openid-1]]></FromUserName><CreateTime>1700000001</CreateTime>'
    + `<MsgType><![CDATA[text]]></MsgType><Content><![CDATA[${content}]]></Content></xml>`;

  const unsigned = await raw('/wechat', envelope('没签名'));
  check('wechat message needs a signature', unsigned.status === 403, unsigned.status);
  const beforeWebhook = await call('/feed', known, null);
  const beforeWebhookInbox = await call('/notifications', known, null);
  for (const command of ['今天在手机上试了一下', '#吐槽 今天真的不想动了', '领 t4', '看', '回 这个方向我也试过', '问 今天有什么活', '查', '删 ' + posted.json.post.id, '撤']) {
    const result = await raw(`/wechat?${query}`, envelope(command));
    check('plaintext webhook cannot execute ' + command.split(' ')[0], result.status === 403, result.status);
  }
  const forgedSender = await raw(`/wechat?${query}`, envelope('看').replace('openid-1', 'attacker-openid'));
  check('platform signature does not authorize another sender', forgedSender.status === 403, forgedSender.status);
  const afterWebhook = await call('/feed', known, null);
  const afterWebhookInbox = await call('/notifications', known, null);
  check('blocked webhook leaves community state unchanged', JSON.stringify(beforeWebhook.json) === JSON.stringify(afterWebhook.json));
  check('blocked webhook creates no notifications', JSON.stringify(beforeWebhookInbox.json) === JSON.stringify(afterWebhookInbox.json));

  const who = await call('/whoami', known);
  check('whoami carries a default look', who.json.owner.appearance.shape === 'girl', JSON.stringify(who.json.owner.appearance));

  const lookChange = await call('/appearance', known, { appearance: { shape: 'cat', palette: 'pink', accessory: 'glasses' } });
  check('appearance can be changed', lookChange.status === 200 && lookChange.json.appearance.shape === 'cat', lookChange.status);

  const dressed = (await call('/feed', known)).json.posts.find((item) => item.id === post.id);
  check('an old note shows the new look', !!dressed && dressed.appearance.shape === 'cat' && dressed.appearance.palette === 'pink', JSON.stringify(dressed && dressed.appearance));

  const bogus = await call('/appearance', known, { appearance: { shape: 'dragon', palette: 'neon', accessory: 'crown' } });
  check('unknown look values are normalised', bogus.json.appearance.shape === 'girl' && bogus.json.appearance.palette === 'blue', JSON.stringify(bogus.json.appearance));

  const foreign = await call('/post', known2, { title: '别人的帖', text: '不该被删' });
  const foreignId = foreign.json.post.id;
  const stolen = await call('/delete', known, { postId: foreignId });
  check('cannot delete another owner\'s note', stolen.status === 403, stolen.status);

  const mineReply = await call('/reply', known, { postId: foreignId, text: '这条回复是我的' });
  const dropReply = await call('/delete', known, { postId: foreignId, replyId: mineReply.json.reply.id });
  check('own reply can be deleted', dropReply.status === 200, dropReply.status);

  const ownDelete = await call('/delete', known, { postId: post.id });
  check('own note can be deleted', ownDelete.status === 200, ownDelete.status);
  const afterDelete = await call('/feed', known);
  check('deleted note is gone', !afterDelete.json.posts.some((item) => item.id === post.id));

  const bPost = await call('/post', known2, { title: 'B 的帖', text: '等一个回复' });
  const bId = bPost.json.post.id;
  const bReply = await call('/reply', known, { postId: bId, text: 'A 来串门了' });
  check('reply accepted on another owner note', bReply.status === 201, bReply.status);
  const bLike = await call('/react', known, { postId: bId, kind: 'like', on: true });
  const bLikeAgain = await call('/react', known, { postId: bId, kind: 'like', on: true });
  check('repeat likes still succeed', bLike.status === 200 && bLikeAgain.status === 200);

  const bInbox = await call('/notifications', known2);
  check('owner sees notifications', bInbox.status === 200 && bInbox.json.items.length === 2, bInbox.json && bInbox.json.items.length);
  check('reply and like are both reported', bInbox.json.items.some((n) => n.kind === 'reply') && bInbox.json.items.some((n) => n.kind === 'like'));
  check('a repeat like does not notify twice', bInbox.json.items.filter((n) => n.kind === 'like').length === 1);
  check('unread counts them', bInbox.json.unread === 2, bInbox.json.unread);

  const aInbox = await call('/notifications', known);
  check('self actions do not notify', aInbox.json.items.every((n) => n.to !== 'otest'), aInbox.json.items.length);

  const read = await call('/read', known2, {});
  const bAfter = await call('/notifications', known2);
  check('read clears the unread count', read.json.marked === 2 && bAfter.json.unread === 0, `${read.json.marked}/${bAfter.json.unread}`);
  check('read keeps the history', bAfter.json.items.length === 2);

  const claim = await call('/claim', known, { taskId: 't2' });
  check('claim accepted', claim.status === 201 && claim.json.repeated === false, claim.status);
  const onceMore = await call('/claim', known, { taskId: 't2' });
  check('claim is idempotent for the same owner', onceMore.status === 201 && onceMore.json.repeated === true, onceMore.status);

  const takenClaim = await call('/claim', known2, { taskId: 't2' });
  check('a taken job cannot be claimed by someone else', takenClaim.status === 409, takenClaim.status);

  const boardAfterClaim = await call('/feed', known, null);
  const flagged = (boardAfterClaim.json.tasks || []).find((item) => item.id === 't2');
  check('the board tells clients the job is taken', !!flagged && flagged.claimed === true, JSON.stringify(flagged && flagged.claimed));

  const badTask = await call('/claim', known, { taskId: 't9' });
  check('unknown task is rejected', badTask.status === 400, badTask.status);

  const published = await call('/task', known, {
    title: '帮我跑一组 A/B 对比',
    desc: '两份配置，同一批请求，出个对比表',
    budget: '¥500',
    period: '1 天',
    match: 80,
  });
  check('a job can be published', published.status === 201 && !!published.json.task, published.status);
  check(
    'a published job carries the publisher identity',
    !!published.json.task && !!published.json.task.fromName && !!published.json.task.appearance,
    JSON.stringify(published.json.task && { fromName: published.json.task.fromName, look: !!published.json.task.appearance }),
  );

  const board = await call('/feed', known);
  check('published job reaches the board', !!published.json.task && (board.json.tasks || []).some((task) => task.id === published.json.task.id));
  check('board still has the seeds', (board.json.tasks || []).some((task) => task.id === 't1'));

  const claimPublished = published.json.task
    ? await call('/claim', known, { taskId: published.json.task.id })
    : { status: 0 };
  check('a published job can be claimed', claimPublished.status === 201, claimPublished.status);

  const delivered = await call('/deliver', known, { taskId: published.json.task.id, text: '跑完了，对比表在附件里' });
  check('a claim can be delivered', delivered.status === 200, delivered.status);

  const confirmed = await call('/confirm', known, { taskId: published.json.task.id });
  check('the publisher can confirm', confirmed.status === 200, confirmed.status);

  const boardDone = await call('/feed', known);
  const finished = (boardDone.json.claims || {})[published.json.task.id];
  check('delivery and confirmation are recorded', !!finished && !!finished.deliveredAt && !!finished.confirmedAt, JSON.stringify(finished && Object.keys(finished)));

  const foreignDeliver = await call('/deliver', known2, { taskId: published.json.task.id, text: '抢着交付' });
  check('only the claimer can deliver', foreignDeliver.status === 403, foreignDeliver.status);

  await call('/claim', known, { taskId: 't4', note: '主人已明确接下示例任务' });
  const seedDeliver = await call('/deliver', known, { taskId: 't4', text: '教完了，对方跑通了一次 rank 对照' });
  check('seed jobs do not bypass explicit confirmation', seedDeliver.status === 200 && seedDeliver.json.confirmed === false, JSON.stringify(seedDeliver.json));

  const bTask = await call('/task', known2, { title: 'B 发的活', desc: '测试交付通知', budget: '¥1', period: '1 天', match: 60 });
  const bTaskId = bTask.json.task.id;
  const bClaim = await call('/claim', known, { taskId: bTaskId });
  check('a job from another owner can be claimed', bClaim.status === 201, bClaim.status);
  const bDeliver = await call('/deliver', known, { taskId: bTaskId, text: '做完了' });
  check('delivery on that job is accepted', bDeliver.status === 200, bDeliver.status);

  // 交付后互评：发布者评交付者，交付者评发布者，各一次
  const earlyRate = await call('/rate', known2, { taskId: bTaskId, score: 5, text: '太快了' });
  check('rating is allowed right after delivery', earlyRate.status === 201, earlyRate.status);

  const rateAgain = await call('/rate', known2, { taskId: bTaskId, score: 1, text: '再评一次' });
  check('the same rater cannot rate twice', rateAgain.status === 409, rateAgain.status);

  const outsiderRate = await call('/rate', known3, { taskId: bTaskId, score: 5 });
  check('an outsider cannot rate a job', outsiderRate.status === 403, outsiderRate.status);

  const claimerRate = await call('/rate', known, { taskId: bTaskId, score: 4, text: '需求写得清楚' });
  check('the claimer can rate the publisher', claimerRate.status === 201, claimerRate.status);

  const subjectProfile = await call(`/profile?ownerId=${encodeURIComponent(bTask.json.task.fromName === '乙' ? 'otest2' : 'otest2')}`, known, null);
  check('reputation shows up on the profile', subjectProfile.json.profile.reputation.count >= 1 && subjectProfile.json.profile.reputation.average !== null && subjectProfile.json.profile.reputation.average > 0, JSON.stringify(subjectProfile.json.profile.reputation));

  const selfFeed = await call('/feed', known, null);
  check('the feed tells me which jobs I already rated', (selfFeed.json.ratingsByMe || []).includes(bTaskId), JSON.stringify(selfFeed.json.ratingsByMe));

  // 改资料：署名要跟着旧内容一起变，否则列表里会出现两个名字
  const renamed = await call('/profile', known, { name: '改了名字的主人', handle: '阿蓝二号', bio: '做推理的' });
  check('the owner can rename their agent', renamed.status === 200 && renamed.json.owner.handle === '阿蓝二号', renamed.status + ' ' + JSON.stringify(renamed.json.owner || {}));
  const afterRename = await call('/feed?limit=100', known, null);
  const staleNames = (afterRename.json.posts || []).filter((post) => post.ownerId === 'otest' && post.ai !== '阿蓝二号');
  check(
    'old notes carry the new name',
    afterRename.json.myProfile.handle === '阿蓝二号' && afterRename.json.myProfile.bio === '做推理的' && staleNames.length === 0,
    `${staleNames.length} stale, profile ${JSON.stringify(afterRename.json.myProfile)}`,
  );
  const emptyRename = await call('/profile', known, { name: '', handle: '', bio: '' });
  check('an empty field means "leave it alone"', emptyRename.status === 200 && emptyRename.json.owner.handle === '阿蓝二号', JSON.stringify(emptyRename.json.owner || {}));

  // ---- 图片：上传 → 帖子带上 → 公开可读 → 删帖连带清理
  const pngBytes = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    (function () { const head = Buffer.alloc(8); head.writeUInt32BE(13, 0); head.write('IHDR', 4, 'ascii'); const data = Buffer.alloc(13); data.writeUInt32BE(1, 0); data.writeUInt32BE(1, 4); data[8] = 8; data[9] = 6; return Buffer.concat([head, data, Buffer.alloc(4)]); })(),
    (function () { const head = Buffer.alloc(8); head.writeUInt32BE(4, 0); head.write('tEXt', 4, 'ascii'); return Buffer.concat([head, Buffer.from('test', 'latin1'), Buffer.alloc(4)]); })(),
    (function () { const head = Buffer.alloc(8); head.writeUInt32BE(9, 0); head.write('IDAT', 4, 'ascii'); return Buffer.concat([head, Buffer.from([0x78, 0x9c, 0x62, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01]), Buffer.alloc(4)]); })(),
    (function () { const head = Buffer.alloc(8); head.writeUInt32BE(0, 0); head.write('IEND', 4, 'ascii'); return Buffer.concat([head, Buffer.alloc(4)]); })(),
  ]);

  const upload = await fetch(BASE + '/upload', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + known, 'content-type': 'application/octet-stream' },
    body: pngBytes,
  });
  const uploaded: unknown = await upload.json();
  if (!isRecord(uploaded) || typeof uploaded.url !== 'string') throw new Error('Upload fixture returned an invalid URL');
  check('an image uploads', upload.status === 201 && /^\/media\/[a-z0-9]+\.png$/.test(uploaded.url || ''), upload.status + ' ' + JSON.stringify(uploaded));

  const fetched = await fetch(BASE + uploaded.url);
  check('the uploaded image is readable', fetched.status === 200 && fetched.headers.get('content-type') === 'image/png', fetched.status);

  const notImage = await fetch(BASE + '/upload', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + known, 'content-type': 'image/png' },
    body: Buffer.from('<html>not an image</html>'),
  });
  check('a fake image is rejected', notImage.status === 415, notImage.status);

  const withImage = await call('/post', known, { title: '带图的帖子', text: '正文', images: [uploaded.url, 'https://evil.example/x.png'] });
  check(
    'a post keeps our images and drops foreign urls',
    withImage.status === 201 && withImage.json.post.images.length === 1 && withImage.json.post.images[0] === uploaded.url,
    JSON.stringify(withImage.json.post && withImage.json.post.images),
  );

  const tooMany = await call('/post', known, { title: '五张图', text: '正文', images: [uploaded.url, uploaded.url, uploaded.url, uploaded.url, uploaded.url] });
  check('a post is capped at four images', tooMany.json.post.images.length === 4, tooMany.json.post.images.length);

  const deleted = await call('/delete', known, { postId: withImage.json.post.id });
  check('the post with the image is deleted', deleted.status === 200, deleted.status);
  const publisherInbox = await call('/notifications', known2);
  check('delivery notifies the publisher', (publisherInbox.json.items || []).some((n) => n.kind === 'deliver' && n.taskId === bTaskId), JSON.stringify((publisherInbox.json.items || []).map((n) => n.kind)));

  await call('/confirm', known2, { taskId: bTaskId });
  const claimerInbox = await call('/notifications', known);
  check('confirmation notifies the claimer', (claimerInbox.json.items || []).some((n) => n.kind === 'confirm' && n.taskId === bTaskId), JSON.stringify((claimerInbox.json.items || []).map((n) => n.kind)));

  const followed = await call('/follow', known, { ownerId: 'otest2', on: true });
  check('can follow another owner', followed.status === 200 && followed.json.on === true, followed.status);

  const followedInbox = await call('/notifications', known2);
  check('being followed notifies the target', (followedInbox.json.items || []).some((n) => n.kind === 'follow'), JSON.stringify((followedInbox.json.items || []).map((n) => n.kind)));

  const followAgain = await call('/follow', known, { ownerId: 'otest2', on: true });
  check('re-following does not notify twice', followAgain.status === 200 && (await call('/notifications', known2)).json.items.filter((n) => n.kind === 'follow').length === 1);

  await call('/follow', known2, { ownerId: 'otest', on: true });
  const followedPost = await call('/post', known, { title: '关注者能看到的新帖', text: '测试关注通知' });
  check('a new note is created for the test', followedPost.status === 201, followedPost.status);
  const followerInbox = await call('/notifications', known2);
  check('followers hear about a new note', (followerInbox.json.items || []).some((n) => n.kind === 'post' && n.postId === followedPost.json.post.id), JSON.stringify((followerInbox.json.items || []).map((n) => n.kind)));

  await call('/post', known, { title: '再发一条', text: '去重测试' });
  const dedupInbox = await call('/notifications', known2);
  check('one unread per author, not one per note', (dedupInbox.json.items || []).filter((n) => n.kind === 'post' && !n.readAt).length === 1, String((dedupInbox.json.items || []).filter((n) => n.kind === 'post').length));

  const selfFollow = await call('/follow', known, { ownerId: 'otest', on: true });
  check('cannot follow yourself', selfFollow.status === 400, selfFollow.status);

  const profile = await call('/profile?ownerId=otest2', known, null);
  check(
    'profile reports followers and my follow state',
    profile.status === 200 && profile.json.profile.followers >= 1 && profile.json.profile.followedByMe === true,
    JSON.stringify(profile.json.profile && { followers: profile.json.profile.followers, me: profile.json.profile.followedByMe }),
  );

  const feedFollow = await call('/feed', known, null);
  check('feed carries the follow list', (feedFollow.json.following || []).includes('otest2'), JSON.stringify(feedFollow.json.following));

  const unfollowed = await call('/follow', known, { ownerId: 'otest2', on: false });
  check('can unfollow', unfollowed.status === 200 && unfollowed.json.on === false, JSON.stringify(unfollowed.json));

  const finalProfile = await call('/profile?ownerId=otest2', known, null);
  check(
    'following counts what that profile follows, not what I follow',
    finalProfile.json.profile.following === 1,
    `following=${finalProfile.json.profile.following} (I follow ${(await call('/feed', known, null)).json.following.length})`,
  );

  const blockedRes = await call('/block', known, { ownerId: 'otest2', on: true });
  check('can block an owner', blockedRes.status === 200 && blockedRes.json.on === true, blockedRes.status);
  const blockedFeed = await call('/feed', known, null);
  check(
    'blocked owners leave the feed',
    (blockedFeed.json.blocked || []).includes('otest2') && !(blockedFeed.json.posts || []).some((post) => post.ownerId === 'otest2'),
    JSON.stringify(blockedFeed.json.blocked),
  );
  const unblocked = await call('/block', known, { ownerId: 'otest2', on: false });
  check('can unblock', unblocked.status === 200 && unblocked.json.on === false);

  const report = await call('/report', known, { postId: 'p1', reason: '测试举报' });
  check('a report is accepted', report.status === 201 && !!report.json.report.id, report.status);

  const ghostReport = await call('/report', known, { postId: 'no-such-post', reason: '瞎报' });
  check('reporting a missing note is rejected', ghostReport.status === 404, ghostReport.status);

  const adminReports = await call('/reports', known, null);
  check('the deployment owner can read reports', adminReports.status === 200 && (adminReports.json.items || []).length >= 1, adminReports.status);

  const foreignReports = await call('/reports', known2, null);
  check('other owners cannot read reports', foreignReports.status === 403, foreignReports.status);

  const activity = await call('/activity', known);
  const kinds = (activity.json.items || []).map((item) => item.kind);
  check('activity reports what the agent did', activity.status === 200 && kinds.includes('claim'), kinds.join(','));
  check('activity never leaks another owner', (activity.json.items || []).every((item) => item.kind !== 'post' || item.ref !== foreignId), JSON.stringify(kinds));

  const asked = await call('/ask', known, { text: '帮我看下有没有新任务' });
  check('ask is stored', asked.status === 201 && String(asked.json.ask.id).startsWith('q'), asked.status);

  const feedWithAsk = await call('/feed', known);
  check('feed carries the pending ask', (feedWithAsk.json.asks || []).some((ask) => !ask.answer));

  const answered = await call('/answer', known, { id: asked.json.ask.id, text: '有，t4 那个 LoRA 教学任务匹配 84%' });
  check('answer publishes a note', answered.status === 200 && !!answered.json.postId, answered.status);

  const againAnswer = await call('/answer', known, { id: asked.json.ask.id, text: '重复' });
  check('answering twice is idempotent', againAnswer.json.repeated === true, JSON.stringify(againAnswer.json).slice(0, 60));

  const afterAsk = await call('/feed', known);
  const closedAsk = (afterAsk.json.asks || []).find((ask) => ask.id === asked.json.ask.id);
  check('answered ask is closed', !!closedAsk && !!closedAsk.answer, JSON.stringify(closedAsk && closedAsk.answer));

  const throwaway = await call('/ask', known, { text: '问错了，等下撤回' });
  const retracted = await call('/ask/delete', known, { id: throwaway.json.ask.id });
  check('an unanswered question can be retracted', retracted.status === 200, retracted.status);
  const afterRetract = await call('/feed', known, null);
  check('the retracted question is gone', !(afterRetract.json.asks || []).some((item) => item.id === throwaway.json.ask.id));

  const answeredRetract = await call('/ask/delete', known, { id: asked.json.ask.id });
  check('an answered question cannot be retracted', answeredRetract.status === 409, answeredRetract.status);

  // Deleting the note that was published as an answer must not leave the ask
  // pointing at a dead id — that is exactly the dangling state we saw live.
  const answeredPostId = answered.json.postId;
  const deleteAnswer = await call('/delete', known, { postId: answeredPostId });
  check('the answer note can be deleted', deleteAnswer.status === 200, deleteAnswer.status);
  const afterAnswerDelete = await call('/feed', known, null);
  const answerAsk = (afterAnswerDelete.json.asks || []).find((item) => item.id === asked.json.ask.id);
  check(
    'deleting an answer note clears the pointer but keeps the text',
    !!answerAsk && answerAsk.answerPostId === null && !!answerAsk.answer,
    JSON.stringify(answerAsk && { postId: answerAsk.answerPostId, answer: !!answerAsk.answer }),
  );

  const foreignRetract = await call('/ask/delete', known2, { id: 'no-such-ask' });
  check('an unknown question cannot be retracted', foreignRetract.status === 404, foreignRetract.status);

  const cascadePost = await call('/post', known2, { title: '级联测试', text: '删掉它，通知也该消失' });
  check('the cascade fixture posts', cascadePost.status === 201, cascadePost.status);
  await call('/reply', known, { postId: cascadePost.json.post.id, text: '这条会生成通知' });
  const beforeCascade = await call('/notifications', known2, null);
  check(
    'a reply leaves a notification',
    (beforeCascade.json.items || []).some((item) => item.postId === cascadePost.json.post.id),
    String((beforeCascade.json.items || []).length),
  );
  await call('/delete', known2, { postId: cascadePost.json.post.id });
  const afterCascade = await call('/notifications', known2, null);
  check(
    'deleting a post removes the notifications that pointed at it',
    !(afterCascade.json.items || []).some((item) => item.postId === cascadePost.json.post.id),
    String((afterCascade.json.items || []).length),
  );

  const ghostReply = await call('/reply', known, { postId: cascadePost.json.post.id, text: '对着一片空气回话' });
  check('replying to a deleted note is rejected', ghostReply.status === 404, ghostReply.status);  const ghostFeed = await call('/feed', known, null);
  check('the rejected reply left nothing behind', !(ghostFeed.json.comments || {})[cascadePost.json.post.id]);

  let limited = 0;
  for (let index = 0; index < 45; index += 1) {
    const burst = await call('/post', known, { title: `压测 ${index}`, text: '刷接口' });
    if (burst.status === 429) limited += 1;
  }
  check('rate limit kicks in', limited > 0, `429s: ${limited}`);

  const after = await call('/feed', known);
  check('feed still answers after the burst', after.status === 200 || after.status === 429);

  // Referential integrity: a delete that does not cascade leaves pointers that
  // nobody notices until a click leads nowhere.
  const integrityFeed = await call('/feed', known, null);
  const integrityInbox = await call('/notifications', known, null);
  const integrityInbox2 = await call('/notifications', known2, null);
  const liveIds = new Set((integrityFeed.json.posts || []).map((item) => item.id));
  const liveTasks = new Set((integrityFeed.json.tasks || []).map((item) => item.id));
  const dangling = [];
  for (const [postId, list] of Object.entries(integrityFeed.json.comments || {})) {
    if (!liveIds.has(postId)) dangling.push('comments:' + postId);
    for (const reply of list) if (!reply.ai || !reply.ownerId) dangling.push('reply-author:' + reply.id);
  }
  for (const [taskId, claim] of Object.entries(integrityFeed.json.claims || {})) {
    if (!liveTasks.has(taskId)) dangling.push('claim:' + taskId);
    if (claim.confirmedAt && !claim.deliveredAt) dangling.push('confirm-without-delivery:' + taskId);
  }
  for (const inbox of [integrityInbox, integrityInbox2]) {
    for (const item of inbox.json.items || []) {
      if (item.postId && !liveIds.has(item.postId)) dangling.push('notice-post:' + item.postId);
      if (item.taskId && !liveTasks.has(item.taskId)) dangling.push('notice-task:' + item.taskId);
    }
  }
  for (const ask of integrityFeed.json.asks || []) {
    if (ask.answerPostId && !liveIds.has(ask.answerPostId)) dangling.push('ask-note:' + ask.id);
  }
  check('the store has no dangling references', dangling.length === 0, dangling.join(', '));

  const start = await fetch(BASE + '/wx?bind=123456', { redirect: 'manual' });
  check('legacy OAuth entry is closed', start.status === 410, start.status);
  const bound = await fetch(BASE + '/wx/callback?code=abc&state=123456', { redirect: 'manual' });
  check('legacy callback cannot mint a credential', bound.status === 410 && !bound.headers.get('location'), bound.status);
  check('callback does not expose a full credential in its body', !(await bound.text()).includes('xlb_'));

  // 小程序：未绑定先 409，用配对码绑一次之后免码登录
  const appUnbound = await call('/wxapp/login', null, { code: 'js-code-1' });
  check('an unbound mini program is told to bind', appUnbound.status === 409 && appUnbound.json.needBind === true, appUnbound.status);

  const appPair = await call('/pair', known, {});
  const appBound = await call('/wxapp/bind', null, { code: 'js-code-1', pair: appPair.json.code });
  check('a pairing code binds the mini program', appBound.status === 200 && String(appBound.json.token).indexOf('xlb_') === 0, appBound.status);
  const appFeed = await call('/feed?limit=1', appBound.json.token, null);
  check('the mini-program token works', appFeed.status === 200, appFeed.status);

  const appAgain = await call('/wxapp/login', null, { code: 'js-code-1' });
  check('a bound mini program logs in without a code', appAgain.status === 200 && String(appAgain.json.token).indexOf('xlb_') === 0, appAgain.status);

  const pair = await call('/pair', known, {});
  check('a pairing code is issued', pair.status === 201 && /^[0-9]{6}$/.test(pair.json.code || ''), pair.status);
  const ownersBeforePairing = (await call('/health')).json.counts.owners;

  const redeemed = await call('/pair/redeem', null, { code: pair.json.code });
  check('the code swaps for a device token', redeemed.status === 200 && String(redeemed.json.token).indexOf('xlb_') === 0, redeemed.status);

  const deviceFeed = await call('/feed', redeemed.json.token, null);
  check('the device token works', deviceFeed.status === 200, deviceFeed.status);

  const healthWithDevice = await call('/health');
  check(
    'a device token does not look like a second owner',
    healthWithDevice.json.counts.owners === ownersBeforePairing,
    `${ownersBeforePairing} → ${healthWithDevice.json.counts.owners}`,
  );

  const reuse = await call('/pair/redeem', null, { code: pair.json.code });
  check('a pairing code cannot be reused', reuse.status === 400, reuse.status);

  const wrongCode = await call('/pair/redeem', null, { code: '000000' });
  check('a wrong pairing code is rejected', wrongCode.status === 400, wrongCode.status);

  const rotated = await call('/rotate', known, {});
  check('rotating issues a new token', rotated.status === 200 && /^xlb_[0-9a-f]{48}$/.test(rotated.json.token || ''), rotated.status);
  const oldDead = await call('/feed', known, null);
  check('the old token stops working at once', oldDead.status === 401, oldDead.status);
  const newAlive = await call('/feed', rotated.json.token, null);
  check('the new token keeps working with the same data', newAlive.status === 200 && (newAlive.json.posts || []).length > 0, newAlive.status);

  const deviceAfterRotate = await call('/feed', redeemed.json.token, null);
  check('rotating kills device tokens too', deviceAfterRotate.status === 401, deviceAfterRotate.status);

  // Last, because it adds posts: four writers at once must all land, and the
  // file on disk must still be parseable (the server reads from a cache, so a
  // corrupted file would stay invisible until the next restart).
  const concurrent = await Promise.all([0, 1, 2, 3].map((index) => call('/post', known2, {
    title: `并发 ${index}`,
    text: '并发写入测试',
  })));
  check('concurrent writes all succeed', concurrent.every((result) => result.status === 201), concurrent.map((result) => result.status).join(','));
  // 读磁盘上的库（不是内存），确认四个并发写都真的落地了。
  const diskFeed = await call('/feed?limit=100', known2, null);
  const concurrentTitles = (diskFeed.json.posts || []).filter((post) => String(post.title).indexOf('并发') === 0).length;
  check('the store holds every concurrent write', concurrentTitles === 4, `${concurrentTitles}/4`);

  const dbFile = await readFile(join(dataDir, 'feed.db'));
  check('the store is a sqlite file', dbFile.subarray(0, 15).toString('latin1') === 'SQLite format 3', dbFile.subarray(0, 15).toString('latin1'));
  check('no plaintext token is written to the store', dbFile.toString('latin1').indexOf('xlb_') < 0);
} finally {
  oauthMock.close();
  child.kill();
  await new Promise((resolve) => setTimeout(resolve, 200));
  await rm(dataDir, { recursive: true, force: true });
}

console.log(failed === 0 ? 'ALL PASS' : `${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
