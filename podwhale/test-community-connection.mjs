/** Real random-port HTTP, real /whoami, real isolated configuration files. */
import { createServer, request } from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCommunityConnection } from './community-connection.mjs';
import { registerCommunityConnectionRoutes } from './community-connection-http.mjs';
const PATH = '/xiaolanshu/api/community-connection';
const SECRET = 'xlb_' + 'a'.repeat(48), OLD = 'xlb_' + 'b'.repeat(48), PRIVATE = 'SYNTHETIC_PRIVATE_ERROR_NEVER_RETURN';
const root = await mkdtemp(join(tmpdir(), 'podwhale-connection-'));
const directory = join(root, 'home', 'xiaolanshu'), file = join(directory, 'remote.json');
let failures = 0;
function check(name, ok) { console.log((ok ? 'ok   ' : 'FAIL ') + name); if (!ok)
    failures++; }
function object(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
function fields(value) { if (!object(value))
    throw new Error('invalid synthetic response'); return value; }
let upstreamMode = 'agent', origin = '', community = '', redirects = 0, authCalls = 0;
let authMode = 'allow';
const upstreamRequests = [];
const responses = [], routes = new Map();
let dispose;
const redirect = createServer((_req, res) => { redirects++; res.end('{}'); });
let redirectOrigin = '';
const upstream = createServer((req, res) => {
    upstreamRequests.push({ path: req.url ?? '', method: req.method, authorization: req.headers.authorization });
    res.setHeader('content-type', 'application/json');
    if (upstreamMode === 'hang')
        return;
    if (upstreamMode === 'redirect') {
        res.writeHead(302, { location: redirectOrigin + '/stolen' });
        res.end();
        return;
    }
    const status = upstreamMode === 'unauthorized' ? 401 : upstreamMode === 'forbidden' ? 403 : upstreamMode === 'limit' ? 429 : 200;
    if (status !== 200) {
        res.writeHead(status);
        res.end(JSON.stringify({ error: PRIVATE, token: SECRET }));
        return;
    }
    if (upstreamMode === 'broken') {
        res.end('{not-json ' + PRIVATE);
        return;
    }
    if (upstreamMode === 'large') {
        res.end(JSON.stringify({ credential: { role: 'agent' }, text: 'x'.repeat(20000), token: SECRET }));
        return;
    }
    res.end(JSON.stringify({ ok: true, owner: { id: upstreamMode === 'reflect' ? SECRET : 'synthetic-owner', name: upstreamMode === 'reflect' ? SECRET : 'Synthetic owner' },
        credential: { role: upstreamMode === 'human' ? 'human' : 'agent', expiresAt: new Date(Date.now() + (upstreamMode === 'expired' ? -10000 : 60000)).toISOString() } }));
});
const authority = { requestRejection(req) {
        authCalls++;
        if (this !== authority || authMode === 'throw')
            throw new Error(PRIVATE);
        if (authMode === 'null')
            return null;
        if (authMode === 'false')
            return false;
        if (authMode === 'empty')
            return '';
        if (authMode === 'zero')
            return 0;
        return req.headers.cookie === 'fixture=synthetic' ? undefined : 401;
    } };
const server = createServer(async (req, res) => {
    const route = routes.get(new URL(req.url ?? '/', 'http://localhost').pathname);
    if (!route) {
        res.writeHead(404);
        res.end();
        return;
    }
    try {
        await route.handler(req, res);
    }
    catch {
        res.writeHead(500);
        res.end('synthetic fixture failure');
    }
});
async function listen(server) {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string')
        throw new Error('missing synthetic listener');
    return 'http://127.0.0.1:' + address.port;
}
async function mount(officialUrl, options = {}) {
    await dispose?.();
    dispose = registerCommunityConnectionRoutes({ webServer: { register(route) { routes.set(route.path, route); return () => { routes.delete(route.path); }; },
            ...(options.noOrigin ? {} : { getOrigin: () => origin }) },
        ...(options.noAuthority ? {} : { connection: authority }), service: createCommunityConnection({ file: options.target ?? file, officialUrl }) });
}
async function http(method = 'GET', options = {}) {
    const raw = options.raw ?? (options.body === undefined ? '' : JSON.stringify(options.body));
    return new Promise((resolve, reject) => {
        let responding = false;
        const req = request(origin + (options.path ?? PATH), { method, agent: false, headers: {
                ...(options.anonymous ? {} : { cookie: 'fixture=synthetic' }), ...(options.noOrigin ? {} : { origin }),
                ...(raw || options.slow ? { 'content-type': 'application/json' } : {}), ...(raw && !options.chunked && !options.slow ? { 'content-length': String(Buffer.byteLength(raw)) } : {}),
                ...options.headers,
            } }, res => {
            responding = true;
            const chunks = [];
            res.on('data', (chunk) => { if (Buffer.isBuffer(chunk))
                chunks.push(chunk); });
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString();
                let value = null;
                try {
                    value = JSON.parse(text);
                }
                catch { /* HEAD has no response body. */ }
                responses.push(text);
                if (options.slow)
                    req.end();
                resolve({ status: res.statusCode ?? 0, headers: res.headers, value, raw: text });
            });
        });
        req.on('error', error => { if (!responding)
            reject(error); });
        req.setTimeout(13000, () => req.destroy(new Error('synthetic HTTP timeout')));
        if (options.slow)
            req.write('{');
        else if (options.chunked) {
            req.write(raw.slice(0, 100));
            req.end(raw.slice(100));
        }
        else
            req.end(raw);
    });
}
function code(reply, wanted, status) {
    return reply.status === status && fields(reply.value).code === wanted
        && reply.headers['cache-control'] === 'no-store' && reply.headers['x-content-type-options'] === 'nosniff';
}
function state(reply) { return fields(fields(reply.value).connection); }
const connect = () => ({ mode: 'custom', url: community + '/xiaolanshu', token: SECRET });
try {
    redirectOrigin = await listen(redirect);
    community = await listen(upstream);
    origin = await listen(server);
    await mount(community + '/official');
    const empty = await http();
    check('unbound GET returns the official selection without registering an account', empty.status === 200 && state(empty).state === 'unbound' && upstreamRequests.length === 0);
    check('unbound GET never creates or rewrites a configuration', !(await stat(file).catch(() => null)));
    check('anonymous requests are rejected before a body or upstream is processed', code(await http('POST', { anonymous: true, raw: 'x'.repeat(9000) }), 'community_forbidden', 403) && upstreamRequests.length === 0);
    check('foreign origins cannot bind an agent', code(await http('POST', { body: connect(), headers: { origin: 'https://foreign.example.test' } }), 'community_forbidden', 403));
    check('POST requires an explicit same-origin browser request', code(await http('POST', { body: connect(), noOrigin: true }), 'community_forbidden', 403));
    check('a foreign Host is rejected despite a synthetic valid session', code(await http('GET', { headers: { host: 'foreign.example.test' } }), 'community_forbidden', 403));
    check('cross-site browser metadata is rejected', code(await http('POST', { body: connect(), headers: { 'sec-fetch-site': 'cross-site' } }), 'community_forbidden', 403));
    for (const mode of ['throw', 'null', 'false', 'empty', 'zero']) {
        authMode = mode;
        check('only exact undefined from the original authority receiver grants access: ' + mode, code(await http(), 'community_forbidden', 403));
    }
    authMode = 'allow';
    await mount(community, { noAuthority: true });
    check('a missing authority fails closed', code(await http(), 'community_forbidden', 403));
    await mount(community, { noOrigin: true });
    check('a missing canonical browser origin fails closed', code(await http(), 'community_forbidden', 403));
    await mount(community + '/official');
    check('query parameters cannot select another binding or account', code(await http('GET', { path: PATH + '?owner=other' }), 'community_invalid_input', 400));
    check('unexpected methods cannot mutate configuration', code(await http('DELETE'), 'community_method_not_allowed', 405));
    check('HEAD is explicitly unsupported without revealing a body', (await http('HEAD')).status === 405);
    check('GET does not accept a request body', code(await http('GET', { raw: '{}' }), 'community_invalid_input', 400));
    check('non-JSON content cannot submit a credential', code(await http('POST', { raw: '{}', headers: { 'content-type': 'text/plain' } }), 'community_json_required', 415));
    check('compressed bodies are rejected', code(await http('POST', { raw: '{}', headers: { 'content-encoding': 'gzip' } }), 'community_json_required', 415));
    check('declared bodies exceeding 8 KiB are rejected', code(await http('POST', { raw: 'x'.repeat(8193) }), 'community_body_too_large', 413));
    check('chunked bodies exceeding 8 KiB are rejected', code(await http('POST', { raw: 'x'.repeat(8193), chunked: true }), 'community_body_too_large', 413));
    check('malformed JSON is rejected with a fixed code', code(await http('POST', { raw: '{' }), 'community_invalid_input', 400));
    for (const value of [{ ...connect(), owner: 'other' }, { ...connect(), approved: true }, { ...connect(), ai: 'other' },
        { mode: 'official', url: community, token: SECRET }, { mode: 'custom', token: SECRET }, { mode: 'custom', url: community, token: '' }]) {
        check('binding input cannot smuggle authorization or incomplete fields', code(await http('POST', { body: value }), 'community_invalid_input', 400));
    }
    for (const url of ['http://public.example.test/xiaolanshu', community + '/?token=secret', community + '/#secret', 'http://user:password@127.0.0.1/xiaolanshu']) {
        check('transport validation rejects unsafe endpoint forms before sending credentials', code(await http('POST', { body: { ...connect(), url } }), 'community_invalid_input', 400));
    }
    await mount(null);
    check('an unset official entry remains disabled rather than choosing a fallback', code(await http('POST', { body: { mode: 'official', token: SECRET } }), 'community_official_unavailable', 503));
    await mount(community + '/official');
    await mkdir(directory, { recursive: true });
    const prior = JSON.stringify({ url: community + '/custom', token: OLD }) + '\n';
    await writeFile(file, prior);
    const custom = await http();
    check('configured custom bindings are preserved even when an official entry exists', state(custom).state === 'connected' && state(custom).url === community + '/custom'
        && await readFile(file, 'utf8') === prior && upstreamRequests.at(-1)?.path === '/custom/whoami');
    for (const [mode, wanted, status] of [['human', 'community_agent_required', 403], ['expired', 'community_agent_expired', 401],
        ['unauthorized', 'community_agent_unauthorized', 401], ['forbidden', 'community_agent_unauthorized', 403], ['limit', 'community_rate_limited', 429],
        ['broken', 'community_identity_invalid', 502], ['large', 'community_identity_invalid', 502], ['redirect', 'community_unavailable', 503]]) {
        upstreamMode = mode;
        check('failed fresh identity validation preserves the old binding: ' + mode, code(await http('POST', { body: connect() }), wanted, status) && await readFile(file, 'utf8') === prior);
    }
    check('redirects never forward a credential to another endpoint', redirects === 0);
    upstreamMode = 'unauthorized';
    const invalid = await http();
    check('a configured revoked credential is invalid, not unbound or silently local', state(invalid).state === 'invalid' && state(invalid).code === 'community_agent_unauthorized' && state(invalid).url === community + '/custom');
    upstreamMode = 'redirect';
    const unavailable = await http();
    check('an unavailable custom server is retained without an official fallback', state(unavailable).state === 'unavailable' && state(unavailable).url === community + '/custom' && await readFile(file, 'utf8') === prior);
    upstreamMode = 'reflect';
    const reflected = await http('POST', { body: connect() });
    check('even a reflecting server cannot return the supplied credential as an owner', reflected.status === 200 && !reflected.raw.includes(SECRET) && state(reflected).ownerId === null);
    upstreamMode = 'agent';
    const official = await http('POST', { body: { mode: 'official', token: SECRET } });
    check('official binding is an explicit verified write to only its whoami endpoint', official.status === 200 && state(official).state === 'connected'
        && state(official).owner === 'Synthetic owner' && state(official).ownerId === 'synthetic-owner' && upstreamRequests.at(-1)?.path === '/official/whoami');
    const persisted = JSON.parse(await readFile(file, 'utf8'));
    check('persisted data contains only the selected endpoint and restricted credential', object(persisted) && Object.keys(persisted).length === 2 && persisted.url === community + '/official' && persisted.token === SECRET);
    check('atomic replacement leaves no temporary credential files', JSON.stringify(await readdir(directory)) === JSON.stringify(['remote.json']));
    if (process.platform !== 'win32')
        check('new configuration permissions are owner-only', (await stat(file)).mode % 512 === 0o600);
    const badDirectory = join(root, 'not-a-directory');
    await writeFile(badDirectory, 'unchanged');
    await mount(community, { target: join(badDirectory, 'remote.json') });
    check('a persistence error is fixed and cannot overwrite an existing parent', code(await http('POST', { body: connect() }), 'community_save_failed', 503) && await readFile(badDirectory, 'utf8') === 'unchanged');
    await mount(community);
    await writeFile(file, '{broken ' + PRIVATE);
    const broken = await http();
    check('corrupt local configuration is explicit and never automatically replaced', state(broken).state === 'invalid' && state(broken).code === 'community_configuration_invalid' && await readFile(file, 'utf8') === '{broken ' + PRIVATE);
    await writeFile(file, prior);
    upstreamMode = 'hang';
    check('a real stalled identity request times out without saving a credential', code(await http('POST', { body: connect() }), 'community_timeout', 504) && await readFile(file, 'utf8') === prior);
    upstreamMode = 'agent';
    const beforeSlow = upstreamRequests.length;
    check('a real unfinished body expires after ten seconds before any identity request', code(await http('POST', { slow: true }), 'community_body_timeout', 408) && upstreamRequests.length === beforeSlow && await readFile(file, 'utf8') === prior);
    check('every remote operation is only an authenticated GET whoami', upstreamRequests.length > 0 && upstreamRequests.every(item => item.method === 'GET' && item.path.endsWith('/whoami') && [SECRET, OLD].some(value => item.authorization === 'Bearer ' + value)));
    check('all browser replies exclude credentials and private exception text', responses.every(value => !value.includes(SECRET) && !value.includes(OLD) && !value.includes(PRIVATE)));
    check('the DSH authority method retains its original receiver', authCalls > 20);
}
catch (error) {
    check('real HTTP connection suite completes', false);
    console.error(error instanceof Error && error.message.startsWith('synthetic') ? error.message : 'fixed fixture failure');
}
finally {
    await dispose?.();
    for (const active of [server, upstream, redirect]) {
        active.closeAllConnections();
        await new Promise(resolve => active.close(() => resolve()));
    }
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
console.log(failures ? failures + ' FAILED' : 'ALL PASS');
process.exitCode = failures ? 1 : 0;
