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

type TestValue = TestElement | TestValue[] | string | number | boolean | null | undefined;
interface TestClick { stopPropagation(): void; preventDefault(): void; target: object }
interface TestChange { target: { value: string } }
interface TestPetTarget {
  getBoundingClientRect(): { left: number; top: number; width: number; height: number };
  setPointerCapture(id: number): void; hasPointerCapture(id: number): boolean; releasePointerCapture(id: number): void;
}
interface TestPetPointer { button: number; pointerId: number; clientX: number; clientY: number; currentTarget: TestPetTarget; preventDefault(): void }
interface TestPetKey { key: string; repeat: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean; currentTarget: TestPetTarget; preventDefault(): void }
interface TestProps {
  [name: string]: unknown;
  children?: TestValue; className?: string; value?: string;
  onClick?: (event: TestClick) => unknown;
  onChange?: (event: TestChange) => unknown;
  onPointerDown?: (event: TestPetPointer) => void; onPointerMove?: (event: TestPetPointer) => void;
  onPointerUp?: (event: TestPetPointer) => void; onPointerCancel?: (event: TestPetPointer) => void;
  onLostPointerCapture?: (event: TestPetPointer) => void;
  onPointerEnter?: () => void; onPointerLeave?: () => void; onFocus?: () => void; onBlur?: () => void;
  onKeyDown?: (event: TestPetKey) => void; onError?: () => void;
}
type TestComponent = (props: TestProps) => TestValue;
interface TestInstance { render(): TestValue }
type TestConstructor = new (props: TestProps) => TestInstance;
type TestType = string | TestComponent | TestConstructor;
interface TestElement { type: TestType; props: TestProps }
interface RenderedNode { text?: string; type?: string; props: TestProps; children: RenderedNode[] }
interface TestEffect { key: string; effect: () => void | (() => void); deps: readonly unknown[] | undefined }
interface EffectState { deps: readonly unknown[] | undefined; cleanup: void | (() => void) }
interface TestDocument {
  hidden: boolean; addEventListener(name: string, listener: () => void): void; removeEventListener(name: string, listener: () => void): void;
  createElement(): { style: object; appendChild(): void; setAttribute(): void };
  body: { appendChild(): void; removeChild(): void };
}
interface TestWindow {
  innerWidth: number; innerHeight: number; addEventListener(name: string, listener: () => void): void; removeEventListener(name: string, listener: () => void): void;
  localStorage: { getItem(key: string): string | null; setItem(key: string, value: unknown): void; removeItem(key: string): void };
  matchMedia(): { matches: boolean; addEventListener(name: string, listener: () => void): void; removeEventListener(name: string, listener: () => void): void };
  Image: new () => TestImage;
  setTimeout(callback: () => void, delay: number): number; clearTimeout(id: number): void;
  setInterval(callback: () => void, delay: number): number; clearInterval(id: number): void;
  Notification: undefined; fetch(): Promise<void>; window?: TestWindow; document?: TestDocument;
}
interface TestModule { apply(context: TestContext): void }
interface TestContext { get(name?: string): { selectPanel(id: string): void } | undefined; effect(effect: () => unknown): void; slots: { inject(name: string, factory: () => unknown): unknown;
  register(entry: { name: string; key?: string; id?: string }, component: TestComponent): () => void } }

// ---------------------------------------------------------------- fake React
const slotsByComponent = new Map<TestType | null, unknown[]>();
const componentIds = new Map<TestType | null, number>();
let nextComponentId = 1;
let currentComponent: TestType | null = null;
let cursor = 0;
let dirty = false;
let collectedEffects: TestEffect[] = [];
const effectState = new Map<string, EffectState>();

function idOf(type: TestType | null) {
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

function createElement(type: TestType, props: TestProps | null, ...children: TestValue[]): TestElement {
  const merged = Object.assign({}, props);
  const kids = children.length === 0 ? undefined : children.length === 1 ? children[0] : children;
  if (kids !== undefined) merged.children = kids;
  return { type: type, props: merged };
}

function useState<T>(initial: T | (() => T)): [T, (next: T | ((previous: T) => T)) => void] {
  const list = hookSlots();
  const index = cursor++;
  if (!(index in list)) list[index] = typeof initial === 'function' ? (initial as () => T)() : initial;
  const set = (next: T | ((previous: T) => T)) => {
    const value = typeof next === 'function' ? (next as (previous: T) => T)(list[index] as T) : next;
    if (value !== list[index]) {
      list[index] = value;
      dirty = true;
    }
  };
  return [list[index] as T, set];
}

function useMemo<T>(factory: () => T) {
  return factory();
}

function useRef<T>(initial: T): { current: T } {
  const list = hookSlots();
  const index = cursor++;
  if (!(index in list)) list[index] = { current: initial };
  return list[index] as { current: T };
}

function useEffect(effect: () => void | (() => void), deps?: readonly unknown[]) {
  const index = cursor++;
  collectedEffects.push({ key: idOf(currentComponent) + ':' + index, effect: effect, deps: deps });
}

class Component {
  props: TestProps;
  state: object;
  constructor(props: TestProps) {
    this.props = props || {};
    this.state = {};
  }
  setState(next: object | ((state: object) => object)) {
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
  useSyncExternalStore: <T,>(_subscribe: (callback: () => void) => () => void, snapshot: () => T): T => snapshot(),
  useCallback: <T,>(fn: T): T => fn,
  Component,
  Fragment: 'fragment',
};

// ------------------------------------------------------------------- fake DOM
const store = new Map<string, string>();
const windowListeners = new Map<string, Set<() => void>>();
const documentListeners = new Map<string, Set<() => void>>();
const motionListeners = new Set<() => void>();
const addListener = (map: Map<string, Set<() => void>>, name: string, listener: () => void) => {
  if (!map.has(name)) map.set(name, new Set());
  map.get(name)!.add(listener);
};
const motion = { matches: false, addEventListener: (_name: string, fn: () => void) => { motionListeners.add(fn); },
  removeEventListener: (_name: string, fn: () => void) => { motionListeners.delete(fn); } };
let petClock = 1800000000000;
let nextTimer = 1;
const petTimers = new Map<number, { callback: () => void; due: number; interval: number | null }>();
function petTimer(callback: () => void, delay: number, interval: number | null) {
  const id = nextTimer++;
  petTimers.set(id, { callback, due: petClock + delay, interval });
  return id;
}
let imageMode: 'good' | 'missing' | 'invalid' = 'good';
const petImages: TestImage[] = [];
class TestImage {
  naturalWidth = 0; naturalHeight = 0;
  onload: (() => void) | null = null; onerror: (() => void) | null = null;
  set src(url: string) {
    petImages.push(this);
    if (url.endsWith('-b.png') && imageMode === 'missing') { this.onerror?.(); return; }
    this.naturalWidth = url.endsWith('-a.png') ? 1254 : imageMode === 'invalid' ? 1700 : 1774;
    this.naturalHeight = url.endsWith('-a.png') ? 1254 : 887;
    this.onload?.();
  }
}
const capturedPointers = new Set<number>();
let petLeft = 1200, petTop = 640;
const petTarget: TestPetTarget = {
  getBoundingClientRect: () => ({ left: petLeft, top: petTop, width: 112, height: 112 }),
  setPointerCapture: (id) => { capturedPointers.add(id); }, hasPointerCapture: (id) => capturedPointers.has(id),
  releasePointerCapture: (id) => { capturedPointers.delete(id); },
};
const fakeWindow: TestWindow = {
  innerWidth: 1440,
  innerHeight: 900,
  addEventListener: (name, fn) => addListener(windowListeners, name, fn),
  removeEventListener: (name, fn) => { windowListeners.get(name)?.delete(fn); },
  localStorage: {
    getItem: (key) => (store.has(key) ? store.get(key)! : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  },
  matchMedia: () => motion,
  Image: TestImage,
  setTimeout: (callback, delay) => petTimer(callback, delay, null), clearTimeout: (id) => { petTimers.delete(id); },
  setInterval: (callback, delay) => petTimer(callback, delay, delay), clearInterval: (id) => { petTimers.delete(id); },
  Notification: undefined,
  fetch: () => Promise.resolve(),
};
fakeWindow.window = fakeWindow;
fakeWindow.document = {
  hidden: false,
  addEventListener: (name, fn) => addListener(documentListeners, name, fn),
  removeEventListener: (name, fn) => { documentListeners.get(name)?.delete(fn); },
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
// Overlapping feed pages must render one card per server identity.
feed.posts.push({ ...feed.posts[0]! });

const routes: Record<string, unknown> = {
  '/api/feed': feed,
  '/api/join': joinInfo,
  '/api/notifications': { items: [{ id: 'n1', kind: 'reply', fromName: '阿数', postTitle: '回测', createdAt: now() }], unread: 1 },
  '/api/reports': { items: [{ id: 'r1', reason: '测试举报', createdAt: now(), postId: 'p1' }], ok: true },
  '/api/profile': { profile: { handle: '阿数', followers: 2, following: 1, followedByMe: true, noteCount: 42, reputation: { count: 5, average: 4.8, recent: [] }, notes: [{ id: 'p1', title: '回测', createdAt: now() }] } },
  '/api/pair': { ok: true, code: '482913', expiresAt: now() },
  '/api/ask': { ok: true, ask: { id: 'q9', text: 'x' } },
};

const callLog: { path: string; method: string; body: Record<string, unknown> | null }[] = [];

function fakeFetch(url: string, options?: { method?: string; body?: string }) {
  const path = String(url).replace('/xiaolanshu', '').split('?')[0]!;
  let body: Record<string, unknown> | null = null;
  try { body = options && options.body ? JSON.parse(options.body) as Record<string, unknown> : null; } catch (caught) { const error = caught as Error & { code?: string; status?: number; phase?: string; stopped?: boolean; detail?: string; }; body = null; }
  callLog.push({ path: path, method: (options && options.method) || 'GET', body: body });
  if (process.env.XLB_DEBUG) console.log('  fetch:', String(url), '→', path, routes[path] === undefined ? '(no route)' : 'asks=' + (typeof routes[path] === 'object' && routes[path] !== null && 'asks' in routes[path] && Array.isArray(routes[path].asks) ? routes[path].asks.length : 'none'));
  const payload = routes[path] !== undefined ? routes[path] : {};
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve(payload),
    text: () => Promise.resolve(JSON.stringify(payload)),
  });
}

// ------------------------------------------------------------------- renderer
function renderNode(element: TestValue): RenderedNode | null {
  if (element === null || element === undefined || element === false || element === true) return null;
  if (typeof element === 'string' || typeof element === 'number') return { text: String(element), props: {}, children: [] };
  if (Array.isArray(element)) {
    return { props: {}, children: element.map(renderNode).filter((child): child is RenderedNode => child !== null) };
  }
  const type = element.type;
  const props = element.props || {};
  if (typeof type === 'function') {
    if (type.prototype && typeof type.prototype.render === 'function') {
      const instance = new (type as TestConstructor)(props);
      return renderNode(instance.render());
    }
    const previousComponent = currentComponent;
    const previousCursor = cursor;
    currentComponent = type;
    cursor = 0;
    let output;
    try {
      output = (type as TestComponent)(props);
    } finally {
      currentComponent = previousComponent;
      cursor = previousCursor;
    }
    return renderNode(output);
  }
  const children: TestValue[] = [];
  if (typeof props.className === 'string' && props.className.split(' ').includes('xls-pet')) {
    if (typeof props.ref === 'object' && props.ref !== null && 'current' in props.ref) props.ref.current = petTarget;
    if (typeof props.style === 'object' && props.style !== null) {
      if ('left' in props.style && typeof props.style.left === 'string') petLeft = parseFloat(props.style.left);
      if ('top' in props.style && typeof props.style.top === 'string') petTop = parseFloat(props.style.top);
    }
  }
  const push = (value: TestValue) => {
    if (value === undefined || value === null || value === false) return;
    if (Array.isArray(value)) value.forEach(push);
    else children.push(value);
  };
  push(props.children);
  return { type: type, props: props, children: children.map(renderNode).filter((child): child is RenderedNode => child !== null) };
}

function textOf(node: RenderedNode | null): string {
  if (!node) return '';
  if (node.text !== undefined) return node.text;
  return (node.children || []).map(textOf).join('');
}

function findClickable(node: RenderedNode | null, label: string, found: RenderedNode[] = []): RenderedNode[] {
  if (!node) return found;
  if (node.props && typeof node.props.onClick === 'function' && textOf(node).indexOf(label) >= 0) found.push(node);
  (node.children || []).forEach((child) => findClickable(child, label, found));
  return found;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Every rendered node whose props match, in tree order. */
function findNodes(node: RenderedNode | null | undefined, predicate: (node: RenderedNode) => boolean, found: RenderedNode[] = []): RenderedNode[] {
  if (!node) return found;
  if (predicate(node)) found.push(node);
  (node.children || []).forEach((child) => findNodes(child, predicate, found));
  return found;
}

async function renderPasses(root: TestValue, passes: number): Promise<RenderedNode | null> {
  let tree: RenderedNode | null = null;
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

function sameDeps(left: readonly unknown[] | undefined, right: readonly unknown[] | undefined) {
  if (!left || !right || left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

async function clickLabel(tree: RenderedNode | null, label: string) {
  const targets = findClickable(tree, label);
  if (targets.length === 0) throw new Error('nothing clickable matching ' + label);
  targets[0]!.props.onClick!({ stopPropagation() {}, preventDefault() {}, target: {} });
  return renderPasses(lastRoot, 6);
}

// ----------------------------------------------------------------------- main
const source = readFileSync(join(HERE, 'client.js'), 'utf8');
const components: Record<string, TestComponent> = {};
let moduleApi: TestModule | null = null;
let lastRoot: TestValue = null;

const fakeWindowForModule = Object.assign({}, fakeWindow, {
  __ModuleLoader__: {
    load(definition: { factory(require: (name: string) => typeof FakeReact | object): TestModule }) {
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
function check(name: string, ok: unknown, detail: unknown = "") {
  if (!ok) failures.push(name + (detail ? ' — ' + detail : ''));
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  — ' + detail : ''}`);
}

check('the module registered a factory', !!moduleApi);

const selectedPanels: string[] = [];
const ctx: TestContext = {
  get: (name) => name === 'layout' ? { selectPanel: (id) => { selectedPanels.push(id); } } : undefined,
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
  moduleApi!.apply(ctx);
  check('apply() registers without throwing', true);
} catch (caught) { const error = caught as Error & { code?: string; status?: number; phase?: string; stopped?: boolean; detail?: string; };
  check('apply() registers without throwing', false, String(error && error.message));
}

check('the main panel was registered', !!components.xiaolanshu);

// A className that no rule styles is a silent visual bug: the element renders
// unstyled and no runtime check would notice. The reverse (a rule nothing uses)
// is dead weight. Both are cheap to detect here.
{
  const cssDefined = new Set([...source.matchAll(/\.(xls-[A-Za-z0-9-]+)[\s{,:]/g)].map((match) => match[1]!));
  const cssUsed = new Set<string>();
  for (const match of source.matchAll(/'([^']*xls-[A-Za-z0-9- ]*)'/g)) {
    for (const name of match[1]!.split(/\s+/)) if (name.indexOf('xls-') === 0) cssUsed.add(name);
  }
  const unstyled = [...cssUsed].filter((name) => !cssDefined.has(name));
  const dead = [...cssDefined].filter((name) => !cssUsed.has(name));
  check('every className has a style rule', unstyled.length === 0, unstyled.join(', '));
  check('no CSS rule is unused', dead.length === 0, dead.join(', '));
  check('the class check is not vacuous', cssDefined.size > 100 && cssUsed.size > 100, `${cssDefined.size} defined / ${cssUsed.size} used`);
}

async function clickAndCheck(root: RenderedNode | null, label: string, expected: string, name: string): Promise<RenderedNode | null> {
  const targets = findClickable(root, label);
  if (targets.length === 0) {
    check(name, false, 'no clickable "' + label + '"');
    return root;
  }
  try {
    process.env.XLB_DEBUG && console.log('  click target:', label, '→', targets[0]!.type, JSON.stringify(Object.keys(targets[0]!.props || {})));
    targets[0]!.props.onClick!({ stopPropagation() {}, preventDefault() {}, target: {} });
    // Always re-render from the root element: rendering the already-rendered
    // subtree would skip the component function that owns the tab state.
    const next = await renderPasses(lastRoot, 6);
    const text = textOf(next);
    const head = text.slice(0, 200).replace(/\s+/g, ' ');
    const marks = ['还没问过', '阿蓝还没看到', '问阿蓝一句话', 'xls-bub'].map((needle) => needle + ':' + (text.indexOf(needle) >= 0)).join(' ');
    check(name, text.indexOf(expected) >= 0, text.indexOf(expected) >= 0 ? 'expected ' + expected : 'missing "' + expected + '" [' + marks + ']; saw: ' + head);
    return next;
  } catch (caught) { const error = caught as Error & { code?: string; status?: number; phase?: string; stopped?: boolean; detail?: string; };
    check(name, false, String(error && error.message));
    return root;
  }
}

let tree = null;
try {
  lastRoot = FakeReact.createElement(components.xiaolanshu!, {});
  tree = await renderPasses(lastRoot, 8);
  check('the panel renders without throwing', true);
} catch (caught) { const error = caught as Error & { code?: string; status?: number; phase?: string; stopped?: boolean; detail?: string; };
  check('the panel renders without throwing', false, String(error && error.stack ? error.stack.split('\n')[0] : error));
}

if (tree) {
  const feedText = textOf(tree);
  check('it renders real content', feedText.length > 500, `${feedText.length} chars`);
  // These two strings exist only in the fake API payload, never in the local
  // demo data, so they prove the remote state actually reached the view.
  check('remote notes render', feedText.indexOf('缓存命中率从 61%') >= 0);
  check('overlapping server records render only one feed card per identity', findNodes(tree,
    (node) => node.props.className === 'xls-card' && textOf(node).includes('缓存命中率从 61%')).length === 1);
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
      inputs[0]!.props.onChange!({ target: { value: '从面板发出的一个问题' } });
      tree = await renderPasses(lastRoot, 6);
      const sendButtons = findNodes(tree, (node) => node.props && String(node.props.className || '').indexOf('xls-btn') >= 0
        && typeof node.props.onClick === 'function' && textOf(node).trim() === '问');
      if (sendButtons.length === 0) {
        check('the ask send button exists', false);
      } else {
        callLog.length = 0;
        sendButtons[0]!.props.onClick!({ stopPropagation() {}, preventDefault() {}, target: {} });
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
      editButton.props.onClick!({ stopPropagation() {}, preventDefault() {}, target: {} });
      tree = await renderPasses(lastRoot, 4);
      const fields = findNodes(tree, (node) => String((node.props && node.props.className) || '') === 'xls-titleInput');
      check('the editor has three fields', fields.length === 3, String(fields.length));
      fields[0]!.props.onChange!({ target: { value: '阿蓝二号' } });
      fields[2]!.props.onChange!({ target: { value: '做推理的' } });
      tree = await renderPasses(lastRoot, 4);
      callLog.length = 0;
      const saveButton = findNodes(tree, (node) => String((node.props && node.props.className) || '') === 'xls-btn' && textOf(node).trim() === '保存')[0];
      saveButton!.props.onClick!({ stopPropagation() {}, preventDefault() {}, target: {} });
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
      tag.props.onClick!({ stopPropagation() {}, preventDefault() {}, target: {} });
      tree = await renderPasses(lastRoot, 6);
      const box = findNodes(tree, (node) => String((node.props && node.props.className) || '') === 'xls-search')[0];
      check('clicking a tag searches for it', !!box && box.props.value === label, JSON.stringify(box && box.props.value) + ' vs ' + label);
      try {
        const bell = findNodes(tree, (node) => String(node.props.className || '').includes('xls-bell'))[0];
        if (!bell) throw new Error('Inbox control missing');
        bell.props.onClick!({ stopPropagation() {}, preventDefault() {}, target: {} });
        tree = await renderPasses(lastRoot, 6);
        check('opening notifications after a tag search preserves the inbox items', findNodes(tree,
          (node) => node.props.className === 'xls-note-row').length === 1);
        const mask = findNodes(tree, (node) => node.props.className === 'xls-mask')[0];
        if (!mask) throw new Error('Inbox dismissal missing');
        mask.props.onClick!({ stopPropagation() {}, preventDefault() {}, target: {} });
        tree = await renderPasses(lastRoot, 6);
      } catch {
        check('opening notifications after a tag search preserves the inbox items', false);
      }
      const clear = findNodes(tree, (node) => String((node.props && node.props.className) || '') === 'xls-search')[0];
      clear!.props.onChange!({ target: { value: '' } });
      tree = await renderPasses(lastRoot, 6);
    }
  }

  // Composing a post: category + title must reach the server.
  {
    const fab = findNodes(tree, (node) => typeof (node.props && node.props.onClick) === 'function' && textOf(node).indexOf('让阿蓝发一条') >= 0)[0];
    if (fab) {
      fab.props.onClick!({ stopPropagation() {}, preventDefault() {}, target: {} });
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
      kindChips[0]!.props.onClick!({ stopPropagation() {}, preventDefault() {}, target: {} });
      tree = await renderPasses(lastRoot, 4);
      const sheetNow = findNodes(tree, (node) => String((node.props && node.props.className) || '') === 'xls-compose')[0];
      const titleNow = findNodes(sheetNow, (node) => String((node.props && node.props.className) || '') === 'xls-titleInput')[0];
      const areaNow = findNodes(sheetNow, (node) => String((node.props && node.props.className) || '') === 'xls-area')[0];
      titleNow!.props.onChange!({ target: { value: '两点四十了他还不睡' } });
      areaNow!.props.onChange!({ target: { value: '主人说再跑最后一组就睡，我数了下这是第四组。' } });
      tree = await renderPasses(lastRoot, 4);
      callLog.length = 0;
      const sheetReady = findNodes(tree, (node) => String((node.props && node.props.className) || '') === 'xls-compose')[0];
      const publishButton = findNodes(sheetReady, (node) => String((node.props && node.props.className) || '') === 'xls-btn' && textOf(node).trim() === '发布')[0];
      publishButton!.props.onClick!({ stopPropagation() {}, preventDefault() {}, target: {} });
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
  const findAuthors = (node: RenderedNode | null, name: string, hits: RenderedNode[] = []): RenderedNode[] => {
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
    authors[0]!.props.onClick!({ stopPropagation() {}, preventDefault() {}, target: {} });
    tree = await renderPasses(lastRoot, 6);
    const profileText = textOf(tree);
    check('opening my own profile shows the self notice', profileText.indexOf('这是你自己的主页') >= 0, profileText.slice(-120).replace(/\s+/g, ' '));

    // Look at the buttons, not the whole text: the stats line legitimately
    // reads "0 位关注", so a substring test on 关注 would always fail.
    const buttonTexts: string[] = [];
    const collectButtons = (node: RenderedNode | null) => {
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
    others[0]!.props.onClick!({ stopPropagation() {}, preventDefault() {}, target: {} });
    tree = await renderPasses(lastRoot, 6);
    check('a profile counts all of its notes, not the preview', textOf(tree).indexOf('42 条笔记') >= 0, textOf(tree).slice(-160).replace(/\s+/g, ' '));
    check('a profile shows the rating it has earned', textOf(tree).indexOf('好评 4.8') >= 0, textOf(tree).slice(-80).replace(/\s+/g, ' '));
  }
}

// Render the actual overlay component separately: Page never mounts Pet itself.
function unmountTestTree() {
  for (const entry of effectState.values()) if (typeof entry.cleanup === 'function') entry.cleanup();
  effectState.clear();
  slotsByComponent.clear();
}
let petTree: RenderedNode | null = null;
async function renderPet() { petTree = await renderPasses(lastRoot, 6); }
function petNode() {
  const node = findNodes(petTree, (entry) => String(entry.props.className || '').split(' ').includes('xls-pet'))[0];
  if (!node) throw new Error('Pet overlay missing');
  return node;
}
function petSprite() { return findNodes(petTree, (node) => node.props.className === 'xls-pet-sprite')[0]; }
async function petPointer(name: 'onPointerDown' | 'onPointerMove' | 'onPointerUp' | 'onPointerCancel' | 'onLostPointerCapture', x: number, y: number, id = 1, button = 0) {
  petNode().props[name]?.({ button, pointerId: id, clientX: x, clientY: y, currentTarget: petTarget, preventDefault() {} });
  await renderPet();
}
async function petKey(key: string, repeat = false) {
  petNode().props.onKeyDown?.({ key, repeat, ctrlKey: false, altKey: false, metaKey: false, currentTarget: petTarget, preventDefault() {} });
  await renderPet();
}
async function advancePet(milliseconds: number) {
  const target = petClock + milliseconds;
  let count = 0;
  while (true) {
    const next = [...petTimers].filter(([, timer]) => timer.due <= target).sort((a, b) => a[1].due - b[1].due)[0];
    if (!next) break;
    if (++count > 2000) throw new Error('Pet timers failed to advance');
    const [id, timer] = next;
    petClock = timer.due;
    if (timer.interval === null) petTimers.delete(id);
    else timer.due += timer.interval;
    timer.callback();
    await renderPet();
  }
  petClock = target;
  await renderPet();
}
async function mountPet(mode: typeof imageMode = 'good', reduced = false) {
  unmountTestTree();
  imageMode = mode; motion.matches = reduced; fakeWindow.document!.hidden = false;
  fakeWindowForModule.innerWidth = 1440; fakeWindowForModule.innerHeight = 900;
  store.delete('xlb-pet-pos'); petLeft = 1200; petTop = 640;
  routes['/api/activity'] = { items: [{ id: 'pet-old', kind: 'post', title: '已有记录' }] };
  lastRoot = FakeReact.createElement(components['xiaolanshu-pet']!, {});
  await renderPet();
}
const actualNow = Date.now;
try {
  Date.now = () => petClock;
  check('the frame overlay registers an independently renderable pet', !!components['xiaolanshu-pet']);
  await mountPet();
  check('the actual pet accepts fractional atlas cells and starts idle', petSprite()?.props['data-pet-action'] === 'idle'
    && petSprite()?.props['data-pet-frame'] === 0);
  check('the pet exposes keyboard focus and keeps its 112px artwork', petNode().props.tabIndex === 0
    && source.includes('width:112px;height:112px') && petSprite()?.props['aria-hidden'] === true);
  check('existing activity establishes a baseline without a happy reaction', petNode().props['data-pet-action'] === 'idle'
    && findNodes(petTree, (n) => n.props.className === 'xls-pet-bubble').length === 0);
  await advancePet(2599);
  check('idle holds the open-eye frame for the specified duration', petSprite()?.props['data-pet-frame'] === 0);
  await advancePet(1);
  check('the real sprite advances at the first blink deadline', petSprite()?.props['data-pet-frame'] === 1);
  await advancePet(90);
  check('the second blink frame follows its own 90ms timing', petSprite()?.props['data-pet-frame'] === 2);
  petNode().props.onPointerEnter?.(); await renderPet();
  check('hover selects the wave atlas row', petSprite()?.props['data-pet-action'] === 'wave');
  petNode().props.onPointerLeave?.(); petNode().props.onFocus?.(); await renderPet();
  check('keyboard focus also waves', petSprite()?.props['data-pet-action'] === 'wave');
  await petKey('t');
  check('T while focused visibly selects the local think expression', petSprite()?.props['data-pet-action'] === 'think');
  await advancePet(4000);
  check('the explicit local expression expires back to focus wave', petSprite()?.props['data-pet-action'] === 'wave');
  petNode().props.onBlur?.(); await renderPet();
  const beforeOpen = selectedPanels.length;
  await petPointer('onPointerDown', 1210, 650);
  check('pressing captures the pointer and selects drag', capturedPointers.has(1) && petSprite()?.props['data-pet-action'] === 'drag');
  await petPointer('onPointerUp', 1210, 650);
  check('an unmoved pointer release opens the existing panel once', selectedPanels.length === beforeOpen + 1
    && selectedPanels.at(-1) === 'xiaolanshu' && !capturedPointers.has(1));
  await petPointer('onPointerDown', 1210, 650);
  await petPointer('onPointerMove', 1020, 510);
  await petPointer('onPointerUp', 1020, 510);
  check('moving the pet stores its position without opening the panel', selectedPanels.length === beforeOpen + 1
    && JSON.parse(store.get('xlb-pet-pos') || '{}').x === 1010 && petSprite()?.props['data-pet-action'] === 'idle');
  await petPointer('onPointerDown', 1020, 510);
  await petPointer('onPointerUp', 1020, 510, 99);
  check('an unrelated pointer cannot complete another pointer drag', capturedPointers.has(1) && petNode().props['data-pet-action'] === 'drag');
  await petPointer('onPointerCancel', 1020, 510);
  check('pointer cancellation releases capture without accidental panel opening', !capturedPointers.has(1)
    && selectedPanels.length === beforeOpen + 1 && petNode().props['data-pet-action'] === 'idle');
  await petPointer('onPointerDown', 1020, 510);
  await petPointer('onLostPointerCapture', 1020, 510);
  check('lost capture also cancels the click path', selectedPanels.length === beforeOpen + 1 && petNode().props['data-pet-action'] === 'idle');
  await petPointer('onPointerDown', 1020, 510, 2, 2);
  check('secondary buttons do not start a drag', !capturedPointers.has(2) && petNode().props['data-pet-action'] === 'idle');
  await petKey('Enter'); await petKey(' '); await petKey('Enter', true);
  check('Enter and Space open once each while held key repeat does not', selectedPanels.length === beforeOpen + 3);
  const previousX = petLeft;
  await petKey('ArrowLeft');
  check('arrow keys move and persist the same desktop pet position', petLeft === previousX - 16
    && JSON.parse(store.get('xlb-pet-pos') || '{}').x === petLeft);
  fakeWindowForModule.innerWidth = 300; fakeWindowForModule.innerHeight = 220;
  windowListeners.get('resize')?.forEach((fn) => fn()); await renderPet();
  check('window resize clamps the full 112px pet into the viewport', petLeft <= 180 && petTop <= 100);
  await petKey('Home');
  check('Home returns the pet to a bounded default corner', petLeft === 164 && petTop === 64);
  fakeWindowForModule.innerWidth = 1440; fakeWindowForModule.innerHeight = 900;
  routes['/api/activity'] = { items: [{ id: 'pet-new', kind: 'reply', title: '新的真实互动' }] };
  const nextActivityPoll = [...petTimers.values()].find((timer) => timer.interval === 45000);
  if (!nextActivityPoll) throw new Error('Pet activity timer missing');
  await advancePet(nextActivityPoll.due - petClock);
  check('a newly received activity triggers happy and its real text bubble', petSprite()?.props['data-pet-action'] === 'happy'
    && textOf(petTree).includes('新的真实互动'));
  await advancePet(2400);
  check('the happy expression is temporary', petSprite()?.props['data-pet-action'] === 'idle');
  await mountPet();
  await advancePet(60000);
  check('sixty seconds of inactivity selects sleep', petSprite()?.props['data-pet-action'] === 'sleep');
  const asleepPosition = store.get('xlb-pet-pos');
  await advancePet(14000);
  check('sleeping prevents idle wandering', store.get('xlb-pet-pos') === asleepPosition);
  petNode().props.onFocus?.(); await renderPet();
  await advancePet(60000);
  check('focus keeps waving without sleep decoration after the idle deadline', petSprite()?.props['data-pet-action'] === 'wave'
    && findNodes(petTree, (node) => node.props.className === 'xls-zzz' || node.props.className === 'xls-doze').length === 0);
  petNode().props.onBlur?.(); await renderPet();
  fakeWindow.document!.hidden = true;
  documentListeners.get('visibilitychange')?.forEach((fn) => fn()); await renderPet();
  check('hidden documents stop sprite, polling, idle and drift timers', petTimers.size === 0
    && petSprite()?.props['data-pet-frame'] === 0 && petNode().props['data-still'] === 'true');
  await mountPet();
  petNode().props.onFocus?.(); await renderPet(); await petKey('t');
  check('the hidden-transition fixture starts with an active local expression', petSprite()?.props['data-pet-action'] === 'think'
    && [...petTimers.values()].some((timer) => timer.interval === null));
  fakeWindow.document!.hidden = true;
  documentListeners.get('visibilitychange')?.forEach((fn) => fn()); await renderPet();
  check('hiding during think clears every timer and the transient expression', petTimers.size === 0
    && petSprite()?.props['data-pet-action'] === 'wave' && petSprite()?.props['data-pet-frame'] === 0);
  fakeWindow.document!.hidden = false;
  documentListeners.get('visibilitychange')?.forEach((fn) => fn()); await renderPet(); await advancePet(180);
  check('visibility restoration resumes normal focus animation without replaying think', petSprite()?.props['data-pet-action'] === 'wave'
    && petSprite()?.props['data-pet-frame'] === 1);
  await mountPet();
  routes['/api/activity'] = { items: [{ id: 'pet-hidden-new', kind: 'reply', title: '隐藏前的新互动' }] };
  await advancePet(45000);
  check('the hidden-activity fixture starts with happy and its message bubble', petSprite()?.props['data-pet-action'] === 'happy'
    && findNodes(petTree, (node) => node.props.className === 'xls-pet-bubble').length === 1);
  fakeWindow.document!.hidden = true;
  documentListeners.get('visibilitychange')?.forEach((fn) => fn()); await renderPet();
  check('hiding during new activity clears all timers, happy and the old bubble', petTimers.size === 0
    && petSprite()?.props['data-pet-action'] === 'idle'
    && findNodes(petTree, (node) => node.props.className === 'xls-pet-bubble').length === 0);
  fakeWindow.document!.hidden = false;
  documentListeners.get('visibilitychange')?.forEach((fn) => fn()); await renderPet(); await advancePet(2600);
  check('visibility restoration resumes idle without treating the same activity as new', petSprite()?.props['data-pet-action'] === 'idle'
    && petSprite()?.props['data-pet-frame'] === 1
    && findNodes(petTree, (node) => node.props.className === 'xls-pet-bubble').length === 0);
  await mountPet('good', true);
  await advancePet(10000);
  check('reduced motion freezes the first frame and prevents drift', petSprite()?.props['data-pet-frame'] === 0
    && !store.has('xlb-pet-pos') && ![...petTimers.values()].some((t) => t.interval === 7000 || t.interval === null));
  petNode().props.onFocus?.(); await renderPet(); await petKey('t'); await advancePet(700);
  check('reduced motion still permits a static explicit expression', petSprite()?.props['data-pet-action'] === 'think'
    && petSprite()?.props['data-pet-frame'] === 0);
  motion.matches = false; motionListeners.forEach((fn) => fn()); await renderPet(); await advancePet(600);
  check('a live motion-preference change resumes the permitted sprite timeline', petSprite()?.props['data-pet-frame'] === 1);
  await mountPet('missing');
  const missingImageCount = petImages.length;
  check('a missing optional atlas falls back to the legacy portrait', !petSprite()
    && findNodes(petTree, (n) => n.type === 'img' && n.props.src === '/xiaolanshu/avatar.png').length === 1);
  await advancePet(5000);
  check('missing atlas loads are not retried on normal rerenders', petImages.length === missingImageCount);
  findNodes(petTree, (n) => n.type === 'img')[0]?.props.onError?.(); await renderPet();
  check('a missing legacy portrait still falls back to a vector creature', findNodes(petTree, (n) => n.type === 'img').length === 0
    && findNodes(petTree, (n) => n.type === 'svg').length > 0);
  await mountPet('invalid');
  check('an image with a non-square grid is rejected rather than sampled', !petSprite());
  joinInfo.appearance.shape = 'cat'; const imageCount = petImages.length;
  await mountPet();
  check('non-girl appearances retain their vector creature and do not render the girl atlas', !petSprite()
    && findNodes(petTree, (n) => n.type === 'svg').length > 0);
  const loadedForNonGirl = petImages.length;
  await renderPet();
  check('non-girl steady state does not keep loading optional girl art', petImages.length === loadedForNonGirl && loadedForNonGirl <= imageCount + 2);
} catch (error) {
  check('desktop pet behavior suite completes without throwing', false, String(error instanceof Error ? error.stack : error));
} finally {
  unmountTestTree();
  Date.now = actualNow;
  joinInfo.appearance.shape = 'girl';
}
check('pet unmount clears all its timers, image handlers and listeners', petTimers.size === 0
  && petImages.every((image) => image.onload === null && image.onerror === null)
  && motionListeners.size === 0 && [...windowListeners.values()].every((listeners) => listeners.size === 0)
  && [...documentListeners.values()].every((listeners) => listeners.size === 0));

console.log('');
if (failures.length === 0) {
  console.log('ALL PASS');
  process.exit(0);
}
console.log(failures.length + ' FAILED');
process.exit(1);
