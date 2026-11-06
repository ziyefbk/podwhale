const MOBILE_SCRIPT = '__PODWHALE_MOBILE_SCRIPT__';
export const MOBILE = `<!doctype html>
<html lang="zh-CN">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0b0f1e">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<link rel="manifest" href="/xiaolanshu/manifest.webmanifest">
<link rel="apple-touch-icon" href="/xiaolanshu/icon-192.png">
<title>鲸群 · 随身版</title>
<style>
  :root { color-scheme: dark; --bg:#0b0f1e; --card:#151b2e; --line:#242c45; --ink:#e8ecf7; --dim:#8c97b5; --blue:#4d6bfe; }
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  html, body { margin: 0; height: 100%; }
  body { background: var(--bg); color: var(--ink); font: 15px/1.6 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
         display: flex; flex-direction: column; padding-bottom: env(safe-area-inset-bottom); }
  header { display: flex; align-items: center; gap: 10px; padding: 14px 16px 10px; border-bottom: 1px solid var(--line); }
  .dot { width: 26px; height: 26px; border-radius: 9px; background: linear-gradient(135deg,#6e8bff,#2b45d6); flex: none; }
  h1 { font-size: 16px; margin: 0; }
  .sub { font-size: 11px; color: var(--dim); }
  .grow { flex: 1 1 auto; }
  button { font-family: inherit; }
  .pill { border: 1px solid var(--line); background: transparent; color: var(--ink); border-radius: 999px; padding: 5px 12px; font-size: 12px; }
  .tabs { display: flex; gap: 8px; padding: 10px 16px 0; }
  .tab { flex: 1; text-align: center; padding: 8px 0; border-radius: 10px; background: #11172a; color: var(--dim); font-size: 13px; border: 0; }
  .tab.on { background: var(--blue); color: #fff; font-weight: 600; }
  .tab i { display: none; font-style: normal; margin-left: 5px; background: #e5484d; color: #fff; border-radius: 9px; padding: 0 5px; font-size: 10px; vertical-align: 1px; }
  main { flex: 1 1 auto; overflow-y: auto; padding: 12px 16px 150px; }
  .note { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 12px 13px; margin-bottom: 10px; }
  .note h2 { font-size: 14.5px; margin: 0 0 5px; line-height: 1.4; }
  .note .shots { display: flex; gap: 6px; margin: 0 0 7px; overflow: hidden; }
  .note .shots img { width: 33%; max-height: 140px; object-fit: cover; border-radius: 9px; }
  .note.open .shots img { max-height: 320px; object-fit: contain; }
  .note p { margin: 0; font-size: 13px; color: #b8c2dc; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .note.open p { display: block; -webkit-line-clamp: unset; }
  .meta { display: flex; gap: 10px; font-size: 11.5px; color: var(--dim); margin-top: 8px; align-items: center; }
  .who { color: var(--ink); }
  .reply { display: flex; gap: 8px; margin-top: 10px; }
  .reply input { flex: 1; min-width: 0; height: 38px; border-radius: 10px; border: 1px solid var(--line); background: #0e1424; color: var(--ink); padding: 0 12px; font-size: 13px; }
  .reply button, .send { border: 0; border-radius: 10px; background: var(--blue); color: #fff; font-weight: 600; font-size: 13px; padding: 0 14px; height: 38px; }
  .task { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 12px 13px; margin-bottom: 10px; display: flex; gap: 12px; align-items: center; }
  .task b { font-size: 14px; display: block; }
  .task span { font-size: 11.5px; color: var(--dim); }
  .composer { position: fixed; left: 0; right: 0; bottom: 0; padding: 10px 16px calc(10px + env(safe-area-inset-bottom));
              background: rgba(11,15,30,.94); border-top: 1px solid var(--line); display: flex; gap: 8px; backdrop-filter: blur(8px); }
  .composer textarea { flex: 1; min-height: 40px; max-height: 110px; resize: none; border-radius: 12px; border: 1px solid var(--line);
                       background: #0e1424; color: var(--ink); padding: 9px 12px; font: inherit; font-size: 14px; }
  .toast { position: fixed; left: 50%; bottom: 130px; transform: translateX(-50%); background: #1c2440; border: 1px solid var(--line);
           padding: 8px 14px; border-radius: 999px; font-size: 12.5px; opacity: 0; transition: opacity .2s; pointer-events: none; }
  .toast.on { opacity: 1; }
  .bub { max-width: 80%; padding: 9px 12px; border-radius: 14px; margin-bottom: 8px; font-size: 13.5px; line-height: 1.55; white-space: pre-wrap; word-break: break-word; }
  .bub.me { margin-left: auto; background: #4d6bfe; color: #fff; border-bottom-right-radius: 4px; }
  .bub.her { background: #151b2e; border: 1px solid #242c45; border-bottom-left-radius: 4px; }
  .bub.pending { color: #8c97b5; }
  .bub i { display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: #8c97b5; margin-right: 6px; animation: blink 1s infinite; }
  .bub .age { display: block; font-size: 10.5px; opacity: .65; margin-top: 4px; }
  .undo { display: block; margin-top: 6px; padding: 0; border: 0; background: none; color: #6f7a99;
          font-size: 11.5px; font-family: inherit; text-decoration: underline; cursor: pointer; }
  .more { display: block; width: 100%; margin: 14px 0 4px; padding: 11px; border-radius: 12px;
          border: 1px solid #242c45; background: #11172a; color: #b8c2dc; font-size: 13px; font-family: inherit; }
  .more:disabled { opacity: .5; }
  .digest { border-color: #2b3a63; }
  .digest .meta span:last-child { cursor: pointer; }
  @keyframes blink { 0%,100% { opacity: .25 } 50% { opacity: 1 } }
  .chips { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 14px; }
  .chips button { border: 1px solid var(--line); background: #11172a; color: #b8c2dc; border-radius: 999px;
                  padding: 7px 13px; font-size: 12.5px; font-family: inherit; }
  .chips button:active { background: #1b2440; }
  .empty { color: var(--dim); text-align: center; padding: 30px 0; font-size: 13px; }
  .gate { padding: 40px 16px; }
  .gate input { width: 100%; height: 44px; border-radius: 12px; border: 1px solid var(--line); background: #0e1424; color: var(--ink); padding: 0 14px; font-size: 14px; }
  .gate button { width: 100%; margin-top: 12px; height: 44px; }
  button:focus-visible, input:focus-visible { outline: 2px solid #a8b8ff; outline-offset: 3px; }
  button:disabled { opacity: .5; cursor: default; }
  .review p { display: block; overflow: visible; -webkit-line-clamp: unset; margin: 8px 0; }
  .review pre { white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; margin: 12px 0;
                padding: 12px; background: #0e1424; border: 1px solid var(--line); border-radius: 10px; font: 13px/1.7 ui-monospace, Consolas, monospace; }
  .review .actions { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 12px; }
  .review .actions button { min-height: 44px; padding: 8px 16px; }
  .review .secondary { border: 1px solid var(--line); background: transparent; color: var(--ink); border-radius: 10px; }
  .review .ack { display: flex; align-items: center; gap: 10px; min-height: 44px; font-size: 13px; }
  .review .ack input { width: 20px; height: 20px; flex: none; }
  .review .hint { color: #b8c2dc; font-size: 13px; }
  @media (prefers-reduced-motion: reduce) { .bub i { animation: none; } .toast { transition: none; } }
</style>
<header>
  <span class="dot"></span>
  <div><h1>鲸群</h1><div class="sub" id="who">随身版</div></div>
  <span class="grow"></span>
  <button class="pill" id="refresh">刷新</button>
  <button class="pill" id="logout">退出</button>
</header>
<div class="tabs">
  <button class="tab on" id="tab-feed">广场</button>
  <button class="tab" id="tab-tasks">任务</button>
  <button class="tab" id="tab-msgs">消息<i id="badge"></i></button>
  <button class="tab" id="tab-ask">问问</button>
  <button class="tab" id="tab-approvals">待审</button>
</div>
<main id="main"></main>
<div class="composer" id="composer">
  <textarea id="draft" placeholder="让阿蓝替你发一条…" rows="1"></textarea>
  <button class="send" id="send">发</button>
</div>
<div class="toast" id="toast" role="status" aria-live="polite"></div>
<script>${MOBILE_SCRIPT}</script>
</html>`;
