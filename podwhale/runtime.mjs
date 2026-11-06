/**
 * 选一个"能跑 node:sqlite"的 Node。
 *
 * 服务端要 Node ≥22.5，但开发机上跑 DSH 的 Node 可能是 20。
 * 仓库里带了 .tools/node24 时优先用它，这样 `node deploy.mjs` 也不必手动切版本。
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readLocalConfig } from './private-config.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));

export async function nodeBin() {
  try {
    await import('node:sqlite');
    return process.execPath;
  } catch (error) {
    const candidates = [
      join(HERE, '..', '.tools', 'node24', 'node.exe'),
      join(HERE, '..', '.tools', 'node24', 'bin', 'node'),
      '/usr/local/bin/node24',
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate;
    }
    return process.execPath;
  }
}

/**
 * 本机私有部署信息（`local.json`，不进仓库）：部署地址、主机、用户。
 * 源码里只留 localhost 默认值，避免把生产机地址带进公开仓库。
 */
export async function localConfig(env = process.env) {
  return readLocalConfig({ packageDir: HERE, env });
}
