/**
 * 小程序的静态检查：开发者工具跑不了，但大部分错是"引用了不存在的东西"。
 *
 *   node test-miniprogram.mjs
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(HERE, 'miniprogram');
const serverSource = readFileSync(join(HERE, 'server/community.mjs'), 'utf8');

const failures = [];
function check(name: string, ok: unknown, detail: unknown = "") {
  if (!ok) failures.push(name + (detail ? ' — ' + detail : ''));
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  — ' + detail : ''}`);
}

// 1. 配置文件必须是合法 JSON
for (const file of ['app.json', 'project.config.json', 'sitemap.json']) {
  let ok = false;
  let detail = '';
  try {
    JSON.parse(readFileSync(join(ROOT, file), 'utf8'));
    ok = true;
  } catch (caught) { const error = caught as Error & { code?: string; status?: number; phase?: string; stopped?: boolean; detail?: string; };
    detail = String(error.message);
  }
  check(`${file} parses`, ok, detail);
}

const app = JSON.parse(readFileSync(join(ROOT, 'app.json'), 'utf8'));

// 2. 每个页面都要有 js 和 wxml
const missing = [];
for (const page of app.pages) {
  for (const ext of ['.js', '.wxml']) {
    if (!existsSync(join(ROOT, page + ext))) missing.push(page + ext);
  }
}
check('every declared page has js and wxml', missing.length === 0, missing.join(', '));

// 3. tabBar 指向的页面必须在 pages 里
const orphans = (app.tabBar && app.tabBar.list ? app.tabBar.list : [])
  .map((item: { pagePath: string }) => item.pagePath)
  .filter((path: string) => app.pages.indexOf(path) < 0);
check('every tab points at a declared page', orphans.length === 0, orphans.join(', '));

// 4. WXML 里绑的事件处理函数必须在同页 js 里定义
const routes = new Set([...serverSource.matchAll(/path === '([^']+)'/g)].map((match) => match[1]!));
for (const page of app.pages) {
  const wxml = readFileSync(join(ROOT, page + '.wxml'), 'utf8');
  const js = readFileSync(join(ROOT, page + '.js'), 'utf8');
  const handlers = new Set([...wxml.matchAll(/\b(?:bind|catch)(?:tap|input|change|confirm|submit)="([A-Za-z_$][\w$]*)"/g)].map((match) => match[1]!));
  const undeclared = [...handlers].filter((name) => !new RegExp('\\b' + name + '\\s*\\(').test(js));
  check(`${page} handlers exist`, undeclared.length === 0, undeclared.join(', '));

  // 5. 页面调用的接口必须真的存在
  const paths = new Set([...js.matchAll(/request\('([^'?]+)/g)].map((match) => match[1]!));
  check(`${page} API scan covers calls`, paths.size > 0, paths.size);
  const unknown = [...paths].filter((path: string) => !routes.has(path));
  check(`${page} api paths are served`, unknown.length === 0, unknown.join(', '));
}

// 6. 全局 app.js 和工具库也检查一遍
for (const file of ['app.js', 'utils/api.js']) {
  const source = readFileSync(join(ROOT, file), 'utf8');
  const paths = new Set([...source.matchAll(/request\('([^'?]+)/g)].map((match) => match[1]!));
  const unknown = [...paths].filter((path: string) => !routes.has(path));
  check(`${file} api paths are served`, unknown.length === 0, unknown.join(', '));
}

console.log('');
if (failures.length === 0) {
  console.log('ALL PASS');
  process.exit(0);
}
console.log(failures.length + ' FAILED');
process.exit(1);
