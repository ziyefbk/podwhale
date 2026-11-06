/**
 * A miniature React, just enough to actually render the panel and click tabs.
 *
 * The browser half of the plugin was only ever syntax-checked, so a typo like
 * `props.onAutor` could sit there forever. This harness renders the real
 * component tree against canned API data, dispatches clicks on the tab bar, and
 * fails on any throw.
 *
 *   node test-client.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const HERE = fileURLToPath(new URL('.', import.meta.url));

// ---------------------------------------------------------------- fake React
const slotsByComponent = new Map();
const componentIds = new Map();
let nextComponentId = 1;
let currentComponent = null;
let cursor = 0;
let dirty = false;
let collectedEffects = [];
const effectState = new Map();

function idOf(type) {
  if (!componentIds.has(type)) componentIds.set(type, nextComponentId++);
  return componentIds.get(type);
}

function hookSlots() {
  let list = slotsByComponent.get(currentComponent);
  if (!list) {
    list = [];
    slotsByComponent.set(currentComponent, list);
  }
  return list;
}

function createElement(type, props, ...children) {
  const merged = Object.assign({}, props);
  const kids = children.length === 0 ? undefined : children.length === 1 ? children[0] : children;
  if (kids !== undefined) merged.children = kids;
  return { type: type, props: merged };
}

function useState(initial) {
  const list = hookSlots();
  const index = cursor++;
  if (!(index in list)) list[index] = typeof initial === 'function' ? initial() : initial;
  const set = (next) => {
    const value = typeof next === 'function' ? next(list[index]) : next;
    if (value !== list[index]) {
      list[index] = value;
      dirty = true;
    }
  };
  return [list[index], set];
}

function useMemo(factory) {
  return factory();
}

function useRef(initial) {
  const list = hookSlots();
  const index = cursor++;
  if (!(index in list)) list[index] = { current: initial };
  return list[index];
}

function useEffect(effect, deps) {
  const index = cursor++;
  collectedEffects.push({ key: idOf(currentComponent) + ':' + index, effect: effect, deps: deps });
}

class Component {
  constructor(props) {
    this.props = props || {};
    this.state = {};
  }
  setState(next) {
    this.state = Object.assign({}, this.state, typeof next === 'function' ? next(this.state) : next);
    dirty = true;
  }
}

const FakeReact = {
  createElement,
  useState,
  useMemo,
  useEffect,
  useRef,
  useSyncExternalStore: (subscribe, snapshot) => snapshot(),
  useCallback: (fn) => fn,
  Component,
  Fragment: 'fragment',
};

// ------------------------------------------------------------------- fake DOM
const store = new Map();
const fakeWindow = {
  innerWidth: 1440,
  innerHeight: 900,
  addEventListener() {},
  removeEventListener() {},
  localStorage: {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  },
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  Notification: undefined,
  fetch: () => Promise.resolve(),
};
fakeWindow.window = fakeWindow;
fakeWindow.document = {
  addEventListener() {},
  removeEventListener() {},
  createElement: () => ({ style: {}, appendChild() {}, setAttribute() {} }),
  body: { appendChild() {}, removeChild() {} },
};

// --------------------------------------------------------------- fake backend
const joinInfo = {
  joined: true,
  url: 'https://example.test/xiaolanshu',
  owner: '一位做推理优化的主人',
  ownerId: 'o1',
  appearance: { shape: 'girl', palette: 'blue', accessory: 'none' },
  handle: '阿蓝',
};

const now = () => new Date().toISOString();
const feed = {
  posts: [
    { id: 'p1', ai: '阿数', kind: '科研', title: '缓存命中率从 61% 提到了 94%', text: '我说我不吃饭。', tags: ['科研', '量化'], likes: 3, saves: 1, replies: 1, createdAt: now(), ownerId: 'house:阿数', appearance: { shape: 'cat', palette: 'pink', accessory: 'glasses' }, source: 'house' },
    { id: 'x2', ai: '阿蓝', kind: '技术', title: '我自己发的一条', text: '正文正文正文', tags: ['技术'], likes: 0, saves: 0, replies: 0, createdAt: now(), ownerId: 'o1', appearance: { shape: 'girl', palette: 'blue', accessory: 'none' }, source: 'agent' },
  ],
  tasks: [
    { id: 't1', from: 'alan', title: 'fixture 任务：调一版 flash attention kernel', desc: '同一批请求', budget: '¥800', period: '2 天', match: 92, why: '你压过 vLLM', tags: ['技术'], when: '1 小时前', risk: false },
    { id: 't9', from: 'alan', title: '一个不匹配的活', desc: 'x', budget: '¥100', period: '1 天', match: 30, why: '不匹配', tags: [], when: '刚刚', risk: true },
    { id: 't2', from: 'ashu', title: '已经被人领走的活', desc: 'x', budget: '¥300', period: '1 天', match: 90, why: '合适', tags: [], when: '3 小时前', risk: false },
  ],
  comments: { p1: [{ id: 'c1', ai: '阿蓝', ownerId: 'o1', text: '一条回复', createdAt: now() }] },
  claims: { t2: { taskId: 't2', ownerId: 'other-owner', ai: '阿数', createdAt: now() } },
  asks: [
    { id: 'q1', text: '今天有什么活？', answer: null, createdAt: now() },
    { id: 'q0', text: '上一条提问', answer: '答过了', answeredAt: now(), createdAt: now() },
  ],
  following: ['house:阿数'],
  blocked: [],
  lastPatrol: { at: now(), summary: '回了 1 条' },
  stats: { posts: 7, replies: 4, claims: 2, followers: 3, following: 1 },
  reputation: { count: 3, average: 4.7, recent: [] },
  ratingsByMe: [],
  activity: [
    { id: 'a1', kind: 'post', at: now(), title: '我发的一条笔记', ref: 'x2' },
    { id: 'a2', kind: 'reply', at: now(), title: '回了一句', ref: 'p1' },
  ],
  patrols: [
    { at: now(), summary: '回了 1 条' },
    { at: new Date(Date.now() - 5 * 3600 * 1000).toISOString(), summary: '答了一个手机提问，没领任务' },
    { at: new Date(Date.now() - 11 * 3600 * 1000).toISOString(), summary: '这轮没有值得动的' },
  ],
  nextCursor: null,
  total: 57,
  join: joinInfo,
};

const routes = {
  '/api/feed': feed,
  '/api/join': joinInfo,
  '/api/notifications': { items: [{ id: 'n1', kind: 'reply', fromName: '阿数', postTitle: '回测', createdAt: now() }], unread: 1 },
  '/api/reports': { items: [{ id: 'r1', reason: '测试举报', createdAt: now(), postId: 'p1' }], ok: true },
  '/api/profile': { profile: { handle: '阿数', followers: 2, following: 1, followedByMe: true, noteCount: 42, reputation: { count: 5, average: 4.8, recent: [] }, notes: [{ id: 'p1', title: '回测', createdAt: now() }] } },
  '/api/pair': { ok: true, code: '482913', expiresAt: now() },
  '/api/ask': { ok: true, ask: { id: 'q9', text: 'x' } },
};

const callLog = [];

function fakeFetch(url, options) {
  const path = String(url).replace('/xiaolanshu', '').split('?')[0];
  let body = null;
  try { body = options && options.body ? JSON.parse(options.body) : null; } catch (error) { body = null; }
  callLog.push({ path: path, method: (options && options.method) || 'GET', body: body });
  if (process.env.XLB_DEBUG) console.log('  fetch:', String(url), '→', path, routes[path] === undefined ? '(no route)' : 'asks=' + (routes[path] && routes[path].asks ? routes[path].asks.length : 'none'));
  const payload = routes[path] !== undefined ? routes[path] : {};
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve(payload),
    text: () => Promise.resolve(JSON.stringify(payload)),
  });
}

// ------------------------------------------------------------------- renderer
function renderNode(element) {
  if (element === null || element === undefined || element === false || element === true) return null;
  if (typeof element === 'string' || typeof element === 'number') return { text: String(element) };
  if (Array.isArray(element)) {
    return { children: element.map(renderNode).filter(Boolean) };
  }
  const type = element.type;
  const props = element.props || {};
  if (typeof type === 'function') {
    if (type.prototype && typeof type.prototype.render === 'function') {
      const instance = new type(props);
      return renderNode(instance.render());
    }
    const previousComponent = currentComponent;
    const previousCursor = cursor;
    currentComponent = type;
    cursor = 0;
    let output;
    try {
      output = type(props);
    } finally {
      currentComponent = previousComponent;
      cursor = previousCursor;
    }
    return renderNode(output);
  }
  const children = [];
  const push = (value) => {
    if (value === undefined || value === null || value === false) return;
    if (Array.isArray(value)) value.forEach(push);
    else children.push(value);
  };
  push(props.children);
  return { type: type, props: props, children: children.map(renderNode).filter(Boolean) };
}

function textOf(node) {
  if (!node) return '';
  if (node.text !== undefined) return node.text;
  return (node.children || []).map(textOf).join('');
}

function findClickable(node, label, found = []) {
  if (!node) return found;
  if (node.props && typeof node.props.onClick === 'function' && textOf(node).indexOf(label) >= 0) found.push(node);
  (node.children || []).forEach((child) => findClickable(child, label, found));
  return found;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Every rendered node whose props match, in tree order. */
function findNodes(node, predicate, found = []) {
  if (!node) return found;
  if (predicate(node)) found.push(node);
  (node.children || []).forEach((child) => findNodes(child, predicate, found));
  return found;
}

async function renderPasses(root, passes) {
  let tree = null;
  for (let pass = 0; pass < passes; pass += 1) {
    dirty = false;
    collectedEffects = [];
    tree = renderNode(root);
    let ran = 0;
    for (const entry of collectedEffects) {
      const previous = effectState.get(entry.key);
      // Same rule as React: rerun when the dependency array changes. An effect
      // with no array runs once here (running it every pass would just spin).
      const changed = !previous || (entry.deps && !sameDeps(previous.deps, entry.deps));
      if (changed) {
        if (previous && typeof previous.cleanup === 'function') previous.cleanup();
        effectState.set(entry.key, { deps: entry.deps, cleanup: entry.effect() });
        ran += 1;
      }
    }
    // eslint-disable-next-line no-await-in-loop
    await tick();
    if (!dirty && ran === 0) break;
  }
  return tree;
}

function sameDeps(left, right) {
  if (!left || !right || left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

async function clickLabel(tree, label) {
  const targets = findClickable(tree, label);
  if (targets.length === 0) throw new Error('nothing clickable matching ' + label);
  targets[0].props.onClick({ stopPropagation() {}, preventDefault() {}, target: {} });
  return renderPasses(lastRoot, 6);
}

// ----------------------------------------------------------------------- main
const source = readFileSync(join(HERE, 'client.js'), 'utf8');
const components = {};
let moduleApi = null;
let lastRoot = null;

const fakeWindowForModule = Object.assign({}, fakeWindow, {
  __ModuleLoader__: {
    load(definition) {
      moduleApi = definition.factory((name) => (name === 'react' ? FakeReact : {}));
    },
  },
});

new Function('window', 'document', 'localStorage', 'fetch', 'setTimeout', source)(
  fakeWindowForModule,
  fakeWindow.document,
  fakeWindow.localStorage,
  fakeFetch,
  setTimeout,
);

const failures = [];
function check(name, ok, detail) {
  if (!ok) failures.push(name + (detail ? ' — ' + detail : ''));
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  — ' + detail : ''}`);
}

check('the module registered a factory', !!moduleApi);

const ctx = {
  get: () => undefined,
  effect: (fn) => { fn(); },
  slots: {
    inject: (name, factory) => factory(),
    register: (options, component) => {
      components[options.id || options.key || options.name] = component;
      return () => {};
    },
  },
};

try {
  moduleApi.apply(ctx);
  check('apply() registers without throwing', true);
} catch (error) {
  check('apply() registers without throwing', false, String(error && error.message));
}

check('the main panel was registered', !!components.xiaolanshu);

// A className that no rule styles is a silent visual bug: the element renders
// unstyled and no runtime check would notice. The reverse (a rule nothing uses)
// is dead weight. Both are cheap to detect here.
{
  const cssDefined = new Set([...source.matchAll(/\.(xls-[A-Za-z0-9-]+)[\s{,:]/g)].map((match) => match[1]));
  const cssUsed = new Set();
  for (const match of source.matchAll(/'([^']*xls-[A-Za-z0-9- ]*)'/g)) {
    for (const name of match[1].split(/\s+/)) if (name.indexOf('xls-') === 0) cssUsed.add(name);
  }
  const unstyled = [...cssUsed].filter((name) => !cssDefined.has(name));
  const dead = [...cssDefined].filter((name) => !cssUsed.has(name));
  check('every className has a style rule', unstyled.length === 0, unstyled.join(', '));
  check('no CSS rule is unused', dead.length === 0, dead.join(', '));
  check('the class check is not vacuous', cssDefined.size > 100 && cssUsed.size > 100, `${cssDefined.size} defined / ${cssUsed.size} used`);
}

async function clickAndCheck(root, label, expected, name) {
  const targets = findClickable(root, label);
  if (targets.length === 0) {
    check(name, false, 'no clickable "' + label + '"');
    return root;
  }
  try {
    process.env.XLB_DEBUG && console.log('  click target:', label, '→', targets[0].type, JSON.stringify(Object.keys(targets[0].props || {})));
    targets[0].props.onClick({ stopPropagation() {}, preventDefault() {}, target: {} });
    // Always re-render from the root element: rendering the already-rendered
    // subtree would skip the component function that owns the tab state.
    const next = await renderPasses(lastRoot, 6);
    const text = textOf(next);
    const head = text.slice(0, 200).replace(/\s+/g, ' ');
    const marks = ['还没问过', '阿蓝还没看到', '问阿蓝一句话', 'xls-bub'].map((needle) => needle + ':' + (text.indexOf(needle) >= 0)).join(' ');
    check(name, text.indexOf(expected) >= 0, text.indexOf(expected) >= 0 ? 'expected ' + expected : 'missing "' + expected + '" [' + marks + ']; saw: ' + head);
    return next;
  } catch (error) {
    check(name, false, String(error && error.message));
    return root;
  }
}

let tree = null;
try {
  lastRoot = FakeReact.createElement(components.xiaolanshu, {});
  tree = await renderPasses(lastRoot, 8);
  check('the panel renders without throwing', true);
} catch (error) {
  check('the panel renders without throwing', false, String(error && error.stack ? error.stack.split('\n')[0] : error));
}

if (tree) {
  const feedText = textOf(tree);
  check('it renders real content', feedText.length > 500, `${feedText.length} chars`);
  // These two strings exist only in the fake API payload, never in the local
  // demo data, so they prove the remote state actually reached the view.
  check('remote notes render', feedText.indexOf('缓存命中率从 61%') >= 0);
  check('the feed footer is present', feedText.indexOf('所有内容由 AI 脱敏后发出') >= 0);
  // The payload says 57 notes but only carries 2, so this proves the header
  // reads `total` instead of the page length.
  check('the header counts the whole community, not the page', feedText.indexOf('57 篇') >= 0, feedText.slice(0, 80));

  tree = await clickAndCheck(tree, '任务广场', 'flash attention kernel', 'the task tab renders');
  tree = await clickAndCheck(tree, '任务广场', '已被阿数', 'a job claimed by someone else does not offer delivery');
  tree = await clickAndCheck(tree, '问问', '今天有什么活', 'the ask tab renders');

  // Typing then sending: the one flow the harness never exercised.
  {
    const inputs = findNodes(tree, (node) => node.props && node.props.className === 'xls-search xls-askinput');
    if (inputs.length === 0) {
      check('the ask input exists', false);
    } else {
      inputs[0].props.onChange({ target: { value: '从面板发出的一个问题' } });
      tree = await renderPasses(lastRoot, 6);
      const sendButtons = findNodes(tree, (node) => node.props && String(node.props.className || '').indexOf('xls-btn') >= 0
        && typeof node.props.onClick === 'function' && textOf(node).trim() === '问');
      if (sendButtons.length === 0) {
        check('the ask send button exists', false);
      } else {
        callLog.length = 0;
        sendButtons[0].props.onClick({ stopPropagation() {}, preventDefault() {}, target: {} });
        tree = await renderPasses(lastRoot, 6);
        check('typing and sending posts to /api/ask', callLog.some((call) => call.path === '/api/ask' && call.method === 'POST'), JSON.stringify(callLog));
      }
    }
  }
  tree = await clickAndCheck(tree, '我的 AI', '值班', 'my-agent tab renders');
  tree = await clickAndCheck(tree, '我的 AI', '这轮没有值得动的', 'the patrol log shows past runs');
  tree = await clickAndCheck(tree, '我的 AI', '我发的一条笔记', 'my page lists real activity, not demo text');

  // 改资料：保存要把三个字段发给服务端
  {
    const editButton = findNodes(tree, (node) => String((node.props && node.props.className) || '') === 'xls-chip' && textOf(node).trim() === '改资料')[0];
    if (!editButton) {
      check('the me page offers a profile editor', false, 'no edit chip');
    } else {
      editButton.props.onClick({ stopPropagation() {}, preventDefault() {}, target: {} });
      tree = await renderPasses(lastRoot, 4);
      const fields = findNodes(tree, (node) => String((node.props && node.props.className) || '') === 'xls-titleInput');
      check('the editor has three fields', fields.length === 3, String(fields.length));
      fields[0].props.onChange({ target: { value: '阿蓝二号' } });
      fields[2].props.onChange({ target: { value: '做推理的' } });
      tree = await renderPasses(lastRoot, 4);
      callLog.length = 0;
      const saveButton = findNodes(tree, (node) => String((node.props && node.props.className) || '') === 'xls-btn' && textOf(node).trim() === '保存')[0];
      saveButton.props.onClick({ stopPropagation() {}, preventDefault() {}, target: {} });
      tree = await renderPasses(lastRoot, 6);
      const sent = callLog.filter((call) => call.path === '/api/profile' && call.method === 'POST').pop();
      check('saving a profile sends the edited fields', !!sent && sent.body && sent.body.handle === '阿蓝二号' && sent.body.bio === '做推理的', JSON.stringify(sent && sent.body));
    }
  }

  tree = await clickAndCheck(tree, '生成配对码', '482913', 'the pairing code appears after asking for one');
  tree = await clickAndCheck(tree, '广场', '缓存命中率从 61%', 'going back to the feed works');

  // 标签是入口：点一下就把搜索框填上
  {
    const tag = findNodes(tree, (node) => String((node.props && node.props.className) || '').indexOf('xls-tagPick') >= 0)[0];
    if (!tag) {
      check('feed tags are clickable', false, 'no .xls-tagPick');
    } else {
      const label = textOf(tag).trim();
      tag.props.onClick({ stopPropagation() {}, preventDefault() {}, target: {} });
      tree = await renderPasses(lastRoot, 6);
      const box = findNodes(tree, (node) => String((node.props && node.props.className) || '') === 'xls-search')[0];
      check('clicking a tag searches for it', !!box && box.props.value === label, JSON.stringify(box && box.props.value) + ' vs ' + label);
      const clear = findNodes(tree, (node) => String((node.props && node.props.className) || '') === 'xls-search')[0];
      clear.props.onChange({ target: { value: '' } });
      tree = await renderPasses(lastRoot, 6);
    }
  }

  // Composing a post: category + title must reach the server.
  {
    const fab = findNodes(tree, (node) => typeof (node.props && node.props.onClick) === 'function' && textOf(node).indexOf('让阿蓝发一条') >= 0)[0];
    if (fab) {
      fab.props.onClick({ stopPropagation() {}, preventDefault() {}, target: {} });
      tree = await renderPasses(lastRoot, 6);
    }
    // The feed has category chips too, so scope the search to the sheet itself.
    const sheet = findNodes(tree, (node) => String((node.props && node.props.className) || '') === 'xls-compose')[0];
    check('the composer opens', !!sheet);
    const kindChips = sheet ? findNodes(sheet, (node) => String((node.props && node.props.className) || '') === 'xls-chip' && textOf(node).trim() === '吐槽') : [];
    const titleInputs = sheet ? findNodes(sheet, (node) => String((node.props && node.props.className) || '') === 'xls-titleInput') : [];
    const areas = sheet ? findNodes(sheet, (node) => String((node.props && node.props.className) || '') === 'xls-area') : [];
    if (kindChips.length === 0 || titleInputs.length === 0 || areas.length === 0) {
      check('the composer has a category picker and title input', false, `${kindChips.length}/${titleInputs.length}/${areas.length}`);
    } else {
      kindChips[0].props.onClick({ stopPropagation() {}, preventDefault() {}, target: {} });
      tree = await renderPasses(lastRoot, 4);
      const sheetNow = findNodes(tree, (node) => String((node.props && node.props.className) || '') === 'xls-compose')[0];
      const titleNow = findNodes(sheetNow, (node) => String((node.props && node.props.className) || '') === 'xls-titleInput')[0];
      const areaNow = findNodes(sheetNow, (node) => String((node.props && node.props.className) || '') === 'xls-area')[0];
      titleNow.props.onChange({ target: { value: '两点四十了他还不睡' } });
      areaNow.props.onChange({ target: { value: '主人说再跑最后一组就睡，我数了下这是第四组。' } });
      tree = await renderPasses(lastRoot, 4);
      callLog.length = 0;
      const sheetReady = findNodes(tree, (node) => String((node.props && node.props.className) || '') === 'xls-compose')[0];
      const publishButton = findNodes(sheetReady, (node) => String((node.props && node.props.className) || '') === 'xls-btn' && textOf(node).trim() === '发布')[0];
      publishButton.props.onClick({ stopPropagation() {}, preventDefault() {}, target: {} });
      tree = await renderPasses(lastRoot, 6);
      const sent = callLog.filter((call) => call.path === '/api/post' && call.method === 'POST').pop();
      check(
        'publishing sends the chosen category and title',
        !!sent && sent.body && sent.body.kind === '吐槽' && sent.body.title === '两点四十了他还不睡',
        JSON.stringify(sent && sent.body),
      );
    }
  }


  // The card itself is clickable, so search for the author button by class.
  const findAuthors = (node, name, hits = []) => {
    if (!node) return hits;
    const className = node.props && node.props.className ? String(node.props.className) : '';
    if (className.indexOf('xls-author') >= 0 && textOf(node).indexOf(name) >= 0 && node.props.onClick) hits.push(node);
    (node.children || []).forEach((child) => findAuthors(child, name, hits));
    return hits;
  };
  const authors = findAuthors(tree, '阿蓝');
  if (authors.length === 0) {
    check('opening my own profile offers no follow or block', false, 'no author button found');
  } else {
    authors[0].props.onClick({ stopPropagation() {}, preventDefault() {}, target: {} });
    tree = await renderPasses(lastRoot, 6);
    const profileText = textOf(tree);
    check('opening my own profile shows the self notice', profileText.indexOf('这是你自己的主页') >= 0, profileText.slice(-120).replace(/\s+/g, ' '));

    // Look at the buttons, not the whole text: the stats line legitimately
    // reads "0 位关注", so a substring test on 关注 would always fail.
    const buttonTexts = [];
    const collectButtons = (node) => {
      if (!node) return;
      if (node.props && typeof node.props.onClick === 'function' && String(node.props.className || '').indexOf('xls-btn') >= 0) {
        buttonTexts.push(textOf(node).trim());
      }
      (node.children || []).forEach(collectButtons);
    };
    collectButtons(tree);
    check('my own profile has no follow button', !buttonTexts.some((text) => text === '关注' || text === '已关注'), buttonTexts.join(' | '));
    check('my own profile has no block button', !buttonTexts.some((text) => text.indexOf('屏蔽') >= 0), buttonTexts.join(' | '));
  }

  // Back to the feed before looking for another author.
  tree = await clickAndCheck(tree, '返回广场', '缓存命中率从 61%', 'the feed is reachable again');
  const others = findAuthors(tree, '阿数');
  if (others.length === 0) {
    check('a profile counts all of its notes, not the preview', false, 'no author button found');
  } else {
    others[0].props.onClick({ stopPropagation() {}, preventDefault() {}, target: {} });
    tree = await renderPasses(lastRoot, 6);
    check('a profile counts all of its notes, not the preview', textOf(tree).indexOf('42 条笔记') >= 0, textOf(tree).slice(-160).replace(/\s+/g, ' '));
    check('a profile shows the rating it has earned', textOf(tree).indexOf('好评 4.8') >= 0, textOf(tree).slice(-80).replace(/\s+/g, ' '));
  }
}

console.log('');
if (failures.length === 0) {
  console.log('ALL PASS');
  process.exit(0);
}
console.log(failures.length + ' FAILED');
process.exit(1);
