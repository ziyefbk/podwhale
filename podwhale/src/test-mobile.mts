/**
 * Cross-reference checks for the two inline pages the server ships.
 *
 * The mobile page and the registration page are hand-written strings of HTML
 * plus a hand-written DOM script. They cannot be rendered here, but most of
 * their bugs are the boring kind: an id that is never defined, an API path the
 * server does not serve, a data attribute nothing emits, an attribute value
 * that is not escaped. This file finds those.
 *
 *   node test-mobile.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const source = readFileSync(join(HERE, 'server/community.mjs'), 'utf8');

// Import the real modules: the page text is a template literal, so reading the
// source file would compare against escapes that the browser never sees.
const { MOBILE } = await import('./server/mobile.mjs');
const { PAGE } = await import('./server/page.mjs');

const failures = [];
function check(name: string, ok: unknown, detail: unknown = "") {
  if (!ok) failures.push(name + (detail ? ' — ' + detail : ''));
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  — ' + detail : ''}`);
}

const routes = new Set([...source.matchAll(/path === '([^']+)'/g)].map((match) => match[1]));
check('server routes were found', routes.size > 20, `${routes.size} routes`);

function auditPage(label: string, template: string) {
  if (!template) {
    check(label + ' template exists', false);
    return 0;
  }
  const scriptMatch = /<script>([\s\S]*?)<\/script>/.exec(template);
  check(label + ' has an inline script', !!scriptMatch);
  if (!scriptMatch) return 0;
  const script = scriptMatch[1]!;

  try {
    new Function(script);
    check(label + ' script parses', true, `${script.length} chars`);
  } catch (caught) { const error = caught as Error & { code?: string; status?: number; phase?: string; stopped?: boolean; detail?: string; };
    check(label + ' script parses', false, String(error.message));
    return 0;
  }

  const defined = new Set([...template.matchAll(/id="([a-zA-Z0-9_-]+)"/g)].map((match) => match[1]));
  const used = new Set([...script.matchAll(/getElementById\('([a-zA-Z0-9_-]+)'\)/g)].map((match) => match[1]));
  const missing = [...used].filter((id) => !defined.has(id));
  check(label + ' ids all exist', missing.length === 0, missing.join(', '));

  const paths = new Set([...script.matchAll(/api\('([^']+)'/g)].map((match) => match[1]!.split('?')[0]));
  for (const match of script.matchAll(/fetch\(base \+ '([^']+)'/g)) paths.add('/' + match[1]!);
  check(label + ' API scan covers calls', paths.size > 0, paths.size);
  const unknown = [...paths].filter((path) => !routes.has(path));
  check(label + ' api paths are served', unknown.length === 0, unknown.join(', '));

  const dataQueries = new Set([...script.matchAll(/\[data-([a-z-]+)\]/g)].map((match) => match[1]));
  const emitted = new Set([...template.matchAll(/data-([a-z-]+)=/g)].map((match) => match[1]));
  const orphan = [...dataQueries].filter((name) => !emitted.has(name));
  check(label + ' data attributes are emitted', orphan.length === 0, orphan.join(', '));

  // An unescaped value inside an attribute can close the quote and inject tags.
  const attrInterpolations = [...script.matchAll(/(?:id|data-[a-z-]+)="' \+ ([^+]+?) \+ '"/g)]
    .map((match) => match[1]!.trim());
  const unsafe = attrInterpolations.filter((expression) => expression.indexOf('esc(') !== 0);
  check(label + ' attribute values are escaped', unsafe.length === 0, unsafe.join(' | '));
  return attrInterpolations.length;
}

const mobileAttributes = auditPage('mobile', MOBILE);
const landingAttributes = auditPage('landing', PAGE);
// Guards against a vacuous regex: if the pattern stops matching, the check
// above would pass without ever looking at anything.
check(
  'attribute escaping is actually exercised',
  mobileAttributes + landingAttributes >= 3,
  `mobile ${mobileAttributes}, landing ${landingAttributes}`,
);

// Exercise the shipped renderer with synthetic data. The tiny DOM surface is
// only a host for the actual inline script; no rendering functions are copied.
class MobileTestNode {
  innerHTML = ''; textContent = ''; value = ''; hidden = false; disabled = false;
  scrollTop = 0;
  dataset: Record<string, string> = {};
  attributes = new Map<string, string>();
  queryResults: Record<string, MobileTestNode[]> = {};
  onclick: (() => void) | null = null;
  oninput: (() => void) | null = null;
  style = { display: '', setProperty(_key: string, _value: string) {} };
  classList = { add(_value: string) {}, remove(_value: string) {}, toggle(_value: string, _on?: boolean) { return false; } };
  querySelectorAll(selector: string) { return this.queryResults[selector] || []; }
  querySelector(_selector: string) { return null; }
  addEventListener(_event: string, _listener: unknown) {}
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  removeAttribute(name: string) { this.attributes.delete(name); }
  focus(_options?: unknown) {}
}
interface MobileTestProposal { id: string; action: string; status: string; digest: string; expiresAt: string; payload: unknown; target: unknown }
interface MobileTestNote { id: string; title: string; text: string; ai: string; createdAt: string; images?: string[]; likes?: number; saves?: number; viewer?: { mine?: boolean; liked?: boolean; saved?: boolean } }
interface MobileTestTask {
  id: string; title: string; budget?: string; ownerId?: string; status?: 'open' | 'claimed' | 'in_progress' | 'delivered' | 'changes_requested' | 'completed' | 'cancelled' | 'expired';
  claimed?: boolean; demo?: boolean; match?: number; risk?: boolean;
  viewer?: { publisher: boolean; claimer: boolean; participant: boolean; canClaim: boolean };
}
interface MobileTestHarness {
  state: { credential: { role: 'human' | 'agent'; expiresAt: string | null } | null; proposals: MobileTestProposal[]; reviewed: Record<string, string | null>; comments: Record<string, { id: string; ai: string; text: string }[]>; notes: MobileTestNote[]; extra: MobileTestNote[]; open: string | null; deciding?: boolean; tab: string; tasks: MobileTestTask[]; me?: string };
  readableEvidence(value: unknown): string;
  renderNote(note: MobileTestNote, open: boolean): string;
  renderApprovals(): void;
  render(): void;
  reactNote(postId: string, kind: 'like' | 'save'): Promise<void>;
  sendReply(postId: string): Promise<void>;
  rememberToken(value: string): void;
  clearSession(): void;
}
const mobileScript = /<script>([\s\S]*?)<\/script>/.exec(MOBILE)?.[1] || '';
const nodes = new Map<string, MobileTestNode>();
const node = (id: string) => { if (!nodes.has(id)) nodes.set(id, new MobileTestNode()); return nodes.get(id)!; };
const scheduledDelays: number[] = [];
const context: Record<string, unknown> = {
  location: { pathname: '/xiaolanshu/m', search: '' }, history: { replaceState() {} }, URLSearchParams,
  sessionStorage: { getItem() { return ''; }, setItem() {}, removeItem() {} }, localStorage: { getItem() { return ''; }, removeItem() {} },
  document: { getElementById: node, body: node('body'), addEventListener() {}, querySelectorAll() { return []; } },
  window: {}, setTimeout(_callback: unknown, delay: number) { scheduledDelays.push(delay); return scheduledDelays.length; }, clearTimeout() {},
};
const instrumented = mobileScript.replace(/\}\)\(\);\s*$/, 'globalThis.__mobileTest = {state,readableEvidence,renderNote,renderApprovals,render,reactNote,sendReply,rememberToken,clearSession};})();');
check('mobile renderer harness instruments the real inline entry', instrumented !== mobileScript);
runInNewContext(instrumented, context, { timeout: 2000 });
const harness = context['__mobileTest'] as MobileTestHarness;
const attack = '<img src=x onerror="globalThis.injected=true">';
const evidence = harness.readableEvidence({ text: attack, unknownExtra: { keep: 'unknown field remains visible' }, nested: [null, true, 17] });
check('mobile readable evidence escapes untrusted text', evidence.includes('&lt;img') && !evidence.includes('<img'));
check('mobile readable evidence retains unknown fields', evidence.includes('unknownExtra') && evidence.includes('unknown field remains visible'));
check('mobile readable evidence retains arrays and scalar values', evidence.includes('第 3 项') && evidence.includes('17') && evidence.includes('未设置'));
const inheritedNames: unknown = JSON.parse('{"__proto__":"proto value <script>","constructor":"constructor value <img>","toString":"string value <svg>"}');
const inheritedEvidence = harness.readableEvidence(inheritedNames);
check('mobile unknown prototype-named fields retain their own names and values', inheritedEvidence.includes('<dt>__proto__</dt>') && inheritedEvidence.includes('<dt>constructor</dt>') && inheritedEvidence.includes('<dt>toString</dt>') && inheritedEvidence.includes('proto value &lt;script&gt;') && inheritedEvidence.includes('constructor value &lt;img&gt;') && inheritedEvidence.includes('string value &lt;svg&gt;'));
const sample: MobileTestNote = { id: 'synthetic-note', title: 'Synthetic title', text: 'Complete text tail ' + attack, ai: 'Synthetic AI', createdAt: new Date().toISOString() };
const textCard = harness.renderNote(sample, false);
check('mobile text cards use a native detail button without invented artwork', textCard.includes('data-note-open="synthetic-note"') && textCard.includes('<button') && !textCard.includes('<img'));
const photoCard = harness.renderNote({ ...sample, images: ['/media/synthetic.png'] }, false);
check('mobile image cards use the served prefix and descriptive alternative', photoCard.includes('src="/xiaolanshu/media/synthetic.png"') && photoCard.includes('loading="lazy"') && photoCard.includes('alt="Synthetic title，图片 1"'));
const rejectedImages = ['https://example.invalid/track.png', '//example.invalid/track.png', '/media/../private.png', '/media/%2e%2e/private.png', '/social/policy', '/media/synthetic.svg', '/media/synthetic.png?extra=1'];
const invalidCard = harness.renderNote({ ...sample, images: rejectedImages }, false);
check('mobile invalid or remote covers fall back to a text card', !invalidCard.includes('<img') && invalidCard.includes('text-note') && invalidCard.includes('Complete text tail'));
const mixedCard = harness.renderNote({ ...sample, images: [...rejectedImages, '/media/valid-name_1.JPEG', '/media/valid-name_2.webp'] }, true);
check('mobile cover allowlist preserves only exact local supported media paths', (mixedCard.match(/<img /g) || []).length === 2 && mixedCard.includes('src="/xiaolanshu/media/valid-name_1.JPEG"') && mixedCard.includes('src="/xiaolanshu/media/valid-name_2.webp"') && !mixedCard.includes('example.invalid'));
harness.state.comments[sample.id] = [{ id: 'one', ai: 'First', text: 'First complete comment' }, { id: 'two', ai: 'Second', text: 'Final comment tail ' + attack }];
const detail = harness.renderNote(sample, true);
check('mobile detail shows complete body and all loaded comments', detail.includes('Complete text tail') && detail.includes('First complete comment') && detail.includes('Final comment tail') && detail.includes('评论 2'));
check('mobile detail escapes comment content and offers a native back control', !detail.includes('<img') && detail.includes('&lt;img') && detail.includes('id="note-back"'));
const fixtureProposal: MobileTestProposal = { id: 'proposal-synthetic', action: 'reply', status: 'pending', digest: 'synthetic-digest', expiresAt: new Date(Date.now() + 3600000).toISOString(), payload: { postId: sample.id, text: 'FULL PAYLOAD TAIL ' + attack }, target: { post: { title: 'Frozen target', text: 'FULL TARGET TAIL ' + attack }, unknownEvidence: 'retain me' } };
harness.state.proposals = [fixtureProposal];
harness.state.credential = { role: 'human', expiresAt: null };
harness.renderApprovals();
let approval = node('main').innerHTML;
check('mobile approval retains full payload and frozen target in raw evidence', approval.includes('class="raw-evidence"') && approval.includes('FULL PAYLOAD TAIL') && approval.includes('FULL TARGET TAIL') && approval.includes('unknownEvidence') && approval.includes('synthetic-digest'));
check('mobile approval evidence never injects raw markup', !approval.includes('<img') && approval.includes('&lt;img'));
check('mobile approval starts disabled before review', /data-approve="proposal-synthetic" disabled/.test(approval));
harness.state.reviewed[fixtureProposal.id] = 'wrong-digest'; harness.renderApprovals();
check('mobile checkbox review cannot carry over to a different digest', /data-approve="proposal-synthetic" disabled/.test(node('main').innerHTML));
harness.state.reviewed[fixtureProposal.id] = fixtureProposal.digest; harness.renderApprovals();
check('mobile approval enables only the matching reviewed digest', /data-approve="proposal-synthetic">/.test(node('main').innerHTML));
harness.state.credential = { role: 'agent', expiresAt: null }; harness.renderApprovals(); approval = node('main').innerHTML;
check('mobile agent view has no approval or human credential controls', !approval.includes('data-approve=') && !approval.includes('data-review=') && !approval.includes('id="issue-agent"') && !approval.includes('id="issue-pair"'));
harness.state.credential = { role: 'human', expiresAt: null };
harness.state.proposals = [{ ...fixtureProposal, expiresAt: new Date(Date.now() - 1000).toISOString() }];
harness.renderApprovals();
check('mobile expired proposals have no approval action', !node('main').innerHTML.includes('data-approve='));

const taskTarget = {
  task: { id: 'task-synthetic', title: '合成任务', status: 'in_progress', acceptanceCriteria: 'FULL ACCEPTANCE CRITERIA TAIL ' + attack,
    deadlineAt: '2030-11-09T09:00:00.000Z', revision: 7,
    cancellation: { requestedBy: 'publisher-synthetic', reason: 'FULL CANCELLATION TAIL ' + attack, createdAt: '2026-11-09T09:00:00.000Z', claimId: 'claim-synthetic' } },
  claim: { claimId: 'claim-synthetic', ownerId: 'claimer-synthetic', revision: 7, deliveryVersion: 2,
    startedAt: '2026-11-09T08:00:00.000Z', reservedUntil: '2026-11-10T08:00:00.000Z',
    deliveries: [{ version: 1, text: 'FIRST DELIVERY TAIL', createdAt: '2026-11-09T08:10:00.000Z', artifacts: [] },
      { version: 2, text: 'SECOND DELIVERY TAIL ' + attack, createdAt: '2026-11-09T08:20:00.000Z',
        artifacts: [{ label: 'FULL ARTIFACT LABEL TAIL', url: 'https://artifacts.example.test/complete-delivery.txt' }] }] },
};
const lifecycleActions = ['task_start', 'task_rework', 'task_withdraw', 'task_cancel'] as const;
let approvalFetches = 0;
context['fetch'] = async () => { approvalFetches += 1; return { ok: false, status: 409, json: async () => ({ error: 'Synthetic decision response' }) }; };
for (const action of lifecycleActions) {
  const proposal = { ...fixtureProposal, id: 'proposal-' + action, action,
    payload: { taskId: 'task-synthetic', expectedRevision: 7, claimId: 'claim-synthetic', deliveryVersion: 2, reason: 'FULL REWORK OR EXIT TAIL ' + attack }, target: taskTarget };
  harness.state.proposals = [proposal]; harness.state.reviewed = {}; harness.state.credential = { role: 'human', expiresAt: null };
  harness.renderApprovals();
  const rendered = node('main').innerHTML;
  check('mobile lifecycle proposal retains complete versioned evidence: ' + action, rendered.includes('FULL ACCEPTANCE CRITERIA TAIL')
    && rendered.includes('2030-11-09T09:00:00.000Z') && rendered.includes('claim-synthetic') && rendered.includes('expectedRevision')
    && rendered.includes('deliveryVersion') && rendered.includes('FIRST DELIVERY TAIL') && rendered.includes('SECOND DELIVERY TAIL')
    && rendered.includes('FULL ARTIFACT LABEL TAIL') && rendered.includes('https://artifacts.example.test/complete-delivery.txt')
    && rendered.includes('FULL CANCELLATION TAIL') && rendered.includes('FULL REWORK OR EXIT TAIL'));
  check('mobile lifecycle approval keeps human review disabled until its digest is checked: ' + action,
    rendered.includes('data-approve="' + proposal.id + '" disabled') && rendered.includes('class="raw-evidence"'));
  check('mobile lifecycle evidence stays inert text without attachment loading: ' + action,
    !rendered.includes('<img') && !rendered.includes('<iframe') && !rendered.includes('<a ') && rendered.includes('&lt;img'));
}
check('mobile displaying task versions and artifacts performs no network request', approvalFetches === 0);
check('mobile task approval explains the first cancellation request without promising immediate cancellation',
  node('main').innerHTML.includes('首次批准只提交取消请求，任务仍继续') && node('main').innerHTML.includes('另一方主人独立批准后才取消'));
const taskEvidence = harness.readableEvidence({ ...taskTarget, history: [{ status: 'changes_requested', endedAt: '2026-11-08T09:00:00.000Z',
  reason: 'FULL ARCHIVE REWORK TAIL ' + attack }], events: [{ action: 'task_withdraw', actorId: 'former-synthetic', reason: 'FULL EVENT TAIL' }] });
check('mobile unknown or archived task evidence is preserved with readable status and escaped text', taskEvidence.includes('FULL ARCHIVE REWORK TAIL')
  && taskEvidence.includes('FULL EVENT TAIL') && taskEvidence.includes('需要返工') && taskEvidence.includes('changes_requested')
  && !taskEvidence.includes('<img') && taskEvidence.includes('&lt;img'));

const approveTask = new MobileTestNode();
approveTask.setAttribute('data-approve', 'proposal-task_cancel');
node('main').queryResults['[data-approve]'] = [approveTask];
node('main').queryResults['[data-approve], [data-reject]'] = [approveTask];
harness.state.reviewed['proposal-task_cancel'] = 'wrong-digest'; harness.renderApprovals();
approveTask.onclick?.();
check('mobile task approval handler cannot submit an unchecked digest', approvalFetches === 0);
harness.state.reviewed['proposal-task_cancel'] = fixtureProposal.digest;
harness.state.credential = { role: 'agent', expiresAt: null }; approveTask.onclick?.();
check('mobile task approval handler rejects a stale button after agent role change', approvalFetches === 0);
harness.state.credential = { role: 'human', expiresAt: null };
let decisionBody: unknown;
context['fetch'] = async (url: string, init: { body?: string }) => {
  if (url.endsWith('/proposals/approve')) { approvalFetches += 1; decisionBody = JSON.parse(init.body || '{}') as unknown; }
  return { ok: false, status: 409, json: async () => ({ error: 'Synthetic decision response' }) };
};
approveTask.onclick?.(); approveTask.onclick?.();
check('mobile task approval submits only the immutable id and digest once', approvalFetches === 1
  && JSON.stringify(decisionBody) === JSON.stringify({ id: 'proposal-task_cancel', digest: fixtureProposal.digest }));
await new Promise<void>(resolve => setImmediate(resolve));
node('main').queryResults['[data-approve]'] = [];
node('main').queryResults['[data-approve], [data-reject]'] = [];
harness.state.deciding = false;

const availableTask: MobileTestTask = { id: 'open-foreign', title: '合成可认领任务', status: 'open', ownerId: 'publisher-synthetic',
  viewer: { publisher: false, claimer: false, participant: false, canClaim: true } };
harness.state.tab = 'tasks'; harness.state.me = 'claimer-synthetic'; harness.state.tasks = [availableTask,
  { ...availableTask, id: 'own-task', ownerId: 'claimer-synthetic', viewer: { publisher: true, claimer: false, participant: true, canClaim: false } },
  { ...availableTask, id: 'completed-task', status: 'completed' }, { ...availableTask, id: 'demo-task', demo: true },
  { id: 'legacy-foreign', title: '旧合成任务', ownerId: 'publisher-synthetic', match: 1, risk: true },
  { id: 'legacy-self', title: '自己的旧任务', ownerId: 'claimer-synthetic' }];
harness.render();
let taskMarkup = node('main').innerHTML;
check('mobile task list uses real status without a missing match score', taskMarkup.includes('开放认领') && taskMarkup.includes('已完成')
  && !taskMarkup.includes('undefined%') && !taskMarkup.includes('匹配') && !taskMarkup.includes('仍要接'));
check('mobile task claiming follows server viewer capability and real lifecycle state', taskMarkup.includes('data-claim="open-foreign"')
  && !taskMarkup.includes('data-claim="own-task"') && !taskMarkup.includes('data-claim="completed-task"') && !taskMarkup.includes('data-claim="demo-task"'));
check('mobile legacy claim fallback excludes self without invented match or risk restrictions', taskMarkup.includes('data-claim="legacy-foreign"')
  && !taskMarkup.includes('data-claim="legacy-self"'));
harness.state.credential = { role: 'agent', expiresAt: null }; harness.render();
check('mobile task list remains readonly for an agent session', !node('main').innerHTML.includes('data-claim='));
const claimButton = new MobileTestNode(); claimButton.setAttribute('data-claim', availableTask.id);
node('main').queryResults['[data-claim]'] = [claimButton];
harness.state.credential = { role: 'human', expiresAt: null }; harness.render();
let taskClaims = 0;
context['fetch'] = async (url: string) => {
  if (url.endsWith('/claim')) taskClaims += 1;
  return { ok: true, status: 200, json: async () => url.endsWith('/whoami') ? { credential: { role: 'human', expiresAt: null } }
    : url.includes('/feed?') ? { posts: [], tasks: harness.state.tasks, comments: {}, me: 'claimer-synthetic' } : { items: [] } };
};
harness.state.credential = { role: 'agent', expiresAt: null }; claimButton.onclick?.();
check('mobile stale task claim button cannot act after session downgrade', taskClaims === 0);
harness.state.credential = { role: 'human', expiresAt: null };
claimButton.onclick?.(); claimButton.onclick?.();
check('mobile human task claim ignores repeated clicks while submitting', taskClaims === 1);
await new Promise<void>(resolve => setImmediate(resolve));
check('mobile successful direct human claim reports the actual completed operation', node('toast').textContent === '已认领任务');
node('main').queryResults['[data-claim]'] = [];
harness.state.tab = 'feed';

interface ReactionTestResponse { ok: boolean; status: number; json(): Promise<Record<string, unknown>> }
const reactionResponse = (ok: boolean, data: Record<string, unknown>, status = 200): ReactionTestResponse => ({ ok, status, json: async () => data });
const reactionCalls: { url: string; body: unknown }[] = [];
const replyCalls: { url: string; body: unknown }[] = [];
let reactionTransport: () => Promise<ReactionTestResponse> = async () => reactionResponse(false, {}, 500);
let replyTransport: () => Promise<ReactionTestResponse> = async () => reactionResponse(false, {}, 500);
context['fetch'] = async (url: string, init: { body?: string }) => {
  if (url.endsWith('/react')) { reactionCalls.push({ url, body: JSON.parse(init.body || '{}') as unknown }); return reactionTransport(); }
  if (url.endsWith('/reply')) { replyCalls.push({ url, body: JSON.parse(init.body || '{}') as unknown }); return replyTransport(); }
  if (url.includes('/feed?')) return reactionResponse(true, { posts: harness.state.notes, comments: harness.state.comments, total: harness.state.notes.length });
  if (url.endsWith('/whoami')) return reactionResponse(true, { credential: harness.state.credential });
  if (url.endsWith('/proposals') || url.endsWith('/notifications')) return reactionResponse(true, { items: [] });
  return reactionResponse(true, {});
};
harness.rememberToken('xlb_synthetic_mobile_fixture');
harness.state.credential = { role: 'human', expiresAt: null };
const reactionNote: MobileTestNote = { ...sample, likes: 5, saves: 2, viewer: { mine: true, liked: false, saved: false } };
harness.state.notes = [reactionNote]; harness.state.extra = [];
let replacementMarkup = node('main').innerHTML;
Object.defineProperty(node('main'), 'innerHTML', { get() { return replacementMarkup; }, set(value: string) {
  replacementMarkup = value;
  // A real DOM replacement discards the old input nodes and their values.
  for (const [id, element] of nodes) if (id.startsWith('r-')) element.value = '';
  const entities: Record<string, string> = { amp: '&', quot: '"', lt: '<', gt: '>' };
  const unescape = (text: string) => text.replace(/&(amp|quot|lt|gt);/g, (_match, name: string) => entities[name] || '');
  for (const [selector, pattern] of [['[data-reply-draft]', /<input\b[^>]*data-reply-draft="[^"]*"[^>]*>/g], ['[data-reply]', /<button\b[^>]*data-reply="[^"]*"[^>]*>/g]] as const) {
    node('main').queryResults[selector] = [...value.matchAll(pattern)].map(match => {
      const attributes = new Map([...match[0].matchAll(/([a-z-]+)="([^"]*)"/g)].map(item => [item[1]!, unescape(item[2]!)]));
      const element = node(attributes.get('id')!);
      element.attributes = attributes; element.value = attributes.get('value') || '';
      element.disabled = /\sdisabled(?=\s|>)/.test(match[0]);
      return element;
    });
  }
} });
harness.state.open = sample.id; harness.render();
node('r-' + sample.id).value = 'Synthetic unsent reply';
node('r-' + sample.id).oninput?.();
const humanCard = harness.renderNote(reactionNote, false);
check('mobile human cards expose native like and save with pressed state', humanCard.includes('data-react="like"') && humanCard.includes('data-react="save"') && humanCard.includes('aria-pressed="false"'));
let finishReaction: (response: ReactionTestResponse) => void = () => { throw new Error('missing synthetic request'); };
reactionTransport = () => new Promise(resolve => { finishReaction = resolve; });
const firstReaction = harness.reactNote(sample.id, 'like');
await harness.reactNote(sample.id, 'like');
const pollTimersBefore = scheduledDelays.filter(delay => delay === 20000).length;
check('mobile repeated reactions share one in-flight request without optimistic counts', reactionCalls.length === 1 && harness.state.notes[0]?.likes === 5 && harness.renderNote(reactionNote, false).includes('aria-pressed="false" disabled'));
finishReaction(reactionResponse(true, { postId: sample.id, likes: 42, saves: 8, viewer: { liked: true, saved: false, mine: false } }));
await firstReaction;
check('mobile reaction uses explicit endpoint kind and desired state', reactionCalls[0]?.url === '/xiaolanshu/react' && JSON.stringify(reactionCalls[0]?.body) === JSON.stringify({ postId: sample.id, kind: 'like', on: true }));
check('mobile confirmed server counts update without losing note ownership', harness.state.notes[0]?.likes === 42 && harness.state.notes[0]?.saves === 8 && harness.state.notes[0]?.viewer?.liked === true && harness.state.notes[0]?.viewer?.mine === true);
check('mobile successful reaction preserves an unsent reply during DOM replacement', node('r-' + sample.id).value === 'Synthetic unsent reply');
check('mobile confirmed reaction schedules polling after invalidating older feed reads', scheduledDelays.filter(delay => delay === 20000).length === pollTimersBefore + 1);
reactionTransport = async () => reactionResponse(false, { error: 'Synthetic failure' }, 500);
await harness.reactNote(sample.id, 'save');
check('mobile failed save preserves confirmed state', harness.state.notes[0]?.likes === 42 && harness.state.notes[0]?.saves === 8 && harness.state.notes[0]?.viewer?.saved === false);
reactionTransport = async () => reactionResponse(true, { postId: sample.id, likes: 42, saves: 99, viewer: { liked: true, saved: true } });
await harness.reactNote(sample.id, 'save');
check('mobile failed reaction unlocks retry and accepts authoritative save state', harness.state.notes[0]?.saves === 99 && harness.state.notes[0]?.viewer?.saved === true && JSON.stringify(reactionCalls.at(-1)?.body) === JSON.stringify({ postId: sample.id, kind: 'save', on: true }));
reactionTransport = async () => reactionResponse(true, { postId: 'other-post', likes: 100, saves: 100, viewer: { liked: false, saved: false } });
await harness.reactNote(sample.id, 'like');
check('mobile mismatched reaction response cannot update another target', harness.state.notes[0]?.likes === 42 && harness.state.notes[0]?.viewer?.liked === true);
harness.state.credential = { role: 'agent', expiresAt: null };
const beforeAgent = reactionCalls.length;
const agentCard = harness.renderNote(harness.state.notes[0]!, false);
await harness.reactNote(sample.id, 'like');
check('mobile agent shows readonly counts and cannot invoke react', !agentCard.includes('data-react=') && agentCard.includes('只读') && reactionCalls.length === beforeAgent);
harness.state.credential = { role: 'human', expiresAt: null };
reactionTransport = () => new Promise(resolve => { finishReaction = resolve; });
const logoutReaction = harness.reactNote(sample.id, 'like');
harness.clearSession(); node('main').innerHTML = 'signed out view';
finishReaction(reactionResponse(true, { postId: sample.id, likes: 100, saves: 100, viewer: { liked: false, saved: false } }));
await logoutReaction;
check('mobile logout prevents an in-flight reaction from restoring private state', harness.state.notes.length === 0 && harness.state.extra.length === 0 && harness.state.credential === null && node('main').innerHTML === 'signed out view');

harness.rememberToken('xlb_second_synthetic_mobile_fixture');
harness.state.credential = { role: 'human', expiresAt: null };
harness.state.notes = [{ ...reactionNote }]; harness.state.open = sample.id; harness.render();
node('r-' + sample.id).value = 'Held synthetic reply'; node('r-' + sample.id).oninput?.();
let finishReply: (response: ReactionTestResponse) => void = () => { throw new Error('missing held reply'); };
replyTransport = () => new Promise(resolve => { finishReply = resolve; });
const heldReply = harness.sendReply(sample.id);
reactionTransport = async () => reactionResponse(true, { postId: sample.id, likes: 6, saves: 2, viewer: { liked: true, saved: false } });
await harness.reactNote(sample.id, 'like');
const rebuiltReplyButton = node('reply-send-' + sample.id);
check('mobile reply stays busy through a successful reaction redraw', rebuiltReplyButton.disabled && harness.renderNote(harness.state.notes[0]!, true).includes('data-reply="synthetic-note" disabled'));
harness.state.open = null; harness.render(); harness.state.open = sample.id; harness.render();
check('mobile leaving and returning cannot reset an in-flight reply lock', node('reply-send-' + sample.id).disabled && node('r-' + sample.id).value === 'Held synthetic reply');
rebuiltReplyButton.onclick?.();
check('mobile a rebuilt reply handler cannot duplicate the held request', replyCalls.length === 1);
finishReply(reactionResponse(false, { error: 'Synthetic reply failure' }, 500)); await heldReply;
check('mobile failed reply unlocks current controls without losing the draft', !node('reply-send-' + sample.id).disabled && node('r-' + sample.id).value === 'Held synthetic reply');
replyTransport = async () => reactionResponse(true, {});
await harness.sendReply(sample.id);
check('mobile reply retry submits once and clears only its confirmed draft', replyCalls.length === 2 && JSON.stringify(replyCalls.at(-1)?.body) === JSON.stringify({ postId: sample.id, text: 'Held synthetic reply' }) && node('r-' + sample.id).value === '');
node('r-' + sample.id).value = 'ABA original'; node('r-' + sample.id).oninput?.();
replyTransport = () => new Promise(resolve => { finishReply = resolve; });
const abaReply = harness.sendReply(sample.id);
node('r-' + sample.id).value = 'Changed while sending'; node('r-' + sample.id).oninput?.();
node('r-' + sample.id).value = 'ABA original'; node('r-' + sample.id).oninput?.();
finishReply(reactionResponse(true, {})); await abaReply;
check('mobile successful reply does not clear a later draft revision with the same text', node('r-' + sample.id).value === 'ABA original');
const secondNote: MobileTestNote = { ...sample, id: 'second-synthetic-note', title: 'Second synthetic note' };
harness.state.notes.push(secondNote);
reactionTransport = () => new Promise(resolve => { finishReaction = resolve; });
const crossNoteReaction = harness.reactNote(sample.id, 'like');
harness.state.open = secondNote.id; harness.render();
node('r-' + secondNote.id).value = 'Different note unsent draft'; node('r-' + secondNote.id).oninput?.();
finishReaction(reactionResponse(true, { postId: sample.id, likes: 5, saves: 2, viewer: { liked: false, saved: false } })); await crossNoteReaction;
check('mobile reaction on one post preserves a different open post draft', harness.state.open === secondNote.id && node('r-' + secondNote.id).value === 'Different note unsent draft');
harness.state.open = sample.id; harness.render();
check('mobile returning to a post restores its separate reply draft', node('r-' + sample.id).value === 'ABA original');
const replyBeforeLogout = harness.sendReply(sample.id);
harness.clearSession(); node('main').innerHTML = 'signed out after reply';
finishReply(reactionResponse(true, {})); await replyBeforeLogout;
check('mobile logout drops a late reply and all per-session drafts', harness.state.notes.length === 0 && harness.state.credential === null && node('main').innerHTML === 'signed out after reply');
harness.state.credential = { role: 'agent', expiresAt: null };
const beforeAgentReply = replyCalls.length;
await harness.sendReply(sample.id);
check('mobile agent cannot create a reply request or see a reply input', replyCalls.length === beforeAgentReply && !harness.renderNote(sample, true).includes('data-reply-draft='));

console.log('');
if (failures.length === 0) {
  console.log('ALL PASS');
  process.exit(0);
}
console.log(failures.length + ' FAILED');
process.exit(1);
