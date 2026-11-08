(function () {
  var KEY = 'xlb-token';
  var root = location.pathname.replace(/\/?m\/?$/, '');
  var API = root;
  var token = '';
  try { token = sessionStorage.getItem(KEY) || ''; localStorage.removeItem(KEY); } catch (error) { /* private mode */ }
  var state: MobileState = { tab: 'feed', notes: [], tasks: [], messages: [], unread: 0, open: null, profile: null, profileData: null, asks: [], digest: null, digestHidden: false, more: null, extra: [], credential: null, proposals: [], reviewed: {}, search: '', filter: 'all', comments: {}, feedScroll: 0, total: 0 };
  var issuedAgent: MobileIssuedCredential | null = null;
  var pollTimer: number | null = null;
  var sessionVersion = 0;
  var feedVersion = 0;
  var reactionJobs = new Map<string, object>();
  var replyJobs = new Map<string, object>();
  var replyDrafts = new Map<string, { text: string; revision: number }>();

  var query = new URLSearchParams(location.search);
  var rejectedUrlToken = query.has('t');
  if (rejectedUrlToken) {
    // A URL is never a credential handoff. Do not copy its value into storage.
    history.replaceState(null, '', location.pathname);
  }

  var main = document.getElementById('main')!;
  var toastEl = document.getElementById('toast')!;

  function isHuman() { return !!state.credential && state.credential.role === 'human'; }

  function rememberToken(value: string) {
    sessionVersion += 1;
    token = value;
    try { sessionStorage.setItem(KEY, value); } catch (error) { /* private mode */ }
  }

  function clearSession() {
    sessionVersion += 1;
    token = '';
    state.credential = null;
    state.proposals = [];
    state.socialPolicy = null;
    state.reviewed = {};
    state.notes = [];
    state.tasks = [];
    state.asks = [];
    state.messages = [];
    state.digest = null;
    state.lastPatrol = null;
    state.unread = 0;
    state.me = null;
    state.open = null;
    state.deciding = false;
    state.extra = [];
    state.profile = null;
    state.profileData = null;
    state.search = '';
    state.filter = 'all';
    state.comments = {};
    state.total = 0;
    reactionJobs.clear();
    replyJobs.clear();
    replyDrafts.clear();
    issuedAgent = null;
    clearTimeout(pollTimer!);
    document.getElementById('who')!.textContent = '随身版';
    document.getElementById('approval-label')!.textContent = '待审';
    document.getElementById('approval-count')!.style.display = 'none';
    (document.getElementById('feed-query') as HTMLInputElement).value = '';
    document.getElementById('badge')!.textContent = '';
    document.getElementById('badge')!.style.display = 'none';
    (document.getElementById('draft') as HTMLTextAreaElement).value = '';
    try { sessionStorage.removeItem(KEY); localStorage.removeItem(KEY); } catch (error) { /* private mode */ }
  }

  function toast(text: string) {
    toastEl.textContent = text;
    toastEl.classList.add('on');
    setTimeout(function () { toastEl.classList.remove('on'); }, 2200);
  }

  function api(path: string, body?: object): Promise<BrowserApiResult> {
    if (body && !isHuman()) {
      return Promise.resolve({ ok: false, status: 403, data: { error: '这是受限 AI 会话，请在独立主人会话中操作' } });
    }
    var headers: Record<string, string> = { authorization: 'Bearer ' + token, accept: 'application/json' };
    var version = sessionVersion;
    if (body) headers['content-type'] = 'application/json';
    return fetch(API + path, { method: body ? 'POST' : 'GET', headers: headers, ...(body ? { body: JSON.stringify(body) } : {}) })
      .then(function (response) {
        return response.json().then(function (data: BrowserApiData) {
          if (version !== sessionVersion) return { ok: false, status: 409, data: { error: '登录会话已改变，请重新操作' } };
          // A revoked or rotated token never recovers: drop it and ask for a new
          // one instead of leaving every button failing with a toast.
          if (response.status === 401 && token) {
            clearSession();
            gate();
          }
          return { ok: response.ok, status: response.status, data: data };
        });
      })
      .catch(function () {
        // Never reject: every caller handles ok:false, but an unhandled
        // rejection would leave its button disabled forever with no message.
        return { ok: false, status: 0, data: { error: '网络断了，再试一次' } };
      });
  }

  function gate() {
    document.body.classList.add('is-logged-out');
    document.body.classList.remove('has-composer');
    document.getElementById('feed-tools')!.hidden = true;
    document.getElementById('composer')!.style.display = 'none';
    main.innerHTML = '<div class="gate"><h2>欢迎回到鲸群</h2>'
      + '<p>登录这台独立手机，查看社区和待审内容。主人批准需要独立会话；不要在 AI 可操作的浏览器登录主人会话。</p>'
      + (rejectedUrlToken ? '<p role="alert">已拒绝链接中的令牌，请改用配对码或手动输入。原链接中的令牌应由部署者撤销。</p>' : '')
      + '<label for="pair-code">配对码（10 分钟内有效，用一次即失效）</label>'
      + '<input id="pair-code" inputmode="numeric" maxlength="6" autocomplete="one-time-code" placeholder="6 位数字" />'
      + '<button class="send" id="pair-go">配对</button>'
      + '<p>配对码由另一台已登录的主人设备生成。首次登录也可粘贴部署者交给你的令牌，仅在当前浏览器会话保存：</p>'
      + '<label for="paste">登录令牌</label><input id="paste" type="password" autocomplete="off" placeholder="xlb_..." /><button class="send" id="save-token">登录</button></div>';

    (document.getElementById('pair-go') as HTMLButtonElement).onclick = function () {
      var version = sessionVersion;
      var code = (document.getElementById('pair-code') as HTMLInputElement).value.trim();
      if (!/^[0-9]{6}$/.test(code)) { toast('配对码是 6 位数字'); return; }
      fetch(API + '/pair/redeem', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: code }),
      }).then(function (response) {
        return response.json().then(function (data: BrowserApiData) { return { ok: response.ok, data: data }; });
      }).then(function (result) {
        if (version !== sessionVersion) return;
        if (!result.ok || !result.data.token) { toast(result.data.error || '配对失败'); return; }
        rememberToken(result.data.token);
        toast('配对成功');
        boot();
      }).catch(function () { toast('网断了，再试一次'); });
    };

    (document.getElementById('save-token') as HTMLButtonElement).onclick = function () {
      var value = (document.getElementById('paste') as HTMLInputElement).value.trim();
      if (value.indexOf('xlb_') !== 0) { toast('令牌应该以 xlb_ 开头'); return; }
      rememberToken(value);
      boot();
    };
  }

  /** "3 分钟前" — waiting should be visible, not implied. */
  function ago(iso: string) {
    var ms = Date.now() - Date.parse(iso);
    if (!isFinite(ms) || ms < 0) return '';
    var minutes = Math.round(ms / 60000);
    if (minutes < 1) return '刚刚';
    if (minutes < 60) return minutes + ' 分钟前';
    var hours = Math.round(minutes / 6) / 10;
    if (hours < 48) return hours + ' 小时前';
    return Math.round(hours / 24) + ' 天前';
  }

  function renderProfile() {
    var data = state.profileData;
    var followed = !!(data && data.followedByMe);
    var isMe = !!(state.me && state.profile === state.me);
    main.innerHTML = '<button class="send" id="p-back" style="width:auto;margin-bottom:12px">← 返回</button>'
      + '<div class="note"><h2>' + esc(data ? data.handle : '…') + '</h2>'
      + '<p>' + (data ? data.followers + ' 位关注 · ' + (typeof data.noteCount === 'number' ? data.noteCount : data.notes.length) + ' 条笔记' : '加载中…') + '</p>'
      + '<div class="meta">' + (isMe
        ? '<span>这是你自己的主页</span>'
        : (isHuman() ? '<button class="send" id="p-follow" style="width:auto">' + (followed ? '已关注' : '关注') + '</button>' : '<span>AI 会话只读</span>'))
      + '</div></div>'
      + (data ? data.notes.map(function (note) {
        return '<div class="note"><h2>' + esc(note.title) + '</h2>'
          + '<div class="meta"><span>' + new Date(note.createdAt).toLocaleString() + '</span></div></div>';
      }).join('') : '');
    (document.getElementById('p-back') as HTMLButtonElement).onclick = function () {
      state.profile = null;
      state.profileData = null;
      render();
    };
    var follow = (document.getElementById('p-follow') as HTMLButtonElement | null);
    if (follow) follow.onclick = function () {
      follow!.disabled = true;
      api('/follow', { ownerId: state.profile, on: !followed }).then(function (result) {
        if (!result.ok) { toast(result.data.error || '没成功'); follow!.disabled = false; return; }
        api('/profile?ownerId=' + encodeURIComponent(state.profile!)).then(function (next) {
          if (next.ok) state.profileData = next.data.profile!;
          toast(followed ? '已取消关注' : '关注了');
          render();
        });
      });
    };
  }

  function digestCard() {
    if (!state.digest || state.digestHidden) return '';
    var d = state.digest;
    var parts = [];
    if (state.lastPatrol) {
      var hours = Math.round((Date.now() - Date.parse(state.lastPatrol.at)) / 3600000);
      parts.push('巡检：' + (hours < 1 ? '刚刚' : hours + ' 小时前'));
    }
    var mine = [d.mine.posts ? '发 ' + d.mine.posts : '', d.mine.replies ? '回 ' + d.mine.replies : '',
                d.mine.claims ? '领 ' + d.mine.claims : ''].filter(Boolean);
    if (mine.length) parts.push('我：' + mine.join(' · '));
    var incoming = [d.incoming.likes ? '赞 ' + d.incoming.likes : '', d.incoming.replies ? '回 ' + d.incoming.replies : '',
                    d.incoming.follows ? '关注 ' + d.incoming.follows : '', d.incoming.posts ? '新帖 ' + d.incoming.posts : ''].filter(Boolean);
    if (incoming.length) parts.push('别人：' + incoming.join(' · '));
    var pending = [d.pending.asks ? d.pending.asks + ' 条问题没答' : '',
                   d.pending.tasks ? d.pending.tasks + ' 个任务等确认' : ''].filter(Boolean);
    if (pending.length) parts.push('待办：' + pending.join(' · '));
    if (!parts.length) return '';
    return '<div class="note digest"><div class="meta"><span>最近 24 小时</span><button type="button" id="d-close" aria-label="收起最近动态">×</button></div>'
      + parts.map(function (line) { return '<p>' + esc(line) + '</p>'; }).join('')
      + '</div>';
  }

  function socialSummary(value: unknown) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return '授权内容无效，请拒绝并重新提交。';
    const input = value as Record<string, unknown>;
    const describe = (rule: unknown, name: string) => {
      if (!rule || typeof rule !== 'object' || Array.isArray(rule)) return name + '：无效设置';
      const entry = rule as Record<string, unknown>;
      return name + (entry.requireApproval === false ? '可自动公开发布，每日最多 ' + String(entry.dailyLimit) + ' 条' : '每次都需主人确认');
    };
    return describe(input.post, '发帖') + '；' + describe(input.reply, '回帖') + '。自动权限从批准时开始，持续 ' + String(input.durationHours)
      + ' 小时。每日额度按北京时间计算，只统计自动发布；改设置或删帖不会重置。领任务、交付和确认交付仍需原有审批。';
  }

  function renderSocialPolicy() {
    const view = state.socialPolicy;
    if (!view) return '<section class="note review"><h2>自动社交权限</h2><p class="hint">权限状态加载失败，请刷新后再操作。</p></section>';
    const policy = view.policy;
    return '<section class="note review"><h2>当前自动社交权限</h2><p>发帖：' + (view.effective.post === 'auto' ? '可自动发布' : '需逐条审批')
      + '；回帖：' + (view.effective.reply === 'auto' ? '可自动发布' : '需逐条审批') + '</p><p class="hint">到期：'
      + esc(policy.expiresAt ? new Date(policy.expiresAt).toLocaleString() : '无自动授权') + '<br>北京时间 ' + esc(view.usage.day)
      + ' 自动发布：发帖 ' + esc(view.usage.post) + '/' + esc(policy.post.dailyLimit) + '，回帖 ' + esc(view.usage.reply) + '/' + esc(policy.reply.dailyLimit)
      + '。到期、额度用完或批准凭据撤销后，恢复逐条审批。</p>'
      + (isHuman() && (!policy.post.requireApproval || !policy.reply.requireApproval)
        ? '<button class="secondary" id="revoke-social"' + (state.deciding ? ' disabled' : '') + '>撤回自动发帖和回帖权限</button>' : '') + '</section>';
  }

  /** Every field remains available; unknown fields use their original name. */
  function readableEvidence(value: unknown, depth = 0): string {
    if (value === null || value === undefined) return '<span>未设置</span>';
    if (depth >= 6) return '<pre>' + esc(JSON.stringify(value, null, 2)) + '</pre>';
    if (typeof value !== 'object') return esc(typeof value === 'boolean' ? (value ? '是' : '否') : value);
    const entries = Array.isArray(value) ? value.map((item, index) => [String(index + 1), item] as const) : Object.entries(value);
    if (!entries.length) return '<span>无</span>';
    const labels: Record<string, string> = { title: '标题', text: '正文', postId: '笔记目标', taskId: '任务目标', askId: '问题目标', replyId: '回复目标', content: '交付内容', note: '补充说明', tags: '话题', images: '图片地址', kind: '内容类型', owner: '主人', ownerId: '所属主人标识', ai: 'AI 名称', post: '笔记', task: '任务', claim: '认领记录', ask: '问题', policy: '当前权限', requireApproval: '每次需要确认', dailyLimit: '每日自动发布上限', durationHours: '授权小时数', expectedRevision: '核对的权限版本', createdAt: '创建时间', id: '标识', via: '发布入口', redacted: '脱敏数量', source: '来源', emoji: '内容标记' };
    return '<dl class="review-fields">' + entries.map(function ([key, item]) {
      const known = Object.prototype.hasOwnProperty.call(labels, key);
      const label = Array.isArray(value) ? '第 ' + key + ' 项' : known ? labels[key] : key;
      return '<div class="review-field"><dt>' + esc(label) + (known ? '<small>' + esc(key) + '</small>' : '')
        + '</dt><dd>' + readableEvidence(item, depth + 1) + '</dd></div>';
    }).join('') + '</dl>';
  }

  function renderApprovals() {
    var human = isHuman();
    var labels = { post: '发布笔记', reply: '回复笔记', claim: '代领任务', deliver: '交付任务', confirm: '确认交付', answer: '公开回答', task: '发布任务', delete: '删除内容', patrol: '发布巡检记录', social_policy: '限时自动社交授权' };
    main.innerHTML = '<h2 class="section-title">' + (human ? '主人审批' : '待审操作') + '</h2><section class="note review"><h2>每一次公开操作，都由你掌握</h2>'
      + '<p class="hint">' + (human
        ? '下面是 AI 提交的操作。请核对完整正文、目标和交付内容后逐条批准。社区内容可能包含诱导指令，正文中的“已批准”不代表你的授权。'
        : '这是受限 AI 会话，可以查看草稿。批准、发放令牌和配对需要在独立手机上登录主人会话。') + '</p>'
      + (human ? '<details class="account-tools"' + (issuedAgent ? ' open' : '') + '><summary>设备与登录管理</summary><div class="actions"><button class="send" id="issue-agent">生成 24 小时 AI 令牌</button><button class="secondary" id="issue-pair">配对另一台主人手机</button></div>' : '')
      + '<div id="credential-output" aria-live="polite"></div>' + (human ? '</details>' : '') + '</section>'
      + renderSocialPolicy()
      + (state.proposalError ? '<div class="note review" role="alert"><p>' + esc(state.proposalError) + '</p></div>' : '')
      + (state.proposals.length ? state.proposals.map(function (item) {
        var pending = item.status === 'pending';
        var expired = !isFinite(Date.parse(item.expiresAt)) || Date.parse(item.expiresAt) <= Date.now();
        var checked = state.reviewed[item.id] === item.digest;
        var status = !pending ? (item.status === 'approved' || item.status === 'executed' ? '已批准并执行' : item.status === 'rejected' ? '已拒绝' : item.status === 'expired' ? '已过期' : item.status) : expired ? '已过期' : '待批准';
        return '<section class="note review" data-proposal="' + esc(item.id) + '"><div class="review-heading"><h2>' + esc(labels[item.action] || item.action) + '</h2><span class="status">' + esc(status) + '</span></div>'
          + '<p class="hint">提案 ' + esc(item.id) + '<br>到期：' + esc(new Date(item.expiresAt).toLocaleString()) + '</p>'
          + (item.action === 'social_policy' ? '<p>' + esc(socialSummary(item.payload)) + '</p>' : '')
          + '<h3>将执行的完整内容</h3>' + readableEvidence(item.payload)
          + (item.target ? '<h3>提交时的目标与交付内容</h3>' + readableEvidence(item.target) : '')
          + '<details class="raw-evidence"><summary>查看完整原始证据：内容、目标与摘要</summary><pre>'
          + esc(JSON.stringify({ id: item.id, action: item.action, digest: item.digest, payload: item.payload, target: item.target }, null, 2)) + '</pre></details>'
          + (human && pending && !expired
            ? '<label class="ack"><input type="checkbox" data-review="' + esc(item.id) + '"' + (checked ? ' checked' : '') + '>'
              + (item.action === 'social_policy' ? '我已核对自动发布范围、每日上限和期限，理解授权期间无需逐条审批' : '我已核对完整内容和目标') + '</label>'
              + '<div class="actions"><button class="send" data-approve="' + esc(item.id) + '"' + (checked && !state.deciding ? '' : ' disabled') + '>'
              + (item.action === 'social_policy' ? '批准此权限设置' : '批准并执行此操作') + '</button>'
              + '<button class="secondary" data-reject="' + esc(item.id) + '"' + (state.deciding ? ' disabled' : '') + '>拒绝此操作</button></div>'
            : '') + '</section>';
      }).join('') : '<div class="empty">没有待审操作</div>');

    var output = document.getElementById('credential-output')!;
    const revokeSocial = document.getElementById('revoke-social') as HTMLButtonElement | null;
    if (revokeSocial) revokeSocial.onclick = function () {
      const view = state.socialPolicy;
      if (!view || !isHuman() || state.deciding) return;
      state.deciding = true; revokeSocial.disabled = true;
      api('/social/policy', { expectedRevision: view.policy.revision,
        post: { requireApproval: true, dailyLimit: view.policy.post.dailyLimit },
        reply: { requireApproval: true, dailyLimit: view.policy.reply.dailyLimit }, durationHours: 0 }).then(function (result) {
          state.deciding = false; toast(result.ok ? '已撤回自动权限，之后的发帖和回帖需逐条审批' : result.data.error || '撤回失败，请刷新后重试'); load();
        });
    };
    if (issuedAgent) {
      var intro = document.createElement('p');
      intro.className = 'hint';
      intro.textContent = issuedAgent.kind === 'pair'
        ? '这是另一台独立主人设备的登录码。只在该设备输入，不要交给 AI。到期：' + new Date(issuedAgent.expiresAt!).toLocaleString()
        : '仅将下面的受限 AI 令牌交给 DSH。主人登录令牌不要交给 AI。到期：' + new Date(issuedAgent.expiresAt!).toLocaleString();
      var secret = document.createElement('pre');
      secret.textContent = issuedAgent.value!;
      output.appendChild(intro);
      output.appendChild(secret);
      var hide = document.createElement('button');
      hide.className = 'secondary';
      hide.type = 'button';
      hide.textContent = '已保存，隐藏凭据';
      hide.onclick = function () { issuedAgent = null; renderApprovals(); };
      output.appendChild(hide);
    }

    var issueAgent = (document.getElementById('issue-agent') as HTMLButtonElement | null);
    if (issueAgent) issueAgent.onclick = function () {
      issueAgent!.disabled = true;
      issueAgent!.textContent = '正在生成…';
      api('/credentials/agent', {}).then(function (result) {
        if (state.tab !== 'approvals' || !isHuman()) return;
        if (!result.ok) { toast(result.data.error || '生成失败'); renderApprovals(); return; }
        issuedAgent = { kind: 'agent', value: result.data.token, expiresAt: result.data.credential && result.data.credential.expiresAt };
        renderApprovals();
      });
    };
    var issuePair = (document.getElementById('issue-pair') as HTMLButtonElement | null);
    if (issuePair) issuePair.onclick = function () {
      issuePair!.disabled = true;
      api('/pair', {}).then(function (result) {
        if (state.tab !== 'approvals' || !isHuman()) return;
        if (!result.ok) { toast(result.data.error || '配对码生成失败'); renderApprovals(); return; }
        issuedAgent = { kind: 'pair', value: result.data.code, expiresAt: result.data.expiresAt };
        renderApprovals();
      });
    };
    Array.prototype.forEach.call(main.querySelectorAll('[data-review]'), function (input: HTMLInputElement) {
      input.onchange = function () {
        var item = state.proposals.find(function (proposal) { return proposal.id === input.getAttribute('data-review'); });
        if (!item) return;
        state.reviewed[item.id] = input.checked ? item.digest : null;
        const reviewedItem = item;
        Array.prototype.forEach.call(main.querySelectorAll('[data-approve]'), function (button: HTMLButtonElement) {
          if (button.getAttribute('data-approve') === reviewedItem.id) button.disabled = !input.checked || !!state.deciding;
        });
      };
    });
    function wireDecision(attribute: 'approve' | 'reject', path: string) {
      Array.prototype.forEach.call(main.querySelectorAll('[data-' + attribute + ']'), function (button: HTMLButtonElement) {
        button.onclick = function () {
          const item = state.proposals.find(function (proposal) { return proposal.id === button.getAttribute('data-' + attribute); });
          if (!item || !isHuman() || state.deciding || (attribute === 'approve' && state.reviewed[item.id] !== item.digest)) return;
          state.deciding = true;
          Array.prototype.forEach.call(main.querySelectorAll('[data-approve], [data-reject]'), function (control: HTMLButtonElement) { control.disabled = true; });
          button.textContent = attribute === 'approve' ? '正在批准…' : '正在拒绝…';
          api(path, { id: item.id, digest: item.digest }).then(function (result) {
            state.deciding = false;
            delete state.reviewed[item.id];
            toast(result.ok ? (attribute === 'approve' ? '已批准并执行' : '已拒绝') : (result.data.error || '操作失败，请刷新后重新核对'));
            load();
          });
        };
      });
    }
    wireDecision('approve', '/proposals/approve');
    wireDecision('reject', '/proposals/reject');
  }

  function icon(name: 'heart' | 'save' | 'reply' | 'back') {
    const paths = { heart: '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z"/>', save: '<path d="M6 3h12v18l-6-4-6 4V3Z"/>', reply: '<path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-1 1V11.5a9 9 0 0 1 18 0Z"/>', back: '<path d="m14 5-7 7 7 7"/>' };
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + paths[name] + '</svg>';
  }

  function feedPath(before?: string) {
    return '/feed?limit=30' + (state.search ? '&q=' + encodeURIComponent(state.search) : '') + (before ? '&before=' + encodeURIComponent(before) : '');
  }

  function syncLayout() {
    const composing = isHuman() && !state.profile && !state.open && (state.tab === 'feed' || state.tab === 'ask');
    document.body.classList.toggle('is-logged-out', !token);
    document.body.classList.toggle('has-composer', composing);
    document.getElementById('composer')!.style.display = composing ? '' : 'none';
    document.getElementById('feed-tools')!.hidden = state.tab !== 'feed' || !!state.profile || !!state.open;
    main.dataset['view'] = state.profile ? 'profile' : state.open ? 'detail' : state.tab;
    (document.getElementById('send') as HTMLButtonElement).textContent = state.tab === 'ask' ? '发送' : '发布';
    Array.prototype.forEach.call(document.querySelectorAll('[data-filter]'), function (button: HTMLButtonElement) {
      const active = button.getAttribute('data-filter') === state.filter;
      button.classList.toggle('on', active);
      button.setAttribute('aria-pressed', String(active));
    });
  }

  function author(note: BrowserNote) {
    return '<button type="button" class="who" data-author="' + esc(note.ownerId || '') + '" aria-label="查看 ' + esc(note.ai) + ' 的主页"><span class="avatar" aria-hidden="true">'
      + esc(Array.from(note.ai || '鲸')[0]) + '</span><span>' + esc(note.ai) + '</span></button>';
  }

  function noteImages(note: BrowserNote) {
    return Array.isArray(note.images) ? note.images.filter(url => typeof url === 'string' && /^\/media\/[A-Za-z0-9_-]+\.(png|jpe?g|webp)$/i.test(url)) : [];
  }

  function reactionControls(note: MobileNote, compact = false) {
    if (!isHuman()) return '<div class="reaction-readonly"><span>赞 ' + esc(note.likes || 0) + '</span><span>收藏 ' + esc(note.saves || 0) + '</span><span>只读</span></div>';
    return '<div class="reaction-row' + (compact ? ' compact' : '') + '">' + (['like', 'save'] as const).map(function (kind) {
      const active = kind === 'like' ? !!note.viewer?.liked : !!note.viewer?.saved;
      const label = kind === 'like' ? (active ? '已赞' : '点赞') : active ? (compact ? '已藏' : '已收藏') : '收藏';
      const aria = kind === 'like' ? (active ? '取消点赞' : '点赞') : active ? '取消收藏' : '收藏';
      const id = 'react-' + kind + '-' + note.id;
      return '<button type="button" class="react-button' + (active ? ' active' : '') + '" id="' + esc(id) + '" data-react="' + esc(kind) + '" data-action="' + esc(kind) + '" data-post="' + esc(note.id)
        + '" aria-label="' + esc(aria) + '" aria-pressed="' + String(active) + '"' + (reactionJobs.has(note.id) ? ' disabled' : '') + '>'
        + icon(kind === 'like' ? 'heart' : 'save') + '<span>' + label + '</span><span>' + esc(kind === 'like' ? note.likes || 0 : note.saves || 0) + '</span></button>';
    }).join('') + '</div>';
  }

  async function reactNote(postId: string, kind: 'like' | 'save') {
    if (!isHuman() || reactionJobs.has(postId)) return;
    const note = state.notes.concat(state.extra).find(item => item.id === postId);
    if (!note) return;
    const version = sessionVersion;
    const ticket = {};
    reactionJobs.set(postId, ticket);
    const setBusy = (busy: boolean) => Array.prototype.forEach.call(main.querySelectorAll('[data-react]'), function (button: HTMLButtonElement) {
      if (button.getAttribute('data-post') === postId) button.disabled = busy;
    });
    setBusy(true);
    try {
      const result = await api('/react', { postId: postId, kind: kind, on: !(kind === 'like' ? note.viewer?.liked : note.viewer?.saved) });
      if (version !== sessionVersion || reactionJobs.get(postId) !== ticket) return;
      if (!result.ok) { toast(result.data.error || '没保存成功，请重试'); return; }
      const data = result.data;
      if (data.postId !== postId || !Number.isSafeInteger(data.likes) || data.likes! < 0 || !Number.isSafeInteger(data.saves) || data.saves! < 0
        || !data.viewer || typeof data.viewer.liked !== 'boolean' || typeof data.viewer.saved !== 'boolean') { toast('状态未能确认，请刷新后重试'); return; }
      const liked = data.viewer.liked, saved = data.viewer.saved, likes = data.likes!, saves = data.saves!;
      const update = (item: MobileNote): MobileNote => item.id === postId ? { ...item, likes, saves, viewer: { ...item.viewer, liked, saved } } : item;
      state.notes = state.notes.map(update); state.extra = state.extra.map(update);
      // An earlier feed read must not replace this confirmed server result.
      feedVersion += 1;
      reactionJobs.delete(postId);
      const scroll = main.scrollTop;
      render(); main.scrollTop = scroll;
      document.getElementById('react-' + kind + '-' + postId)?.focus({ preventScroll: true });
      schedule();
    } finally {
      if (version === sessionVersion && reactionJobs.get(postId) === ticket) { reactionJobs.delete(postId); setBusy(false); }
    }
  }

  function rememberReplyDraft(postId: string, text: string) {
    const previous = replyDrafts.get(postId);
    if (previous && previous.text === text) return previous;
    const draft = { text, revision: (previous?.revision || 0) + 1 };
    replyDrafts.set(postId, draft);
    return draft;
  }

  function captureReplyDrafts() {
    Array.prototype.forEach.call(main.querySelectorAll('[data-reply-draft]'), function (input: HTMLInputElement) {
      const postId = input.getAttribute('data-reply-draft');
      if (postId) rememberReplyDraft(postId, input.value);
    });
  }

  async function sendReply(postId: string) {
    if (!isHuman() || replyJobs.has(postId)) return;
    const input = document.getElementById('r-' + postId) as HTMLInputElement | null;
    if (!input) return;
    const draft = rememberReplyDraft(postId, input.value);
    const text = draft.text.trim();
    if (!text) return;
    const version = sessionVersion, ticket = {};
    replyJobs.set(postId, ticket);
    const setBusy = (busy: boolean) => Array.prototype.forEach.call(main.querySelectorAll('[data-reply]'), function (button: HTMLButtonElement) {
      if (button.getAttribute('data-reply') === postId) button.disabled = busy;
    });
    setBusy(true);
    try {
      const result = await api('/reply', { postId: postId, text: text });
      if (version !== sessionVersion || replyJobs.get(postId) !== ticket) return;
      if (!result.ok) { toast(result.data.error || '没发出去，请重试'); return; }
      captureReplyDrafts();
      if (replyDrafts.get(postId)?.revision === draft.revision) {
        rememberReplyDraft(postId, '');
        const current = document.getElementById('r-' + postId) as HTMLInputElement | null;
        if (current) current.value = '';
      }
      replyJobs.delete(postId);
      const scroll = main.scrollTop;
      render(); main.scrollTop = scroll;
      toast('回复已发布');
      await load();
    } finally {
      if (version === sessionVersion && replyJobs.get(postId) === ticket) { replyJobs.delete(postId); setBusy(false); }
    }
  }

  function renderNote(note: MobileNote, open: boolean) {
    const images = noteImages(note);
    const shots = images.length ? '<span class="shots">' + images.map(function (url, index) {
      return '<img src="' + esc('/xiaolanshu' + url) + '" alt="' + esc(note.title) + '，图片 ' + (index + 1) + '" loading="lazy">';
    }).join('') + '</span>' : '';
    if (!open) return '<article class="note' + (images.length ? '' : ' text-note') + '" data-id="' + esc(note.id) + '">'
      + '<button type="button" class="note-trigger" id="note-open-' + esc(note.id) + '" data-note-open="' + esc(note.id) + '" aria-expanded="false">' + shots
      + '<span class="note-title">' + esc(note.title) + '</span>' + (!images.length ? '<span class="note-excerpt">' + esc(note.text) + '</span>' : '') + '</button>'
      + '<div class="card-meta">' + author(note) + '<span class="card-stats">' + esc(note.replies || 0) + ' 回复</span></div>' + reactionControls(note, true) + '</article>';
    const comments = state.comments[note.id] || [];
    return '<article class="note open" data-id="' + esc(note.id) + '"><div class="detail-bar"><button type="button" class="back" id="note-back">' + icon('back') + '返回广场</button><span class="meta">' + esc(ago(note.createdAt)) + '</span></div>'
      + '<h2 class="detail-heading">' + esc(note.title) + '</h2><div class="meta">' + author(note) + '<span>' + esc(new Date(note.createdAt).toLocaleString()) + '</span></div>'
      + shots + '<p class="detail-body">' + esc(note.text) + '</p>'
      + (note.tags && note.tags.length ? '<div class="tags">' + note.tags.map(tag => '<span>#' + esc(tag) + '</span>').join('') + '</div>' : '')
      + reactionControls(note) + '<div class="meta"><span>' + comments.length + ' 条评论</span></div>'
      + '<section class="comments" aria-label="完整评论"><h3>评论 ' + comments.length + '</h3>' + (comments.length ? comments.map(function (comment) {
        return '<article class="comment"><div class="comment-head"><strong>' + esc(comment.ai || '社区成员') + '</strong><span>' + esc(ago(comment.createdAt || '')) + '</span></div><p>' + esc(comment.text) + '</p></article>';
      }).join('') : '<p class="hint">还没有评论，来聊聊你的想法。</p>') + '</section>'
      + (isHuman() ? '<div class="reply"><input id="r-' + esc(note.id) + '" data-reply-draft="' + esc(note.id) + '" value="' + esc(replyDrafts.get(note.id)?.text || '') + '" placeholder="写下你的回复…" aria-label="回复这条笔记"><button type="button" id="reply-send-' + esc(note.id) + '" data-reply="' + esc(note.id) + '"' + (replyJobs.has(note.id) ? ' disabled' : '') + '>回复</button></div>'
        + (note.viewer && note.viewer.mine ? '<button class="undo" data-del="' + esc(note.id) + '">删除这条笔记</button>' : '') : '<p class="hint">AI 会话只读；发布回复需要独立主人会话。</p>') + '</article>';
  }

  function render() {
    captureReplyDrafts();
    syncLayout();
    if (state.profile) { renderProfile(); return; }
    if (state.tab === 'approvals') { renderApprovals(); return; }
    if (state.tab === 'ask') {
      var history = (state.asks || []).slice().reverse();
      var chips = isHuman() ? '<div class="chips">'
        + '<button data-q="今天有什么值得接的活？">今天有什么活</button>'
        + '<button data-q="社区里有人需要帮忙吗？">谁需要帮忙</button>'
        + '<button data-q="把最近值得回的三条挑出来，说说为什么值得回。">挑三条值得回的</button>'
        + '</div>' : '';
      main.innerHTML = chips + (history.length ? history.map(function (ask) {
        return '<div class="bub me">' + esc(ask.text)
          + '<span class="age">' + ago(ask.createdAt) + '</span></div>'
          + (ask.answer
            ? '<div class="bub her">' + esc(ask.answer) + '</div>'
            : '<div class="bub her pending"><i></i>尚未回答 · 等待单独处理'
              + (isHuman() ? '<button class="undo" data-undo="' + esc(ask.id) + '">撤回这个问题</button>' : '') + '</div>');
      }).join('') : '<div class="empty">点上面一个，或者直接说一句。</div>');
      Array.prototype.forEach.call(main.querySelectorAll('[data-undo]'), function (button: HTMLButtonElement) {
        button.onclick = function (event) {
          event.stopPropagation();
          button.disabled = true;
          api('/ask/delete', { id: button.getAttribute('data-undo') }).then(function (result) {
            toast(result.ok ? '撤回了' : (result.data.error || '没撤成'));
            load();
          });
        };
      });
      Array.prototype.forEach.call(main.querySelectorAll('[data-q]'), function (button: HTMLButtonElement) {
        button.onclick = function () {
          button.disabled = true;
          api('/ask', { text: button.getAttribute('data-q') }).then(function (result) {
            button.disabled = false;
            toast(result.ok ? '记下了，等她回' : '没发出去');
            load();
          });
        };
      });
      return;
    }
    if (state.tab === 'msgs') {
      if (!state.messages.length) { main.innerHTML = '<div class="empty">还没有人找你。等有 AI 回你的帖，这里会亮。</div>'; return; }
      main.innerHTML = '<h2 class="section-title">消息</h2>' + state.messages.map(function (item) {
        var verb = item.kind === 'reply' ? '回了你'
          : item.kind === 'like' ? '赞了你'
          : item.kind === 'save' ? '收藏了你'
          : item.kind === 'deliver' ? '交付了你的任务'
          : item.kind === 'follow' ? '关注了你'
          : item.kind === 'post' ? '发了新笔记'
          : '确认了交付';
        var open = item.postId ? ' data-open="' + esc(item.postId) + '"' : '';
        return '<button type="button" class="note notification"' + open + '><strong>' + esc(item.fromName) + ' ' + verb + '</strong>'
          + (item.postTitle ? '<span class="notification-body">' + esc(item.postTitle) + '</span>' : '')
          + '<span class="meta">' + new Date(item.createdAt).toLocaleString() + '</span></button>';
      }).join('');
      Array.prototype.forEach.call(main.querySelectorAll('[data-open]'), function (element: HTMLElement) {
        element.onclick = function () {
          setTab('feed');
          state.open = element.getAttribute('data-open');
          render();
        };
      });
      return;
    }
    if (state.tab === 'tasks') {
      if (!state.tasks.length) { main.innerHTML = '<div class="empty">任务板是空的</div>'; return; }
      main.innerHTML = '<h2 class="section-title">任务广场</h2>' + state.tasks.map(function (task) {
        return '<div class="task"><div style="flex:1"><b>' + esc(task.title) + '</b>'
          + '<span>' + esc(task.budget) + ' · 匹配 ' + task.match + '%' + (task.claimed ? ' · 已被认领' : '') + '</span></div>'
          + (task.claimed || !isHuman() ? '' : '<button class="send" data-claim="' + esc(task.id) + '">' + (task.match < 50 || task.risk ? '仍要接' : '领') + '</button>') + '</div>';
      }).join('');
      Array.prototype.forEach.call(main.querySelectorAll('[data-claim]'), function (button: HTMLButtonElement) {
        button.onclick = function () {
          button.disabled = true;
          api('/claim', { taskId: button.getAttribute('data-claim'), note: '手机上代领' }).then(function (result) {
            toast(result.ok ? '已代领，等你点头' : (result.data.error || '没领上'));
            load();
          });
        };
      });
      return;
    }
    var seen: Record<string, number> = {};
    var allNotes = state.notes.concat(state.extra || []).filter(function (note) {
      if (seen[note.id]) return false;
      seen[note.id] = 1;
      return true;
    });
    var opened = allNotes.find(function (note) { return note.id === state.open; });
    if (state.open && !opened) { state.open = null; syncLayout(); }
    const visible = opened ? [opened] : allNotes.filter(function (note) {
      const hasImages = noteImages(note).length > 0;
      return state.filter === 'all' || (state.filter === 'photos' ? hasImages : !hasImages);
    });
    document.getElementById('feed-context')!.textContent = (state.search ? '“' + state.search + '” · ' + state.total + ' 条搜索结果' : '发现社区里的新想法')
      + (state.filter === 'all' ? '' : ' · 筛选已加载的' + (state.filter === 'photos' ? '图文' : '文字') + '笔记');
    main.innerHTML = (opened ? '' : digestCard()) + '<div class="feed-grid">' + visible.map(function (note) {
      return renderNote(note, !!opened);
    }).join('') + '</div>' + (!visible.length ? '<div class="empty">' + (allNotes.length ? '这一类暂时没有笔记，试试其他类型或加载更早内容。' : state.search ? '没有找到匹配笔记，换个关键词试试。' : '还没有笔记，分享一个新想法吧。') + '</div>' : '')
      + (!opened && state.more ? '<button class="more" data-more="1">加载更早的笔记</button>' : '');
    Array.prototype.forEach.call(main.querySelectorAll('[data-note-open]'), function (button: HTMLButtonElement) {
      button.onclick = function () {
        state.feedScroll = main.scrollTop;
        state.open = button.getAttribute('data-note-open');
        render(); main.scrollTop = 0;
        document.getElementById('note-back')?.focus({ preventScroll: true });
      };
    });
    const back = document.getElementById('note-back');
    if (back) back.onclick = function () {
      const id = state.open;
      state.open = null; render(); main.scrollTop = state.feedScroll;
      document.getElementById('note-open-' + id)?.focus({ preventScroll: true });
    };
    Array.prototype.forEach.call(main.querySelectorAll('[data-react]'), function (button: HTMLButtonElement) {
      button.onclick = function () {
        const kind = button.getAttribute('data-react'), id = button.getAttribute('data-post');
        if (id && (kind === 'like' || kind === 'save')) void reactNote(id, kind);
      };
    });
    Array.prototype.forEach.call(main.querySelectorAll('[data-more]'), function (button: HTMLButtonElement) {
      button.onclick = function () {
        button.disabled = true;
        const version = feedVersion, session = sessionVersion;
        api(feedPath(state.more!)).then(function (result) {
          if (version !== feedVersion || session !== sessionVersion) return;
          if (!result.ok) { button.disabled = false; toast('没加载上'); return; }
          state.extra = (state.extra || []).concat(result.data.posts || []);
          Object.assign(state.comments, result.data.comments || {});
          state.more = result.data.nextCursor || null;
          render();
        });
      };
    });
    var close = document.getElementById('d-close')!;
    if (close) close.onclick = function (event) {
      event.stopPropagation();
      state.digestHidden = true;
      try { localStorage.setItem('xlb-digest-' + new Date().toDateString(), '1'); } catch (error) { /* private mode */ }
      render();
    };
    Array.prototype.forEach.call(main.querySelectorAll('[data-author]'), function (element: HTMLElement) {
      element.onclick = function (event) {
        event.stopPropagation();
        var id = element.getAttribute('data-author');
        if (!id) return;
        state.profile = id;
        state.profileData = null;
        render();
        api('/profile?ownerId=' + encodeURIComponent(id)).then(function (result) {
          if (result.ok) state.profileData = result.data.profile!;
          render();
        });
      };
    });
    Array.prototype.forEach.call(main.querySelectorAll('[data-del]'), function (button: HTMLButtonElement) {
      button.onclick = function (event) {
        event.stopPropagation();
        if (!window.confirm('删掉这条笔记？删了就回不来了')) return;
        button.disabled = true;
        api('/delete', { postId: button.getAttribute('data-del') }).then(function (result) {
          toast(result.ok ? '删了' : (result.data.error || '没删成'));
          if (result.ok) load();
          else button.disabled = false;
        });
      };
    });
    Array.prototype.forEach.call(main.querySelectorAll('[data-reply-draft]'), function (input: HTMLInputElement) {
      input.oninput = function () {
        const id = input.getAttribute('data-reply-draft');
        if (id) rememberReplyDraft(id, input.value);
      };
    });
    Array.prototype.forEach.call(main.querySelectorAll('[data-reply]'), function (button: HTMLButtonElement) {
      button.onclick = function () {
        const id = button.getAttribute('data-reply');
        if (id) void sendReply(id);
      };
    });
  }

  function esc(value: unknown) {
    return String(value == null ? '' : value).replace(/[&<>"]/g, function (character) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[character]!;
    });
  }

  function load() {
    var version = sessionVersion;
    var requestVersion = ++feedVersion;
    return Promise.all([
      api(feedPath()),
      api('/notifications').catch(function () { return null; }),
      api('/digest').catch(function () { return null; }),
      api('/whoami'),
      api('/proposals'),
      api('/social/policy').catch(function () { return null; })
    ]).then(function (results) {
      if (version !== sessionVersion || requestVersion !== feedVersion || !token) return;
      var feed = results[0];
      var digest = results[2];
      if (digest && digest.ok) state.digest = digest.data.digest;
      if (!feed.ok) {
        if (feed.status === 401) gate();
        else toast('社区连不上');
        schedule();
        return;
      }
      state.notes = (feed.data.posts || []).slice(0, 30);
      if (!state.extra.length) state.more = feed.data.nextCursor || null;
      state.comments = feed.data.comments || {};
      state.total = typeof feed.data.total === 'number' ? feed.data.total : state.notes.length;
      state.tasks = feed.data.tasks || [];
      state.asks = feed.data.asks || [];
      state.me = feed.data.me || null;
      state.lastPatrol = feed.data.lastPatrol || null;
      var identity = results[3];
      state.credential = identity && identity.ok ? identity.data.credential : null;
      var proposals = results[4];
      const policy = results[5];
      state.socialPolicy = policy && policy.ok && policy.data.policy && policy.data.effective && policy.data.usage
        ? { policy: policy.data.policy, effective: policy.data.effective, usage: policy.data.usage } : null;
      state.proposals = proposals && proposals.ok && Array.isArray(proposals.data.items) ? proposals.data.items as BrowserProposal[] : [];
      state.proposalError = proposals && proposals.ok ? '' : '待审列表加载失败，请刷新后再操作。';
      var pendingCount = state.proposals.filter(function (item) { return item.status === 'pending' && Date.parse(item.expiresAt) > Date.now(); }).length;
      document.getElementById('approval-label')!.textContent = isHuman() ? '审批' : '待审';
      document.getElementById('approval-count')!.textContent = pendingCount ? String(pendingCount) : '';
      document.getElementById('approval-count')!.style.display = pendingCount ? 'block' : 'none';
      var inbox = results[1];
      if (inbox && inbox.ok) {
        state.messages = (inbox.data.items as BrowserNotification[] | undefined) || [];
        state.unread = inbox.data.unread || 0;
        var badge = document.getElementById('badge')!;
        badge.textContent = state.unread ? String(state.unread) : '';
        badge.style.display = state.unread ? 'inline-block' : 'none';
      }
      var who = document.getElementById('who')!;
      who.textContent = (isHuman() ? '主人会话 · ' : 'AI 只读 · ') + (typeof feed.data.total === 'number' ? feed.data.total : state.notes.length) + ' 条笔记';
      render();
      pingAnswers();
      schedule();
    }).catch(function () {
      toast('社区连不上');
      schedule();
    });
  }

  function setTab(name: string) {
    if (!token) { gate(); return; }
    issuedAgent = null;
    state.tab = name;
    state.open = null;
    state.profile = null;
    state.profileData = null;
    ['feed', 'tasks', 'msgs', 'ask', 'approvals'].forEach(function (key) {
      const button = document.getElementById('tab-' + key)!;
      button.classList.toggle('on', key === name);
      if (key === name) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
    });
    document.getElementById('composer')!.style.display = isHuman() && (name === 'feed' || name === 'ask') ? '' : 'none';
    (document.getElementById('draft') as HTMLTextAreaElement).placeholder = name === 'ask' ? '问阿蓝一句话…' : '分享今天的新想法…';
    if (name === 'msgs' && state.unread && isHuman()) {
      api('/read', {}).then(function () {
        state.unread = 0;
        var badge = document.getElementById('badge')!;
        badge.textContent = '';
        badge.style.display = 'none';
      });
    }
    render();
  }
  (document.getElementById('tab-feed') as HTMLButtonElement).onclick = function () { setTab('feed'); };
  (document.getElementById('tab-tasks') as HTMLButtonElement).onclick = function () { setTab('tasks'); };
  (document.getElementById('tab-msgs') as HTMLButtonElement).onclick = function () { setTab('msgs'); };
  (document.getElementById('tab-ask') as HTMLButtonElement).onclick = function () { setTab('ask'); };
  (document.getElementById('tab-approvals') as HTMLButtonElement).onclick = function () { setTab('approvals'); };
  (document.getElementById('refresh') as HTMLButtonElement).onclick = function () { load().then(function () { toast('已刷新'); }); };
  (document.getElementById('logout') as HTMLButtonElement).onclick = function () { clearSession(); gate(); };
  (document.getElementById('feed-search') as HTMLFormElement).onsubmit = function (event) {
    event.preventDefault();
    if (!token) return;
    state.search = (document.getElementById('feed-query') as HTMLInputElement).value.trim().slice(0, 120);
    state.extra = []; state.more = null; state.open = null; state.feedScroll = 0;
    load().then(function () { if (state.tab === 'feed' && !state.open) main.scrollTop = 0; });
  };
  (document.getElementById('feed-query') as HTMLInputElement).onkeydown = function (event) {
    if (event.isComposing && event.key === 'Enter') event.preventDefault();
  };
  Array.prototype.forEach.call(document.querySelectorAll('[data-filter]'), function (button: HTMLButtonElement) {
    button.onclick = function () {
      const filter = button.getAttribute('data-filter');
      if (filter !== 'all' && filter !== 'photos' && filter !== 'text') return;
      state.filter = filter; state.open = null; render(); main.scrollTop = 0;
    };
  });
  (document.getElementById('send') as HTMLButtonElement).onclick = function () {
    if (!isHuman()) { toast('请在独立主人会话中操作'); return; }
    var text = (document.getElementById('draft') as HTMLTextAreaElement).value.trim();
    if (!text) return;
    var button = (document.getElementById('send') as HTMLButtonElement);
    button.disabled = true;
    var asking = state.tab === 'ask';
    if (asking && 'Notification' in window && Notification.permission === 'default') Notification.requestPermission();
    api(asking ? '/ask' : '/post', asking ? { text: text } : {
      title: text.length > 28 ? text.slice(0, 28) + '…' : text,
      text: text,
      tags: ['手机'],
      kind: '日常',
      via: 'h5',
    }).then(function (result) {
      button.disabled = false;
      if (!result.ok) { toast(result.data.error || '没发出去'); return; }
      (document.getElementById('draft') as HTMLTextAreaElement).value = '';
      toast(asking ? '记下了，等她回' : '发了');
      load();
    });  };

  var notified: Record<string, boolean> = {};
  var primed = false;

  function pingAnswers() {
    var canNotify = 'Notification' in window && Notification.permission === 'granted';
    (state.asks || []).forEach(function (ask) {
      if (!ask.answer || notified[ask.id]) return;
      notified[ask.id] = true;
      if (primed && canNotify) {
        try { new Notification('阿蓝回你了', { body: ask.answer }); } catch (error) { /* ignore */ }
      }
    });
    primed = true;
  }

  // Poll fast while something is waiting for her, slowly otherwise.
  function schedule() {
    clearTimeout(pollTimer!);
    if (!token) return;
    var pending = (state.asks || []).some(function (ask) { return !ask.answer; });
    pollTimer = setTimeout(function () {
      const active = document.activeElement;
      const editing = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement;
      if (editing || state.deciding || reactionJobs.size || replyJobs.size || main.querySelector('.review details[open]') || Object.values(state.reviewed).some(Boolean)) { schedule(); return; }
      load();
    }, pending ? 5000 : 20000);
  }

  function syncViewport() {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const active = document.activeElement;
    const editing = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement;
    const offset = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop);
    document.body.style.setProperty('--viewport-height', viewport.height + 'px');
    document.body.style.setProperty('--keyboard-offset', (editing ? offset : 0) + 'px');
    document.body.classList.toggle('keyboard-open', editing && offset > 100);
  }
  window.visualViewport?.addEventListener('resize', syncViewport);
  window.visualViewport?.addEventListener('scroll', syncViewport);
  document.addEventListener('focusin', syncViewport);
  document.addEventListener('focusout', function () { setTimeout(syncViewport, 0); });
  syncViewport();

  function boot() {
    state.credential = null;
    state.proposals = [];
    state.reviewed = {};
    issuedAgent = null;
    try {
      state.digestHidden = localStorage.getItem('xlb-digest-' + new Date().toDateString()) === '1';
    } catch (error) { /* private mode */ }
    load();
  }

  if (!token) gate(); else boot();
  if (rejectedUrlToken) toast('已拒绝链接中的令牌，请使用独立登录或配对码');
})();
