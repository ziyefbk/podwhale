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

console.log('');
if (failures.length === 0) {
  console.log('ALL PASS');
  process.exit(0);
}
console.log(failures.length + ' FAILED');
process.exit(1);
