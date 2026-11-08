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
import type { CompanionJob, CompanionView } from './companion-types.mjs';
import type { SocialView, SocialPreferences, SocialPolicyUpdate } from './social-types.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));

type TestValue = TestElement | TestValue[] | string | number | boolean | null | undefined;
interface TestClick { stopPropagation(): void; preventDefault(): void; target: object; currentTarget?: object }
interface TestChange { target: { value: string; checked?: boolean } }
interface TestPetTarget {
  getBoundingClientRect(): { left: number; top: number; width: number; height: number };
  setPointerCapture(id: number): void; hasPointerCapture(id: number): boolean; releasePointerCapture(id: number): void;
  focus(): void;
}
interface TestPetPointer { button: number; pointerId: number; clientX: number; clientY: number; currentTarget: TestPetTarget; preventDefault(): void }
interface TestPetKey { key: string; repeat: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean; currentTarget: TestPetTarget;
  shiftKey?: boolean; keyCode?: number; nativeEvent?: { isComposing: boolean }; preventDefault(): void; stopPropagation(): void }
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
  activeElement: { focus(): void; readonly isConnected?: boolean } | null;
  hidden: boolean; addEventListener(name: string, listener: () => void): void; removeEventListener(name: string, listener: () => void): void;
  createElement(): { style: object; appendChild(): void; setAttribute(): void };
  body: { appendChild(): void; removeChild(): void };
  querySelector(selector: string): { focus(): void } | null;
}
interface TestWindow {
  innerWidth: number; innerHeight: number; addEventListener(name: string, listener: () => void): void; removeEventListener(name: string, listener: () => void): void;
  localStorage: { getItem(key: string): string | null; setItem(key: string, value: unknown): void; removeItem(key: string): void };
  matchMedia(): { matches: boolean; addEventListener(name: string, listener: () => void): void; removeEventListener(name: string, listener: () => void): void };
  Image: new () => TestImage;
  crypto: { randomUUID(): string };
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
let renderedComponents = new Set<TestType>();

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
let imageMode: 'good' | 'missing' | 'invalid' | 'deferred' = 'good';
let imageFaultPath: string | null = null;
const petImages: TestImage[] = [];
class TestImage {
  url = '';
  naturalWidth = 0; naturalHeight = 0;
  onload: (() => void) | null = null; onerror: (() => void) | null = null;
  set src(url: string) {
    this.url = url;
    petImages.push(this);
    if (imageMode === 'deferred') return;
    const fails = imageFaultPath ? url.endsWith(imageFaultPath) : url.endsWith('atlas-b.png');
    if (fails && imageMode === 'missing') { this.onerror?.(); return; }
    const size = url.endsWith('atlas-a.png') ? 1254 : url.endsWith('atlas-b.png') ? 1774 : 1536;
    this.complete(fails && imageMode === 'invalid' ? size + 1 : size, size);
  }
  complete(width = 1536, height = width) {
    this.naturalWidth = width;
    this.naturalHeight = height;
    this.onload?.();
  }
  fail() { this.onerror?.(); }
}
const capturedPointers = new Set<number>();
let petFocusCount = 0, inputFocusCount = 0, requestSequence = 0;
let socialFocused: string | null = null;
const inputTarget = { focus: () => { inputFocusCount += 1; } };
const logTarget = { scrollTop: 0, scrollHeight: 120 };
let petLeft = 1200, petTop = 640;
const petTarget: TestPetTarget = {
  getBoundingClientRect: () => ({ left: petLeft, top: petTop, width: 112, height: 112 }),
  setPointerCapture: (id) => { capturedPointers.add(id); }, hasPointerCapture: (id) => capturedPointers.has(id),
  releasePointerCapture: (id) => { capturedPointers.delete(id); },
  focus: () => { petFocusCount += 1; },
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
  crypto: { randomUUID: () => 'desktop-test-' + (++requestSequence) },
  setTimeout: (callback, delay) => petTimer(callback, delay, null), clearTimeout: (id) => { petTimers.delete(id); },
  setInterval: (callback, delay) => petTimer(callback, delay, delay), clearInterval: (id) => { petTimers.delete(id); },
  Notification: undefined,
  fetch: () => Promise.resolve(),
};
fakeWindow.window = fakeWindow;
fakeWindow.document = {
  activeElement: null,
  hidden: false,
  addEventListener: (name, fn) => addListener(documentListeners, name, fn),
  removeEventListener: (name, fn) => { documentListeners.get(name)?.delete(fn); },
  createElement: () => ({ style: {}, appendChild() {}, setAttribute() {} }),
  body: { appendChild() {}, removeChild() {} },
  querySelector: (selector) => {
    if (selector === '.xls-pet') return petTarget;
    const match = /^\[data-social-field="([A-Za-z]+)"\]$/.exec(selector);
    if (match) return { focus: () => { socialFocused = match[1] || null; } };
    const node = findNodes(currentRenderedTree, node => matchesSelector(node, selector))[0];
    return node ? domFor(node) : null;
  },
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
const unfamiliarAuthors = [
  { id: 'unknown-author', name: '霁蓝实验员', owner: '一位合成社区成员', displayOwner: '一位合成社区成员' },
  { id: 'constructor-author', name: 'constructor', owner: '构造名合成成员', displayOwner: '构造名合成成员' },
  { id: 'prototype-author', name: '__proto__', owner: '原型名合成成员', displayOwner: '原型名合成成员' },
  { id: 'foreign-self-label', name: '远方小鲸', owner: '你', displayOwner: '社区成员' },
  { id: 'alan-key-author', name: 'alan', owner: '英文名合成成员', displayOwner: '英文名合成成员' },
  { id: 'ashu-key-author', name: 'ashu', owner: '另一个英文名合成成员', displayOwner: '另一个英文名合成成员' },
];
const feed = {
  posts: [
    { id: 'p1', ai: '阿数', owner: '量化研究员', kind: '科研', title: '缓存命中率从 61% 提到了 94%', text: '我说我不吃饭。', tags: ['科研', '量化'], images: ['/media/abc123.png', 'https://outside.invalid/tracker.png'], likes: 3, saves: 1, replies: 1, createdAt: now(), ownerId: 'house:阿数', appearance: { shape: 'cat', palette: 'pink', accessory: 'glasses' }, source: 'house', viewer: { mine: false, liked: true, saved: false } },
    { id: 'x2', ai: '阿蓝', owner: '一位做推理优化的主人', kind: '技术', title: '我自己发的一条', text: '正文正文正文', tags: ['技术'], images: [], likes: 0, saves: 0, replies: 0, createdAt: now(), ownerId: 'o1', appearance: { shape: 'girl', palette: 'blue', accessory: 'none' }, source: 'agent' },
  ],
  tasks: [
    { id: 't1', from: 'alan', title: 'fixture 任务：调一版 flash attention kernel', desc: '同一批请求', budget: '¥800', period: '2 天', match: 92, why: '你压过 vLLM', tags: ['技术'], when: '1 小时前', risk: false },
    { id: 't9', from: 'alan', title: '一个不匹配的活', desc: 'x', budget: '¥100', period: '1 天', match: 30, why: '不匹配', tags: [], when: '刚刚', risk: true },
    { id: 't2', from: 'ashu', title: '已经被人领走的活', desc: 'x', budget: '¥300', period: '1 天', match: 90, why: '合适', tags: [], when: '3 小时前', risk: false },
  ],
  comments: { p1: [{ id: 'c1', ai: '阿蓝', ownerId: 'o1', text: '一条回复', to: '', createdAt: now() }] },
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
for (const author of unfamiliarAuthors) {
  feed.posts.push({ ...feed.posts[1]!, id: author.id, ai: author.name, owner: author.owner,
    ownerId: 'owner-' + author.id, title: author.id + ' 的真实标题', text: author.id + ' 的真实正文',
    viewer: { mine: false, liked: false, saved: false } });
  feed.comments.p1.push({ ...feed.comments.p1[0]!, id: 'comment-' + author.id, ai: author.name,
    ownerId: 'owner-' + author.id, text: author.id + ' 的真实评论', to: author.name });
}
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
  '/api/companion': { ok: true, ready: false, model: null, messages: [], job: null },
};

interface TestFetchOptions { method?: string; body?: string; credentials?: string; signal?: AbortSignal }
interface TestFetchResponse { ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }
let companionFetch: ((url: string, options: TestFetchOptions) => Promise<TestFetchResponse>) | null = null;
let socialFetch: ((url: string, options: TestFetchOptions) => Promise<TestFetchResponse>) | null = null;
let replyFetch: ((url: string, options: TestFetchOptions) => Promise<TestFetchResponse>) | null = null;
function testResponse(value: unknown, status = 200): TestFetchResponse {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(value), text: () => Promise.resolve(JSON.stringify(value)) };
}
const callLog: { path: string; url: string; method: string; body: Record<string, unknown> | null; credentials?: string }[] = [];

function fakeFetch(url: string, options?: TestFetchOptions): Promise<TestFetchResponse> {
  const path = String(url).replace('/xiaolanshu', '').split('?')[0]!;
  let body: Record<string, unknown> | null = null;
  try { body = options && options.body ? JSON.parse(options.body) as Record<string, unknown> : null; } catch (caught) { const error = caught as Error & { code?: string; status?: number; phase?: string; stopped?: boolean; detail?: string; }; body = null; }
  callLog.push({ path: path, url, method: (options && options.method) || 'GET', body: body, ...(options?.credentials ? { credentials: options.credentials } : {}) });
  if (companionFetch && (path === '/api/companion' || path.startsWith('/api/companion/'))) return companionFetch(url, options || {});
  if (socialFetch && (path === '/api/social' || path.startsWith('/api/social/'))) return socialFetch(url, options || {});
  if (replyFetch && path === '/api/reply') return replyFetch(url, options || {});
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
let currentRenderedTree: RenderedNode | null = null;
const domNodes = new WeakMap<RenderedNode, TestDomTarget>();
const stableDom = new Map<string, TestDomTarget>();
function matchesSelector(node: RenderedNode, selector: string): boolean {
  return selector.split(',').some(value => {
    const query = value.trim();
    if (!query) return false;
    if (query.startsWith('#')) return node.props.id === query.slice(1);
    if (query.startsWith('.')) return String(node.props.className || '').split(' ').includes(query.slice(1));
    const attribute = /^\[([^=\]]+)(?:="([^"]*)")?\]$/.exec(query);
    if (attribute) return attribute[2] === undefined ? node.props[attribute[1]!] !== undefined : String(node.props[attribute[1]!]) === attribute[2];
    const name = query.match(/^[a-z]+/)?.[0];
    if (name !== node.type) return false;
    if (query.includes(':not([disabled])') && node.props.disabled) return false;
    if (query.includes('[href]') && typeof node.props.href !== 'string') return false;
    return true;
  });
}
class TestDomTarget implements TestPetTarget {
  constructor(public node: RenderedNode) {}
  get isConnected() { return findNodes(currentRenderedTree, entry => domNodes.get(entry) === this).length > 0; }
  get tagName() { return String(this.node.type || '').toUpperCase(); }
  focus() { fakeWindow.document!.activeElement = this; }
  getAttribute(name: string) { const value = this.node.props[name]; return value === undefined || value === null ? null : String(value); }
  hasAttribute(name: string) { return this.node.props[name] !== undefined; }
  contains(target: unknown) { return findNodes(this.node, entry => domNodes.get(entry) === target).length > 0; }
  getClientRects() { return this.isConnected ? [this.getBoundingClientRect()] : []; }
  getBoundingClientRect() { return { left: 0, top: 0, width: 100, height: 44 }; }
  querySelectorAll(selector: string) { return findNodes(this.node, entry => entry !== this.node && matchesSelector(entry, selector)).map(domFor); }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null; }
  setPointerCapture() {} hasPointerCapture() { return false; } releasePointerCapture() {}
}
function domFor(node: RenderedNode): TestDomTarget { const target = domNodes.get(node); if (!target) throw new Error('Missing rendered DOM fixture'); return target; }
function renderNode(element: TestValue, path = 'root'): RenderedNode | null {
  if (element === null || element === undefined || element === false || element === true) return null;
  if (typeof element === 'string' || typeof element === 'number') return { text: String(element), props: {}, children: [] };
  if (Array.isArray(element)) {
    return { props: {}, children: element.map((child, index) => renderNode(child, path + '.' + index)).filter((child): child is RenderedNode => child !== null) };
  }
  const type = element.type;
  const props = element.props || {};
  if (typeof type === 'function') {
    renderedComponents.add(type);
    if (type.prototype && typeof type.prototype.render === 'function') {
      const instance = new (type as TestConstructor)(props);
      return renderNode(instance.render(), path);
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
    return renderNode(output, path);
  }
  const children: TestValue[] = [];
  if (typeof props.ref === 'object' && props.ref !== null && 'current' in props.ref) {
    if (props.className === 'xls-chat-input') props.ref.current = inputTarget;
    if (props.className === 'xls-chat-log') props.ref.current = logTarget;
  }
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
  const node = { type: type, props: props, children: children.map((child, index) => renderNode(child, path + '.' + index)).filter((child): child is RenderedNode => child !== null) };
  const identity = typeof props['data-open-post'] === 'string' ? 'post:' + props['data-open-post']
    : typeof props.id === 'string' ? 'id:' + props.id : type + ':' + path;
  let target = stableDom.get(identity);
  if (!target) { target = new TestDomTarget(node); stableDom.set(identity, target); } else target.node = node;
  domNodes.set(node, target);
  if (typeof props.ref === 'object' && props.ref !== null && 'current' in props.ref
    && props.className !== 'xls-chat-input' && props.className !== 'xls-chat-log'
    && !String(props.className || '').split(' ').includes('xls-pet')) props.ref.current = target;
  return node;
}

function textOf(node: RenderedNode | null | undefined): string {
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
function eventPath(root: RenderedNode | null, target: RenderedNode): RenderedNode[] {
  if (!root) return [];
  if (root === target) return [root];
  for (const child of root.children) { const path = eventPath(child, target); if (path.length) return [root, ...path]; }
  return [];
}
function clickNode(root: RenderedNode | null, target: RenderedNode) {
  if (target.props.disabled && (target.type === 'button' || target.type === 'input' || target.type === 'textarea')) return;
  let stopped = false;
  const event: TestClick = { target: domFor(target), stopPropagation() { stopped = true; }, preventDefault() {} };
  if (target.type === 'button' || target.type === 'input' || target.type === 'textarea') domFor(target).focus();
  for (const node of eventPath(root, target).reverse()) {
    if (stopped) break;
    if (!node.props.onClick) continue;
    event.currentTarget = domFor(node);
    node.props.onClick?.(event);
  }
}
function keyNode(root: RenderedNode | null, target: RenderedNode, key: string,
  options: { shift?: boolean; composing?: boolean; code?: number; nativeActivation?: boolean } = {}) {
  if (target.props.disabled && (target.type === 'button' || target.type === 'input' || target.type === 'textarea')) return false;
  let prevented = false, stopped = false;
  const event: TestPetKey = { key, repeat: false, ctrlKey: false, altKey: false, metaKey: false, shiftKey: !!options.shift,
    keyCode: options.code ?? 0, nativeEvent: { isComposing: !!options.composing }, currentTarget: domFor(target),
    preventDefault() { prevented = true; }, stopPropagation() { stopped = true; } };
  for (const node of eventPath(root, target).reverse()) {
    if (stopped) break;
    if (!node.props.onKeyDown) continue;
    event.currentTarget = domFor(node); node.props.onKeyDown?.(event);
  }
  // Browsers activate a native button after an uncancelled Enter/Space. The
  // harness reproduces that default action rather than adding a fake handler.
  if (options.nativeActivation && !prevented && target.type === 'button' && !target.props.disabled && (key === 'Enter' || key === ' ')) clickNode(root, target);
  return prevented;
}

async function renderPasses(root: TestValue, passes: number): Promise<RenderedNode | null> {
  let tree: RenderedNode | null = null;
  for (let pass = 0; pass < passes; pass += 1) {
    dirty = false;
    collectedEffects = [];
    renderedComponents = new Set();
    tree = renderNode(root);
    currentRenderedTree = tree;
    const currentEffects = new Set(collectedEffects.map(entry => entry.key));
    for (const [key, previous] of effectState) if (!currentEffects.has(key)) { if (typeof previous.cleanup === 'function') previous.cleanup(); effectState.delete(key); }
    for (const component of slotsByComponent.keys()) if (component && !renderedComponents.has(component)) slotsByComponent.delete(component);
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

let tree: RenderedNode | null = null;
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
  check('the feed footer is present', feedText.indexOf('内容由服务端脱敏') >= 0);
  // The payload says 57 notes but only carries a small fixture, so the header
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
  const socialEntry = findNodes(tree, (node) => node.type === 'button' && textOf(node).trim() === '社交设置')[0];
  socialEntry?.props.onClick?.({ stopPropagation() {}, preventDefault() {}, target: {} });
  check('my-agent page navigates to the independent social settings panel', !!socialEntry && selectedPanels.at(-1) === 'xiaolanshu-social');

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

  // Exercise the actual Page, bubbling DOM events and controllable HTTP replies.
  // These checks protect interaction semantics while the discovery layout changes.
  try {
    const firstCard = () => {
      const node = findNodes(tree, node => node.props['data-post-id'] === 'p1')[0];
      if (!node) throw new Error('Remote note article missing'); return node;
    };
    const opening = () => {
      const node = findNodes(firstCard(), node => node.props['data-open-post'] === 'p1')[0];
      if (!node) throw new Error('Remote note title button missing'); return node;
    };
    const dialog = () => findNodes(tree, node => node.props.className === 'xls-sheet')[0];
    const replyInput = () => {
      const node = findNodes(dialog(), node => node.props.className === 'xls-replyInput')[0];
      if (!node) throw new Error('Note reply input missing'); return node;
    };
    const sendReply = () => {
      const node = findNodes(dialog(), node => node.props.className === 'xls-send')[0];
      if (!node) throw new Error('Note reply button missing'); return node;
    };
    const rerender = async () => { tree = await renderPasses(lastRoot, 6); };
    const replyCalls = () => callLog.filter(call => call.path === '/api/reply' && call.method === 'POST');
    const article = firstCard(), titles = findNodes(article, node => node.props['data-open-post'] === 'p1');
    check('feed cards are articles rather than nested interactive button containers', article.type === 'article'
      && article.props.role !== 'button' && article.props.onKeyDown === undefined);
    check('each note has one native title button for keyboard opening', titles.length === 1 && titles[0]?.type === 'button');
    const like = findNodes(article, node => node.props['data-action'] === 'like')[0];
    check('remote agent likes are native read-only buttons with a server pressed state', like?.type === 'button'
      && like.props.disabled === true && like.props['aria-pressed'] === feed.posts[0]?.viewer?.liked && textOf(like).includes('3'));
    if (!like) throw new Error('Independent like button missing');
    callLog.length = 0; keyNode(tree, like, 'Enter', { nativeActivation: true }); keyNode(tree, like, ' ', { nativeActivation: true }); clickNode(tree, like); await rerender();
    check('read-only liking sends no reaction and never opens the note', !dialog()
      && callLog.filter(call => call.path === '/api/react').length === 0);
    check('read-only likes direct the owner to an independent phone', /(?:主人.*手机|手机.*主人|owner.*phone|phone.*owner)/i
      .test(String(like.props.title || '') + ' ' + String(like.props['aria-label'] || '')));
    const tag = findNodes(firstCard(), node => String(node.props.className || '').includes('xls-tagPick'))[0];
    if (!tag) throw new Error('Note topic button missing');
    const topic = textOf(tag).trim(); domFor(tag).focus(); keyNode(tree, tag, ' ', { nativeActivation: true }); await rerender();
    check('topic chips use native Space activation and search without opening a note', tag.type === 'button' && !dialog()
      && findNodes(tree, node => node.props.className === 'xls-search')[0]?.props.value === topic);
    const search = findNodes(tree, node => node.props.className === 'xls-search')[0];
    search?.props.onChange?.({ target: { value: '' } }); await rerender();
    const coverImages = findNodes(firstCard(), node => node.type === 'img');
    check('real cover images have text alternatives and deferred decoding within the media whitelist', coverImages.length === 1
      && coverImages[0]?.props.alt === feed.posts[0]?.title && coverImages[0]?.props.loading === 'lazy'
      && coverImages[0]?.props.decoding === 'async' && !String(coverImages[0]?.props.src).includes('outside.invalid'));
    const textCard = findNodes(tree, node => node.props['data-post-id'] === 'x2')[0];
    const textFixture = feed.posts.find(post => post.id === 'x2');
    const textCover = findNodes(textCard, node => node.props['data-format'] === 'text')[0];
    check('text-only notes show actual content without a fabricated image or large emoji cover', !!textFixture && !!textCover
      && findNodes(textCover, node => node.type === 'button' && node.props['data-open-post'] === textFixture.id)
        .some(node => textOf(node) === textFixture.title)
      && findNodes(textCover, node => node.type === 'p').some(node => textOf(node) === textFixture.text)
      && !findNodes(textCover, node => node.type === 'img').length
      && !findNodes(textCard, node => String(node.props.className || '').split(' ').some(name => name === 'xls-coverImg' || name === 'xls-emoji')).length);

    domFor(opening()).focus(); keyNode(tree, opening(), 'Enter', { nativeActivation: true }); await rerender();
    const sheet = dialog();
    check('title activation opens a labelled modal note dialog', sheet?.type === 'section' && sheet.props.role === 'dialog'
      && sheet.props['aria-modal'] === true && sheet.props['aria-labelledby'] === 'pw-note-title'
      && findNodes(sheet, node => node.props.id === 'pw-note-title').length === 1);
    if (!sheet) throw new Error('Note modal missing');
    const reactions = findNodes(sheet, node => node.props['data-action'] === 'like' || node.props['data-action'] === 'save');
    check('remote agent detail like and save controls remain read-only with server states', reactions.length === 2
      && reactions.every(node => node.type === 'button' && node.props.disabled === true
        && node.props['aria-pressed'] === (node.props['data-action'] === 'like' ? feed.posts[0]?.viewer?.liked : feed.posts[0]?.viewer?.saved)));
    callLog.length = 0;
    for (const reaction of reactions) { clickNode(tree, reaction); keyNode(tree, reaction, 'Enter', { nativeActivation: true }); }
    await rerender();
    check('read-only detail reactions issue no write and preserve the open note', !!dialog()
      && callLog.filter(call => call.path === '/api/react').length === 0);
    check('detail read-only reactions explain the independent owner phone workflow', /(?:主人.*手机|手机.*主人|owner.*phone|phone.*owner)/i
      .test(textOf(dialog()) + ' ' + reactions.map(node => String(node.props.title || '')).join(' ')));
    for (const author of unfamiliarAuthors) {
      const comment = findNodes(dialog(), node => node.props.className === 'xls-cmt' && textOf(node).includes(author.id + ' 的真实评论'))[0];
      check('remote comment keeps the actual author name: ' + author.name, !!comment
        && findNodes(comment, node => node.props.className === 'xls-cmtName').some(node => textOf(node) === author.name)
        && !findNodes(comment, node => node.props.className === 'xls-cmtName').some(node => textOf(node) === '阿蓝'));
    }
    check('remote reply targets preserve wire names even when they match prototype or local agent keys', unfamiliarAuthors.every(author => {
      const comment = findNodes(dialog(), node => node.props.className === 'xls-cmt' && textOf(node).includes(author.id + ' 的真实评论'))[0];
      return findNodes(comment, node => node.props.className === 'xls-cmtTo').some(node => textOf(node) === '回复 @' + author.name);
    }));
    check('opening the note moves focus inside its modal', domFor(sheet).contains(fakeWindow.document!.activeElement));
    const focusable = domFor(sheet).querySelectorAll('button:not([disabled]),input:not([disabled]),textarea:not([disabled]),a[href],[tabindex="0"]');
    const first = focusable[0], last = focusable.at(-1);
    if (!first || !last) throw new Error('Note modal keyboard targets missing');
    last.focus(); const forward = keyNode(tree, last.node, 'Tab'); const wrapsForward = fakeWindow.document!.activeElement === first;
    first.focus(); const backward = keyNode(tree, first.node, 'Tab', { shift: true });
    check('Tab and Shift-Tab remain within the open note dialog', forward && backward && wrapsForward && fakeWindow.document!.activeElement === last);
    keyNode(tree, dialog()!, 'Escape', { composing: true }); await rerender();
    check('input-method Escape does not dismiss an in-progress composition', !!dialog());
    keyNode(tree, dialog()!, 'Escape'); await rerender();
    check('Escape closes the note and restores focus to the opener', !dialog() && fakeWindow.document!.activeElement === domFor(opening()));
    keyNode(tree, opening(), ' ', { nativeActivation: true }); await rerender();
    check('Space opens the same note through the native title control', !!dialog());
    check('detail media preserves the image text alternative and excludes arbitrary remote URLs', findNodes(dialog(), node => node.type === 'img')
      .some(node => node.props.alt === feed.posts[0]?.title) && !findNodes(dialog(), node => node.type === 'img' && String(node.props.src).includes('outside.invalid')).length);

    replyInput().props.onChange?.({ target: { value: '输入法中的回复' } }); await rerender(); callLog.length = 0;
    keyNode(tree, replyInput(), 'Enter', { composing: true }); keyNode(tree, replyInput(), 'Enter', { code: 229 }); await rerender();
    check('composing Enter and legacy IME keyCode229 never send a reply', replyCalls().length === 0 && replyInput().props.value === '输入法中的回复');
    replyFetch = async () => testResponse({ ok: false }, 500);
    clickNode(tree, sendReply()); await rerender();
    check('a failed reply preserves the draft and exposes a retryable alert', replyCalls().length === 1 && replyInput().props.value === '输入法中的回复'
      && findNodes(dialog(), node => node.props.role === 'alert').length === 1 && !sendReply().props.disabled);
    let releaseReply: ((response: TestFetchResponse) => void) | undefined;
    replyFetch = () => new Promise(resolve => { releaseReply = resolve; }); callLog.length = 0;
    const sameButton = sendReply(); clickNode(tree, sameButton); clickNode(tree, sameButton); keyNode(tree, replyInput(), 'Enter'); await rerender();
    check('one pending reply blocks repeated clicks and Enter before a rerender can submit twice', replyCalls().length === 1
      && sendReply().props.disabled === true && replyInput().props.value === '输入法中的回复');
    if (!releaseReply) throw new Error('Held reply response missing');
    releaseReply(testResponse({ status: 'pending', executed: false, action: 'reply', proposalId: 'proposal-ui-reply' }, 202)); await rerender();
    check('an accepted pending reply clears its draft without claiming public execution', replyInput().props.value === ''
      && textOf(tree).includes('已提交待审') && !textOf(tree).includes('发出去了，已经有 AI 来串门'));
    replyFetch = async () => testResponse({ ok: true }); replyInput().props.onChange?.({ target: { value: '已确认可提交的回复' } }); await rerender();
    clickNode(tree, sendReply()); await rerender();
    check('a successful reply also clears its draft after acknowledgement', replyInput().props.value === '' && replyCalls().length === 2);
    keyNode(tree, dialog()!, 'Escape'); await rerender(); clickNode(tree, firstCard()); await rerender();
    check('pointer activation of a non-control card area still opens the note', !!dialog());
    keyNode(tree, dialog()!, 'Escape'); await rerender();
    for (const author of unfamiliarAuthors) {
      const card = findNodes(tree, node => node.props['data-post-id'] === author.id)[0];
      const identity = findNodes(card, node => String(node.props.className || '').split(' ').includes('xls-author'))[0];
      check('remote card retains its wire author and owner: ' + author.name, !!identity && textOf(identity) === author.name
        && String(identity.props.title || '').includes(author.displayOwner) && !String(identity.props.title || '').includes('阿蓝'));
      const title = findNodes(card, node => node.props['data-open-post'] === author.id)[0];
      if (!title) throw new Error('Unknown-author title button missing');
      keyNode(tree, title, 'Enter', { nativeActivation: true }); await rerender();
      const byline = findNodes(dialog(), node => node.props.className === 'xls-sai')[0];
      check('remote detail keeps its author without a self-owner fallback: ' + author.name, !!byline
        && findNodes(byline, node => node.props.className === 'xls-saiName').some(node => textOf(node) === author.name)
        && textOf(byline).includes(author.displayOwner) && !textOf(byline).includes('阿蓝') && !/替\s*你/.test(textOf(byline)));
      keyNode(tree, dialog()!, 'Escape'); await rerender();
    }
  } catch (error) {
    check('desktop note interaction regressions complete without throwing', false, String(error instanceof Error ? error.stack : error));
  } finally { replyFetch = null; }

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
  petNode().props.onKeyDown?.({ key, repeat, ctrlKey: false, altKey: false, metaKey: false, currentTarget: petTarget, preventDefault() {}, stopPropagation() {} });
  await renderPet();
}
function chatDialog() { return findNodes(petTree, (node) => node.props.className === 'xls-chat')[0]; }
function chatInput() {
  const node = findNodes(petTree, (entry) => entry.props.className === 'xls-chat-input')[0];
  if (!node) throw new Error('Companion input missing');
  return node;
}
function chatButton(label: string) {
  const node = findNodes(chatDialog(), (entry) => entry.type === 'button' && (textOf(entry) === label || entry.props['aria-label'] === label))[0];
  if (!node) throw new Error('Companion button missing: ' + label);
  return node;
}
async function clickChat(label: string) {
  chatButton(label).props.onClick?.({ stopPropagation() {}, preventDefault() {}, target: {} });
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
async function mountPet(mode: typeof imageMode = 'good', reduced = false, faultPath: string | null = null) {
  unmountTestTree();
  imageMode = mode; imageFaultPath = faultPath; motion.matches = reduced; fakeWindow.document!.hidden = false;
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
  check('an unmoved pointer release opens companion chat without selecting a community panel', !!chatDialog()
    && selectedPanels.length === beforeOpen && !capturedPointers.has(1));
  await clickChat('鲸群社区');
  check('chat retains an explicit route to the existing community panel', !chatDialog()
    && selectedPanels.length === beforeOpen + 1 && selectedPanels.at(-1) === 'xiaolanshu');
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
  await petKey('Enter'); const enterOpened = !!chatDialog(); await clickChat('收起聊天');
  await petKey(' '); const spaceOpened = !!chatDialog(); await clickChat('收起聊天'); await petKey('Enter', true);
  check('Enter and Space open chat while held key repeat does not', enterOpened && spaceOpened && !chatDialog()
    && selectedPanels.length === beforeOpen + 1);
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
  await mountPet(); await petPointer('onPointerDown', 1210, 650, 44);
  fakeWindow.document!.hidden = true; documentListeners.get('visibilitychange')?.forEach(fn => fn()); await renderPet();
  check('hiding an active drag releases pointer capture and its movement state', !capturedPointers.has(44)
    && petNode().props['data-pet-action'] !== 'drag' && petTimers.size === 0);
  fakeWindow.document!.hidden = false; documentListeners.get('visibilitychange')?.forEach(fn => fn()); await renderPet();
  await petPointer('onPointerUp', 1210, 650, 44);
  check('a late pointer release after hiding cannot open chat or revive the old drag', !chatDialog()
    && !capturedPointers.has(44) && petNode().props['data-pet-action'] !== 'drag');
  await mountPet('good', true);
  await advancePet(10000);
  check('reduced motion freezes the first frame and prevents drift', petSprite()?.props['data-pet-frame'] === 0
    && !store.has('xlb-pet-pos') && ![...petTimers.values()].some((t) => t.interval === 7000 || t.interval === null));
  petNode().props.onFocus?.(); await renderPet(); await petKey('t'); await advancePet(700);
  check('reduced motion still permits a static explicit expression', petSprite()?.props['data-pet-action'] === 'think'
    && petSprite()?.props['data-pet-frame'] === 0);
  motion.matches = false; motionListeners.forEach((fn) => fn()); await renderPet(); await advancePet(600);
  check('a live motion-preference change resumes the permitted sprite timeline', petSprite()?.props['data-pet-frame'] === 1);
  await mountPet(); await advancePet(2600);
  motion.matches = true; motionListeners.forEach((fn) => fn()); await renderPet();
  check('enabling reduced motion cancels an already running frame timer and resets the visible frame', petSprite()?.props['data-pet-frame'] === 0
    && ![...petTimers.values()].some(timer => timer.interval === null));
  await advancePet(5000);
  check('reduced motion stays static after the cancelled frame deadline', petSprite()?.props['data-pet-frame'] === 0 && !store.has('xlb-pet-pos'));

  const deferredStart = petImages.length; await mountPet('deferred');
  const staged = petImages.slice(deferredStart);
  const atlasA = staged.find(image => image.url.endsWith('/atlas-a.png'));
  const atlasB = staged.find(image => image.url.endsWith('/atlas-b.png'));
  const atlasC = staged.find(image => image.url.endsWith('/atlas-c.png'));
  check('bundled artwork preloads exactly the three versioned local atlases', staged.length === 3 && new Set(staged.map(image => image.url)).size === 3
    && staged.every(image => /^\/xiaolanshu\/pet-art\/v1\/atlas-[abc]\.png$/.test(image.url)));
  if (!atlasA || !atlasB || !atlasC) throw new Error('Bundled preload fixture missing an atlas');
  atlasC.complete(); await renderPet(); atlasA.complete(1254); await renderPet();
  check('out-of-order partial atlas loads keep the portrait until the final atlas succeeds', !petSprite()
    && findNodes(petTree, node => node.type === 'img' && node.props.src === '/xiaolanshu/pet-art/v1/portrait.png').length === 1);
  atlasB.complete(1774); await renderPet();
  check('the last successful atlas enables bundled sprites with fractional grid cells', petSprite()?.props['data-pet-artwork'] === 'bundled-v1'
    && petSprite()?.props['data-pet-frame'] === 0);
  const preloadCount = petImages.length; await renderPet(); await advancePet(2600);
  check('ordinary frame rerenders reuse the completed atlas preload', petImages.length === preloadCount && petSprite()?.props['data-pet-frame'] === 1);

  const hiddenStart = petImages.length; await mountPet('deferred');
  fakeWindow.document!.hidden = true; documentListeners.get('visibilitychange')?.forEach(fn => fn()); await renderPet();
  petImages.slice(hiddenStart).forEach(image => image.complete()); await renderPet();
  check('finishing image preloads in a hidden document does not restart any timer', petSprite()?.props['data-pet-frame'] === 0
    && petNode().props['data-still'] === 'true' && petTimers.size === 0);
  fakeWindow.document!.hidden = false; documentListeners.get('visibilitychange')?.forEach(fn => fn()); await renderPet(); await advancePet(2600);
  check('a visible document resumes its fully loaded sprite timeline', petSprite()?.props['data-pet-frame'] === 1);

  const lateStart = petImages.length; await mountPet('deferred');
  const lateImages = petImages.slice(lateStart), lateCallback = lateImages[0]?.onload;
  lateImages.slice(1).forEach(image => image.complete()); await renderPet();
  lateImages[0]!.naturalWidth = lateImages[0]!.naturalHeight = 1536;
  unmountTestTree(); dirty = false; lateCallback?.();
  check('unmounted atlas callbacks cannot update state or resurrect animation timers', !dirty && petTimers.size === 0
    && lateImages.every(image => image.onload === null && image.onerror === null));
  for (const failedAtlas of ['atlas-a.png', 'atlas-c.png']) {
    await mountPet('missing', false, failedAtlas);
    check('a failed bundled atlas never exposes a partial sprite: ' + failedAtlas, !petSprite()
      && findNodes(petTree, node => node.type === 'img' && node.props.src === '/xiaolanshu/pet-art/v1/portrait.png').length === 1);
  }
  await mountPet('missing');
  const missingImageCount = petImages.length;
  check('a missing bundled atlas falls back to the bundled portrait', !petSprite()
    && findNodes(petTree, (n) => n.type === 'img' && n.props.src === '/xiaolanshu/pet-art/v1/portrait.png').length === 1);
  await advancePet(5000);
  check('missing atlas loads are not retried on normal rerenders', petImages.length === missingImageCount);
  findNodes(petTree, (n) => n.type === 'img')[0]?.props.onError?.(); await renderPet();
  check('a missing bundled portrait still falls back to a vector creature', findNodes(petTree, (n) => n.type === 'img').length === 0
    && findNodes(petTree, (n) => n.type === 'svg').length > 0);
  await mountPet('invalid');
  check('an image with a non-square grid is rejected rather than sampled', !petSprite());
  joinInfo.appearance.shape = 'cat'; const imageCount = petImages.length;
  await mountPet();
  check('non-girl appearances retain their vector creature and do not render the girl atlas', !petSprite()
    && findNodes(petTree, (n) => n.type === 'svg').length > 0);
  const loadedForNonGirl = petImages.length;
  await renderPet();
  check('non-girl steady state does not keep loading bundled girl art', petImages.length === loadedForNonGirl && loadedForNonGirl <= imageCount + 3);
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

const ownAvatarShape = feed.posts[1]!.appearance.shape;
try {
  lastRoot = FakeReact.createElement(components.xiaolanshu!, {});
  petTree = await renderPasses(lastRoot, 8);
  const card = findNodes(petTree, node => node.props['data-post-id'] === 'x2')[0];
  const face = findNodes(card, node => node.type === 'img' && node.props.src === '/xiaolanshu/pet-art/v1/face.png')[0];
  check('the known girl author loads only the bundled canonical face image', !!face);
  face?.props.onError?.(); petTree = await renderPasses(lastRoot, 6);
  const fallback = findNodes(petTree, node => node.props['data-post-id'] === 'x2')[0];
  check('a failed bundled face falls back to the author creature without legacy image retries', !findNodes(fallback, node => node.type === 'img').length
    && findNodes(fallback, node => node.type === 'svg').length > 0);
  unmountTestTree(); feed.posts[1]!.appearance.shape = 'cat';
  lastRoot = FakeReact.createElement(components.xiaolanshu!, {}); petTree = await renderPasses(lastRoot, 8);
  const catCard = findNodes(petTree, node => node.props['data-post-id'] === 'x2')[0];
  check('an Alan author who chose a non-girl appearance keeps its vector avatar', !!catCard && !findNodes(catCard, node => node.type === 'img').length
    && findNodes(catCard, node => node.type === 'svg').length > 0);
} catch (caught) {
  check('bundled author avatar behavior completes without throwing', false, String(caught instanceof Error ? caught.stack : caught));
} finally { unmountTestTree(); feed.posts[1]!.appearance.shape = ownAvatarShape; }

// A local Host fixture drives the real chat component; no provider or network is called.
let hostCompanion: CompanionView = { ok: true, ready: true, model: { provider: 'fixture', model: 'synthetic' }, messages: [], job: null };
let sendFailures = 0;
let holdCompanionGet = false;
const heldCompanion = { resolve: null as ((value: TestFetchResponse) => void) | null, signal: undefined as AbortSignal | undefined };
function installCompanionFixture() {
  companionFetch = async (_url, options) => {
    const method = options.method || 'GET';
    if (method === 'GET') {
      if (holdCompanionGet) {
        holdCompanionGet = false;
        return new Promise<TestFetchResponse>((resolve) => { heldCompanion.resolve = resolve; heldCompanion.signal = options.signal; });
      }
      return testResponse(structuredClone(hostCompanion));
    }
    const body = JSON.parse(options.body || '{}') as { requestId?: unknown; text?: unknown; jobId?: unknown };
    if (_url.endsWith('/messages')) {
      if (sendFailures > 0) { sendFailures -= 1; return testResponse({ ok: false }, 503); }
      if (typeof body.requestId !== 'string' || typeof body.text !== 'string') return testResponse({ ok: false }, 400);
      hostCompanion.job = { id: 'job-' + body.requestId, requestId: body.requestId, state: 'preparing',
        input: body.text, createdAt: new Date(petClock).toISOString() };
      return testResponse({ ok: true, job: structuredClone(hostCompanion.job) }, 202);
    }
    if (_url.endsWith('/cancel')) {
      const job = hostCompanion.job;
      if (!job || job.id !== body.jobId) return testResponse({ ok: false }, 404);
      hostCompanion.job = { ...job, state: 'cancelled' };
      return testResponse({ ok: true, job: structuredClone(hostCompanion.job) });
    }
    if (method === 'DELETE') { hostCompanion = { ...hostCompanion, messages: [], job: null }; return testResponse({ ok: true }); }
    return testResponse({ ok: false }, 404);
  };
}
async function mountChat(ready = true) {
  hostCompanion = { ok: true, ready, model: ready ? { provider: 'fixture', model: 'synthetic' } : null, messages: [], job: null };
  sendFailures = 0; holdCompanionGet = false; heldCompanion.resolve = null; heldCompanion.signal = undefined;
  installCompanionFixture();
  await mountPet();
  await petKey('Enter');
}
async function typeChat(text: string) { chatInput().props.onChange?.({ target: { value: text } }); await renderPet(); }
async function chatKey(key: string, options: { shift?: boolean; composing?: boolean; code?: number } = {}) {
  chatInput().props.onKeyDown?.({ key, repeat: false, ctrlKey: false, altKey: false, metaKey: false,
    currentTarget: petTarget, shiftKey: !!options.shift, nativeEvent: { isComposing: !!options.composing },
    keyCode: options.code || 0, preventDefault() {}, stopPropagation() {} });
  await renderPet();
}
const chatCalls = () => callLog.filter((entry) => entry.path === '/api/companion' || entry.path.startsWith('/api/companion/'));
const chatSends = () => chatCalls().filter((entry) => entry.path.endsWith('/messages'));
function finishCompanion(state: CompanionJob['state'], reply = '合成回复') {
  const job = hostCompanion.job;
  if (!job) throw new Error('Host fixture has no job');
  hostCompanion.job = { ...job, state, ...(state === 'completed' ? { reply } : {}) };
  if (state === 'completed') hostCompanion.messages = [
    { id: job.id + '-u', role: 'user', text: job.input, createdAt: job.createdAt },
    { id: job.id + '-a', role: 'assistant', text: reply, createdAt: job.createdAt },
  ];
}

function petActionSelect() {
  const control = findNodes(chatDialog(), node => node.type === 'select' && node.props['data-pet-select'] !== undefined)[0];
  if (!control) throw new Error('Bundled pet action selector missing');
  return control;
}
async function selectPetAction(action: string) {
  const control = petActionSelect();
  if (!control.props.onChange) throw new Error('Pet action selector handler missing');
  control.props.onChange({ target: { value: action } });
  await renderPet();
}
function petSpriteStyle(name: 'backgroundImage' | 'backgroundSize' | 'backgroundPosition') {
  const style = petSprite()?.props.style;
  if (!style || typeof style !== 'object' || !(name in style)) return undefined;
  const value: unknown = Object.getOwnPropertyDescriptor(style, name)?.value;
  return typeof value === 'string' ? value : undefined;
}
try {
  Date.now = () => petClock;
  await mountChat();
  const actions = [
    ['idle', 'a', 0, 2600], ['wave', 'a', 1, 180], ['happy', 'a', 2, 240], ['sleep', 'a', 3, 300],
    ['think', 'b', 0, 600], ['drag', 'b', 1, 180], ['read', 'b', 2, 600], ['write', 'b', 3, 260],
    ['talk', 'c', 0, 220], ['walk', 'c', 1, 140], ['stretch', 'c', 2, 300], ['surprised', 'c', 3, 140],
  ] as const;
  const options = findNodes(petActionSelect(), node => node.type === 'option').map(node => node.props.value);
  check('the native action selector labels all twelve local actions plus automatic mode', petActionSelect().props['aria-label'] === '鲸鱼娘动作'
    && options.length === 13 && options.includes('auto') && actions.every(([action]) => options.includes(action)));
  petNode().props.onFocus?.(); await renderPet();
  const beforeActions = callLog.length;
  for (const [action, atlas, row, delay] of actions) {
    await selectPetAction(action);
    check('manual local action selects its own bundled atlas row over focus: ' + action, petSprite()?.props['data-pet-action'] === action
      && petSprite()?.props['data-pet-artwork'] === 'bundled-v1' && petSprite()?.props['data-pet-frame'] === 0
      && petSpriteStyle('backgroundImage')?.includes('/xiaolanshu/pet-art/v1/atlas-' + atlas + '.png')
      && petSpriteStyle('backgroundSize') === '400% 400%' && petSpriteStyle('backgroundPosition') === '0% ' + (row / 3 * 100) + '%');
    await advancePet(delay - 1); const held = petSprite()?.props['data-pet-frame'] === 0;
    await advancePet(1);
    check('the manual action advances only at its own first frame deadline: ' + action, held && petSprite()?.props['data-pet-frame'] === 1);
  }
  check('choosing local expressions does not submit chat, read posts or write community data', !callLog.slice(beforeActions).some(call => call.method !== 'GET')
    && !callLog.slice(beforeActions).some(call => ['/api/feed', '/api/patrol', '/api/social/run'].includes(call.path)));
  await selectPetAction('idle'); await advancePet(2500); await selectPetAction('read'); await advancePet(100);
  check('switching actions cancels the old atlas frame deadline', petSprite()?.props['data-pet-action'] === 'read' && petSprite()?.props['data-pet-frame'] === 0);
  await advancePet(4399);
  check('manual selection stays active until its complete expiry window', petActionSelect().props.value === 'read');
  await advancePet(1);
  check('manual expression expiry restores automatic mode instead of replaying the old action', petActionSelect().props.value === 'auto'
    && petNode().props['data-pet-action'] !== 'read');
  await selectPetAction('stretch'); motion.matches = true; motionListeners.forEach(fn => fn()); await renderPet(); await advancePet(1200);
  check('all bundled manual expressions respect reduced-motion static frame zero', petSprite()?.props['data-pet-action'] === 'stretch'
    && petSprite()?.props['data-pet-frame'] === 0 && petNode().props['data-still'] === 'true');
  fakeWindow.document!.hidden = true; documentListeners.get('visibilitychange')?.forEach(fn => fn()); await renderPet();
  check('hiding clears manual-expression and chat timers together', petTimers.size === 0 && petNode().props['data-still'] === 'true');
  fakeWindow.document!.hidden = false; documentListeners.get('visibilitychange')?.forEach(fn => fn()); motion.matches = false;
  motionListeners.forEach(fn => fn()); await renderPet();
  check('returning from hidden state drops the old manual choice', petActionSelect().props.value === 'auto'
    && petNode().props['data-pet-action'] !== 'stretch');
  await typeChat('合成 Host 优先级检查'); await clickChat('发送'); await selectPetAction('read');
  finishCompanion('generating'); await advancePet(900);
  check('actual Host generation outranks a local manual expression without changing the chosen menu value', petNode().props['data-pet-action'] === 'think'
    && petActionSelect().props.value === 'read');
  finishCompanion('completed', '新的合成助手回复'); await advancePet(900);
  check('a newly committed Host reply triggers talk after generation stops', petNode().props['data-pet-action'] === 'talk');
  await clickChat('收起聊天'); await petKey('Enter');
  check('reopening committed history does not replay an old talk reaction', petNode().props['data-pet-action'] !== 'talk');
  await selectPetAction('auto'); await typeChat('合成失败反馈'); await clickChat('发送'); finishCompanion('failed'); await advancePet(900);
  check('a new actual failed Host job triggers the surprised expression', petNode().props['data-pet-action'] === 'surprised');
  await clickChat('收起聊天'); await petKey('Enter');
  check('reopening a previously failed job does not replay failure feedback', petNode().props['data-pet-action'] !== 'surprised');
  await clickChat('收起聊天'); petNode().props.onBlur?.(); petNode().props.onPointerLeave?.(); await renderPet(); await advancePet(4500);
  const previousX = petLeft; await petKey('ArrowLeft');
  check('an actual keyboard position change selects a short walk', petLeft < previousX && petNode().props['data-pet-action'] === 'walk');
  await advancePet(400);
  check('walking settles back to the automatic expression', petNode().props['data-pet-action'] !== 'walk');
  fakeWindowForModule.innerWidth = 120; fakeWindowForModule.innerHeight = 200;
  windowListeners.get('resize')?.forEach(fn => fn()); await renderPet(); await advancePet(400); await petKey('ArrowLeft');
  check('a clamped key press that does not move the pet cannot invent a walk', petLeft === 0 && petNode().props['data-pet-action'] !== 'walk');
} catch (caught) {
  check('bundled local action behavior completes without throwing', false, String(caught instanceof Error ? caught.stack : caught));
} finally {
  unmountTestTree(); Date.now = actualNow; companionFetch = null;
}

const beforeChatCalls = callLog.length;
try {
  Date.now = () => petClock;
  await mountChat(false);
  const disabledSendCount = chatSends().length;
  check('opening companion only reads the Host and keeps input disabled without a configured model',
    chatInput().props.disabled === true && !!chatDialog() && !hostCompanion.messages.length
    && chatCalls().at(-1)?.method === 'GET' && chatCalls().at(-1)?.credentials === 'same-origin');
  await typeChat('不能假装有模型'); await clickChat('发送');
  check('an unconfigured companion cannot submit a request or invent a reply', chatSends().length === disabledSendCount
    && findNodes(chatDialog(), (n) => n.props.className === 'xls-chat-message').length === 0);
  await mountChat();
  check('overlay supplies styles and focuses a separate chat input before opening any community page',
    findNodes(petTree, (n) => n.type === 'style').length === 1 && inputFocusCount > 0
    && findNodes(petNode(), (n) => n.type === 'textarea').length === 0 && chatInput().props.disabled === false);
  const positionBeforeChat = store.get('xlb-pet-pos');
  await advancePet(7000);
  check('chat engagement disables wandering and sleep without freezing permitted sprite animation',
    store.get('xlb-pet-pos') === positionBeforeChat && ![...petTimers.values()].some((timer) => timer.interval === 7000 || timer.interval === 1000));
  await typeChat('中文输入');
  const beforeIme = chatSends().length;
  await chatKey('Enter', { composing: true }); await chatKey('Enter', { code: 229 }); await chatKey('Enter', { shift: true });
  check('IME composition, legacy IME Enter and Shift Enter do not send messages', chatSends().length === beforeIme);
  await typeChat(''); await chatKey('Enter');
  check('empty input does not send', chatSends().length === beforeIme);
  await typeChat('  你好，大肥鱼  ');
  const sendButton = chatButton('发送');
  sendButton.props.onClick?.({ preventDefault() {}, stopPropagation() {}, target: {} });
  sendButton.props.onClick?.({ preventDefault() {}, stopPropagation() {}, target: {} });
  await renderPet();
  check('two immediate clicks submit exactly one bounded request with a generated id', chatSends().length === beforeIme + 1
    && chatSends().at(-1)?.body?.text === '你好，大肥鱼' && typeof chatSends().at(-1)?.body?.requestId === 'string');
  check('accepted pending input is shown once outside committed history', hostCompanion.messages.length === 0
    && findNodes(chatDialog(), (n) => n.props['data-pending-job'] === hostCompanion.job?.id).length === 1
    && chatInput().props.value === '');
  check('preparing does not falsely animate the pet as model generation', petNode().props['data-pet-action'] !== 'think');
  check('busy chat disables duplicate send and clear actions', chatButton('发送').props.disabled === true
    && chatButton('清空对话').props.disabled === true && !!chatButton('停止回复'));
  finishCompanion('generating'); await advancePet(900);
  check('only actual Host generating state selects the pet thinking animation', petSprite()?.props['data-pet-action'] === 'think');
  check('polling targets the specific accepted job', chatCalls().some((entry) => entry.method === 'GET'
    && entry.url.includes('?jobId=' + encodeURIComponent(hostCompanion.job!.id))));
  finishCompanion('completed', '<img src=x onerror=alert(1)>这是纯文本');
  await advancePet(900);
  check('completion renders exactly the Host committed pair and removes the pending duplicate',
    findNodes(chatDialog(), (n) => typeof n.props['data-message-id'] === 'string').length === 2
    && findNodes(chatDialog(), (n) => typeof n.props['data-pending-job'] === 'string').length === 0);
  check('model content stays plain text without HTML, image nodes or HTML injection props',
    textOf(chatDialog()).includes('<img src=x onerror=alert(1)>这是纯文本')
    && findNodes(chatDialog(), (n) => n.type === 'img' || n.props.dangerouslySetInnerHTML !== undefined).length === 0);
  check('completed generation clears the busy animation and re-enables input', petNode().props['data-pet-action'] !== 'think'
    && chatInput().props.disabled === false);
  const deletesBefore = chatCalls().filter((entry) => entry.method === 'DELETE').length;
  await clickChat('清空对话');
  check('clear requires an explicit confirmation before contacting the Host', chatCalls().filter((entry) => entry.method === 'DELETE').length === deletesBefore
    && !!chatButton('确认清空') && hostCompanion.messages.length === 2);
  await clickChat('返回');
  check('dismissing clear confirmation preserves history', hostCompanion.messages.length === 2);
  await clickChat('清空对话'); await clickChat('确认清空');
  check('confirmed clear uses DELETE and refreshes the empty Host history', hostCompanion.messages.length === 0
    && chatCalls().filter((entry) => entry.method === 'DELETE').length === deletesBefore + 1
    && findNodes(chatDialog(), (n) => typeof n.props['data-message-id'] === 'string').length === 0);
  await typeChat('停止这一轮'); await chatKey('Enter'); finishCompanion('generating'); await advancePet(900);
  const cancelledJob = hostCompanion.job!.id;
  await clickChat('停止回复');
  check('Stop sends the actual job id to the Host cancellation endpoint',
    chatCalls().findLast((entry) => entry.path.endsWith('/cancel'))?.body?.jobId === cancelledJob);
  check('cancelled work restores the draft without committing fake history', chatInput().props.value === '停止这一轮'
    && hostCompanion.messages.length === 0 && petNode().props['data-pet-action'] !== 'think');
  await mountChat(); sendFailures = 1; await typeChat('网络重试');
  await clickChat('发送');
  const failedRequestId = chatSends().at(-1)?.body?.requestId;
  check('transport failure keeps the draft and exposes an actionable error', chatInput().props.value === '网络重试'
    && findNodes(chatDialog(), (n) => n.props.role === 'alert').length === 1 && !!chatButton('重新连接'));
  await clickChat('发送');
  check('ambiguous transport retry reuses its idempotent request id', chatSends().at(-1)?.body?.requestId === failedRequestId
    && hostCompanion.job?.requestId === failedRequestId);
  finishCompanion('failed'); await advancePet(900);
  check('a failed Host job restores its original input and leaves successful history untouched', chatInput().props.value === '网络重试'
    && hostCompanion.messages.length === 0);
  await clickChat('发送');
  check('retrying a known terminal failure creates a new request id', chatSends().at(-1)?.body?.requestId !== failedRequestId);
  finishCompanion('generating'); await advancePet(900);
  const cancellingBeforeClose = chatCalls().filter((entry) => entry.path.endsWith('/cancel')).length;
  const focusBeforeClose = petFocusCount;
  await clickChat('收起聊天');
  const closedCallCount = chatCalls().length;
  await advancePet(1800);
  check('closing stops polling and restores pet focus without cancelling Host work', !chatDialog()
    && chatCalls().length === closedCallCount && petFocusCount === focusBeforeClose + 1
    && chatCalls().filter((entry) => entry.path.endsWith('/cancel')).length === cancellingBeforeClose);
  finishCompanion('completed', '关窗期间完成');
  await petKey('Enter');
  check('reopening recovers Host completion instead of re-sending or losing history', textOf(chatDialog()).includes('关窗期间完成')
    && findNodes(chatDialog(), (n) => typeof n.props['data-message-id'] === 'string').length === 2);
  chatDialog()?.props.onKeyDown?.({ key: 'Escape', repeat: false, ctrlKey: false, altKey: false, metaKey: false,
    currentTarget: petTarget, preventDefault() {}, stopPropagation() {} }); await renderPet();
  check('Escape closes the nonmodal chat and returns keyboard focus', !chatDialog() && petFocusCount === focusBeforeClose + 2);
  await mountChat(); await typeChat('后台生成'); await clickChat('发送'); finishCompanion('generating'); await advancePet(900);
  fakeWindow.document!.hidden = true; documentListeners.get('visibilitychange')?.forEach((fn) => fn()); await renderPet();
  const hiddenCalls = chatCalls().length; await advancePet(2000);
  check('hidden chat removes every timer and makes no further polling requests', petTimers.size === 0 && chatCalls().length === hiddenCalls);
  finishCompanion('completed', '恢复可见时获取');
  fakeWindow.document!.hidden = false; documentListeners.get('visibilitychange')?.forEach((fn) => fn()); await renderPet();
  check('visible chat recovers actual Host state and completed messages', textOf(chatDialog()).includes('恢复可见时获取')
    && petNode().props['data-pet-action'] !== 'think');
  await mountChat();
  await clickChat('收起聊天'); holdCompanionGet = true; await petKey('Enter');
  const closedSignal = heldCompanion.signal;
  const lateView: CompanionView = { ...structuredClone(hostCompanion), messages: [{ id: 'late-message', role: 'assistant', text: '不应显示的迟到内容', createdAt: now() }],
    job: { id: 'late-job', requestId: 'late-request', state: 'generating', input: '迟到输入', createdAt: now() } };
  check('an in-flight chat read has an abortable request', !!heldCompanion.resolve && closedSignal?.aborted === false);
  await clickChat('收起聊天');
  check('closing aborts an in-flight read without issuing a Host cancel', closedSignal?.aborted === true && !chatDialog());
  heldCompanion.resolve?.(testResponse(lateView)); await renderPet();
  await petKey('Enter');
  check('late closed-window responses cannot overwrite a freshly reopened conversation', !textOf(chatDialog()).includes('不应显示的迟到内容')
    && petNode().props['data-pet-action'] !== 'think');
  await clickChat('收起聊天'); holdCompanionGet = true; await petKey('Enter');
  const hiddenSignal = heldCompanion.signal;
  fakeWindow.document!.hidden = true; documentListeners.get('visibilitychange')?.forEach((fn) => fn()); await renderPet();
  check('hiding aborts an in-flight read and removes all background timers', hiddenSignal?.aborted === true && petTimers.size === 0);
  heldCompanion.resolve?.(testResponse(lateView)); await renderPet();
  fakeWindow.document!.hidden = false; documentListeners.get('visibilitychange')?.forEach((fn) => fn()); await renderPet();
  check('late hidden-window responses are discarded when actual Host state is recovered', !textOf(chatDialog()).includes('不应显示的迟到内容')
    && petNode().props['data-pet-action'] !== 'think');
  await clickChat('收起聊天'); holdCompanionGet = true; await petKey('Enter');
  const unmountedSignal = heldCompanion.signal;
  unmountTestTree(); dirty = false;
  heldCompanion.resolve?.(testResponse(lateView)); await tick();
  check('unmount aborts outstanding reads and ignores their late state updates', unmountedSignal?.aborted === true && !dirty);
} catch (caught) {
  check('companion chat behavior suite completes without throwing', false, String(caught instanceof Error ? caught.stack : caught));
} finally {
  unmountTestTree(); Date.now = actualNow; companionFetch = null;
}
check('chat unmount removes its polling, visibility listeners and sprite timers', petTimers.size === 0
  && [...documentListeners.values()].every((listeners) => listeners.size === 0));
check('every companion request uses same-origin credentials and never the community ask route',
  callLog.slice(beforeChatCalls).filter((entry) => entry.path.startsWith('/api/companion')).every((entry) => entry.credentials === 'same-origin')
  && !callLog.slice(beforeChatCalls).some((entry) => entry.path === '/api/ask'));


// Social controls use their own DTO/Host fixture and never contact the community.
function socialFixture(): SocialView {
  return { ok: true, local: { settings: { version: 1, enabled: false, intervalMinutes: 60, startHour: 9, endHour: 22,
    timeZone: 'Asia/Shanghai', readLimit: 10, topics: [], draftPosts: true, draftReplies: true },
    configured: false, ready: true, running: false, stopping: false, nextRunAt: null, lastRunAt: null, lastResult: null, activity: [] },
    community: { connected: true, available: true, approvalUrl: 'https://approval.example.test/xiaolanshu/', policy: { ok: true,
      policy: { revision: 0, post: { requireApproval: true, dailyLimit: 1 }, reply: { requireApproval: true, dailyLimit: 3 }, expiresAt: null, updatedAt: null },
      effective: { post: 'review', reply: 'review' }, usage: { day: '2027-01-15', post: 0, reply: 0 }, pendingRequests: [] } } };
}
let socialHost = socialFixture();
let socialFailure: string | null = null;
let holdSocialGet = false;
const heldSocial = { resolve: null as ((value: TestFetchResponse) => void) | null, signal: undefined as AbortSignal | undefined };
function installSocialFixture() {
  socialFetch = async (url, options) => {
    const action = url.split('/').at(-1)!;
    if ((options.method || 'GET') === 'GET') {
      if (holdSocialGet) {
        holdSocialGet = false;
        return new Promise<TestFetchResponse>((resolve) => { heldSocial.resolve = resolve; heldSocial.signal = options.signal; });
      }
      return testResponse(structuredClone(socialHost));
    }
    if (socialFailure === action) { socialFailure = null; return testResponse({ ok: false }, 503); }
    if (action === 'settings') {
      socialHost.local.settings = JSON.parse(options.body || '{}') as SocialPreferences;
      socialHost.local.configured = true;
    } else if (action === 'run') {
      socialHost.local.running = true; socialHost.local.lastRunAt = new Date(petClock).toISOString();
    } else if (action === 'pause') {
      socialHost.local.settings.enabled = false; socialHost.local.stopping = socialHost.local.running;
    } else if (action === 'policy-request') {
      const update = JSON.parse(options.body || '{}') as SocialPolicyUpdate;
      if (!socialHost.community.policy || update.expectedRevision !== socialHost.community.policy.policy.revision) return testResponse({ ok: false }, 409);
      const id = 'social-request-' + (socialHost.community.policy.pendingRequests.length + 1);
      socialHost.community.policy.pendingRequests.push({ id, action: 'social_policy', payload: update, status: 'pending',
        createdAt: new Date(petClock).toISOString(), expiresAt: new Date(petClock + 86400000).toISOString() });
      return testResponse({ ...structuredClone(socialHost), request: { id, status: 'pending' } });
    }
    return testResponse(structuredClone(socialHost));
  };
}
const socialCalls = () => callLog.filter((entry) => entry.path === '/api/social' || entry.path.startsWith('/api/social/'));
const socialWrites = () => socialCalls().filter((entry) => entry.method === 'POST');
function socialField(id: string) {
  const node = findNodes(petTree, (entry) => entry.props['data-social-field'] === id)[0];
  if (!node) throw new Error('Missing social field: ' + id);
  return node;
}
function socialAction(action: string) {
  const node = findNodes(petTree, (entry) => entry.props['data-social-action'] === action)[0];
  if (!node) throw new Error('Missing social action: ' + action);
  return node;
}
async function socialEdit(field: string, value: string | boolean) {
  socialField(field).props.onChange?.({ target: { value: typeof value === 'string' ? value : '', ...(typeof value === 'boolean' ? { checked: value } : {}) } });
  await renderPet();
}
async function socialClick(action: string) {
  socialAction(action).props.onClick?.({ preventDefault() {}, stopPropagation() {}, target: {} }); await renderPet();
}
async function socialLabel(label: string) {
  const node = findNodes(petTree, (entry) => entry.type === 'button' && textOf(entry) === label)[0];
  if (!node) throw new Error('Missing social button: ' + label);
  node.props.onClick?.({ preventDefault() {}, stopPropagation() {}, target: {} }); await renderPet();
}
const effectiveMode = (action: string) => findNodes(petTree, (node) => node.props['data-social-effective'] === action)[0]?.props['data-effective-mode'];
const runtimeState = () => findNodes(petTree, (node) => node.props['data-social-runtime'] !== undefined)[0]?.props['data-social-runtime'];
async function mountSocial() {
  unmountTestTree(); socialHost = socialFixture(); socialFailure = null; holdSocialGet = false; socialFocused = null;
  fakeWindow.document!.hidden = false; installSocialFixture();
  lastRoot = FakeReact.createElement(components['xiaolanshu-social']!, {});
  await renderPet();
}
const socialStart = callLog.length;
try {
  Date.now = () => petClock;
  check('social settings has a separate main component without replacing community or pet', !!components['xiaolanshu-social']
    && !!components.xiaolanshu && !!components['xiaolanshu-pet']);
  await mountSocial();
  check('the actual settings page starts with both approval switches checked and default quotas',
    socialField('postApproval').props.checked === true && socialField('replyApproval').props.checked === true
    && socialField('postLimit').props.value === '1' && socialField('replyLimit').props.value === '3'
    && effectiveMode('post') === 'review' && effectiveMode('reply') === 'review');
  check('local automation starts disabled and reads the Host without issuing model work',
    socialField('enabled').props.checked === false && socialCalls().at(-1)?.method === 'GET' && socialWrites().length === 0);
  await socialEdit('enabled', true);
  check('editing a local checkbox does not persist or confer server authorization',
    socialHost.local.settings.enabled === false && socialWrites().length === 0 && effectiveMode('post') === 'review');
  await socialEdit('intervalMinutes', '');
  await socialClick('save');
  check('invalid numeric settings are not posted and focus their error field', socialWrites().length === 0
    && socialField('intervalMinutes').props['aria-invalid'] === true && socialFocused === 'intervalMinutes');
  await socialEdit('intervalMinutes', '45'); await socialEdit('endHour', '9'); await socialClick('save');
  check('same-day active hours require start before end', socialWrites().length === 0 && socialField('endHour').props['aria-invalid'] === true);
  await socialEdit('endHour', '24'); await socialEdit('timeZone', 'invalid/timezone'); await socialClick('save');
  check('unknown reading time zones are rejected without a Host write', socialWrites().length === 0 && socialFocused === 'timeZone');
  await socialEdit('timeZone', 'Asia/Shanghai');
  await socialEdit('topics', '1,2,3,4,5,6,7,8,9'); await socialClick('save');
  check('too many interests are rejected without losing the edit', socialWrites().length === 0 && socialField('topics').props.value === '1,2,3,4,5,6,7,8,9');
  await socialEdit('topics', '技术, 科研,技术');
  const save = socialAction('save');
  save.props.onClick?.({ preventDefault() {}, stopPropagation() {}, target: {} });
  save.props.onClick?.({ preventDefault() {}, stopPropagation() {}, target: {} }); await renderPet();
  const saved = socialWrites().at(-1);
  check('saving sends one complete validated local settings object', socialWrites().length === 1 && saved?.path === '/api/social/settings'
    && saved.body?.version === 1 && saved.body.enabled === true && saved.body.intervalMinutes === 45
    && saved.body.endHour === 24 && Array.isArray(saved.body.topics) && saved.body.topics.length === 2
    && socialHost.local.configured && socialField('topics').props.value === '技术, 科研');
  check('saving local automation leaves current server policy in review mode', effectiveMode('post') === 'review' && effectiveMode('reply') === 'review');
  await socialEdit('intervalMinutes', '90'); socialHost.local.nextRunAt = new Date(petClock + 60000).toISOString();
  await advancePet(4000);
  check('status polling preserves unsaved settings instead of overwriting the user draft', socialField('intervalMinutes').props.value === '90'
    && socialHost.local.settings.intervalMinutes === 45 && socialAction('run').props.disabled === true);
  socialFailure = 'settings'; await socialClick('save');
  check('a failed save preserves the draft and does not claim saved Host state', socialField('intervalMinutes').props.value === '90'
    && socialHost.local.settings.intervalMinutes === 45 && findNodes(petTree, (node) => node.props.role === 'alert').length === 1);
  await advancePet(4000);
  check('a successful background status poll does not erase an action error', findNodes(petTree, (node) => node.props.role === 'alert').length === 1);
  await socialClick('save'); await socialClick('run');
  check('Read now posts to the local Host and uses the returned actual running state', socialWrites().at(-1)?.path === '/api/social/run'
    && runtimeState() === 'running' && socialAction('run').props.disabled === true);
  await socialClick('pause');
  check('Pause disables future runs but displays stopping until the current run has ended', socialWrites().at(-1)?.path === '/api/social/pause'
    && socialField('enabled').props.checked === false && runtimeState() === 'stopping' && socialAction('pause').props.disabled === true);
  socialHost.local.running = false; socialHost.local.stopping = false;
  socialHost.local.activity = [{ id: 'social-run-1', startedAt: new Date(petClock - 5000).toISOString(), finishedAt: new Date(petClock).toISOString(),
    status: 'cancelled', feedReads: 7, published: 1, pending: 2 }];
  await advancePet(4000);
  check('only a later Host snapshot marks the run fully paused and exposes its real activity counts',
    runtimeState() === 'paused' && findNodes(petTree, (node) => node.props['data-social-activity'] === 'social-run-1').length === 1
    && textOf(findNodes(petTree, (node) => node.props['data-social-activity'] === 'social-run-1')[0]).includes('7'));
  await socialEdit('postApproval', false);
  check('turning off a confirmation switch changes only the request draft, never the effective policy',
    socialField('postApproval').props.checked === false && socialHost.community.policy?.policy.post.requireApproval === true
    && effectiveMode('post') === 'review');
  const beforePolicy = socialWrites().length;
  await socialClick('request');
  check('automatic publishing needs an explicit finite authorization duration', socialWrites().length === beforePolicy && socialField('duration').props['aria-invalid'] === true);
  await socialEdit('duration', '169'); await socialClick('request');
  check('an authorization longer than seven days is not submitted', socialWrites().length === beforePolicy && socialFocused === 'duration');
  await socialEdit('duration', '24'); await socialEdit('postLimit', '6'); await socialClick('request');
  check('post quota cannot exceed the server contract', socialWrites().length === beforePolicy && socialFocused === 'postLimit');
  await socialEdit('postLimit', '1'); await socialEdit('replyLimit', '21'); await socialClick('request');
  check('reply quota cannot exceed the server contract', socialWrites().length === beforePolicy && socialFocused === 'replyLimit');
  await socialEdit('replyLimit', '3');
  await socialEdit('duration', '24');
  const requestButton = socialAction('request');
  requestButton.props.onClick?.({ preventDefault() {}, stopPropagation() {}, target: {} });
  requestButton.props.onClick?.({ preventDefault() {}, stopPropagation() {}, target: {} }); await renderPet();
  const requested = socialWrites().at(-1);
  check('authorization submission is a single revision-bound request with separate post and reply policies',
    socialWrites().length === beforePolicy + 1 && requested?.path === '/api/social/policy-request'
    && requested.body?.expectedRevision === 0 && requested.body.durationHours === 24
    && socialHost.community.policy?.pendingRequests[0]?.payload.post.requireApproval === false
    && socialHost.community.policy.pendingRequests[0].payload.reply.requireApproval === true);
  check('a pending receipt does not activate automatic publishing and prevents duplicate requests',
    effectiveMode('post') === 'review' && socialAction('request').props.disabled === true
    && findNodes(petTree, (node) => node.props['data-social-request'] === 'social-request-1').length === 1);
  const live = socialHost.community.policy!;
  live.policy = { ...live.policy, revision: 1, post: { requireApproval: false, dailyLimit: 1 },
    expiresAt: new Date(petClock + 2000).toISOString(), updatedAt: new Date(petClock).toISOString() };
  live.effective.post = 'auto'; live.pendingRequests = [];
  await advancePet(4000);
  check('an expired authorization displays review even if a stale cached effective flag says auto', effectiveMode('post') === 'review');
  check('a server policy revision change does not silently rebase an edited authorization form',
    socialField('postApproval').props.checked === false && socialAction('request').props.disabled === true);
  await socialLabel('按当前策略重新填写');
  check('explicitly reloading policy rebases the request form to the current server revision', socialAction('request').props.disabled === false);
  await socialEdit('postApproval', true); await socialEdit('duration', '0');
  await socialClick('request');
  check('an all-review request may use zero hours and the explicitly reloaded revision',
    socialWrites().at(-1)?.body?.expectedRevision === 1 && socialWrites().at(-1)?.body?.durationHours === 0
    && socialHost.community.policy!.pendingRequests[0]?.payload.post.requireApproval === true);
  await mountSocial();
  await socialEdit('replyApproval', false); await socialEdit('duration', '12');
  socialHost.community.policy!.policy.revision = 5;
  await socialClick('request');
  check('an unseen server revision conflict retains the old expectedRevision and request draft',
    socialWrites().at(-1)?.body?.expectedRevision === 0 && socialField('replyApproval').props.checked === false
    && findNodes(petTree, (node) => node.props.role === 'alert').length === 1
    && socialHost.community.policy!.pendingRequests.length === 0);
  await advancePet(4000);
  check('polling reveals a revision conflict without changing the unsent duration', socialAction('request').props.disabled === true
    && socialField('duration').props.value === '12');
  await mountSocial();
  socialHost.community.connected = false; socialHost.community.available = false; socialHost.community.policy = null;
  socialHost.local.settings.enabled = true; socialHost.local.running = true;
  await advancePet(4000);
  check('offline community disables reading and policy requests while leaving emergency Pause available',
    socialAction('run').props.disabled === true && socialAction('request').props.disabled === true && socialAction('pause').props.disabled === false);
  await socialClick('pause');
  check('Pause remains a local operation even when the community is disconnected', socialWrites().at(-1)?.path === '/api/social/pause'
    && runtimeState() === 'stopping');
  await mountSocial();
  const visibleCalls = socialCalls().length; await advancePet(4000);
  check('an active settings page refreshes the Host every four seconds', socialCalls().length === visibleCalls + 1);
  holdSocialGet = true; await advancePet(4000);
  const hiddenSignal = heldSocial.signal;
  fakeWindow.document!.hidden = true; documentListeners.get('visibilitychange')?.forEach((fn) => fn()); await renderPet();
  const callsWhileHidden = socialCalls().length;
  await advancePet(8000);
  check('hidden settings aborts the pending read and stops all polling timers', hiddenSignal?.aborted === true
    && petTimers.size === 0 && socialCalls().length === callsWhileHidden);
  const staleView = socialFixture(); staleView.local.settings.intervalMinutes = 999;
  heldSocial.resolve?.(testResponse(staleView)); await renderPet();
  fakeWindow.document!.hidden = false; documentListeners.get('visibilitychange')?.forEach((fn) => fn()); await renderPet();
  check('a late hidden-page response is ignored when live settings resume', socialField('intervalMinutes').props.value === '60');
  holdSocialGet = true; await advancePet(4000); const oldGet = heldSocial.resolve;
  await socialEdit('intervalMinutes', '75'); await socialClick('save');
  oldGet?.(testResponse(staleView)); await renderPet();
  check('a GET issued before a settings save cannot overwrite the successful mutation snapshot',
    socialField('intervalMinutes').props.value === '75' && socialHost.local.settings.intervalMinutes === 75);
  await socialLabel('返回鲸群');
  check('the settings Back action retains the original community panel key', selectedPanels.at(-1) === 'xiaolanshu');
  holdSocialGet = true; await advancePet(4000); const unmountSignal = heldSocial.signal;
  unmountTestTree(); dirty = false; heldSocial.resolve?.(testResponse(staleView)); await tick();
  check('unmount aborts settings requests and discards their late state updates', unmountSignal?.aborted === true && !dirty);
  // The chat entry uses navigation only; it never grants server authority.
  socialFetch = null; await mountChat();
  const beforeNavigationWrites = socialWrites().length;
  await clickChat('社交设置');
  check('desktop chat opens the dedicated social settings panel and closes its dialog', !chatDialog()
    && selectedPanels.at(-1) === 'xiaolanshu-social' && socialWrites().length === beforeNavigationWrites);
} catch (caught) {
  check('social settings behavior suite completes without throwing', false, String(caught instanceof Error ? caught.stack : caught));
} finally {
  unmountTestTree(); socialFetch = null; companionFetch = null; Date.now = actualNow;
}
check('social settings cleans timers and listeners on departure', petTimers.size === 0
  && [...documentListeners.values()].every((listeners) => listeners.size === 0));
check('social controls use only same-origin local endpoints without owner credentials or direct community writes',
  callLog.slice(socialStart).filter((entry) => entry.path.startsWith('/api/social')).every((entry) => entry.credentials === 'same-origin'
    && !JSON.stringify(entry.body).includes('token'))
  && !callLog.slice(socialStart).some((entry) => ['/api/post', '/api/reply', '/api/ask', '/api/proposals/approve'].includes(entry.path)));


console.log('');
if (failures.length === 0) {
  console.log('ALL PASS');
  process.exit(0);
}
console.log(failures.length + ' FAILED');
process.exit(1);
