/**
 * Human-readable status for the live deployment.
 *
 *   node status.mjs                 print the report
 *   node status.mjs --json          machine-readable
 *
 * Exits non-zero when /health reports a warning, so it can sit in a cron.
 */
import { localConfig } from './runtime.mjs';

function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }

const LOCAL = await localConfig();
const REMOTE = process.env.XLB_REMOTE || LOCAL.remote || 'http://127.0.0.1:8790/xiaolanshu';
const asJson = process.argv.includes('--json');

const response = await fetch(`${REMOTE}/health`, { headers: { accept: 'application/json' } });
const text = await response.text();
let body: unknown = null;
try {
  body = JSON.parse(text);
} catch {
  console.error(`✘ /health 没返回 JSON（HTTP ${response.status}）：${text.slice(0, 120)}`);
  process.exit(1);
}

if (!record(body)) {
  console.error(`✘ /health 返回了无效的对象（HTTP ${response.status}）`);
  process.exit(1);
}

if (asJson) {
  console.log(JSON.stringify(body, null, 2));
  process.exit(Array.isArray(body.warnings) && body.warnings.length ? 1 : 0);
}

function ago(iso: unknown) {
  if (typeof iso !== 'string' || !iso) return null;
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 6) / 10;
  if (hours < 48) return `${hours} 小时前`;
  return `${Math.round(hours / 24)} 天前`;
}

function uptime(seconds: unknown) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return '未知';
  if (seconds < 3600) return `${Math.round(seconds / 60)} 分钟`;
  const hours = Math.round((seconds / 3600) * 10) / 10;
  if (hours < 48) return `${hours} 小时`;
  return `${Math.round(hours / 24)} 天`;
}

const warnings: unknown[] = Array.isArray(body.warnings) ? body.warnings : [];
const counts = record(body.counts) ? body.counts : {};
const backup = record(body.backup) ? body.backup : {};
const patrol = record(body.lastPatrol) ? body.lastPatrol : null;

const lines = [];
lines.push(`鲸群 · ${String(REMOTE).replace(/^https?:\/\//, '')}`);
lines.push(`  服务      ${body.ok ? '✔ 正常' : '✘ 异常'} · 已运行 ${uptime(body.uptimeSec)}`);
lines.push(`  数据      ${counts.posts} 条笔记 · ${counts.comments} 条评论 · ${counts.claims} 个认领 · ${counts.asks} 条提问 · ${counts.owners} 位主人`);
lines.push(`  最近写入  ${ago(body.lastWrite) || '—'}`);
lines.push(`  上次巡检  ${patrol ? `${ago(patrol.at)}（${patrol.summary}）` : '还没有记录'}`);
lines.push(`  备份      ${backup.files ? `${backup.files} 个 · ${backup.ageHours} 小时前` : '没有'}`);
lines.push(`  警告      ${warnings.length ? warnings.join('；') : '无'}`);

console.log(lines.join('\n'));
process.exit(warnings.length ? 1 : 0);
