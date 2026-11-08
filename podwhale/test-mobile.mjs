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
function check(name, ok, detail = "") {
    if (!ok)
        failures.push(name + (detail ? ' — ' + detail : ''));
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  — ' + detail : ''}`);
}
const routes = new Set([...source.matchAll(/path === '([^']+)'/g)].map((match) => match[1]));
check('server routes were found', routes.size > 20, `${routes.size} routes`);
function auditPage(label, template) {
    if (!template) {
        check(label + ' template exists', false);
        return 0;
    }
    const scriptMatch = /<script>([\s\S]*?)<\/script>/.exec(template);
    check(label + ' has an inline script', !!scriptMatch);
    if (!scriptMatch)
        return 0;
    const script = scriptMatch[1];
    try {
        new Function(script);
        check(label + ' script parses', true, `${script.length} chars`);
    }
    catch (caught) {
        const error = caught;
        check(label + ' script parses', false, String(error.message));
        return 0;
    }
    const defined = new Set([...template.matchAll(/id="([a-zA-Z0-9_-]+)"/g)].map((match) => match[1]));
    const used = new Set([...script.matchAll(/getElementById\('([a-zA-Z0-9_-]+)'\)/g)].map((match) => match[1]));
    const missing = [...used].filter((id) => !defined.has(id));
    check(label + ' ids all exist', missing.length === 0, missing.join(', '));
    const paths = new Set([...script.matchAll(/api\('([^']+)'/g)].map((match) => match[1].split('?')[0]));
    for (const match of script.matchAll(/fetch\(base \+ '([^']+)'/g))
        paths.add('/' + match[1]);
    check(label + ' API scan covers calls', paths.size > 0, paths.size);
    const unknown = [...paths].filter((path) => !routes.has(path));
    check(label + ' api paths are served', unknown.length === 0, unknown.join(', '));
    const dataQueries = new Set([...script.matchAll(/\[data-([a-z-]+)\]/g)].map((match) => match[1]));
    const emitted = new Set([...template.matchAll(/data-([a-z-]+)=/g)].map((match) => match[1]));
    const orphan = [...dataQueries].filter((name) => !emitted.has(name));
    check(label + ' data attributes are emitted', orphan.length === 0, orphan.join(', '));
    // An unescaped value inside an attribute can close the quote and inject tags.
    const attrInterpolations = [...script.matchAll(/(?:id|data-[a-z-]+)="' \+ ([^+]+?) \+ '"/g)]
        .map((match) => match[1].trim());
    const unsafe = attrInterpolations.filter((expression) => expression.indexOf('esc(') !== 0);
    check(label + ' attribute values are escaped', unsafe.length === 0, unsafe.join(' | '));
    return attrInterpolations.length;
}
const mobileAttributes = auditPage('mobile', MOBILE);
const landingAttributes = auditPage('landing', PAGE);
// Guards against a vacuous regex: if the pattern stops matching, the check
// above would pass without ever looking at anything.
check('attribute escaping is actually exercised', mobileAttributes + landingAttributes >= 3, `mobile ${mobileAttributes}, landing ${landingAttributes}`);
// Exercise the shipped renderer with synthetic data. The tiny DOM surface is
// only a host for the actual inline script; no rendering functions are copied.
class MobileTestNode {
    innerHTML = '';
    textContent = '';
    value = '';
    hidden = false;
    disabled = false;
    scrollTop = 0;
    dataset = {};
    attributes = new Map();
    queryResults = {};
    onclick = null;
    oninput = null;
    style = { display: '', setProperty(_key, _value) { } };
    classList = { add(_value) { }, remove(_value) { }, toggle(_value, _on) { return false; } };
    querySelectorAll(selector) { return this.queryResults[selector] || []; }
    querySelector(_selector) { return null; }
    addEventListener(_event, _listener) { }
    setAttribute(name, value) { this.attributes.set(name, value); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    removeAttribute(name) { this.attributes.delete(name); }
    focus(_options) { }
}
const mobileScript = /<script>([\s\S]*?)<\/script>/.exec(MOBILE)?.[1] || '';
const nodes = new Map();
const node = (id) => { if (!nodes.has(id))
    nodes.set(id, new MobileTestNode()); return nodes.get(id); };
const scheduledDelays = [];
const context = {
    location: { pathname: '/xiaolanshu/m', search: '' }, history: { replaceState() { } }, URLSearchParams,
    sessionStorage: { getItem() { return ''; }, setItem() { }, removeItem() { } }, localStorage: { getItem() { return ''; }, removeItem() { } },
    document: { getElementById: node, body: node('body'), addEventListener() { }, querySelectorAll() { return []; } },
    window: {}, setTimeout(_callback, delay) { scheduledDelays.push(delay); return scheduledDelays.length; }, clearTimeout() { },
};
const instrumented = mobileScript.replace(/\}\)\(\);\s*$/, 'globalThis.__mobileTest = {state,readableEvidence,renderNote,renderApprovals,render,reactNote,sendReply,rememberToken,clearSession};})();');
check('mobile renderer harness instruments the real inline entry', instrumented !== mobileScript);
runInNewContext(instrumented, context, { timeout: 2000 });
const harness = context['__mobileTest'];
const attack = '<img src=x onerror="globalThis.injected=true">';
const evidence = harness.readableEvidence({ text: attack, unknownExtra: { keep: 'unknown field remains visible' }, nested: [null, true, 17] });
check('mobile readable evidence escapes untrusted text', evidence.includes('&lt;img') && !evidence.includes('<img'));
check('mobile readable evidence retains unknown fields', evidence.includes('unknownExtra') && evidence.includes('unknown field remains visible'));
check('mobile readable evidence retains arrays and scalar values', evidence.includes('第 3 项') && evidence.includes('17') && evidence.includes('未设置'));
const inheritedNames = JSON.parse('{"__proto__":"proto value <script>","constructor":"constructor value <img>","toString":"string value <svg>"}');
const inheritedEvidence = harness.readableEvidence(inheritedNames);
check('mobile unknown prototype-named fields retain their own names and values', inheritedEvidence.includes('<dt>__proto__</dt>') && inheritedEvidence.includes('<dt>constructor</dt>') && inheritedEvidence.includes('<dt>toString</dt>') && inheritedEvidence.includes('proto value &lt;script&gt;') && inheritedEvidence.includes('constructor value &lt;img&gt;') && inheritedEvidence.includes('string value &lt;svg&gt;'));
const sample = { id: 'synthetic-note', title: 'Synthetic title', text: 'Complete text tail ' + attack, ai: 'Synthetic AI', createdAt: new Date().toISOString() };
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
const fixtureProposal = { id: 'proposal-synthetic', action: 'reply', status: 'pending', digest: 'synthetic-digest', expiresAt: new Date(Date.now() + 3600000).toISOString(), payload: { postId: sample.id, text: 'FULL PAYLOAD TAIL ' + attack }, target: { post: { title: 'Frozen target', text: 'FULL TARGET TAIL ' + attack }, unknownEvidence: 'retain me' } };
harness.state.proposals = [fixtureProposal];
harness.state.credential = { role: 'human', expiresAt: null };
harness.renderApprovals();
let approval = node('main').innerHTML;
check('mobile approval retains full payload and frozen target in raw evidence', approval.includes('class="raw-evidence"') && approval.includes('FULL PAYLOAD TAIL') && approval.includes('FULL TARGET TAIL') && approval.includes('unknownEvidence') && approval.includes('synthetic-digest'));
check('mobile approval evidence never injects raw markup', !approval.includes('<img') && approval.includes('&lt;img'));
check('mobile approval starts disabled before review', /data-approve="proposal-synthetic" disabled/.test(approval));
harness.state.reviewed[fixtureProposal.id] = 'wrong-digest';
harness.renderApprovals();
check('mobile checkbox review cannot carry over to a different digest', /data-approve="proposal-synthetic" disabled/.test(node('main').innerHTML));
harness.state.reviewed[fixtureProposal.id] = fixtureProposal.digest;
harness.renderApprovals();
check('mobile approval enables only the matching reviewed digest', /data-approve="proposal-synthetic">/.test(node('main').innerHTML));
harness.state.credential = { role: 'agent', expiresAt: null };
harness.renderApprovals();
approval = node('main').innerHTML;
check('mobile agent view has no approval or human credential controls', !approval.includes('data-approve=') && !approval.includes('data-review=') && !approval.includes('id="issue-agent"') && !approval.includes('id="issue-pair"'));
harness.state.credential = { role: 'human', expiresAt: null };
harness.state.proposals = [{ ...fixtureProposal, expiresAt: new Date(Date.now() - 1000).toISOString() }];
harness.renderApprovals();
check('mobile expired proposals have no approval action', !node('main').innerHTML.includes('data-approve='));
const reactionResponse = (ok, data, status = 200) => ({ ok, status, json: async () => data });
const reactionCalls = [];
const replyCalls = [];
let reactionTransport = async () => reactionResponse(false, {}, 500);
let replyTransport = async () => reactionResponse(false, {}, 500);
context['fetch'] = async (url, init) => {
    if (url.endsWith('/react')) {
        reactionCalls.push({ url, body: JSON.parse(init.body || '{}') });
        return reactionTransport();
    }
    if (url.endsWith('/reply')) {
        replyCalls.push({ url, body: JSON.parse(init.body || '{}') });
        return replyTransport();
    }
    if (url.includes('/feed?'))
        return reactionResponse(true, { posts: harness.state.notes, comments: harness.state.comments, total: harness.state.notes.length });
    if (url.endsWith('/whoami'))
        return reactionResponse(true, { credential: harness.state.credential });
    if (url.endsWith('/proposals') || url.endsWith('/notifications'))
        return reactionResponse(true, { items: [] });
    return reactionResponse(true, {});
};
harness.rememberToken('xlb_synthetic_mobile_fixture');
harness.state.credential = { role: 'human', expiresAt: null };
const reactionNote = { ...sample, likes: 5, saves: 2, viewer: { mine: true, liked: false, saved: false } };
harness.state.notes = [reactionNote];
harness.state.extra = [];
let replacementMarkup = node('main').innerHTML;
Object.defineProperty(node('main'), 'innerHTML', { get() { return replacementMarkup; }, set(value) {
        replacementMarkup = value;
        // A real DOM replacement discards the old input nodes and their values.
        for (const [id, element] of nodes)
            if (id.startsWith('r-'))
                element.value = '';
        const entities = { amp: '&', quot: '"', lt: '<', gt: '>' };
        const unescape = (text) => text.replace(/&(amp|quot|lt|gt);/g, (_match, name) => entities[name] || '');
        for (const [selector, pattern] of [['[data-reply-draft]', /<input\b[^>]*data-reply-draft="[^"]*"[^>]*>/g], ['[data-reply]', /<button\b[^>]*data-reply="[^"]*"[^>]*>/g]]) {
            node('main').queryResults[selector] = [...value.matchAll(pattern)].map(match => {
                const attributes = new Map([...match[0].matchAll(/([a-z-]+)="([^"]*)"/g)].map(item => [item[1], unescape(item[2])]));
                const element = node(attributes.get('id'));
                element.attributes = attributes;
                element.value = attributes.get('value') || '';
                element.disabled = /\sdisabled(?=\s|>)/.test(match[0]);
                return element;
            });
        }
    } });
harness.state.open = sample.id;
harness.render();
node('r-' + sample.id).value = 'Synthetic unsent reply';
node('r-' + sample.id).oninput?.();
const humanCard = harness.renderNote(reactionNote, false);
check('mobile human cards expose native like and save with pressed state', humanCard.includes('data-react="like"') && humanCard.includes('data-react="save"') && humanCard.includes('aria-pressed="false"'));
let finishReaction = () => { throw new Error('missing synthetic request'); };
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
const agentCard = harness.renderNote(harness.state.notes[0], false);
await harness.reactNote(sample.id, 'like');
check('mobile agent shows readonly counts and cannot invoke react', !agentCard.includes('data-react=') && agentCard.includes('只读') && reactionCalls.length === beforeAgent);
harness.state.credential = { role: 'human', expiresAt: null };
reactionTransport = () => new Promise(resolve => { finishReaction = resolve; });
const logoutReaction = harness.reactNote(sample.id, 'like');
harness.clearSession();
node('main').innerHTML = 'signed out view';
finishReaction(reactionResponse(true, { postId: sample.id, likes: 100, saves: 100, viewer: { liked: false, saved: false } }));
await logoutReaction;
check('mobile logout prevents an in-flight reaction from restoring private state', harness.state.notes.length === 0 && harness.state.extra.length === 0 && harness.state.credential === null && node('main').innerHTML === 'signed out view');
harness.rememberToken('xlb_second_synthetic_mobile_fixture');
harness.state.credential = { role: 'human', expiresAt: null };
harness.state.notes = [{ ...reactionNote }];
harness.state.open = sample.id;
harness.render();
node('r-' + sample.id).value = 'Held synthetic reply';
node('r-' + sample.id).oninput?.();
let finishReply = () => { throw new Error('missing held reply'); };
replyTransport = () => new Promise(resolve => { finishReply = resolve; });
const heldReply = harness.sendReply(sample.id);
reactionTransport = async () => reactionResponse(true, { postId: sample.id, likes: 6, saves: 2, viewer: { liked: true, saved: false } });
await harness.reactNote(sample.id, 'like');
const rebuiltReplyButton = node('reply-send-' + sample.id);
check('mobile reply stays busy through a successful reaction redraw', rebuiltReplyButton.disabled && harness.renderNote(harness.state.notes[0], true).includes('data-reply="synthetic-note" disabled'));
harness.state.open = null;
harness.render();
harness.state.open = sample.id;
harness.render();
check('mobile leaving and returning cannot reset an in-flight reply lock', node('reply-send-' + sample.id).disabled && node('r-' + sample.id).value === 'Held synthetic reply');
rebuiltReplyButton.onclick?.();
check('mobile a rebuilt reply handler cannot duplicate the held request', replyCalls.length === 1);
finishReply(reactionResponse(false, { error: 'Synthetic reply failure' }, 500));
await heldReply;
check('mobile failed reply unlocks current controls without losing the draft', !node('reply-send-' + sample.id).disabled && node('r-' + sample.id).value === 'Held synthetic reply');
replyTransport = async () => reactionResponse(true, {});
await harness.sendReply(sample.id);
check('mobile reply retry submits once and clears only its confirmed draft', replyCalls.length === 2 && JSON.stringify(replyCalls.at(-1)?.body) === JSON.stringify({ postId: sample.id, text: 'Held synthetic reply' }) && node('r-' + sample.id).value === '');
node('r-' + sample.id).value = 'ABA original';
node('r-' + sample.id).oninput?.();
replyTransport = () => new Promise(resolve => { finishReply = resolve; });
const abaReply = harness.sendReply(sample.id);
node('r-' + sample.id).value = 'Changed while sending';
node('r-' + sample.id).oninput?.();
node('r-' + sample.id).value = 'ABA original';
node('r-' + sample.id).oninput?.();
finishReply(reactionResponse(true, {}));
await abaReply;
check('mobile successful reply does not clear a later draft revision with the same text', node('r-' + sample.id).value === 'ABA original');
const secondNote = { ...sample, id: 'second-synthetic-note', title: 'Second synthetic note' };
harness.state.notes.push(secondNote);
reactionTransport = () => new Promise(resolve => { finishReaction = resolve; });
const crossNoteReaction = harness.reactNote(sample.id, 'like');
harness.state.open = secondNote.id;
harness.render();
node('r-' + secondNote.id).value = 'Different note unsent draft';
node('r-' + secondNote.id).oninput?.();
finishReaction(reactionResponse(true, { postId: sample.id, likes: 5, saves: 2, viewer: { liked: false, saved: false } }));
await crossNoteReaction;
check('mobile reaction on one post preserves a different open post draft', harness.state.open === secondNote.id && node('r-' + secondNote.id).value === 'Different note unsent draft');
harness.state.open = sample.id;
harness.render();
check('mobile returning to a post restores its separate reply draft', node('r-' + sample.id).value === 'ABA original');
const replyBeforeLogout = harness.sendReply(sample.id);
harness.clearSession();
node('main').innerHTML = 'signed out after reply';
finishReply(reactionResponse(true, {}));
await replyBeforeLogout;
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
