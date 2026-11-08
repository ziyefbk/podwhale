/** A binding is accepted only after a fresh, restricted-agent identity check. */
import { randomBytes } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { communityEndpoint, requireAgentIdentity } from './community-endpoint.mjs';
import { field } from './redact.js';
export class CommunityConnectionError extends Error {
    code;
    status;
    constructor(code, status) {
        super(code);
        this.code = code;
        this.status = status;
    }
}
const LIMIT = 8192;
function record(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
function token(value) {
    if (typeof value !== 'string' || !/^xlb_[A-Za-z0-9_-]{12,256}$/.test(value.trim()))
        throw new CommunityConnectionError('community_invalid_input', 400);
    return value.trim();
}
function endpoint(value) {
    if (typeof value !== 'string' || value.length > 2048 || /xlb_[A-Za-z0-9_-]{12,}/.test(value))
        throw new CommunityConnectionError('community_invalid_input', 400);
    try {
        return communityEndpoint(value.trim());
    }
    catch {
        throw new CommunityConnectionError('community_invalid_input', 400);
    }
}
function publicOwner(value, credential) {
    if (typeof value !== 'string')
        return null;
    const text = field(value.replaceAll(credential, '[凭据]'), 80).text.replace(/[\u0000-\u001f\u007f]/g, ' ');
    return text || null;
}
function publicOwnerId(value, credential) {
    return typeof value === 'string' && value !== credential && !value.startsWith('xlb_') && /^[A-Za-z0-9_-]{1,100}$/.test(value) ? value : null;
}
/** Atomic replacement; callers must have validated the agent with /whoami first. */
export async function persistCommunityConfig(file, config) {
    const value = { url: endpoint(config.url), token: token(config.token) };
    const dir = dirname(file), temporary = join(dir, '.remote-' + randomBytes(16).toString('hex') + '.tmp');
    try {
        await mkdir(dir, { recursive: true, mode: 0o700 });
        await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        await rename(temporary, file);
    }
    catch {
        throw new CommunityConnectionError('community_save_failed', 503);
    }
    finally {
        await rm(temporary, { force: true }).catch(() => undefined);
    }
}
async function identity(config) {
    let response;
    try {
        response = await fetch(config.url + '/whoami', { method: 'GET', headers: { accept: 'application/json', authorization: 'Bearer ' + config.token },
            redirect: 'error', signal: AbortSignal.timeout(8000) });
    }
    catch (error) {
        throw new CommunityConnectionError(record(error) && error.name === 'TimeoutError' ? 'community_timeout' : 'community_unavailable', record(error) && error.name === 'TimeoutError' ? 504 : 503);
    }
    if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        if (response.status === 401 || response.status === 403)
            throw new CommunityConnectionError('community_agent_unauthorized', response.status);
        if (response.status === 429)
            throw new CommunityConnectionError('community_rate_limited', 429);
        throw new CommunityConnectionError(response.status === 404 ? 'community_identity_invalid' : 'community_unavailable', response.status === 404 ? 502 : 503);
    }
    let payload;
    try {
        const chunks = [];
        let size = 0;
        const reader = response.body?.getReader();
        if (!reader)
            throw new CommunityConnectionError('community_identity_invalid', 502);
        try {
            for (;;) {
                const part = await reader.read();
                if (part.done)
                    break;
                size += part.value.byteLength;
                if (size > 16384) {
                    await reader.cancel();
                    throw new CommunityConnectionError('community_identity_invalid', 502);
                }
                chunks.push(part.value);
            }
        }
        finally {
            reader.releaseLock();
        }
        payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    }
    catch (error) {
        if (error instanceof CommunityConnectionError)
            throw error;
        if (record(error) && (error.name === 'TimeoutError' || error.name === 'AbortError'))
            throw new CommunityConnectionError('community_timeout', 504);
        throw new CommunityConnectionError('community_identity_invalid', 502);
    }
    if (!record(payload) || payload.ok !== true || !record(payload.credential))
        throw new CommunityConnectionError('community_identity_invalid', 502);
    if (payload.credential.role !== 'agent')
        throw new CommunityConnectionError('community_agent_required', 403);
    try {
        requireAgentIdentity(payload);
    }
    catch {
        throw new CommunityConnectionError('community_agent_expired', 401);
    }
    const owner = record(payload.owner) ? payload.owner : {};
    return { owner: publicOwner(owner.name, config.token), ownerId: publicOwnerId(owner.id, config.token) };
}
export function createCommunityConnection({ file, officialUrl }) {
    const official = officialUrl === null ? null : endpoint(officialUrl);
    let writes = Promise.resolve();
    const connected = (config, who) => ({ ok: true, officialUrl: official, connection: { state: 'connected', url: config.url, ...who } });
    async function view() {
        let config;
        try {
            const info = await lstat(file);
            if (!info.isFile() || info.isSymbolicLink() || info.size > LIMIT)
                throw new CommunityConnectionError('community_configuration_invalid', 400);
            const bytes = await readFile(file);
            if (bytes.length > LIMIT)
                throw new CommunityConnectionError('community_configuration_invalid', 400);
            let raw;
            try {
                raw = JSON.parse(bytes.toString('utf8'));
            }
            catch {
                throw new CommunityConnectionError('community_configuration_invalid', 400);
            }
            if (!record(raw))
                throw new CommunityConnectionError('community_configuration_invalid', 400);
            try {
                config = { url: endpoint(raw.url), token: token(raw.token) };
            }
            catch {
                throw new CommunityConnectionError('community_configuration_invalid', 400);
            }
        }
        catch (error) {
            if (record(error) && error.code === 'ENOENT')
                return { ok: true, officialUrl: official, connection: { state: 'unbound' } };
            const known = error instanceof CommunityConnectionError;
            return { ok: true, officialUrl: official, connection: { state: known ? 'invalid' : 'unavailable',
                    code: known ? error.code : 'community_configuration_unavailable' } };
        }
        try {
            return connected(config, await identity(config));
        }
        catch (error) {
            const fault = error instanceof CommunityConnectionError ? error : new CommunityConnectionError('community_unavailable', 503);
            const invalid = ['community_agent_unauthorized', 'community_agent_required', 'community_agent_expired', 'community_identity_invalid'].includes(fault.code);
            return { ok: true, officialUrl: official, connection: { state: invalid ? 'invalid' : 'unavailable', url: config.url, code: fault.code } };
        }
    }
    async function connect(value) {
        if (!record(value) || value.mode !== 'official' && value.mode !== 'custom'
            || Object.keys(value).some(key => !['mode', 'url', 'token'].includes(key))
            || Object.keys(value).length !== (value.mode === 'official' ? 2 : 3)
            || value.mode === 'official' && Object.hasOwn(value, 'url'))
            throw new CommunityConnectionError('community_invalid_input', 400);
        if (value.mode === 'official' && official === null)
            throw new CommunityConnectionError('community_official_unavailable', 503);
        const config = { url: value.mode === 'official' ? official : endpoint(value.url), token: token(value.token) };
        if (config.url === null)
            throw new CommunityConnectionError('community_official_unavailable', 503);
        const selected = { url: config.url, token: config.token };
        const who = await identity(selected);
        const save = writes.then(() => persistCommunityConfig(file, selected));
        writes = save.catch(() => undefined);
        await save;
        return connected(selected, who);
    }
    return { view, connect };
}
