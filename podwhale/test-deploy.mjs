/** Deployment safety tests. No real SSH, upload, restart, or production config. */
import { mkdtemp, mkdir, writeFile, readFile, stat, rm, realpath, symlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename, isAbsolute, posix } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { SOURCE_FILES, REMOTE_SOURCE_FILES, validateDeploymentConfig, loadDeploymentConfig, shellQuote, sshArguments, scpArguments, publishScript, deploymentExecNode, validateStageScript, processRunner, runDeployment, redactDeploymentOutput } from './deployment.mjs';
const ROOT = resolve(process.env.PODWHALE_DEPLOY_TEST_REPO_ROOT || fileURLToPath(new URL('..', import.meta.url)));
const HERE = fileURLToPath(new URL('.', import.meta.url));
const CONFIG = { host: 'deploy.invalid', user: 'ubuntu', remote: 'https://community.invalid/xiaolanshu' };
let failed = 0;
function check(name, ok, detail = "") {
    console.log((ok ? 'ok   ' : 'FAIL ') + name + (detail ? ' -> ' + detail : ''));
    if (!ok)
        failed += 1;
}
async function failure(task) { try {
    await task();
    return null;
}
catch (caught) {
    const error = caught;
    return error;
} }
const temp = await mkdtemp(join(tmpdir(), 'podwhale-deploy-tests-'));
let preflightCleanup;
const shell = process.platform === 'win32' ? 'D:/Git/bin/bash.exe' : '/bin/bash';
const shellPath = (value) => process.platform === 'win32' ? resolve(value).replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, drive) => '/' + drive.toLowerCase()) : value;
try {
    for (const field of ['host', 'user', 'remote']) {
        const config = { ...CONFIG };
        delete config[field];
        const calls = [];
        const error = await failure(() => runDeployment({ repoRoot: ROOT, env: {}, config,
            runner: async (...args) => { calls.push({ command: args[0], args: args[1], options: args[2] }); return { code: 0 }; } }));
        check('missing ' + field + ' fails before any child process', !!error && calls.length === 0);
    }
    for (const [field, value] of [
        ['host', '-oProxyCommand=unsafe'], ['host', 'good;touch'], ['user', 'ubuntu -oUnsafe=yes'],
        ['port', '22 -oUnsafe=yes'], ['remoteDir', '/home/ubuntu/../other'], ['remoteDir', '/'],
        ['remoteDir', '/home/ubuntu/site;bad'], ['dataDir', '/outside/data'],
        ['remoteDir', '/srv/\u9cb8\u7fa4'],
        ['remoteNode', '/tmp/node$(bad)'], ['remote', 'https://user:password@community.invalid'],
        ['remote', 'http://community.invalid/xiaolanshu'],
        ['dataDir', '/home/ubuntu/podwhale/backups'],
    ]) {
        const calls = [];
        const error = await failure(() => runDeployment({ repoRoot: ROOT, env: {}, config: { ...CONFIG, [field]: value },
            runner: async (...args) => { calls.push({ command: args[0], args: args[1], options: args[2] }); return { code: 0 }; } }));
        check('unsafe ' + field + ' fails before any child process', !!error && calls.length === 0);
    }
    check('unencrypted HTTP is allowed only for explicit loopback development', ['http://localhost:8790/xiaolanshu', 'http://127.0.0.8:8790/xiaolanshu', 'http://[::1]:8790/xiaolanshu']
        .every((remote) => validateDeploymentConfig({ ...CONFIG, remote }).remote === remote));
    const externalConfig = join(temp, 'private-config.json');
    await writeFile(externalConfig, JSON.stringify(CONFIG));
    const loaded = await loadDeploymentConfig({ XLB_LOCAL_CONFIG: externalConfig }, ROOT);
    const aliasLoaded = await loadDeploymentConfig({ XLB_CONFIG_FILE: externalConfig }, ROOT);
    check('external private config loads in memory through either supported name', loaded.host === CONFIG.host && aliasLoaded.remote === CONFIG.remote);
    check('new deployment defaults use the renamed physical root without changing the HTTP prefix', loaded.remoteDir === '/home/ubuntu/podwhale'
        && loaded.dataDir === '/home/ubuntu/podwhale/data' && loaded.remoteNode === '/home/ubuntu/podwhale/runtime/bin/node'
        && loaded.remote === CONFIG.remote);
    const configConflict = await failure(() => loadDeploymentConfig({ XLB_LOCAL_CONFIG: externalConfig, XLB_CONFIG_FILE: join(temp, 'different.json') }, ROOT));
    check('conflicting private config paths fail closed', !!configConflict);
    const configRoot = join(temp, 'config-repository');
    const newConfig = join(configRoot, 'podwhale', 'local.json');
    const legacyConfig = join(configRoot, 'xiaolanshu', 'local.json');
    await Promise.all([mkdir(dirname(newConfig), { recursive: true }), mkdir(dirname(legacyConfig), { recursive: true })]);
    await writeFile(legacyConfig, JSON.stringify(CONFIG));
    const legacyLoaded = await loadDeploymentConfig({}, configRoot);
    check('default deployment config preserves the legacy private file when the new file is absent', legacyLoaded.host === CONFIG.host);
    await writeFile(newConfig, JSON.stringify({ ...CONFIG, host: 'preferred.invalid' }));
    check('the new package private config takes precedence over the legacy file', (await loadDeploymentConfig({}, configRoot)).host === 'preferred.invalid');
    for (const contents of ['{broken JSON', '{}']) {
        await writeFile(newConfig, contents);
        const configCalls = [];
        const invalidNew = await failure(() => runDeployment({ repoRoot: configRoot, env: {}, preflightOnly: true,
            runner: async (...args) => { configCalls.push(args); return { code: 0 }; } }));
        check('an invalid new config never falls back or performs external work (' + (contents === '{}' ? 'missing fields' : 'malformed JSON') + ')', !!invalidNew && configCalls.length === 0);
    }
    const onlyPreflight = [];
    const readOnly = await runDeployment({ repoRoot: ROOT, env: {}, config: CONFIG, preflightOnly: true,
        runner: async (command, args, options) => { onlyPreflight.push({ command, args, options }); return { code: 0 }; } });
    check('preflight mode performs only one read-only SSH phase', readOnly.preflight && onlyPreflight.length === 1 && onlyPreflight[0].options.phase === 'preflight');
    check('remote script is carried on stdin, never in the SSH command arguments', onlyPreflight[0].args.slice(-3).join(' ') === 'bash -s --' && onlyPreflight[0].options.input.includes('PODWHALE_PREFLIGHT_OK') && !onlyPreflight[0].args.some((arg) => arg.includes('\n')));
    const failedPreflightCalls = [];
    const failedPreflight = await failure(() => runDeployment({ repoRoot: ROOT, env: {}, config: CONFIG,
        runner: async (command, args, options) => { failedPreflightCalls.push(options.phase); return { code: 1, stderr: 'preflight failed' }; } }));
    check('a failed preflight never tests, packages, stages, or uploads', failedPreflight?.phase === 'preflight' && failedPreflightCalls.join(',') === 'preflight');
    const calls = [];
    const builtArchive = join(temp, 'built-source.tar.gz');
    let archiveMembers = [];
    let packedCommunity = Buffer.alloc(0);
    const result = await runDeployment({ repoRoot: ROOT, env: {}, config: CONFIG,
        runner: async (command, args, options) => {
            calls.push({ command, args, options });
            if (options.phase === 'pack') {
                const packed = await processRunner(command, args, { cwd: ROOT, timeoutMs: 10000 });
                if (packed.code !== 0)
                    return packed;
                await writeFile(builtArchive, await readFile(args[1]));
                packedCommunity = await readFile(join(args[3], 'podwhale', 'server', 'community.mjs'));
                const listing = await processRunner('tar', ['-tzf', builtArchive], { cwd: ROOT, timeoutMs: 10000 });
                if (listing.code !== 0)
                    return listing;
                archiveMembers = listing.stdout.trim().split(/\r?\n/);
            }
            return { code: 0 };
        } });
    check('deployment verifies before publishing', calls.map((call) => call.options.phase).join(',') === 'preflight,local-tests,pack,create-stage,upload,validate-stage,publish');
    const pack = calls.find((call) => call.options.phase === 'pack');
    check('local verification and source reads use the renamed repository package', SOURCE_FILES.every((file) => file.startsWith('podwhale/')) && calls.find((call) => call.options.phase === 'local-tests').args[0] === join(ROOT, 'podwhale', 'check.mjs'));
    check('archive includes authorization code and only the canonical service allowlist', pack.args.slice(4).join('\n') === REMOTE_SOURCE_FILES.join('\n') && pack.args.includes('podwhale/server/auth.mjs') && !SOURCE_FILES.some((file) => /(?:local\.json|remote\.json|data\/|assets\/)/.test(file)));
    check('the real archive contains canonical service paths and bytes from the local source', archiveMembers.join('\n') === REMOTE_SOURCE_FILES.join('\n') && packedCommunity.equals(await readFile(join(ROOT, 'podwhale', 'server', 'community.mjs'))) && !archiveMembers.some((file) => file.startsWith('xiaolanshu/')));
    check('source manifest binds authorization, task policy and community source hashes', ['auth', 'task-policy', 'community'].every(name => /^[a-f0-9]{64}$/.test(result.manifest['podwhale/server/' + name + '.mjs'])));
    check('all subprocesses have a timeout', calls.every((call) => call.options.timeoutMs > 0));
    const network = calls.filter((call) => ['ssh', 'scp'].includes(call.command));
    check('all SSH and SCP operations require existing trust and noninteractive authentication', network.every((call) => ['BatchMode=yes', 'StrictHostKeyChecking=yes', 'UpdateHostKeys=no'].every((option) => call.args.includes(option))));
    check('remote destination stays one argv element', network.filter((call) => call.command === 'scp').every((call) => call.args.at(-1).startsWith('ubuntu@deploy.invalid:/home/ubuntu/podwhale/.deploy-')));
    const failedStage = [];
    await failure(() => runDeployment({ repoRoot: ROOT, env: {}, config: CONFIG,
        runner: async (command, args, options) => { failedStage.push(options.phase); return { code: options.phase === 'validate-stage' ? 1 : 0 }; } }));
    check('invalid staged code cannot stop or replace the running app', !failedStage.includes('publish') && !failedStage.includes('fail-closed-stop'));
    const failedPublish = [];
    const publishError = await failure(() => runDeployment({ repoRoot: ROOT, env: {}, config: CONFIG,
        runner: async (command, args, options) => { failedPublish.push(options.phase); return { code: options.phase === 'publish' ? 1 : 0, stderr: CONFIG.host + ' ' + CONFIG.remote + ' token=synthetic-private-value' }; } }));
    check('failed publication invokes a fail-closed stop instead of rollback', publishError?.stopped === true && failedPublish.at(-1) === 'fail-closed-stop' && !failedPublish.some((phase) => /rollback|restore/.test(phase)));
    check('private destination and secret fields are removed from error details', typeof publishError?.detail === 'string' && !publishError.detail.includes(CONFIG.host) && !publishError.detail.includes(CONFIG.remote) && !publishError.detail.includes('synthetic-private-value'));
    check('redaction also handles unrelated URLs and bearer-like secrets', !/example\.invalid|xlb_abcdefghijklmnop/.test(redactDeploymentOutput('https://example.invalid/path xlb_abcdefghijklmnop', loaded)));
    const timeout = await processRunner(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { cwd: ROOT, timeoutMs: 100 });
    check('timed-out subprocesses fail instead of hanging deployment', timeout.timedOut === true && timeout.code !== 0);
    const graphRoot = join(temp, 'graph');
    await mkdir(graphRoot);
    const graphEntry = join(graphRoot, 'entry.mjs');
    const graphMarker = join(graphRoot, 'must-not-exist');
    const helperUrl = pathToFileURL(join(HERE, 'deployment.mjs')).href;
    const graphCode = `import {verifyModuleGraph} from ${JSON.stringify(helperUrl)}; await verifyModuleGraph(process.argv[1]);`;
    const actualGraph = await processRunner(process.execPath, ['--experimental-vm-modules', '--input-type=module', '-e', graphCode, join(ROOT, 'podwhale', 'server', 'community.mjs')], { cwd: ROOT, timeoutMs: 10000 });
    check('the actual community module graph links without starting a service', actualGraph.code === 0);
    await writeFile(join(graphRoot, 'dep.mjs'), 'export const ok = 1;');
    await writeFile(graphEntry, `import {ok} from './dep.mjs'; import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(graphMarker)},String(ok));`);
    const graphOk = await processRunner(process.execPath, ['--experimental-vm-modules', '--input-type=module', '-e', graphCode, graphEntry], { cwd: ROOT, timeoutMs: 10000 });
    check('module validation links imports without executing startup side effects', graphOk.code === 0 && !existsSync(graphMarker));
    await writeFile(graphEntry, "import {missing} from './dep.mjs';");
    const missingExport = await processRunner(process.execPath, ['--experimental-vm-modules', '--input-type=module', '-e', graphCode, graphEntry], { cwd: ROOT, timeoutMs: 10000 });
    check('module validation rejects missing exports before service shutdown', missingExport.code !== 0);
    await writeFile(graphEntry, "import './missing.mjs';");
    const missingFile = await processRunner(process.execPath, ['--experimental-vm-modules', '--input-type=module', '-e', graphCode, graphEntry], { cwd: ROOT, timeoutMs: 10000 });
    check('module validation rejects missing import files', missingFile.code !== 0);
    if (!existsSync(shell))
        throw new Error('bash is required for deployment shell behavior tests');
    const oddValue = "text with ' quotes $(must-not-run); and\nnewline";
    const quoted = await processRunner(shell, ['--noprofile', '--norc', '-c', 'printf %s ' + shellQuote(oddValue)], { cwd: ROOT, timeoutMs: 10000 });
    check('shell quoting preserves literal quotes, substitutions, and newlines', quoted.code === 0 && quoted.stdout === oddValue);
    const expectedEntry = '/srv/podwhale/app/podwhale/server/community.mjs';
    check('unit parsing accepts the direct configured Node and exact canonical entry', deploymentExecNode('{ path=/srv/podwhale/runtime/bin/node ; argv[]=/srv/podwhale/runtime/bin/node ' + expectedEntry + ' ; ignore_errors=no ; pid=1 ; }', expectedEntry) === '/srv/podwhale/runtime/bin/node');
    const ambiguousUnit = await failure(() => deploymentExecNode('{ path=/usr/bin/node ; argv[]=/usr/bin/node -e ' + expectedEntry + ' ; }', expectedEntry));
    check('unit parsing rejects flags or command wrappers instead of guessing the executed script', !!ambiguousUnit);
    // Linux deployment paths deliberately accept only a narrow ASCII alphabet.
    // Git Bash's /tmp namespace stays POSIX-shaped even when TEMP's Windows
    // directory contains Chinese characters, spaces, or other local-only syntax.
    const mappedTmp = await processRunner(shell, ['--noprofile', '--norc', '-c', process.platform === 'win32'
            ? 'cygpath -w /tmp' : "printf '%s\\n' /tmp"], { cwd: ROOT, timeoutMs: 10000 });
    const nativeTmp = mappedTmp.stdout.trim();
    if (mappedTmp.code !== 0 || !isAbsolute(nativeTmp) || /[\r\n]/.test(nativeTmp))
        throw new Error('cannot map the shell temporary namespace');
    const preflightTemp = await mkdtemp(join(nativeTmp, 'podwhale-preflight-tests-'));
    preflightCleanup = { parent: await realpath(nativeTmp), directory: preflightTemp };
    const shellTemp = '/tmp/' + basename(preflightTemp);
    for (const layout of ['canonical', 'legacy', 'dual-tree', 'wrong-working-directory', 'wrong-entry', 'wrong-node']) {
        const sandbox = join(preflightTemp, layout), bin = join(sandbox, 'bin'), app = join(sandbox, 'app');
        const remoteSandbox = posix.join(shellTemp, layout), remoteBin = posix.join(remoteSandbox, 'bin'), remoteApp = posix.join(remoteSandbox, 'app');
        const data = join(sandbox, 'data'), backups = join(sandbox, 'backups');
        const packageDir = join(app, layout === 'legacy' ? 'xiaolanshu' : 'podwhale');
        await Promise.all([bin, data, backups, join(packageDir, 'server')].map(directory => mkdir(directory, { recursive: true })));
        const entry = join(packageDir, 'server', 'community.mjs');
        await writeFile(entry, 'preflight must preserve these code bytes');
        await writeFile(join(data, 'feed.db'), 'preflight database bytes');
        if (layout === 'dual-tree')
            await mkdir(join(app, 'xiaolanshu'));
        const fakeNode = join(bin, 'node-fixture'), otherNode = join(bin, 'other-node-fixture');
        const nodeWrapper = `#!/bin/bash\nset -eu\ncase "\${3-}" in *NODE_VERSION*) echo 'NODE_VERSION 24.0.0'; exit 0;; esac\nexec ${shellQuote(shellPath(process.execPath))} "$@"\n`;
        await writeFile(fakeNode, nodeWrapper, { mode: 0o755 });
        await writeFile(otherNode, nodeWrapper, { mode: 0o755 });
        const unitNode = posix.join(remoteBin, layout === 'wrong-node' ? 'other-node-fixture' : 'node-fixture');
        const unitEntry = posix.join(remoteApp, layout === 'wrong-entry' ? 'xiaolanshu' : 'podwhale', 'server', 'community.mjs');
        const unitDirectory = layout === 'wrong-working-directory' ? remoteSandbox : remoteApp;
        const controlMarker = join(sandbox, 'must-not-control-service');
        const fakeSystemctl = join(bin, 'systemctl-fixture');
        await writeFile(fakeSystemctl, `#!/bin/bash\nset -eu\ncase "$1" in\nis-active) exit 0;;\nshow) case "$2" in\n--property=WorkingDirectory) printf '%s\\n' ${shellQuote(unitDirectory)};;\n--property=ExecStart) printf '%s\\n' ${shellQuote('{ path=' + unitNode + ' ; argv[]=' + unitNode + ' ' + unitEntry + ' ; ignore_errors=no ; pid=1 ; }')};;\n*) exit 1;;\nesac;;\n*) echo unexpected > ${shellQuote(shellPath(controlMarker))}; exit 1;;\nesac\n`, { mode: 0o755 });
        await writeFile(join(bin, 'sudo'), '#!/bin/bash\nset -eu\nif test "$1" = -n; then shift; fi\nif test "$1" = -l; then exit 0; fi\nexit 1\n', { mode: 0o755 });
        const config = { ...loaded, remoteDir: remoteSandbox, dataDir: posix.join(remoteSandbox, 'data'), remoteNode: posix.join(remoteBin, 'node-fixture') };
        const phases = [];
        const error = await failure(() => runDeployment({ repoRoot: ROOT, env: {}, config, preflightOnly: layout === 'canonical',
            runner: async (_command, _args, options) => {
                phases.push(options.phase);
                if (options.phase !== 'preflight')
                    return { code: 1, stderr: 'unexpected work after preflight' };
                const script = options.input.replace('SYSTEMCTL=/usr/bin/systemctl', 'SYSTEMCTL=' + shellQuote(posix.join(remoteBin, 'systemctl-fixture')))
                    .replace('set -euo pipefail', 'set -euo pipefail\nexport PATH=' + shellQuote(remoteBin) + ':$PATH');
                return processRunner(shell, ['--noprofile', '--norc', '-s'], { cwd: ROOT, input: script, timeoutMs: 15000 });
            } }));
        const accepted = phases.join(',') === 'preflight'
            && (layout === 'canonical' ? !error : error?.phase === 'preflight' && error.detail?.includes('PODWHALE_LAYOUT_MIGRATION_REQUIRED'))
            && !existsSync(controlMarker) && (await readFile(entry, 'utf8')) === 'preflight must preserve these code bytes'
            && (await readFile(join(data, 'feed.db'), 'utf8')) === 'preflight database bytes';
        check('real preflight ' + (layout === 'canonical' ? 'accepts the canonical unit' : 'rejects ' + layout + ' before testing or uploading'), accepted, accepted ? '' : JSON.stringify({ phases, error: error ? { name: error.name, message: error.message, phase: error.phase, detail: error.detail } : null }).slice(0, 1800));
    }
    const compatRoot = join(temp, 'compatible-stage');
    const compatStage = join(compatRoot, '.deploy-test-release');
    const compatApp = join(compatStage, 'app');
    await Promise.all([join(compatRoot, 'app'), join(compatRoot, 'data'), join(compatRoot, 'backups'),
        join(compatApp, 'podwhale')].map((directory) => mkdir(directory, { recursive: true })));
    await writeFile(join(compatStage, 'source.tar.gz'), await readFile(builtArchive));
    const compatConfig = { ...loaded, remoteDir: shellPath(compatRoot), dataDir: shellPath(join(compatRoot, 'data')), remoteNode: shellPath(process.execPath) };
    const compatValidation = await processRunner(shell, ['--noprofile', '--norc', '-s'], {
        cwd: ROOT, input: validateStageScript(compatConfig, 'test-release', result.manifest), timeoutMs: 20000,
    });
    check('the real archive passes canonical staging syntax, module, and digest checks', compatValidation.code === 0
        && (await readFile(join(compatApp, 'podwhale', 'server', 'community.mjs'))).equals(packedCommunity)
        && !existsSync(join(compatApp, 'xiaolanshu')), (compatValidation.stderr || compatValidation.stdout).slice(-2000));
    const linkRoot = join(temp, 'symlink-stage');
    const linkStage = join(linkRoot, '.deploy-test-release');
    const outside = join(temp, 'must-not-write');
    const linkApp = join(linkStage, 'app');
    const archiveSource = join(temp, 'archive-source');
    await Promise.all([join(linkRoot, 'app'), join(linkRoot, 'data'), join(linkRoot, 'backups'),
        join(linkApp, 'podwhale', 'server'), outside, archiveSource].map((directory) => mkdir(directory, { recursive: true })));
    await writeFile(join(outside, 'icon-192.png'), 'outside sentinel');
    await symlink(outside, join(linkApp, 'podwhale', 'server', 'static'), process.platform === 'win32' ? 'junction' : 'dir');
    const linkManifest = {};
    for (const file of REMOTE_SOURCE_FILES) {
        const target = join(archiveSource, file);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, 'staged ' + file);
        linkManifest[file] = createHash('sha256').update('staged ' + file).digest('hex');
    }
    const realArchive = await processRunner('tar', ['-czf', join(linkStage, 'source.tar.gz'), '-C', archiveSource, ...REMOTE_SOURCE_FILES], { cwd: ROOT, timeoutMs: 10000 });
    if (realArchive.code !== 0)
        throw new Error('cannot create the isolated archive fixture');
    const linkConfig = { ...loaded, remoteDir: shellPath(linkRoot), dataDir: shellPath(join(linkRoot, 'data')), remoteNode: '/not-needed/node' };
    const symlinkValidation = await processRunner(shell, ['--noprofile', '--norc', '-s'], { cwd: ROOT, input: validateStageScript(linkConfig, 'test-release', linkManifest), timeoutMs: 10000 });
    check('staging rejects symlink parents before archive extraction writes any source', symlinkValidation.code !== 0
        && !existsSync(join(linkStage, 'archive-list')) && !existsSync(join(linkApp, 'podwhale', 'server', 'auth.mjs'))
        && (await readFile(join(outside, 'icon-192.png'), 'utf8')) === 'outside sentinel');
    // Execute the actual publication script in an isolated directory. Only the
    // service controller and Node smoke probe are replaced; mv/tar/hash are real.
    for (const mode of ['success', 'backup-failure', 'smoke-failure']) {
        const sandbox = join(temp, mode);
        const bin = join(sandbox, 'bin');
        const stage = join(sandbox, '.deploy-test-release', 'app');
        const app = join(sandbox, 'app');
        const data = join(sandbox, 'data');
        const backups = join(sandbox, 'backups');
        await Promise.all([bin, stage, app, data, backups].map((directory) => mkdir(directory, { recursive: true })));
        await writeFile(join(data, 'feed.db'), 'preserved database bytes');
        await writeFile(join(app, 'old-code-marker'), 'old application');
        const installedEntry = join(app, 'podwhale', 'server', 'community.mjs');
        await mkdir(dirname(installedEntry), { recursive: true });
        await writeFile(installedEntry, 'old deployed source');
        const manifest = {};
        for (const file of REMOTE_SOURCE_FILES) {
            const target = join(stage, file);
            await mkdir(dirname(target), { recursive: true });
            await writeFile(target, 'new source ' + file);
            manifest[file] = createHash('sha256').update('new source ' + file).digest('hex');
        }
        const logPath = shellPath(join(sandbox, 'events'));
        const statePath = shellPath(join(sandbox, 'state'));
        await writeFile(join(sandbox, 'state'), 'active\n');
        const fakeSystemctl = join(bin, 'systemctl-fake');
        await writeFile(fakeSystemctl, `#!/bin/bash\nset -eu\ncase "$1" in\nstop) echo stop >> ${shellQuote(logPath)}; echo stopped > ${shellQuote(statePath)};;\nrestart) echo restart >> ${shellQuote(logPath)}; test "$(cat ${shellQuote(shellPath(installedEntry))})" = 'new source podwhale/server/community.mjs'; echo active > ${shellQuote(statePath)};;\nis-active) test "$(cat ${shellQuote(statePath)})" = active;;\n*) exit 1;;\nesac\n`, { mode: 0o755 });
        await writeFile(join(bin, 'sudo'), '#!/bin/bash\nset -eu\nif test "$1" = -n; then shift; fi\nexec "$@"\n', { mode: 0o755 });
        await writeFile(join(bin, 'tar'), `#!/bin/bash\nset -eu\ncase "$2" in\n*/data.tar.gz) echo backup-data >> ${shellQuote(logPath)}; ${mode === 'backup-failure' ? 'exit 1' : ':'};;\n*/code.tar.gz) echo backup-code >> ${shellQuote(logPath)};;\nesac\nexec /usr/bin/tar "$@"\n`, { mode: 0o755 });
        await writeFile(join(bin, 'mv'), `#!/bin/bash\necho publish >> ${shellQuote(logPath)}\nexec /usr/bin/mv "$@"\n`, { mode: 0o755 });
        const fakeNode = join(bin, 'node-fake');
        await writeFile(fakeNode, `#!/bin/bash\necho smoke >> ${shellQuote(logPath)}\nexit ${mode === 'smoke-failure' ? 1 : 0}\n`, { mode: 0o755 });
        const sandboxConfig = { ...loaded, remoteDir: shellPath(sandbox), dataDir: shellPath(data), remoteNode: shellPath(fakeNode) };
        const script = publishScript(sandboxConfig, 'test-release', manifest)
            .replace('SYSTEMCTL=/usr/bin/systemctl', 'SYSTEMCTL=' + shellQuote(shellPath(fakeSystemctl)))
            .replace('set -euo pipefail', 'set -euo pipefail\nexport PATH=' + shellQuote(shellPath(bin)) + ':$PATH');
        const executed = await processRunner(shell, ['--noprofile', '--norc', '-s'], { cwd: ROOT, input: script, timeoutMs: 20000 });
        const events = (await readFile(join(sandbox, 'events'), 'utf8')).trim().split(/\r?\n/);
        const state = (await readFile(join(sandbox, 'state'), 'utf8')).trim();
        const backup = join(backups, 'deploy-test-release');
        if (mode === 'success') {
            check('real shell backs up stopped data before replacing or restarting code', executed.code === 0 && events.indexOf('stop') < events.indexOf('backup-data') && events.indexOf('backup-data') < events.indexOf('backup-code') && events.indexOf('backup-code') < events.indexOf('publish') && events.lastIndexOf('publish') < events.indexOf('restart') && state === 'active');
            check('data backup and code backup are retained after successful deployment', (await stat(join(backup, 'data.tar.gz'))).size > 0 && (await stat(join(backup, 'code.tar.gz'))).size > 0 && existsSync(join(backup, 'app-before', 'old-code-marker')));
            check('publication replaces the existing systemd entry without creating a shadow package tree', (await readFile(installedEntry, 'utf8')) === 'new source podwhale/server/community.mjs'
                && (await readFile(join(backup, 'app-before', 'podwhale', 'server', 'community.mjs'), 'utf8')) === 'old deployed source'
                && !existsSync(join(app, 'xiaolanshu')));
            const listing = await processRunner(shell, ['--noprofile', '--norc', '-c', 'tar -tzf ' + shellQuote(shellPath(join(backup, 'data.tar.gz')))], { cwd: ROOT, timeoutMs: 10000 });
            check('data archive is relative to DATA and preserves database bytes', listing.code === 0 && listing.stdout.split(/\r?\n/).includes('./feed.db') && !listing.stdout.includes(shellPath(data)) && (await readFile(join(data, 'feed.db'), 'utf8')) === 'preserved database bytes');
            const restoredCode = join(sandbox, 'restore-probe-code'), restoredData = join(sandbox, 'restore-probe-data');
            await Promise.all([mkdir(restoredCode), mkdir(restoredData)]);
            const codeRestore = await processRunner(shell, ['--noprofile', '--norc', '-c', 'tar -xzf ' + shellQuote(shellPath(join(backup, 'code.tar.gz'))) + ' -C ' + shellQuote(shellPath(restoredCode))], { cwd: ROOT, timeoutMs: 10000 });
            const dataRestore = await processRunner(shell, ['--noprofile', '--norc', '-c', 'tar -xzf ' + shellQuote(shellPath(join(backup, 'data.tar.gz'))) + ' -C ' + shellQuote(shellPath(restoredData))], { cwd: ROOT, timeoutMs: 10000 });
            const hash = (value) => createHash('sha256').update(value).digest('hex');
            check('isolated backup restoration preserves canonical old-code and data hashes', codeRestore.code === 0 && dataRestore.code === 0
                && hash(await readFile(join(restoredCode, 'podwhale', 'server', 'community.mjs'))) === hash('old deployed source')
                && hash(await readFile(join(restoredData, 'feed.db'))) === hash('preserved database bytes')
                && !existsSync(join(restoredCode, 'xiaolanshu')));
        }
        else if (mode === 'backup-failure') {
            check('backup failure leaves the old code unmodified and the service stopped', executed.code !== 0 && state === 'stopped' && !events.includes('publish') && !events.includes('restart') && existsSync(join(app, 'old-code-marker')));
        }
        else {
            check('security check failure stops the service without restoring old public code', executed.code !== 0 && state === 'stopped' && events.at(-1) === 'stop' && !existsSync(join(app, 'old-code-marker')) && existsSync(join(backup, 'app-before', 'old-code-marker')) && existsSync(join(backup, 'data.tar.gz')));
        }
    }
}
catch (caught) {
    const error = caught;
    check('deployment test completes without an unexpected exception', false, error.message);
}
finally {
    if (preflightCleanup) {
        const target = await realpath(preflightCleanup.directory);
        if (dirname(target).toLowerCase() !== preflightCleanup.parent.toLowerCase() || !basename(target).startsWith('podwhale-preflight-tests-'))
            throw new Error('unsafe preflight fixture cleanup');
        await rm(target, { recursive: true, force: true });
    }
    const parent = await realpath(tmpdir());
    const target = await realpath(temp);
    if (dirname(target).toLowerCase() !== parent.toLowerCase() || !basename(target).startsWith('podwhale-deploy-tests-'))
        throw new Error('unsafe test cleanup');
    await rm(target, { recursive: true, force: true });
}
console.log(failed === 0 ? 'ALL PASS' : failed + ' FAILED');
process.exit(failed === 0 ? 0 : 1);
