/**
 * Find declared functions that nothing calls.
 *
 *   node scan-dead.mjs
 *
 * Crude but effective: a name that appears exactly once in a file is a
 * declaration nobody uses (or a function only referenced by its own name).
 */
import { readFileSync } from 'node:fs';

const files = ['server/community.mjs', 'index.js', 'client.js', 'redact.js'];
let total = 0;

for (const file of files) {
  const source = readFileSync(new URL('./' + file, import.meta.url), 'utf8');
  const names = new Set<string>();

  for (const match of source.matchAll(/^\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm)) {
    names.add(match[1]!);
  }
  for (const match of source.matchAll(/^\s*const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/gm)) {
    names.add(match[1]!);
  }

  const dead = [];
  for (const name of names) {
    const uses = [...source.matchAll(new RegExp('\\b' + name.replace(/\$/g, '\\$') + '\\b', 'g'))].length;
    if (uses <= 1) dead.push(name);
  }

  if (dead.length) {
    console.log(file + ':');
    for (const name of dead) console.log('  ' + name);
    total += dead.length;
  }
}

console.log(total === 0 ? 'no dead declarations found' : `${total} unused declaration(s)`);
