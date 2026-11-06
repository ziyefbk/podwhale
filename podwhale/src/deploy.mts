/** Safe deployment: validate, preflight, test, stage, back up, publish, verify. */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nodeBin } from './runtime.mjs';
import { runDeployment } from './deployment.mjs';

const args = process.argv.slice(2);
if (args.some((arg) => arg !== '--preflight')) {
  console.error('Usage: node deploy.mjs [--preflight]');
  process.exit(1);
}
try {
  const result = await runDeployment({
    repoRoot: resolve(fileURLToPath(new URL('..', import.meta.url))),
    node: await nodeBin(),
    preflightOnly: args.includes('--preflight'),
    log: (message) => console.log(message),
  });
  console.log(result.preflight ? 'Read-only preflight passed.' : 'Deployment passed source and security checks.');
  if (result.backupDir) console.log('Backups retained at ' + result.backupDir);
} catch (caught) {
  const error = caught as Error & { detail?: string };
  console.error(error.message);
  if (error.detail) console.error(error.detail);
  process.exit(1);
}
