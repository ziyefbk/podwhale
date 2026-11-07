/** Explicit local setup. Server stores a hash; client credential never reaches UI. */
import { createHash, randomBytes } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile, unlink, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
function fault() { return Object.assign(new Error('companion_setup_invalid'), { code: 'companion_setup_invalid' }); }
function record(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
function origin(value) {
    const url = new URL(value);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash)
        throw fault();
    return url.origin;
}
function allowlists(accounts, peers) {
    const id = (value) => /^[1-9]\d{0,9}$/.test(value) && Number(value) <= 2147483647;
    if (!accounts.length || accounts.length > 8 || !peers.length || peers.length > 15 || new Set(accounts).size !== accounts.length || new Set(peers).size !== peers.length
        || accounts.some(value => !id(value)) || peers.some(value => {
        const [kind, account, peer, extra] = value.split(':');
        return !['private', 'group'].includes(kind ?? '') || !account || !accounts.includes(account) || !peer || !id(peer) || account === peer || extra !== undefined;
    }))
        throw fault();
}
export async function setupCompanionWechat(options) {
    if (!isAbsolute(options.home) || !isAbsolute(options.wechatRoot))
        throw fault();
    allowlists(options.accounts, options.peers);
    const hostBaseUrl = origin(options.hostBaseUrl), directory = join(options.home, 'xiaolanshu');
    const accessFile = join(directory, 'companion-wechat-access.json'), clientFile = join(directory, 'companion-wechat-client.json');
    const hostToken = randomBytes(32).toString('hex');
    await mkdir(directory, { recursive: true });
    // Refuse implicit credential rotation and all overwrite of existing settings.
    for (const file of [accessFile, clientFile]) {
        const existing = await lstat(file).catch((error) => { if (record(error) && error.code === 'ENOENT')
            return null; throw fault(); });
        if (existing)
            throw fault();
    }
    await writeFile(clientFile, JSON.stringify({ enabled: true, wechatRoot: resolve(options.wechatRoot), hostBaseUrl, hostToken,
        accounts: options.accounts, peers: options.peers }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    try {
        await writeFile(accessFile, JSON.stringify({ enabled: true, tokenHash: createHash('sha256').update(hostToken).digest('hex'),
            accounts: options.accounts, peers: options.peers }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    }
    catch {
        await unlink(clientFile).catch(() => { });
        throw fault();
    }
    return { accessFile, clientFile };
}
export async function setCompanionWechatEnabled(home, enabled) {
    const file = join(home, 'xiaolanshu', 'companion-wechat-access.json');
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 16384)
        throw fault();
    const data = JSON.parse(await readFile(file, 'utf8'));
    if (!record(data) || typeof data.tokenHash !== 'string' || !/^[a-f0-9]{64}$/.test(data.tokenHash) || !Array.isArray(data.accounts) || !Array.isArray(data.peers)
        || !data.accounts.every((item) => typeof item === 'string') || !data.peers.every((item) => typeof item === 'string'))
        throw fault();
    allowlists(data.accounts, data.peers);
    const temporary = file + '.' + process.pid + '.tmp';
    await writeFile(temporary, JSON.stringify({ enabled, tokenHash: data.tokenHash, accounts: data.accounts, peers: data.peers }, null, 2) + '\n', { mode: 0o600 });
    await rename(temporary, file);
    return { enabled };
}
export async function runCompanionSetup(args) {
    const home = process.env.DSH_HOME || join(homedir(), '.dsh');
    if (args.length === 1 && ['--disable-wechat', '--enable-wechat'].includes(args[0]))
        return setCompanionWechatEnabled(home, args[0] === '--enable-wechat');
    if (args[0] !== '--init-wechat')
        throw fault();
    const values = {};
    for (let i = 1; i < args.length; i += 2) {
        const name = args[i], value = args[i + 1];
        if (!name || !['--wechat-root', '--host-url', '--account', '--peer'].includes(name) || !value || value.startsWith('--'))
            throw fault();
        (values[name] ??= []).push(value);
    }
    if (values['--wechat-root']?.length !== 1 || values['--host-url']?.length !== 1)
        throw fault();
    return setupCompanionWechat({ home, wechatRoot: values['--wechat-root'][0], hostBaseUrl: values['--host-url'][0],
        accounts: values['--account'] ?? [], peers: values['--peer'] ?? [] });
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
    try {
        console.log(JSON.stringify(await runCompanionSetup(process.argv.slice(2))));
    }
    catch {
        console.error('companion_setup_invalid');
        process.exitCode = 1;
    }
}
