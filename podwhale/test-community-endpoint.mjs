/** Public default selection is pure; no test contacts the shipped endpoint. */
import { DEFAULT_COMMUNITY_URL, resolveCommunityTarget } from './official-community.mjs';
let passed = 0, failed = 0, networkCalls = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { networkCalls += 1; throw new Error('Network is forbidden in endpoint selection tests'); };
function check(name, ok) {
    console.log((ok ? 'ok   ' : 'FAIL ') + name);
    if (ok)
        passed += 1;
    else
        failed += 1;
}
function rejects(run, predicate = error => error instanceof Error) {
    try {
        run();
        return false;
    }
    catch (error) {
        return predicate(error);
    }
}
const official = 'https://official.example.test/xiaolanshu';
const custom = 'https://custom.example.test/community';
try {
    const published = DEFAULT_COMMUNITY_URL ? new URL(DEFAULT_COMMUNITY_URL) : null;
    check('the shipped official endpoint is configured with HTTPS and contains no embedded credentials', !!published
        && published.protocol === 'https:' && !published.username && !published.password && !published.search && !published.hash);
    check('only an omitted address selects the normalized official default', resolveCommunityTarget(undefined, official + '///') === official);
    check('an explicit custom endpoint always takes precedence over the official default', resolveCommunityTarget(custom + '/', official) === custom);
    check('an existing explicit endpoint remains usable when an official default is unavailable', resolveCommunityTarget(custom, null) === custom);
    check('explicit loopback HTTP remains available for isolated development', resolveCommunityTarget('http://127.0.0.1:8787/xiaolanshu', official) === 'http://127.0.0.1:8787/xiaolanshu');
    check('explicit IPv6 loopback HTTP remains available for isolated development', resolveCommunityTarget('http://[::1]:8787/xiaolanshu/', official) === 'http://[::1]:8787/xiaolanshu');
    check('an omitted address fails clearly when the official default is unavailable', rejects(() => resolveCommunityTarget(undefined, null), error => error instanceof Error && 'code' in error && error.code === 'community_official_unavailable' && 'status' in error && error.status === 503));
    const invalid = [
        ['', 'an explicit empty address'], ['   ', 'an explicit blank address'], ['not a URL', 'a malformed address'],
        ['http://public.example.test/xiaolanshu', 'public HTTP'], ['https://user:password@custom.example.test/xiaolanshu', 'embedded credentials'],
        [custom + '?token=synthetic', 'a query parameter'], [custom + '#synthetic', 'a URL fragment'],
        ['//custom.example.test/xiaolanshu', 'a protocol-relative address'], ['javascript:alert(1)', 'an executable scheme'],
    ];
    for (const [address, label] of invalid) {
        check(label + ' is rejected instead of silently selecting the official server', rejects(() => resolveCommunityTarget(address, official)));
    }
    check('an unsafe configured official endpoint is validated rather than blindly accepted', rejects(() => resolveCommunityTarget(undefined, 'http://public.example.test/xiaolanshu')));
    check('endpoint selection never invokes a network request', networkCalls === 0);
}
finally {
    globalThis.fetch = originalFetch;
}
console.log(failed ? `${failed} FAILED` : `ALL PASS (${passed} checks)`);
process.exitCode = failed ? 1 : 0;
