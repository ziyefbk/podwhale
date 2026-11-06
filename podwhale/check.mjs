/**
 * One command that answers "is everything actually fine?".
 *
 *   node check.mjs            local suites + live server
 *   node check.mjs --local    local suites only
 *
 * Exits non-zero when anything fails, so it can gate a deploy.
 */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nodeBin, localConfig } from './runtime.mjs';
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function failureMessage(error) { return String(object(error) && error.message ? error.message : error); }
const HERE = fileURLToPath(new URL('.', import.meta.url));
const NODE = await nodeBin();
if (existsSync(join(HERE, 'src'))) {
    execFileSync(NODE, [join(HERE, 'tools', 'build.mjs'), '--check'], {
        cwd: HERE, stdio: 'inherit', windowsHide: true, timeout: 120000,
    });
}
const LOCAL = await localConfig();
const REMOTE = process.env.XLB_REMOTE || LOCAL.remote || 'http://127.0.0.1:8790/xiaolanshu';
const localOnly = process.argv.includes('--local');
const liveOnly = process.argv.includes('--live-only');
const results = [];
function record(group, name, ok, detail) {
    results.push({ group, name, ok, detail });
}
function runSuite(file) {
    return new Promise((resolve) => {
        // 临时目录固定在仓库内：某些环境（沙箱、CI）对系统 TEMP 没有写权限，
        // 而几乎每个套件都要 mkdtemp。
        const temp = join(HERE, '..', '.tmp');
        mkdirSync(temp, { recursive: true });
        const child = spawn(NODE, [join(HERE, file)], {
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, TEMP: temp, TMP: temp, TMPDIR: temp },
        });
        let output = '';
        child.stdout.on('data', (chunk) => { output += chunk; });
        child.stderr.on('data', (chunk) => { output += chunk; });
        child.on('exit', (code) => {
            resolve({
                code: code,
                passed: (output.match(/^ok\s/gm) || []).length,
                failed: (output.match(/^FAIL/gm) || []).length,
                output: output,
            });
        });
    });
}
async function live() {
    try {
        const response = await fetch(`${REMOTE}/health`);
        const text = await response.text();
        let body = null;
        try {
            body = JSON.parse(text);
        }
        catch {
            body = null;
        }
        record('live', 'health 200', response.status === 200 && object(body) && body.ok === true, body ? `status ${response.status}` : `非 JSON（${response.status}）：${text.slice(0, 40)}`);
        if (!object(body))
            throw new Error('health did not return JSON');
        record('live', 'no warnings', Array.isArray(body.warnings) && body.warnings.length === 0, JSON.stringify(body.warnings));
        const backup = object(body.backup) ? body.backup : null;
        record('live', 'backup fresh', backup && typeof backup.ageHours === 'number' && Number.isFinite(backup.ageHours) && backup.ageHours < 30, backup ? `${backup.ageHours}h / ${backup.files} file(s)` : 'no backup field');
        const counts = object(body.counts) ? body.counts : null;
        record('live', 'has content', counts && typeof counts.posts === 'number' && counts.posts > 0, JSON.stringify(body.counts));
    }
    catch (error) {
        record('live', 'health 200', false, failureMessage(error));
    }
    try {
        const manifest = await fetch(`${REMOTE}/manifest.webmanifest`);
        const text = await manifest.text();
        let json = null;
        try {
            json = JSON.parse(text);
        }
        catch {
            json = null;
        }
        record('live', 'manifest', manifest.status === 200 && object(json) && Array.isArray(json.icons) && json.icons.length === 2, json ? `${object(json) && Array.isArray(json.icons) ? json.icons.length : 0} icon(s)` : `非 JSON（${manifest.status}）`);
    }
    catch (error) {
        record('live', 'manifest', false, failureMessage(error));
    }
    try {
        const page = await fetch(`${REMOTE}/m`);
        const html = await page.text();
        const script = html.match(/<script>([\s\S]*?)<\/script>/);
        let parses = false;
        try {
            const source = script?.[1];
            if (source === undefined)
                throw new Error('mobile script not found');
            new Function(source);
            parses = true;
        }
        catch {
            parses = false;
        }
        record('live', 'mobile page', page.status === 200 && html.includes('随身版') && parses, `${html.length} bytes`);
    }
    catch (error) {
        record('live', 'mobile page', false, failureMessage(error));
    }
    try {
        const forged = await fetch(`${REMOTE}/wechat?signature=bad&timestamp=1&nonce=2`);
        record('live', 'wechat rejects bad signature', forged.status === 403, `status ${forged.status}`);
        const anon = await fetch(`${REMOTE}/feed`);
        record('live', 'feed needs a token', anon.status === 401, `status ${anon.status}`);
    }
    catch (error) {
        record('live', 'wechat rejects bad signature', false, failureMessage(error));
    }
}
const suites = [
    ['本地', 'redact.test.mjs', '脱敏'],
    ['本地', 'server/test-community.mjs', '服务端接口'],
    ['本地', 'server/test-enroll.mjs', '注册/自助加入'],
    ['本地', 'server/test-security.mjs', '授权与待审提案'],
    ['本地', 'server/test-revocation.mjs', '撤销与慢请求竞争'],
    ['本地', 'server/test-http-security.mjs', 'HTTP 入口与资源限制'],
    ['本地', 'test-agent-security.mjs', '巡检工具边界'],
    ['本地', 'test-runtime-security.mjs', '模型出站上下文隔离'],
    ['本地', 'test-deploy.mjs', '部署预检与发布保护'],
    ['本地', 'test-package.mjs', '发行包与首次安装'],
    ['本地', 'test-private-config.mjs', '旧版私有配置兼容'],
    ['本地', 'test-client.mjs', '面板渲染'],
    ['本地', 'server/test-db.mjs', '存储层'],
    ['本地', 'server/test-media.mjs', '图片元数据'],
    ['本地', 'test-mobile.mjs', '内联页交叉校验'],
    ['本地', 'test-miniprogram.mjs', '小程序静态检查'],
    ['本地', 'test-journey.mjs', '端到端旅程'],
    ['本地', 'test-restore.mjs', '备份还原演练'],
];
if (existsSync(join(HERE, 'src')))
    suites.unshift(['本地', 'test-build.mjs', '编译失败与产物保护']);
for (const [, file, label] of suites) {
    if (liveOnly)
        break;
    const result = await runSuite(file);
    record('local', label, result.code === 0 && result.failed === 0, `${result.passed} 项通过${result.failed ? `，${result.failed} 项失败` : ''}`);
    if (result.code !== 0) {
        const failedLines = result.output.split('\n').filter((line) => line.startsWith('FAIL')).slice(0, 5);
        for (const line of failedLines)
            record('local', `${label} · 失败行`, false, line.trim());
    }
}
if (!localOnly)
    await live();
const groups = [...new Set(results.map((item) => item.group))];
let failed = 0;
for (const group of groups) {
    console.log(`\n${group === 'local' ? '本地测试' : '线上检查'}`);
    for (const item of results.filter((entry) => entry.group === group)) {
        if (!item.ok)
            failed += 1;
        const mark = item.ok ? '✔' : '✘';
        console.log(`  ${mark} ${item.name}${item.detail ? '  — ' + item.detail : ''}`);
    }
}
console.log(`\n${failed === 0 ? '全部通过' : `${failed} 项失败`}`);
process.exit(failed === 0 ? 0 : 1);
