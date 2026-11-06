import { countOf, field, redact } from './redact.js';
const cases = [
    ['unix path', '服务器是 a1，路径 /root/phil/spork/.venv/bin/python 上跑的', '服务器是 a1，路径 [路径] 上跑的'],
    ['windows path', 'C:\\Users\\28275\\Documents\\x 里有东西', '[路径] 里有东西'],
    ['home path', '日志在 ~/.dsh/profiles/desktop 下面', '日志在 [路径] 下面'],
    ['sk key', 'key: sk-live-abcdefghijklmnop1234', 'key: [密钥]'],
    ['github token', 'token ghp_abcdefghijklmnopqrstuvwxyz0123', 'token [密钥]'],
    ['aws key', 'AKIAABCDEFGHIJKLMNOP 是临时的', '[密钥] 是临时的'],
    ['bearer', 'Authorization: Bearer abcdefghijklmnop1234', 'Authorization: Bearer [密钥]'],
    ['bare community token', '令牌 xlb_' + 'a1'.repeat(24), '令牌 [密钥]'],
    ['embedded community token', 'copy=prefixxlb_' + 'b2'.repeat(24) + '。', 'copy=prefix[密钥]。'],
    ['community credential variants', 'xlb_agent_' + 'z'.repeat(32) + ' xlb_human_' + 'y'.repeat(32), '[密钥] [密钥]'],
    ['link with query', 'https://api.example.com/v1/run?token=abc123&x=1 挂了', '[带参数链接] 挂了'],
    ['email', 'mail ubuntu@example.com now', 'mail [邮箱] now'],
    ['ip with port', '连 100.118.255.76:8100 这台', '连 [IP] 这台'],
    ['long hex', 'commit 3f9a2b7c1d4e5f60718293a4b5c6d7e8f9012345 ok', 'commit [长串] ok'],
    ['plain prose untouched', 'Qwen3-4B 在 4×A100-40GB 上，vLLM 0.19.1，8192 token，P95 1.38×', 'Qwen3-4B 在 4×A100-40GB 上，vLLM 0.19.1，8192 token，P95 1.38×'],
    ['plain link untouched', 'https://arxiv.org/abs/2607.03333', 'https://arxiv.org/abs/2607.03333'],
];
let failed = 0;
for (const [name, input, expected] of cases) {
    const actual = redact(input).text;
    if (actual !== expected) {
        failed += 1;
        console.log('FAIL', name, '\n   expected:', expected, '\n   actual  :', actual);
    }
    else {
        console.log('ok  ', name);
    }
}
const mixed = redact('用 /root/x 里的 sk-live-abcdefghijklmnop1234 跑，出问题发 ubuntu@example.com');
console.log('counts', JSON.stringify(mixed.counts), '-> total', countOf(mixed.counts));
if (countOf(mixed.counts) !== 3) {
    failed += 1;
    console.log('FAIL count expected 3');
}
const cut = field('sk-live-abcdefghijklmnop1234 后面还有很多字', 12);
if (cut.text.includes('sk-')) {
    failed += 1;
    console.log('FAIL truncation leaked a key prefix:', cut.text);
}
else {
    console.log('ok   truncation happens after redaction');
}
const communityCut = field('xlb_' + 'c3'.repeat(24) + ' 尾部', 8);
if (communityCut.text.includes('xlb_') || !communityCut.counts.key) {
    failed += 1;
    console.log('FAIL community token truncation');
}
else {
    console.log('ok   community token redacted before truncation');
}
console.log(failed === 0 ? 'ALL PASS' : failed + ' FAILED');
process.exit(failed === 0 ? 0 : 1);
