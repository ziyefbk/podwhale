/**
 * Rebuild the MIT PWA icons from ../icon.svg with an installed Chromium browser.
 * No npm packages are required. Use Node >=22.5:
 *   node ops/generate-pwa-icons.mjs [--browser /path/to/chrome-or-edge]
 * PODWHALE_BROWSER can also select the browser. This is an optional maintainer
 * command; installing the plugin or running its tests never launches a browser.
 */
import { spawn } from 'node:child_process';
import { access, readFile, writeFile, mkdtemp, rm, realpath, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = resolve(HERE, '..', 'icon.svg');
const OUTPUT = resolve(HERE, '..', 'server', 'static');
const sizes = [192, 512];
const pause = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

async function browserPath(args) {
  if (args.length && (args.length !== 2 || args[0] !== '--browser')) {
    throw new Error('Usage: node ops/generate-pwa-icons.mjs [--browser PATH]');
  }
  const explicit = args[1] || process.env.PODWHALE_BROWSER;
  const candidates = explicit ? [explicit] : [
    process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env['PROGRAMFILES(X86)'] && join(process.env['PROGRAMFILES(X86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  for (const file of candidates.filter(Boolean)) {
    try { await access(file); return file; } catch { /* try another installed browser */ }
  }
  throw new Error('No installed Chromium browser found; pass --browser PATH');
}

class DevTools {
  constructor(socket) {
    this.socket = socket;
    this.sequence = 0;
    this.pending = new Map();
    socket.addEventListener('message', ({ data }) => {
      const value = JSON.parse(data);
      const pending = this.pending.get(value.id);
      if (!pending) return;
      this.pending.delete(value.id);
      clearTimeout(pending.timer);
      if (value.error) pending.reject(new Error('Chromium rejected a rendering command'));
      else pending.resolve(value.result);
    });
    socket.addEventListener('close', () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error('Chromium rendering connection closed'));
      }
      this.pending.clear();
    });
  }
  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => reject(new Error('Chromium connection timed out')), 10000);
      socket.addEventListener('open', () => { clearTimeout(timer); resolvePromise(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Chromium connection failed')); }, { once: true });
    });
    return new DevTools(socket);
  }
  call(method, params = {}, sessionId) {
    const id = ++this.sequence;
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Chromium rendering timed out')); }, 10000);
      this.pending.set(id, { resolve: resolvePromise, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
}

function iconPage(svg) {
  const source = Buffer.from(svg, 'utf8').toString('base64');
  // The source's painted bounds are x=4..48/y=10..43. This placement centers
  // the whale and keeps all painted points inside the maskable 40% safe radius.
  return `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#eff4ff}
img{position:absolute;left:11%;top:10.25%;width:72%;height:72%;display:block}
</style><img alt="" src="data:image/svg+xml;base64,${source}">`;
}

function assertDimensions(png, size) {
  if (!png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    || png.readUInt32BE(16) !== size || png.readUInt32BE(20) !== size) {
    throw new Error('Rendered PNG has unexpected dimensions');
  }
}

async function generate() {
  if (typeof WebSocket !== 'function') throw new Error('Node >=22.5 is required');
  const executable = await browserPath(process.argv.slice(2));
  const svg = await readFile(SOURCE, 'utf8');
  if (!/viewBox="0 0 48 48"/.test(svg) || /<(?:script|image|foreignObject)\b|\bon\w+\s*=|(?:href|src)\s*=/i.test(svg)) {
    throw new Error('The icon source must remain a self-contained vector SVG');
  }
  const temporary = await mkdtemp(join(tmpdir(), 'podwhale-pwa-icons-'));
  const profile = join(temporary, 'profile');
  let browser;
  let exited = false;
  let client;
  try {
    browser = spawn(executable, ['--headless=new', '--disable-gpu', '--disable-extensions',
      '--disable-background-networking', '--no-first-run', '--no-default-browser-check',
      '--hide-scrollbars', '--mute-audio', '--remote-debugging-port=0',
      '--remote-debugging-address=127.0.0.1', '--user-data-dir=' + profile, 'about:blank'],
    { stdio: 'ignore', windowsHide: true, shell: false });
    let startupError = false;
    browser.on('error', () => { startupError = true; exited = true; });
    browser.on('exit', () => { exited = true; });
    const deadline = Date.now() + 15000;
    let endpoint;
    while (Date.now() < deadline && !startupError && !exited) {
      try {
        const [port, path] = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).trim().split(/\r?\n/);
        if (/^\d+$/.test(port) && /^\/devtools\/browser\/[a-f0-9-]+$/i.test(path)) {
          endpoint = 'ws://127.0.0.1:' + port + path;
          break;
        }
      } catch { /* the browser is still starting */ }
      await pause(50);
    }
    if (!endpoint) throw new Error('Chromium did not start its isolated rendering profile');
    client = await DevTools.connect(endpoint);
    const { targetId } = await client.call('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await client.call('Target.attachToTarget', { targetId, flatten: true });
    await client.call('Page.enable', {}, sessionId);
    const outputs = [];
    for (const size of sizes) {
      await client.call('Emulation.setDeviceMetricsOverride', {
        width: size, height: size, deviceScaleFactor: 1, mobile: false,
      }, sessionId);
      await client.call('Page.navigate', { url: 'data:text/html;charset=utf-8,' + encodeURIComponent(iconPage(svg)) }, sessionId);
      const decoded = await client.call('Runtime.evaluate', {
        expression: 'Promise.all(Array.from(document.images).map(image => image.decode())).then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))',
        awaitPromise: true, returnByValue: true,
      }, sessionId);
      if (decoded.exceptionDetails) throw new Error('The SVG did not decode');
      const result = await client.call('Page.captureScreenshot', {
        format: 'png', fromSurface: true, captureBeyondViewport: false,
        clip: { x: 0, y: 0, width: size, height: size, scale: 1 },
      }, sessionId);
      const png = Buffer.from(result.data, 'base64');
      assertDimensions(png, size);
      outputs.push({ file: join(OUTPUT, 'icon-' + size + '.png'), png, size });
    }
    await mkdir(OUTPUT, { recursive: true });
    for (const output of outputs) {
      await writeFile(output.file, output.png);
      console.log('Generated icon-' + output.size + '.png (' + output.size + ' x ' + output.size + ')');
    }
    console.log('SVG SHA-256 ' + createHash('sha256').update(svg).digest('hex'));
  } finally {
    try { await client?.call('Browser.close'); } catch { /* closing can disconnect before its reply */ }
    client?.socket.close();
    for (let i = 0; browser && !exited && i < 50; i++) await pause(100);
    if (browser && !exited) browser.kill();
    const parent = await realpath(tmpdir());
    const target = await realpath(temporary);
    if (dirname(target).toLowerCase() !== parent.toLowerCase() || !basename(target).startsWith('podwhale-pwa-icons-')) {
      throw new Error('Refusing cleanup outside the icon rendering temp directory');
    }
    await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

generate().catch((error) => { console.error(error.message); process.exitCode = 1; });
