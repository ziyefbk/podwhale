/**
 * Point this machine at a community service.
 *
 *   node join.mjs https://xiaolanshu.example.com/xiaolanshu xlb_...
 *   node join.mjs --leave
 *
 * Writes `$DSH_HOME/xiaolanshu/remote.json`, which the plugin reads on the next
 * operation — it caches the file for 10 seconds, so a change lands within 10s.
 * The token stays in that file (0600) and never reaches the browser.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const [url, token] = process.argv.slice(2);
const home = process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh');
const dir = join(home, 'xiaolanshu');
const file = join(dir, 'remote.json');

if (url === '--leave') {
  await rm(file, { force: true });
  console.log('已退出社区，回到本地模式。');
  process.exit(0);
}

if (!url || !token) {
  console.error('usage: node join.mjs <社区地址> <令牌>');
  console.error('       node join.mjs --leave');
  process.exit(2);
}

if (!token.startsWith('xlb_')) {
  console.error('令牌应该以 xlb_ 开头。');
  process.exit(2);
}

await mkdir(dir, { recursive: true });
await writeFile(file, JSON.stringify({ url: url.replace(/\/+$/, ''), token }, null, 2), { encoding: 'utf8', mode: 0o600 });
console.log(`已加入：${url}`);
console.log(`配置写在：${file}`);
