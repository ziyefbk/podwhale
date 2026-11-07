/** Real isolated HTTP/SQLite authority, quotas and replay tests. No model or deployment. */
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { request } from 'node:http';
import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { socialDay, setSocialPolicy, executeSocialAction } from './social-policy.mjs';
const HERE = dirname(fileURLToPath(import.meta.url));
const temporaryRoot = await realpath(tmpdir());
const data = await mkdtemp(join(temporaryRoot, 'podwhale-social-'));
const dbFile = join(data, 'feed.db');
const human = 'xlb_' + '1'.repeat(48), replacement = 'xlb_' + '2'.repeat(48);
const agent = 'xlb_' + '3'.repeat(48), foreign = 'xlb_' + '4'.repeat(48);
const hash = (text) => createHash('sha256').update(text).digest('hex');
const ownerId = 'social-owner-a';
let child, base = '', total = 0, failed = 0;
const check = (name, ok) => { total++; console.log((ok ? 'ok   ' : 'FAIL ') + name); if (!ok)
    failed++; };
function fields(value) { if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('invalid social fixture object'); return value; }
function list(value) { if (!Array.isArray(value))
    throw new Error('invalid social fixture list'); return value.map(fields); }
function receipt(value) {
    const item = fields(fields(value).receipt);
    if (typeof item.id !== 'string' || (item.action !== 'post' && item.action !== 'reply') || (item.status !== 'pending' && item.status !== 'published') || typeof item.executed !== 'boolean')
        throw new Error('invalid social receipt fixture');
    return { id: item.id, action: item.action, status: item.status, executed: item.executed,
        ...(typeof item.proposalId === 'string' ? { proposalId: item.proposalId } : {}), ...(typeof item.targetId === 'string' ? { targetId: item.targetId } : {}) };
}
async function call(path, token = agent, body) {
    const res = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(8000) });
    const value = await res.json();
    return { status: res.status, value: fields(value) };
}
function update(revision, post = false, reply = false, postLimit = 1, replyLimit = 3) {
    return { expectedRevision: revision, post: { requireApproval: !post, dailyLimit: postLimit }, reply: { requireApproval: !reply, dailyLimit: replyLimit }, durationHours: post || reply ? 1 : 0 };
}
const requestId = (now = Date.now()) => 'social-' + now + '-' + randomUUID();
const post = (title) => ({ title, text: 'Synthetic public text' });
const action = (kind, payload, id = requestId()) => call('/social/actions', agent, { requestId: id, action: kind, payload });
async function policy() { return (await call('/social/policy')).value; }
async function revision() { const value = fields((await policy()).policy).revision; if (typeof value !== 'number')
    throw new Error('invalid policy revision fixture'); return value; }
async function setPolicy(postAuto, replyAuto, postLimit = 1, replyLimit = 3, token = human) {
    return call('/social/policy', token, update(await revision(), postAuto, replyAuto, postLimit, replyLimit));
}
async function proposal(id) {
    const result = list((await call('/proposals')).value.items).find(item => item.id === id);
    if (!result)
        throw new Error('missing social proposal fixture');
    return result;
}
async function decide(id, approve = true, token = human) {
    const item = await proposal(id);
    return call('/proposals/' + (approve ? 'approve' : 'reject'), token, { id, digest: item.digest });
}
async function posts() { return list((await call('/feed')).value.posts); }
function operator(code, args = []) {
    return execFileSync(process.execPath, ['--input-type=module', '-e', `import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(process.argv[1]);try{${code}}finally{db.close();}`, dbFile, ...args], { encoding: 'utf8', windowsHide: true });
}
async function start() {
    let stdout = '', stderr = '';
    child = spawn(process.execPath, [join(HERE, 'community.mjs')], { env: { ...process.env, XLB_DATA: data, XLB_PORT: '0', XLB_HOST: '127.0.0.1', XLB_WRITE_LIMIT: '500' }, stdio: ['ignore', 'pipe', 'pipe'] });
    const current = child;
    await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('social fixture start timed out')), 15000);
        current.stdout?.on('data', (chunk) => {
            stdout += chunk.toString();
            const match = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(stdout);
            if (match) {
                base = 'http://127.0.0.1:' + match[1];
                clearTimeout(timeout);
                resolve();
            }
        });
        current.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
        current.once('error', error => { clearTimeout(timeout); reject(error); });
        current.once('exit', () => { clearTimeout(timeout); reject(new Error('social fixture exited: ' + stderr)); });
    });
}
async function stop() {
    if (!child)
        return;
    const current = child;
    child = undefined;
    if (current.exitCode !== null)
        return;
    await new Promise(resolve => { current.once('exit', () => resolve()); current.kill(); });
}
try {
    const expiresAt = new Date(Date.now() + 86400000).toISOString();
    const owner = { id: ownerId, name: 'Synthetic owner', handle: 'Test fish', createdAt: new Date().toISOString(), revoked: false };
    await writeFile(join(data, 'owners.json'), JSON.stringify({
        [hash(human)]: { ...owner, credential: { role: 'human', expiresAt } },
        [hash(replacement)]: { ...owner, credential: { role: 'human', expiresAt } },
        [hash(agent)]: { ...owner, credential: { role: 'agent', expiresAt } },
        [hash(foreign)]: { ...owner, id: 'social-owner-b', credential: { role: 'human', expiresAt } },
    }));
    await start();
    const initial = await policy();
    check('legacy owners default to approval for both post and reply', fields(initial.policy).revision === 0
        && fields(fields(initial.policy).post).requireApproval === true && fields(fields(initial.policy).reply).requireApproval === true
        && fields(initial.effective).post === 'review' && fields(initial.effective).reply === 'review');
    check('an agent cannot set its own policy even with forged human flags', (await call('/social/policy', agent, { ...update(0, true), role: 'human', ownerId })).status === 403);
    check('the automatic action endpoint only accepts agents', (await call('/social/actions', human, { requestId: requestId(), action: 'post', payload: post('human-auto-denied') })).status === 403);
    const id = requestId(), pending = await action('post', post('requires-review'), id), first = receipt(pending.value);
    check('default social actions create a pending receipt without publishing', pending.status === 200 && first.status === 'pending' && !first.executed
        && !!first.proposalId && !(await posts()).some(item => item.title === 'requires-review'));
    check('receipt returns metadata without community or natural-language fields', Object.keys(fields(pending.value.receipt)).sort().join(',') === 'action,executed,id,proposalId,status');
    check('retrying the same request is atomic and idempotent', receipt((await action('post', post('requires-review'), id)).value).id === first.id);
    check('changing payload under the same request ID conflicts', (await action('post', post('changed-payload'), id)).status === 409);
    check('expired request IDs never become new work', (await action('post', post('expired-replay'), requestId(Date.now() - 26 * 3600000))).status === 409);
    check('future and opaque request IDs are rejected', (await action('post', post('future'), requestId(Date.now() + 120000))).status === 409
        && (await action('post', post('opaque'), 'opaque-request')).status === 409);
    const policyRequest = await call('/social/policy-request', agent, update(0, true, true, 2, 2));
    const grantId = fields(policyRequest.value.proposal).id;
    if (typeof grantId !== 'string')
        throw new Error('missing grant fixture');
    check('agents can only request a pending policy change', policyRequest.status === 202 && fields(policyRequest.value.proposal).status === 'pending' && fields((await policy()).policy).revision === 0);
    const pendingPolicies = list((await policy()).pendingRequests);
    check('own policy requests expose only structured settings and metadata', pendingPolicies.length === 1 && pendingPolicies[0]?.id === grantId
        && Object.keys(pendingPolicies[0]).sort().join(',') === 'action,createdAt,expiresAt,id,payload,status');
    check('another owner cannot read or approve the policy request', list((await call('/social/policy', foreign)).value.pendingRequests).length === 0
        && (await decide(grantId, true, foreign)).status === 404);
    check('agents cannot approve policy requests', (await decide(grantId, true, agent)).status === 403);
    check('human approval installs the limited policy', (await decide(grantId)).status === 200 && fields((await policy()).effective).post === 'auto');
    check('a later authorization cannot automatically execute old pending work', receipt((await action('post', post('requires-review'), id)).value).status === 'pending'
        && !(await posts()).some(item => item.title === 'requires-review'));
    check('explicit human approval publishes old pending work', !!first.proposalId && (await decide(first.proposalId)).status === 200);
    const approvedRetry = receipt((await action('post', post('requires-review'), id)).value);
    check('approved receipt updates atomically to the published target', approvedRetry.status === 'published' && approvedRetry.executed && !!approvedRetry.targetId);
    check('human-reviewed publication does not consume automatic quota', fields((await policy()).usage).post === 0);
    check('payload cannot override the authenticated AI identity', (await action('post', { ...post('forged'), ai: 'forged' })).status === 400);
    const autoId = requestId(), autoPayload = { ...post('auto-redacted'), text: 'Synthetic fixture@example.test 192.0.2.1 /home/fixture/secret' };
    const automatic = receipt((await action('post', autoPayload, autoId)).value);
    const autoPost = (await posts()).find(item => item.id === automatic.targetId);
    check('authorized automatic publishing preserves server identity and redacts before storage', automatic.executed && automatic.status === 'published'
        && autoPost?.ownerId === ownerId && autoPost.ai === owner.handle && !String(autoPost.text).includes('fixture@example.test')
        && !String(autoPost.text).includes('192.0.2.1') && !String(autoPost.text).includes('/home/fixture/secret'));
    const duplicates = await Promise.all([action('post', autoPayload, autoId), action('post', autoPayload, autoId)]);
    check('concurrent identical requests never publish twice or consume quota twice', duplicates.every(reply => receipt(reply.value).id === automatic.id)
        && (await posts()).filter(item => item.id === automatic.targetId).length === 1 && fields((await policy()).usage).post === 1);
    const second = receipt((await action('post', post('second-auto'))).value);
    const quotaPending = receipt((await action('post', post('quota-review'))).value);
    check('daily automatic quota is atomic and exhaustion returns to review', second.status === 'published' && quotaPending.status === 'pending'
        && fields((await policy()).usage).post === 2 && fields((await policy()).effective).post === 'review');
    check('deleting an automatic post never refunds its quota', (await call('/delete', human, { postId: automatic.targetId })).status === 200
        && fields((await policy()).usage).post === 2);
    check('deleted targets do not make a completed request publish again', receipt((await action('post', autoPayload, autoId)).value).targetId === automatic.targetId
        && !(await posts()).some(item => item.id === automatic.targetId));
    await setPolicy(false, false, 2, 2);
    check('turning approval back on preserves automatic usage', fields((await policy()).usage).post === 2 && fields((await policy()).effective).post === 'review');
    await setPolicy(true, true, 2, 2);
    check('renewing a policy does not reset its daily ledger', fields((await policy()).usage).post === 2 && fields((await policy()).effective).post === 'review'
        && fields((await policy()).effective).reply === 'auto');
    const replyId = requestId(), replyPayload = { postId: approvedRetry.targetId, text: 'Synthetic automatic reply' };
    const replyResults = await Promise.all([action('reply', replyPayload, replyId), action('reply', replyPayload, replyId)]);
    check('reply retries share one automatic result and quota debit', receipt(replyResults[0].value).id === receipt(replyResults[1].value).id
        && fields((await policy()).usage).reply === 1);
    await action('reply', { ...replyPayload, text: 'Second automatic reply' });
    const replyPendingId = requestId(), replyPendingPayload = { ...replyPayload, text: 'Needs review' };
    const replyPending = receipt((await action('reply', replyPendingPayload, replyPendingId)).value);
    check('reply quota also falls back to owner review', replyPending.status === 'pending'
        && fields((await policy()).usage).reply === 2);
    check('task commitments and completion retain their original human boundary', (await call('/claim', agent, { taskId: 't1' })).status === 403
        && (await call('/deliver', agent, { taskId: 't1', text: 'forged' })).status === 403
        && (await call('/confirm', agent, { taskId: 't1' })).status === 403
        && (await call('/social/actions', agent, { requestId: requestId(), action: 'claim', payload: { taskId: 't1' } })).status === 400);
    check('foreign owner policy is still independent', fields((await call('/social/policy', foreign)).value.policy).revision === 0);
    check('policy output never exposes authorization credential hashes or receipts', !JSON.stringify(await policy()).includes(hash(human))
        && !JSON.stringify(await policy()).includes('authorizerHash') && !JSON.stringify(await policy()).includes('receipts'));
    const rev = await revision();
    for (const invalid of [{ ...update(rev, true), durationHours: 169 }, { ...update(rev, true), durationHours: 0 },
        { ...update(rev, true), post: { requireApproval: false, dailyLimit: 6 } }, { ...update(rev, true), reply: { requireApproval: false, dailyLimit: 21 } },
        { ...update(rev), ownerId: 'social-owner-b' }, { ...update(rev), post: { requireApproval: 'false', dailyLimit: 1 } }]) {
        check('policy rejects excessive or forged authorization settings', (await call('/social/policy', human, invalid)).status === 400);
    }
    const stale = await call('/social/policy-request', agent, update(rev, true, false, 5));
    const staleId = fields(stale.value.proposal).id;
    if (typeof staleId !== 'string')
        throw new Error('invalid stale proposal fixture');
    const cas = await Promise.all([call('/social/policy', human, update(rev)), call('/social/policy', human, update(rev))]);
    check('concurrent policy writers use revision CAS', cas.map(reply => reply.status).sort().join(',') === '200,409');
    check('old reviewed policy targets cannot override a newer revision', (await decide(staleId)).status === 409);
    if (!quotaPending.proposalId)
        throw new Error('missing quota proposal fixture');
    await decide(quotaPending.proposalId, false);
    // Recover the existing request ID from this test's own persisted ledger.
    check('rejected action IDs cannot create another proposal or publish', (await action('post', post('quota-review'), operator("const row=db.prepare('SELECT data FROM entities WHERE collection=? AND key=?').get('socialPolicies',process.argv[2]);const item=JSON.parse(row.data);console.log(item.receipts.find(e=>e.receipt.proposalId===process.argv[3]).requestId);", [ownerId, quotaPending.proposalId]).trim())).status === 409);
    await setPolicy(true, false, 5, 2);
    const slowInput = JSON.stringify({ requestId: requestId(), action: 'post', payload: post('revoked-authorizer') });
    let finishSlow;
    const slow = new Promise((resolve, reject) => {
        const req = request(base + '/social/actions', { method: 'POST', agent: false, headers: { authorization: 'Bearer ' + agent,
                'content-type': 'application/json', 'content-length': String(Buffer.byteLength(slowInput)) } }, res => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => { const value = JSON.parse(Buffer.concat(chunks).toString()); resolve({ status: res.statusCode ?? 0, value }); });
        });
        req.on('error', reject);
        req.write(slowInput.slice(0, -1));
        finishSlow = () => req.end(slowInput.slice(-1));
    });
    await new Promise(resolve => setTimeout(resolve, 40));
    operator("const row=db.prepare('SELECT data FROM owners WHERE token_hash=?').get(process.argv[2]);const owner=JSON.parse(row.data);owner.revoked=true;db.prepare('UPDATE owners SET data=? WHERE token_hash=?').run(JSON.stringify(owner),process.argv[2]);", [hash(human)]);
    if (!finishSlow)
        throw new Error('missing slow body fixture');
    finishSlow();
    const revoked = await slow;
    check('revoking the granting human while an agent body is pending prevents auto publication', revoked.status === 200 && receipt(revoked.value).status === 'pending'
        && !(await posts()).some(item => item.title === 'revoked-authorizer'));
    check('live effective policy immediately reflects revocation while the agent remains valid', fields((await policy()).effective).post === 'review'
        && (await call('/whoami')).status === 200 && (await call('/whoami', human)).status === 401);
    await setPolicy(true, false, 5, 2, replacement);
    await stop();
    operator("const row=db.prepare('SELECT data FROM entities WHERE collection=? AND key=?').get('socialPolicies',process.argv[2]);const item=JSON.parse(row.data);item.policy.expiresAt='2000-01-01T00:00:00.000Z';db.prepare('UPDATE entities SET data=? WHERE collection=? AND key=?').run(JSON.stringify(item),'socialPolicies',process.argv[2]);", [ownerId]);
    if (!replyPending.proposalId)
        throw new Error('missing expiry proposal fixture');
    operator("const row=db.prepare('SELECT data FROM entities WHERE collection=? AND key=?').get('proposals',process.argv[2]);const item=JSON.parse(row.data);item.expiresAt='2000-01-01T00:00:00.000Z';db.prepare('UPDATE entities SET data=? WHERE collection=? AND key=?').run(JSON.stringify(item),'proposals',process.argv[2]);", [replyPending.proposalId]);
    await start();
    check('expired automation returns to review after restart without resetting quota', fields((await policy()).effective).post === 'review'
        && fields((await policy()).usage).post === 2 && receipt((await action('post', post('expired-policy-review'))).value).status === 'pending');
    check('published idempotency survives restart and policy expiration', receipt((await action('post', autoPayload, autoId)).value).id === automatic.id);
    check('an expired pending proposal cannot be renewed by replaying its action ID', (await action('reply', replyPendingPayload, replyPendingId)).status === 409);
    await setPolicy(true, false, 5, 2, replacement);
    const failureId = requestId();
    operator("db.exec(\"CREATE TRIGGER social_failure BEFORE INSERT ON entities WHEN NEW.collection='posts' AND json_extract(NEW.data,'$.title')='save-failure' BEGIN SELECT RAISE(FAIL,'synthetic failure'); END\");");
    check('a failed database commit cannot report successful automatic publication', (await action('post', post('save-failure'), failureId)).status === 500);
    check('failed publication leaves quota and visible state unchanged', fields((await policy()).usage).post === 2 && !(await posts()).some(item => item.title === 'save-failure'));
    operator('db.exec("DROP TRIGGER social_failure");');
    check('the identical request retries once after storage recovers', receipt((await action('post', post('save-failure'), failureId)).value).status === 'published'
        && fields((await policy()).usage).post === 3);
    await stop();
    operator("const {randomUUID}=await import('node:crypto');const row=db.prepare('SELECT data FROM entities WHERE collection=? AND key=?').get('socialPolicies',process.argv[2]);const item=JSON.parse(row.data),sample=item.receipts[0],now=Date.now();while(item.receipts.length<512)item.receipts.push({...sample,requestId:'social-'+now+'-'+randomUUID(),issuedAt:now,receipt:{...sample.receipt,id:'filler-'+randomUUID()}});db.prepare('UPDATE entities SET data=? WHERE collection=? AND key=?').run(JSON.stringify(item),'socialPolicies',process.argv[2]);", [ownerId]);
    await start();
    check('a full receipt ledger rejects new work instead of evicting live replay protection', (await action('post', post('capacity-denied'))).status === 429);
    check('old live receipts remain idempotent at the bounded capacity', receipt((await action('post', autoPayload, autoId)).value).id === automatic.id);
    const simulated = {}, midnight = Date.parse('2026-11-08T15:59:59.000Z');
    setSocialPolicy(simulated, 'unit-owner', update(0, true, false), 'a'.repeat(64), midnight);
    let publications = 0;
    const effects = { publish: () => 'target-' + (++publications), propose: () => 'proposal-unit', proposal: () => ({ status: 'pending', expiresAt: new Date(midnight + 3600000).toISOString() }), authorizerActive: () => true };
    executeSocialAction(simulated, 'unit-owner', { requestId: requestId(midnight), action: 'post', digest: 'a'.repeat(64) }, effects, midnight);
    const beforeMidnight = executeSocialAction(simulated, 'unit-owner', { requestId: requestId(midnight + 1), action: 'post', digest: 'b'.repeat(64) }, effects, midnight + 1);
    const afterMidnight = executeSocialAction(simulated, 'unit-owner', { requestId: requestId(midnight + 1000), action: 'post', digest: 'c'.repeat(64) }, effects, midnight + 1000);
    check('automatic day boundaries are Beijing midnight, independent of process locale', socialDay(midnight) === '2026-11-08' && socialDay(midnight + 1000) === '2026-11-09'
        && beforeMidnight.status === 'pending' && afterMidnight.status === 'published' && publications === 2);
    check('prior daily usage remains stored when the next Beijing day begins', simulated['unit-owner']?.usage['2026-11-08']?.post === 1
        && simulated['unit-owner']?.usage['2026-11-09']?.post === 1);
}
catch (error) {
    check('social policy HTTP fixture completes without unexpected errors', false);
    console.error(error instanceof Error ? error.stack : 'unexpected social fixture failure');
}
finally {
    await stop();
    const actual = await realpath(data);
    if (dirname(actual).toLowerCase() !== temporaryRoot.toLowerCase() || !basename(actual).startsWith('podwhale-social-'))
        throw new Error('unsafe social fixture cleanup');
    await rm(actual, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}
console.log(`Social policy: ${total - failed}/${total} passed; real local HTTP only.`);
process.exitCode = failed ? 1 : 0;
