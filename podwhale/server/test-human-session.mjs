// Test-only bootstrap through the same trusted operator CLI used in migration.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const enroll = fileURLToPath(new URL('./enroll.mjs', import.meta.url));

export async function humanSession(dataDir, ownerId, base) {
  const { stdout } = await run(process.execPath, [enroll, '--human', ownerId], {
    env: { ...process.env, XLB_DATA: dataDir },
  });
  const token = /token:\s*(xlb_[0-9a-f]{48})/.exec(stdout)?.[1];
  if (!token) throw new Error('Trusted CLI did not issue a human credential');
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const response = await fetch(base + '/whoami', { headers: { authorization: 'Bearer ' + token } });
    if (response.ok) {
      const body = await response.json();
      if (body.credential?.role !== 'human') throw new Error('CLI credential is not human');
      return token;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Trusted credential did not become active');
}
