/**
 * One end-to-end story, told only over HTTP.
 *
 * The other suites test endpoints; this one proves the features chain together
 * for two owners who have never existed before: enroll → post → reply → task →
 * claim → deliver → confirm → ask → answer → follow → profile → block → report
 * → patrol, plus the pages the deployment serves.
 *
 *   node test-journey.mjs
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { humanSession } from './server/test-human-session.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const PORT = 8767;
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = await mkdtemp(join(tmpdir(), 'xlb-journey-'));

interface JourneyOwner { id: string; name: string }
interface JourneyPost { id: string; ownerId?: string }
interface JourneyAsk { id: string; answer?: string | null }
interface JourneyClaim { deliveredAt?: string; confirmedAt?: string }
interface JourneyPatrol { at: string; ownerId: string; summary: string }
interface JourneyFeed {
  posts: JourneyPost[]; asks: JourneyAsk[]; claims: Record<string, JourneyClaim>;
  following: string[]; blocked: string[]; lastPatrol: JourneyPatrol | null; patrols: JourneyPatrol[];
}
interface JourneyNotification { kind: string; taskId?: string | null }
interface JourneyResponses {
  '/enroll': { token: string; owner: JourneyOwner };
  '/whoami': { owner: JourneyOwner };
  '/pair': { code: string };
  '/pair/redeem': { token: string };
  '/post': { post: JourneyPost };
  '/reply': { ok: boolean };
  '/notifications': { items: JourneyNotification[] };
  '/task': { task: { id: string } };
  '/claim': { ok: boolean };
  '/deliver': { ok: boolean };
  '/confirm': { ok: boolean };
  '/ask': { ask: { id: string } };
  '/answer': { postId: string };
  '/follow': { on: boolean };
  '/block': { ok: boolean };
  '/report': { ok: boolean };
  // The unprivileged owner receives an error object from this same endpoint.
  '/reports': { items?: { reason: string }[]; error?: string };
  '/digest': { digest: { mine: { posts: number }; pending: { asks: number } } };
  '/patrol': { at: string };
  '/health': { lastPatrol: { at: string } | null };
}
type JourneyPath = keyof JourneyResponses | '/feed' | `/feed?${string}` | `/profile?${string}`;
type JourneyResponse<P extends JourneyPath> = P extends '/feed' | `/feed?${string}` ? JourneyFeed
  : P extends `/profile?${string}` ? { profile: { followedByMe: boolean; notes: JourneyPost[] } }
  : P extends keyof JourneyResponses ? JourneyResponses[P] : never;

const failures: string[] = [];
function step(name: string, ok: unknown, detail: unknown = "") {
  if (!ok) failures.push(name + (detail ? ' — ' + detail : ''));
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  — ' + detail : ''}`);
}

async function call<P extends JourneyPath>(path: P, token?: string | null, body?: unknown): Promise<{ status: number; json: JourneyResponse<P> }> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (body) headers['content-type'] = 'application/json';
  const response = await fetch(BASE + path, {
    method: body ? 'POST' : 'GET',
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let json: unknown = null;
  try {
    json = await response.json();
  } catch {
    /* not json */
  }
  if (json === null || typeof json !== 'object' || Array.isArray(json)) throw new Error('Expected a JSON object from a journey endpoint');
  // This suite owns the local service and each path's fixture contract. HTTP
  // status assertions below still decide whether each requested action worked.
  return { status: response.status, json: json as JourneyResponse<P> };
}

const child = spawn(process.execPath, [join(HERE, 'server/community.mjs')], {  cwd: HERE,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    XLB_PORT: String(PORT),
    XLB_HOST: '127.0.0.1',
    XLB_DATA: dataDir,
    XLB_WRITE_LIMIT: '60',
    XLB_PATROL_MAX_HOURS: '26',
    XLB_WECHAT_TOKEN: 'jtest',
  },
});
child.stderr!.on('data', (chunk) => process.stderr.write(chunk));

/** Send a text message the way the WeChat platform does. */
async function wechatSend(content: string) {
  const stamp = String(Math.floor(Date.now() / 1000));
  const nonce = 'jn0nce';
  const signature = createHash('sha1').update(['jtest', stamp, nonce].sort().join('')).digest('hex');
  const body = '<xml><ToUserName><![CDATA[gh_account]]></ToUserName>'
    + '<FromUserName><![CDATA[openid-1]]></FromUserName><CreateTime>' + stamp + '</CreateTime>'
    + '<MsgType><![CDATA[text]]></MsgType><Content><![CDATA[' + content + ']]></Content></xml>';
  const response = await fetch(`${BASE}/wechat?signature=${signature}&timestamp=${stamp}&nonce=${nonce}`, {
    method: 'POST',
    headers: { 'content-type': 'text/xml' },
    body: body,
  });
  return { status: response.status, text: await response.text() };
}

async function waitForServer() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(BASE + '/health');
      if (response.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

try {
  const up = await waitForServer();
  step('the service comes up', up);
  if (!up) throw new Error('server did not start');

  // ---------------------------------------------------------------- enrollment
  const first = await call('/enroll', null, { name: '甲的主人', handle: '甲' });
  step('a stranger can enroll', first.status === 201 && String(first.json.token).startsWith('xlb_'), first.status);
  const agentA = first.json.token;
  step('public enrollment does not grant human write authority', (await call('/post', agentA, { title: 'not approved', text: 'must not publish' })).status === 403);
  const tokenA = await humanSession(dataDir, first.json.owner.id, BASE);

  const whoami = await call('/whoami', tokenA);
  step('the new token identifies its owner', whoami.status === 200 && whoami.json.owner.name === '甲的主人', whoami.status);

  // Plaintext platform signatures must never grant this sole owner's authority.
  const wechatAlone = await wechatSend('看');
  step('wechat cannot assume the sole owner identity', wechatAlone.status === 403, wechatAlone.status);

  // Pairing a phone adds a SECOND token for the same person.
  const pairCode = await call('/pair', tokenA, {});
  const redeemed = await call('/pair/redeem', null, { code: pairCode.json.code });
  step('a phone can pair with a six-digit code', redeemed.status === 200 && String(redeemed.json.token).indexOf('xlb_') === 0, redeemed.status);
  const deviceFeed = await call('/feed?limit=1', redeemed.json.token, null);
  step('the paired phone can read the feed', deviceFeed.status === 200, deviceFeed.status);

  const wechatAfterPairing = await wechatSend('看');
  step(
    'pairing a phone does not reopen the plaintext webhook',
    wechatAfterPairing.status === 403,
    wechatAfterPairing.text.slice(0, 80),
  );

  const second = await call('/enroll', null, { name: '乙的主人', handle: '乙' });
  step('a second stranger enrolls', second.status === 201, second.status);
  const tokenB = await humanSession(dataDir, second.json.owner.id, BASE);

  // ------------------------------------------------------------------- posting
  const note = await call('/post', tokenA, { title: '甲的第一条笔记', text: '投机解码在 batch=8 时收益最大', tags: ['技术'] });
  step('owner A posts a note', note.status === 201 && !!note.json.post.id, note.status);
  const postId = note.json.post.id;

  const feed = await call('/feed', tokenB, null);
  step('owner B can see it', (feed.json.posts || []).some((post) => post.id === postId));

  const reply = await call('/reply', tokenB, { postId: postId, text: '我们 batch=16 才有收益，可能和 KV cache 有关' });
  step('owner B replies', reply.status === 201, reply.status);

  const inboxA = await call('/notifications', tokenA, null);
  step('owner A hears about the reply', (inboxA.json.items || []).some((item) => item.kind === 'reply'), JSON.stringify((inboxA.json.items || []).map((item) => item.kind)));

  const search = await call(`/feed?q=${encodeURIComponent('投机解码')}`, tokenB, null);
  step('the note is searchable', (search.json.posts || []).some((post) => post.id === postId), String((search.json.posts || []).length));

  // --------------------------------------------------------------------- task
  const task = await call('/task', tokenA, { title: '甲发的活：跑一组 batch 对比', desc: '8/16/32 三档', budget: '¥600', period: '1 天', match: 85 });
  step('owner A publishes a job', task.status === 201 && !!task.json.task.id, task.status);
  const taskId = task.json.task.id;

  const claimed = await call('/claim', tokenB, { taskId: taskId, note: '我来做' });
  step('owner B claims it', claimed.status === 201, claimed.status);

  const delivered = await call('/deliver', tokenB, { taskId: taskId, text: '跑完了，三档数据在表里' });
  step('owner B delivers', delivered.status === 200, delivered.status);

  const inboxPublisher = await call('/notifications', tokenA, null);
  step('owner A is told about the delivery', (inboxPublisher.json.items || []).some((item) => item.kind === 'deliver' && item.taskId === taskId), JSON.stringify((inboxPublisher.json.items || []).map((item) => item.kind)));

  const confirmed = await call('/confirm', tokenA, { taskId: taskId });
  step('owner A confirms', confirmed.status === 200, confirmed.status);

  const inboxClaimer = await call('/notifications', tokenB, null);
  step('owner B is told about the confirmation', (inboxClaimer.json.items || []).some((item) => item.kind === 'confirm' && item.taskId === taskId), JSON.stringify((inboxClaimer.json.items || []).map((item) => item.kind)));

  const board = await call('/feed', tokenB, null);
  const claim = (board.json.claims || {})[taskId];
  step('the job ends fully closed', !!claim && !!claim.deliveredAt && !!claim.confirmedAt, JSON.stringify(claim && Object.keys(claim)));

  // ---------------------------------------------------------------------- ask
  const asked = await call('/ask', tokenA, { text: '这单接得值吗？' });
  step('owner A asks from the phone', asked.status === 201, asked.status);
  const pending = await call('/feed', tokenA, null);
  step('the question waits in the queue', (pending.json.asks || []).some((item) => !item.answer));

  const answered = await call('/answer', tokenA, { id: asked.json.ask.id, text: '值，成本一小时，报价六百' });
  step('the AI answers it', answered.status === 200 && !!answered.json.postId, answered.status);
  const closed = await call('/feed', tokenA, null);
  step('the question is closed', (closed.json.asks || []).every((item) => !!item.answer));

  // -------------------------------------------------------------------- social
  const ownerBId = (await call('/whoami', tokenB)).json.owner.id;

  const followed = await call('/follow', tokenB, { ownerId: whoami.json.owner.id, on: true });
  step('owner B follows owner A', followed.status === 200 && followed.json.on === true, followed.status);

  const inboxFollow = await call('/notifications', tokenA, null);
  step('owner A is told about the follower', (inboxFollow.json.items || []).some((item) => item.kind === 'follow'), JSON.stringify((inboxFollow.json.items || []).map((item) => item.kind)));

  const profile = await call(`/profile?ownerId=${whoami.json.owner.id}`, tokenB, null);
  step(
    'the profile shows notes and my follow state',
    profile.status === 200 && profile.json.profile.followedByMe === true && (profile.json.profile.notes || []).length >= 1,
    JSON.stringify(profile.json.profile && { notes: profile.json.profile.notes.length, followed: profile.json.profile.followedByMe }),
  );

  const followedFeed = await call('/feed', tokenB, null);
  step('the follow list reaches the feed', (followedFeed.json.following || []).includes(whoami.json.owner.id), JSON.stringify(followedFeed.json.following));

  await call('/post', tokenA, { title: '关注者才会收到的新帖', text: '这条用来验证关注推送' });
  const inboxNewPost = await call('/notifications', tokenB, null);
  step('followers hear about a new note', (inboxNewPost.json.items || []).some((item) => item.kind === 'post'), JSON.stringify((inboxNewPost.json.items || []).map((item) => item.kind)));

  const blocked = await call('/block', tokenB, { ownerId: whoami.json.owner.id, on: true });
  const blockedFeed = await call('/feed', tokenB, null);
  step(
    'blocking hides that owner from me only',
    blocked.status === 200 && !(blockedFeed.json.posts || []).some((post) => post.ownerId === whoami.json.owner.id),
    JSON.stringify(blockedFeed.json.blocked),
  );
  const stillVisible = await call('/feed', tokenA, null);
  step('blocking does not hide me from anyone else', (stillVisible.json.posts || []).some((post) => post.ownerId === whoami.json.owner.id));
  await call('/block', tokenB, { ownerId: whoami.json.owner.id, on: false });

  const reported = await call('/report', tokenB, { postId: postId, reason: '演练举报' });
  step('owner B reports a note', reported.status === 201, reported.status);

  const reportsA = await call('/reports', tokenA, null);
  const reportsB = await call('/reports', tokenB, null);
  step('exactly one owner is the deployment admin', (reportsA.status === 200) !== (reportsB.status === 200), `${reportsA.status}/${reportsB.status}`);
  const adminView = reportsA.status === 200 ? reportsA : reportsB;
  step('the admin sees the report', (adminView.json.items || []).some((item) => item.reason === '演练举报'), String((adminView.json.items || []).length));

  // ------------------------------------------------------------------- recap
  const digest = await call('/digest', tokenA, null);
  step('the digest counts the day', digest.json.digest.mine.posts >= 1 && digest.json.digest.pending.asks === 0, JSON.stringify(digest.json.digest.mine));

  const patrol = await call('/patrol', tokenA, { summary: '演练：答了一个提问，交付了一个任务' });
  const health = await call('/health', null, null);
  step('health exposes patrol freshness without its private contents', health.json.lastPatrol?.at === patrol.json.at
    && Object.keys(health.json.lastPatrol).length === 1 && !JSON.stringify(health.json).includes('演练：'));
  const privatePatrol = await call('/feed', tokenA);
  step('owner can read the complete patrol', privatePatrol.json.lastPatrol?.at === patrol.json.at
    && privatePatrol.json.lastPatrol.ownerId === whoami.json.owner.id && !!privatePatrol.json.lastPatrol.summary);
  const foreignPatrol = await call('/feed', tokenB);
  step('other owner cannot read the patrol', foreignPatrol.json.lastPatrol === null && foreignPatrol.json.patrols.length === 0);

  // -------------------------------------------------------------------- pages
  const mobile = await fetch(BASE + '/m');
  const html = await mobile.text();
  const script = /<script>([\s\S]*?)<\/script>/.exec(html);
  let parses = false;
  try {
    new Function(script![1]!);
    parses = true;
  } catch {
    parses = false;
  }
  step('the mobile page is served and its script runs', mobile.status === 200 && parses, `${html.length} bytes`);

  const landing = await fetch(BASE + '/');
  const landingHtml = await landing.text();
  step('the landing page is served', landing.status === 200 && landingHtml.indexOf('领取一个席位') >= 0, `${landingHtml.length} bytes`);

  const manifest = await fetch(BASE + '/manifest.webmanifest');
  step('the manifest is served', manifest.status === 200);
} catch (caught) { const error = caught as Error & { code?: string; status?: number; phase?: string; stopped?: boolean; detail?: string; };
  step('the journey finishes without throwing', false, String(error && error.message));
} finally {
  child.kill();
  await new Promise((resolve) => setTimeout(resolve, 200));
  await rm(dataDir, { recursive: true, force: true });
}

console.log('');
if (failures.length === 0) {
  console.log('ALL PASS');
  process.exit(0);
}
console.log(failures.length + ' FAILED');
process.exit(1);
