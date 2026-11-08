import { CommunityConnectionError } from './community-connection.mjs';
const PATH = '/xiaolanshu/api/community-connection';
const LIMIT = 8192;
function send(res, status, value) {
    if (res.destroyed || res.writableEnded)
        return;
    res.statusCode = status;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.setHeader('x-content-type-options', 'nosniff');
    res.end(JSON.stringify(value));
}
async function authenticate(req, webServer, connection) {
    try {
        if (!connection || typeof connection.requestRejection !== 'function' || connection.requestRejection.call(connection, req) !== undefined)
            throw new Error('denied');
        const configured = await webServer.getOrigin?.();
        if (typeof configured !== 'string')
            throw new Error('denied');
        const origin = new URL(configured).origin;
        if (req.headers.host !== new URL(origin).host || req.headers.origin !== undefined && req.headers.origin !== origin
            || req.method === 'POST' && req.headers.origin !== origin
            || req.headers['sec-fetch-site'] !== undefined && !['same-origin', 'none'].includes(String(req.headers['sec-fetch-site'])))
            throw new Error('denied');
    }
    catch {
        throw new CommunityConnectionError('community_forbidden', 403);
    }
}
async function json(req) {
    const length = req.headers['content-length'];
    if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > LIMIT))
        throw new CommunityConnectionError('community_body_too_large', 413);
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '')
        || req.headers['content-encoding'] !== undefined && req.headers['content-encoding'] !== 'identity')
        throw new CommunityConnectionError('community_json_required', 415);
    const bytes = await new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0, settled = false;
        const finish = (error) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            req.off('data', data);
            req.off('end', end);
            req.off('error', aborted);
            req.off('aborted', aborted);
            if (error) {
                req.pause();
                reject(error);
            }
            else
                resolve(Buffer.concat(chunks));
        };
        const data = (chunk) => {
            if (!Buffer.isBuffer(chunk)) {
                finish(new CommunityConnectionError('community_invalid_input', 400));
                return;
            }
            size += chunk.length;
            if (size > LIMIT) {
                finish(new CommunityConnectionError('community_body_too_large', 413));
                return;
            }
            chunks.push(chunk);
        };
        const end = () => finish();
        const aborted = () => finish(new CommunityConnectionError('community_invalid_input', 400));
        const timer = setTimeout(() => finish(new CommunityConnectionError('community_body_timeout', 408)), 10000);
        timer.unref();
        req.on('data', data);
        req.once('end', end);
        req.once('error', aborted);
        req.once('aborted', aborted);
    });
    try {
        return JSON.parse(bytes.toString('utf8'));
    }
    catch {
        throw new CommunityConnectionError('community_invalid_input', 400);
    }
}
export function registerCommunityConnectionRoutes({ webServer, connection, service }) {
    return webServer.register({ kind: 'exact', path: PATH, async handler(req, res) {
            try {
                await authenticate(req, webServer, connection);
                if (!req.url?.startsWith('/') || req.url.startsWith('//'))
                    throw new CommunityConnectionError('community_invalid_input', 400);
                const url = new URL(req.url ?? '/', 'http://' + req.headers.host);
                if (url.search || url.hash || url.pathname !== PATH)
                    throw new CommunityConnectionError('community_invalid_input', 400);
                if (req.method !== 'GET' && req.method !== 'POST') {
                    res.setHeader('allow', 'GET, POST');
                    throw new CommunityConnectionError('community_method_not_allowed', 405);
                }
                if (req.method === 'GET') {
                    if (req.headers['transfer-encoding'] !== undefined || req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0')
                        throw new CommunityConnectionError('community_invalid_input', 400);
                    send(res, 200, await service.view());
                }
                else
                    send(res, 200, await service.connect(await json(req)));
            }
            catch (error) {
                const fault = error instanceof CommunityConnectionError ? error : new CommunityConnectionError('community_unavailable', 503);
                res.shouldKeepAlive = false;
                res.setHeader('connection', 'close');
                send(res, fault.status, { ok: false, code: fault.code, error: fault.code });
            }
        } });
}
