/** Bootstrap only: the compiler is a development tool, never a runtime import. */
import ts from 'typescript';
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = join(root, 'src');
const args = new Set(process.argv.slice(2));
if (args.size > 1 || [...args].some((arg) => !['--check', '--typecheck'].includes(arg))) throw new Error('Usage: node tools/build.mjs [--check|--typecheck]');
const checkOnly = args.has('--check');
const typesOnly = args.has('--typecheck');
const normalize = (path) => path.replaceAll('\\', '/');
async function walk(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await walk(path));
    else result.push(path);
  }
  return result.sort();
}
const sources = (await walk(sourceRoot)).filter((path) => /\.(?:m?ts)$/.test(path) && !/\.d\.ts$/.test(path));
// Type escapes hide migration errors. Deliberate negative type tests use
// @ts-expect-error with an explanation and are checked by the compiler.
for (const path of await walk(sourceRoot)) {
  if (!/\.(?:m?ts)$/.test(path)) continue;
  const text = await readFile(path, 'utf8');
  const tree = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  if (/@ts-(?:ignore|nocheck)\b/.test(text)) throw new Error('Suppressed type checking: ' + relative(root, path));
  function inspect(node) {
    if (node.kind === ts.SyntaxKind.AnyKeyword) throw new Error('Explicit any: ' + relative(root, path));
    ts.forEachChild(node, inspect);
  }
  inspect(tree);
}
const parsed = ts.getParsedCommandLineOfConfigFile(join(root, 'tsconfig.json'), {}, {
  ...ts.sys, onUnRecoverableConfigFileDiagnostic(diagnostic) { throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')); },
});
if (!parsed) throw new Error('Cannot read tsconfig');
if (parsed.errors.length) throw new Error(ts.formatDiagnostics(parsed.errors, { getCurrentDirectory: () => root, getCanonicalFileName: (path) => path, getNewLine: () => '\n' }));
for (const option of ['strict', 'noUncheckedIndexedAccess', 'exactOptionalPropertyTypes', 'useUnknownInCatchVariables', 'noEmitOnError']) {
  if (parsed.options[option] !== true) throw new Error('Required compiler option: ' + option);
}
for (const option of ['noImplicitAny', 'noImplicitThis', 'strictNullChecks', 'strictFunctionTypes',
  'strictBindCallApply', 'strictPropertyInitialization', 'alwaysStrict']) {
  if (parsed.options[option] === false) throw new Error('Strict compiler option disabled: ' + option);
}
const outputRoot = resolve(root, parsed.options.outDir);
const outputs = new Map();
const checkedSources = new Set();
function compile(files, options) {
  const program = ts.createProgram(files, options);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length) {
    process.stderr.write(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCurrentDirectory: () => root, getCanonicalFileName: (path) => path, getNewLine: () => '\n',
    }));
    process.exitCode = 1;
    return;
  }
  for (const source of program.getSourceFiles()) checkedSources.add(resolve(source.fileName));
  const emitted = program.emit(undefined, (path, text) => {
    const target = normalize(relative(outputRoot, path));
    if (target.startsWith('../') || resolve(outputRoot, target) === outputRoot) throw new Error('Unsafe compiler output');
    if (outputs.has(target) && outputs.get(target) !== text) throw new Error('Conflicting compiler output: ' + target);
    outputs.set(target, text);
  });
  if (emitted.emitSkipped) throw new Error('Compiler did not emit JavaScript');
}
compile(parsed.fileNames, parsed.options);
// DSH's loader and WeChat load classic scripts. Separate programs preserve
// that execution model and keep their global environments independent.
const scriptEntries = sources.filter((path) => /\/(?:browser|miniprogram)\//.test(normalize(path)) || path === join(sourceRoot, 'client.ts'));
for (const entry of scriptEntries) {
  const environment = entry.endsWith('client.ts') ? 'client' : normalize(entry).includes('/miniprogram/') ? 'mini' : 'browser';
  const declaration = join(sourceRoot, 'types', environment + '.d.ts');
  const files = [entry];
  if (environment === 'browser') {
    const declarations = ['browser-common.d.ts', 'browser-' + basename(entry).replace('.ts', '.d.ts')];
    for (const name of declarations) files.push(join(sourceRoot, 'types', name));
  }
  try { await readFile(declaration); files.push(declaration); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  compile(files, { ...parsed.options, module: ts.ModuleKind.None, moduleResolution: ts.ModuleResolutionKind.Node10,
    moduleDetection: ts.ModuleDetectionKind.Legacy, verbatimModuleSyntax: false,
    types: environment === 'client' ? ['react'] : [], lib: ['lib.es2023.d.ts', 'lib.dom.d.ts'] });
}
if (process.exitCode) process.exit(process.exitCode);
for (const path of sources) if (!checkedSources.has(resolve(path))) throw new Error('Source excluded from type checking: ' + relative(root, path));
const markers = { 'server/mobile.mjs': ['__PODWHALE_MOBILE_SCRIPT__', 'browser/mobile.js'],
  'server/page.mjs': ['__PODWHALE_PAGE_SCRIPT__', 'browser/page.js'] };
for (const [target, [marker, script]] of Object.entries(markers)) {
  if (!outputs.has(script) || !outputs.has(target)) throw new Error('Missing inline script or template: ' + target);
  if (/<\/script\b/i.test(outputs.get(script))) throw new Error('Inline script contains an HTML closing tag: ' + script);
  const text = outputs.get(target);
  const pattern = new RegExp('([\'\"])' + marker + '\\1', 'g');
  const matches = [...text.matchAll(pattern)];
  if (matches.length !== 1) throw new Error('Expected one inline script marker: ' + target);
  outputs.set(target, text.replace(pattern, () => JSON.stringify(outputs.get(script))));
  outputs.delete(script);
}
const baseline = JSON.parse(await readFile(join(root, 'tools/source-inventory.json'), 'utf8'));
const missing = baseline.filter((file) => !outputs.has(file));
if (missing.length) throw new Error('Unmigrated source files: ' + missing.join(', '));
const runtimeFiles = [...(await readdir(root)).filter((file) => /\.(?:m?js)$/.test(file)),
  ...(await walk(join(root, 'server'))).filter((file) => /\.(?:m?js)$/.test(file)).map((file) => normalize(relative(root, file))),
  ...(await walk(join(root, 'miniprogram'))).filter((file) => /\.js$/.test(file)).map((file) => normalize(relative(root, file)))];
for (const file of runtimeFiles) if (!outputs.has(file)) throw new Error('JavaScript has no TypeScript source: ' + file);
if (!typesOnly) {
  for (const [path, text] of outputs) {
    const destination = join(root, path);
    if (checkOnly) {
      if (await readFile(destination, 'utf8') !== text) throw new Error('Stale generated JS: ' + path + '; run npm run build');
    } else {
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, text);
    }
  }
}
console.log(`${typesOnly ? 'Typecheck' : checkOnly ? 'Build consistency' : 'Build'} passed: ${sources.length} TypeScript sources, ${outputs.size} JavaScript outputs`);
