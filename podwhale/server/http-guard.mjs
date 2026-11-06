/** Bounded, dependency-free HTTP admission before authentication or routing. */
import { isIP } from 'node:net';
import { performance } from 'node:perf_hooks';
function setting(env, name, fallback, minimum, integer = true) {
    const raw = env[name];
    const value = raw === undefined || raw === '' ? fallback : Number(raw);
    if (!Number.isFinite(value) || value < minimum || value > 1e9 || (integer && !Number.isSafeInteger(value))) {
        throw new Error('Invalid HTTP guard configuration: ' + name);
    }
    return value;
}
export function httpGuardConfig(env = process.env) {
    const number = (name, fallback, minimum = 1, integer = true) => setting(env, 'XLB_HTTP_' + name, fallback, minimum, integer);
    const requestTimeoutMs = number('REQUEST_TIMEOUT_MS', 30000, 50);
    return Object.freeze({
        globalRate: number('GLOBAL_RATE', 100, 0.001, false), globalBurst: number('GLOBAL_BURST', 600),
        ipRate: number('IP_RATE', 30, 0.001, false), ipBurst: number('IP_BURST', 300),
        authRate: number('AUTH_FAIL_RATE', 1, 0.001, false), authBurst: number('AUTH_FAIL_BURST', 60),
        authGlobalRate: number('AUTH_GLOBAL_RATE', 10, 0.001, false), authGlobalBurst: number('AUTH_GLOBAL_BURST', 240),
        ipKeys: number('IP_KEYS', 4096), windowKeys: number('WINDOW_KEYS', 8192),
        bucketTtlMs: number('BUCKET_TTL_MS', 300000),
        headersTimeoutMs: Math.min(number('HEADERS_TIMEOUT_MS', 10000, 50), requestTimeoutMs),
        requestTimeoutMs, socketTimeoutMs: number('SOCKET_TIMEOUT_MS', 15000, 50),
        keepAliveTimeoutMs: number('KEEP_ALIVE_TIMEOUT_MS', 5000), checkIntervalMs: number('CHECK_INTERVAL_MS', 250, 10),
        maxHeaderBytes: number('MAX_HEADER_BYTES', 8192, 128), maxHeaders: number('MAX_HEADERS', 64),
        maxConnections: number('MAX_CONNECTIONS', 256), maxRequestsPerSocket: number('MAX_REQUESTS_PER_SOCKET', 100),
        rejectGraceMs: number('REJECT_GRACE_MS', 100),
        healthCacheMs: setting(env, 'XLB_HEALTH_CACHE_MS', 1000, 0),
    });
}
export function trustedClientIp(req, trustProxy = process.env.XLB_TRUST_PROXY === '1') {
    const remote = String(req.socket.remoteAddress || 'unknown');
    if (!trustProxy)
        return remote;
    const forwarded = (String(req.headers['x-forwarded-for'] || '').split(',')[0] || '').trim();
    return isIP(forwarded) ? forwarded : remote;
}
function refill(bucket, rate, burst, now) {
    bucket.tokens = Math.min(burst, bucket.tokens + Math.max(0, now - bucket.at) * rate / 1000);
    bucket.at = now;
    bucket.lastSeen = now;
}
class TokenBucket {
    rate;
    burst;
    bucket;
    constructor(rate, burst) {
        this.rate = rate;
        this.burst = burst;
        this.bucket = { tokens: burst, at: performance.now(), lastSeen: performance.now() };
    }
    take(now) {
        refill(this.bucket, this.rate, this.burst, now);
        if (this.bucket.tokens < 1)
            return false;
        this.bucket.tokens -= 1;
        return true;
    }
    retrySeconds() { return Math.max(1, Math.ceil((1 - this.bucket.tokens) / this.rate)); }
}
class BoundedBuckets {
    rate;
    burst;
    maxKeys;
    retentionMs;
    entries;
    lastSweep;
    constructor(rate, burst, maxKeys, ttlMs) {
        this.rate = rate;
        this.burst = burst;
        this.maxKeys = maxKeys;
        // Expiring an unfilled bucket would reset a restriction prematurely.
        this.retentionMs = Math.max(ttlMs, burst / rate * 1000);
        this.entries = new Map();
        this.lastSweep = -Infinity;
    }
    take(key, now) {
        let bucket = this.entries.get(key);
        if (!bucket) {
            if (this.entries.size >= this.maxKeys && now - this.lastSweep >= Math.min(1000, this.retentionMs)) {
                this.lastSweep = now;
                for (const [candidate, entry] of this.entries) {
                    if (now - entry.lastSeen >= this.retentionMs)
                        this.entries.delete(candidate);
                }
            }
            // Never evict an active limited address to admit a new attacker key.
            if (this.entries.size >= this.maxKeys)
                return { ok: false, retryAfter: Math.max(1, Math.ceil(this.retentionMs / 1000)) };
            bucket = { tokens: this.burst, at: now, lastSeen: now };
            this.entries.set(key, bucket);
        }
        refill(bucket, this.rate, this.burst, now);
        if (bucket.tokens < 1)
            return { ok: false, retryAfter: Math.max(1, Math.ceil((1 - bucket.tokens) / this.rate)) };
        bucket.tokens -= 1;
        return { ok: true };
    }
}
/** Preserve existing sliding-window business limits without unbounded IP maps. */
class BoundedWindows {
    maxKeys;
    domains;
    constructor(maxKeys) { this.maxKeys = maxKeys; this.domains = new Map(); }
    take(domain, key, limit, windowMs) {
        if (!Number.isFinite(limit) || limit <= 0)
            return false;
        let entries = this.domains.get(domain);
        if (!entries) {
            entries = new Map();
            this.domains.set(domain, entries);
        }
        const now = performance.now();
        let times = entries.get(key);
        if (!times && entries.size >= this.maxKeys) {
            for (const [candidate, prior] of entries) {
                if (now - prior.at >= windowMs)
                    entries.delete(candidate);
            }
            if (entries.size >= this.maxKeys)
                return false;
        }
        const recent = (times?.times || []).filter((time) => now - time < windowMs);
        if (recent.length >= limit) {
            entries.set(key, { times: recent, at: now });
            return false;
        }
        recent.push(now);
        entries.set(key, { times: recent, at: now });
        return true;
    }
}
function closeSocket(socket, graceMs) {
    if (socket.destroyed)
        return;
    socket.end();
    const timer = setTimeout(() => socket.destroy(), graceMs);
    timer.unref();
    socket.once('close', () => clearTimeout(timer));
}
export function createHttpGuard(config, identify = trustedClientIp) {
    const global = new TokenBucket(config.globalRate, config.globalBurst);
    const perIp = new BoundedBuckets(config.ipRate, config.ipBurst, config.ipKeys, config.bucketTtlMs);
    const failedGlobal = new TokenBucket(config.authGlobalRate, config.authGlobalBurst);
    const failedIp = new BoundedBuckets(config.authRate, config.authBurst, config.ipKeys, config.bucketTtlMs);
    const windows = new BoundedWindows(config.windowKeys);
    const requests = new WeakMap();
    function closeResponse(res) {
        if (!res.headersSent) {
            res.shouldKeepAlive = false;
            res.setHeader('connection', 'close');
        }
    }
    function reject(req, res, status, error, retryAfter) {
        if (res.writableEnded || res.destroyed)
            return false;
        closeResponse(res);
        if (retryAfter)
            res.setHeader('retry-after', String(retryAfter));
        const body = JSON.stringify({ ok: false, error });
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8',
            'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' });
        res.end(body);
        // No req.resume(): rejected uploads are not drained into application memory.
        return false;
    }
    function admit(req, res) {
        const context = { res, continued: false, expired: false, bodyEnded: false,
            deadline: performance.now() + config.requestTimeoutMs };
        requests.set(req, context);
        const timeout = setTimeout(() => {
            context.expired = true;
            reject(req, res, 408, 'request timeout');
            closeSocket(req.socket, config.rejectGraceMs);
        }, config.requestTimeoutMs);
        timeout.unref();
        const clear = () => clearTimeout(timeout);
        req.once('end', () => {
            if (performance.now() >= context.deadline)
                context.expired = true;
            context.bodyEnded = true;
            clear();
        });
        req.once('close', () => { if (!context.bodyEnded)
            context.expired = true; clear(); });
        res.once('close', () => { if (!context.bodyEnded)
            context.expired = true; clear(); });
        res.once('finish', () => {
            if (!context.bodyEnded)
                context.expired = true;
            clear();
            if (res.statusCode >= 400 || !req.complete)
                closeSocket(req.socket, config.rejectGraceMs);
        });
        if (req.rawHeaders.length / 2 > config.maxHeaders)
            return reject(req, res, 431, 'too many headers');
        const now = performance.now();
        if (!global.take(now))
            return reject(req, res, 429, 'request rate exceeded', global.retrySeconds());
        const result = perIp.take(identify(req), now);
        if (!result.ok)
            return reject(req, res, 429, 'request rate exceeded', result.retryAfter);
        return true;
    }
    function bodyLength(req, res, maximum) {
        const length = req.headers['content-length'];
        if (length !== undefined && (!/^\d+$/.test(String(length)) || Number(length) > maximum)) {
            return reject(req, res, 413, 'body too large');
        }
        return true;
    }
    function continueBody(req) {
        assertRequestActive(req);
        const context = requests.get(req);
        if (context && !context.continued && req.headers.expect?.toLowerCase() === '100-continue') {
            context.continued = true;
            context.res.writeContinue();
        }
    }
    function assertRequestActive(req) {
        const context = requests.get(req);
        // Node's parser-level request timeout starts before admission. Its
        // clientError handler may have closed the write side before our timer fires.
        if (context && (req.socket.writableEnded || req.socket.destroyed))
            context.expired = true;
        // A delayed event-loop timer cannot turn a late final chunk into a valid
        // write. Once the body ended on time, later processing is not cancelled.
        if (context && !context.bodyEnded && performance.now() >= context.deadline)
            context.expired = true;
        if (!context || context.expired)
            throw Object.assign(new Error('request timeout'), { status: 408 });
    }
    function authenticationFailed(req, res) {
        const now = performance.now();
        if (!failedGlobal.take(now))
            return reject(req, res, 429, 'authentication rate exceeded', failedGlobal.retrySeconds());
        const result = failedIp.take(identify(req), now);
        if (!result.ok)
            return reject(req, res, 429, 'authentication rate exceeded', result.retryAfter);
        res.setHeader('www-authenticate', 'Bearer');
        return reject(req, res, 401, 'unauthorized');
    }
    function serverOptions() {
        return { maxHeaderSize: config.maxHeaderBytes, headersTimeout: config.headersTimeoutMs,
            requestTimeout: config.requestTimeoutMs, keepAliveTimeout: config.keepAliveTimeoutMs,
            connectionsCheckingInterval: config.checkIntervalMs };
    }
    function configureServer(server) {
        server.maxConnections = config.maxConnections;
        server.maxRequestsPerSocket = config.maxRequestsPerSocket;
        // Count full rawHeaders ourselves; Node's maxHeadersCount silently truncates.
        server.maxHeadersCount = 0;
        if ('keepAliveTimeoutBuffer' in server)
            Reflect.set(server, 'keepAliveTimeoutBuffer', 0);
        server.setTimeout(config.socketTimeoutMs, (socket) => socket.destroy());
        server.on('clientError', (error, socket) => {
            if (!socket.writable || socket.writableEnded || socket.destroyed) {
                socket.destroy();
                return;
            }
            const code = Reflect.get(error, 'code');
            const status = code === 'HPE_HEADER_OVERFLOW' ? 431 : code === 'ERR_HTTP_REQUEST_TIMEOUT' ? 408 : 400;
            const reason = status === 431 ? 'Request Header Fields Too Large' : status === 408 ? 'Request Timeout' : 'Bad Request';
            socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
            closeSocket(socket, config.rejectGraceMs);
        });
    }
    return { admit, reject, bodyLength, continueBody, assertRequestActive, authenticationFailed, closeResponse,
        serverOptions, configureServer, windowAllowed: (...args) => windows.take(...args) };
}
/** Short single-flight cache. Writes invalidate its epoch, including pending loads. */
export function createHealthCache(ttlMs) {
    let epoch = 0;
    let cached;
    let until = 0;
    let pending;
    function invalidate() { epoch += 1; cached = undefined; until = 0; pending = undefined; }
    async function get(load) {
        if (ttlMs === 0)
            return load();
        if (cached !== undefined && performance.now() < until)
            return cached;
        if (pending)
            return pending;
        const generation = epoch;
        const work = Promise.resolve().then(load).then((value) => {
            if (generation === epoch) {
                cached = value;
                until = performance.now() + ttlMs;
            }
            return value;
        }).finally(() => { if (pending === work)
            pending = undefined; });
        pending = work;
        return work;
    }
    return { invalidate, get };
}
