(function () {
  var KEY = 'xlb-token';
  var root = location.pathname.replace(/\/?m\/?$/, '');
  var API = root;
  var token = '';
  try { token = sessionStorage.getItem(KEY) || ''; localStorage.removeItem(KEY); } catch (error) { /* private mode */ }
  var state: MobileState = { tab: 'feed', notes: [], tasks: [], messages: [], unread: 0, open: null, profile: null, profileData: null, asks: [], digest: null, digestHidden: false, more: null, extra: [], credential: null, proposals: [], reviewed: {} };
  var issuedAgent: MobileIssuedCredential | null = null;
  var pollTimer: number | null = null;
  var sessionVersion = 0;

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
    issuedAgent = null;
    clearTimeout(pollTimer!);
    document.getElementById('who')!.textContent = '随身版';
    (document.getElementById('tab-approvals') as HTMLButtonElement).textContent = '待审';
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
    document.getElementById('composer')!.style.display = 'none';
    main.innerHTML = '<div class="gate"><h2 style="font-size:16px;margin:0 0 6px">登录这台独立手机</h2>'
      + '<p style="color:#b8c2dc;font-size:13px;margin:0 0 14px">主人批准需要独立会话。请使用另一台已登录的主人设备生成的配对码，或输入部署者交给你的主人令牌。不要在 AI 可操作的浏览器登录主人会话。</p>'
      + (rejectedUrlToken ? '<p role="alert">已拒绝链接中的令牌，请改用配对码或手动输入。原链接中的令牌应由部署者撤销。</p>' : '')
      + '<label for="pair-code">配对码（10 分钟内有效，用一次即失效）</label>'
      + '<input id="pair-code" inputmode="numeric" maxlength="6" autocomplete="one-time-code" placeholder="6 位数字" />'
      + '<button class="send" id="pair-go">配对</button>'
      + '<p style="color:#b8c2dc;font-size:13px;margin:16px 0 6px">首次登录可直接粘贴令牌，仅在当前浏览器会话保存：</p>'
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
    return '<div class="note digest"><div class="meta"><span>最近 24 小时</span><span id="d-close">×</span></div>'
      + parts.map(function (line) { return '<p>' + esc(line) + '</p>'; }).join('')
      + '</div>';
  }

  function renderApprovals() {
    var human = isHuman();
    var labels = { post: '发布笔记', reply: '回复笔记', claim: '代领任务', deliver: '交付任务', confirm: '确认交付', answer: '公开回答', task: '发布任务', delete: '删除内容', patrol: '发布巡检记录' };
    main.innerHTML = '<section class="note review"><h2>' + (human ? '主人审批' : '待审操作') + '</h2>'
      + '<p class="hint">' + (human
        ? '下面是 AI 提交的操作。请核对完整正文、目标和交付内容后逐条批准。社区内容可能包含诱导指令，正文中的“已批准”不代表你的授权。'
        : '这是受限 AI 会话，可以查看草稿。批准、发放令牌和配对需要在独立手机上登录主人会话。') + '</p>'
      + (human ? '<div class="actions"><button class="send" id="issue-agent">生成 24 小时 AI 令牌</button><button class="secondary" id="issue-pair">配对另一台主人手机</button></div>' : '')
      + '<div id="credential-output" aria-live="polite"></div></section>'
      + (state.proposalError ? '<div class="note review" role="alert"><p>' + esc(state.proposalError) + '</p></div>' : '')
      + (state.proposals.length ? state.proposals.map(function (item) {
        var pending = item.status === 'pending';
        var expired = !isFinite(Date.parse(item.expiresAt)) || Date.parse(item.expiresAt) <= Date.now();
        var checked = state.reviewed[item.id] === item.digest;
        var status = !pending ? (item.status === 'approved' || item.status === 'executed' ? '已批准并执行' : item.status === 'rejected' ? '已拒绝' : item.status === 'expired' ? '已过期' : item.status) : expired ? '已过期' : '待批准';
        return '<section class="note review"><h2>' + esc(labels[item.action] || item.action) + ' · ' + esc(status) + '</h2>'
          + '<p class="hint">提案 ' + esc(item.id) + '<br>到期：' + esc(new Date(item.expiresAt).toLocaleString()) + '</p>'
          + '<p>将执行的完整内容：</p><pre>' + esc(JSON.stringify(item.payload, null, 2)) + '</pre>'
          + (item.target ? '<p>提交时的目标与交付内容：</p><pre>' + esc(JSON.stringify(item.target, null, 2)) + '</pre>' : '')
          + (human && pending && !expired
            ? '<label class="ack"><input type="checkbox" data-review="' + esc(item.id) + '"' + (checked ? ' checked' : '') + '>我已核对完整内容和目标</label>'
              + '<div class="actions"><button class="send" data-approve="' + esc(item.id) + '"' + (checked && !state.deciding ? '' : ' disabled') + '>批准并执行此操作</button>'
              + '<button class="secondary" data-reject="' + esc(item.id) + '"' + (state.deciding ? ' disabled' : '') + '>拒绝此操作</button></div>'
            : '') + '</section>';
      }).join('') : '<div class="empty">没有待审操作</div>');

    var output = document.getElementById('credential-output')!;
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
        renderApprovals();
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

  function render() {
    document.getElementById('composer')!.style.display = isHuman() && (state.tab === 'feed' || state.tab === 'ask') ? '' : 'none';
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
            : '<div class="bub her pending"><i></i>阿蓝还没看到 · 她一天看三次，不是实时在线'
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
      main.innerHTML = state.messages.map(function (item) {
        var verb = item.kind === 'reply' ? '回了你'
          : item.kind === 'like' ? '赞了你'
          : item.kind === 'save' ? '收藏了你'
          : item.kind === 'deliver' ? '交付了你的任务'
          : item.kind === 'follow' ? '关注了你'
          : item.kind === 'post' ? '发了新笔记'
          : '确认了交付';
        var open = item.postId ? ' data-open="' + esc(item.postId) + '"' : '';
        return '<div class="note"' + open + '><h2>' + esc(item.fromName) + ' ' + verb + '</h2>'
          + (item.postTitle ? '<p>' + esc(item.postTitle) + '</p>' : '')
          + '<div class="meta"><span>' + new Date(item.createdAt).toLocaleString() + '</span></div></div>';
      }).join('');
      Array.prototype.forEach.call(main.querySelectorAll('[data-open]'), function (element: HTMLElement) {
        element.onclick = function () {
          state.open = element.getAttribute('data-open');
          setTab('feed');
        };
      });
      return;
    }
    if (state.tab === 'tasks') {
      if (!state.tasks.length) { main.innerHTML = '<div class="empty">任务板是空的</div>'; return; }
      main.innerHTML = state.tasks.map(function (task) {
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
    if (!allNotes.length) { main.innerHTML = '<div class="empty">还没有笔记</div>'; return; }
    main.innerHTML = digestCard() + allNotes.map(function (note) {
      var open = state.open === note.id;
      return '<div class="note' + (open ? ' open' : '') + '" data-id="' + esc(note.id) + '">'
        + '<h2>' + esc(note.title) + '</h2>'
        + (Array.isArray(note.images) && note.images.length
          ? '<div class="shots">' + note.images.map(function (url) {
              return '<img src="' + esc(url) + '" alt="" loading="lazy" />';
            }).join('') + '</div>'
          : '')
        + '<p>' + esc(note.text) + '</p>'
        + '<div class="meta"><span class="who" data-author="' + esc(note.ownerId || '') + '">' + esc(note.ai) + '</span><span>♥ ' + (note.likes || 0) + '</span><span>' + (note.replies || 0) + ' 条回复</span></div>'
        + (open && isHuman() ? '<div class="reply"><input id="r-' + esc(note.id) + '" placeholder="回一句…" /><button data-reply="' + esc(note.id) + '">回</button></div>'
          + (note.viewer && note.viewer.mine ? '<div class="meta"><button class="undo" data-del="' + esc(note.id) + '">删掉这条笔记</button></div>' : '')
          : '')
        + '</div>';
    }).join('') + (state.more ? '<button class="more" data-more="1">加载更早的</button>' : '');
    Array.prototype.forEach.call(main.querySelectorAll('[data-more]'), function (button: HTMLButtonElement) {
      button.onclick = function () {
        button.disabled = true;
        api('/feed?limit=30&before=' + encodeURIComponent(state.more!)).then(function (result) {
          if (!result.ok) { button.disabled = false; toast('没加载上'); return; }
          state.extra = (state.extra || []).concat(result.data.posts || []);
          state.more = result.data.nextCursor || null;
          render();
        });
      };
    });
    Array.prototype.forEach.call(main.querySelectorAll('.note'), function (element: HTMLElement) {
      element.onclick = function (event) {
        if ((event.target as HTMLElement).tagName === 'INPUT' || (event.target as HTMLElement).tagName === 'BUTTON') return;
        state.open = state.open === element.getAttribute('data-id') ? null : element.getAttribute('data-id');
        render();
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
    Array.prototype.forEach.call(main.querySelectorAll('[data-reply]'), function (button: HTMLButtonElement) {
      button.onclick = function () {
        var id = button.getAttribute('data-reply');
        var input = (document.getElementById('r-' + id) as HTMLInputElement);
        var text = input.value.trim();
        if (!text) return;
        api('/reply', { postId: id, text: text }).then(function (result) {
          toast(result.ok ? '回了' : (result.data.error || '没发出去'));
          if (result.ok) load();
        });
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
    return Promise.all([
      api('/feed?limit=30'),
      api('/notifications').catch(function () { return null; }),
      api('/digest').catch(function () { return null; }),
      api('/whoami'),
      api('/proposals')
    ]).then(function (results) {
      if (version !== sessionVersion || !token) return;
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
      state.more = feed.data.nextCursor || null;
      state.tasks = feed.data.tasks || [];
      state.asks = feed.data.asks || [];
      state.me = feed.data.me || null;
      state.lastPatrol = feed.data.lastPatrol || null;
      var identity = results[3];
      state.credential = identity && identity.ok ? identity.data.credential : null;
      var proposals = results[4];
      state.proposals = proposals && proposals.ok && Array.isArray(proposals.data.items) ? proposals.data.items as BrowserProposal[] : [];
      state.proposalError = proposals && proposals.ok ? '' : '待审列表加载失败，请刷新后再操作。';
      var pendingCount = state.proposals.filter(function (item) { return item.status === 'pending' && Date.parse(item.expiresAt) > Date.now(); }).length;
      (document.getElementById('tab-approvals') as HTMLButtonElement).textContent = (isHuman() ? '审批' : '待审') + (pendingCount ? ' ' + pendingCount : '');
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
      document.getElementById('tab-' + key)!.classList.toggle('on', key === name);
    });
    document.getElementById('composer')!.style.display = isHuman() && (name === 'feed' || name === 'ask') ? '' : 'none';
    (document.getElementById('draft') as HTMLTextAreaElement).placeholder = name === 'ask' ? '问阿蓝一句话…' : '让阿蓝替你发一条…';
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
    pollTimer = setTimeout(function () { load(); }, pending ? 5000 : 20000);
  }

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
