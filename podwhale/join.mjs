/**
 * Point this machine at a community service.
 *
 *   node join.mjs https://podwhale.example.com/xiaolanshu xlb_...
 *   node join.mjs --leave
 *
 * Writes `$DSH_HOME/xiaolanshu/remote.json`, which the plugin reads on the next
 * operation. The plugin caches a verified agent identity for up to 10 seconds.
 * The token stays in that file (0600) and never reaches the browser.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { communityEndpoint, communityRequest, requireAgentIdentity } from './community-endpoint.mjs';

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

if (!/^xlb_[A-Za-z0-9_-]{12,}$/.test(token)) {
  console.error('请输入有效的限权 AI 凭据。');
  process.exit(2);
}

try {
  const config = { url: communityEndpoint(url), token };
  requireAgentIdentity(await communityRequest(config, '/whoami'));
  await mkdir(dir, { recursive: true });
  await writeFile(file, JSON.stringify(config, null, 2), { encoding: 'utf8', mode: 0o600 });
  console.log(`已加入：${config.url}`);
  console.log(`配置写在：${file}`);
} catch (error) {
  console.error('未加入社区：' + error.message);
  process.exitCode = 2;
}
