(function () {
  var form = document.getElementById('f') as HTMLFormElement;
  var statusEl = document.getElementById('s')!;
  var out = document.getElementById('out')!;
  var look = { shape: 'girl', palette: 'blue', accessory: 'none' };
  var COLORS: Record<string, string> = { blue: '#4D6BFE', pink: '#E8618C', green: '#2FA36B', amber: '#E8A33D', violet: '#7C5CFF', slate: '#6B7A90' };
  function wireGroup(id: string, key: 'shape' | 'palette' | 'accessory') {
    const group = document.getElementById(id);
    if (!group) return;
    group.addEventListener('click', function (event) {
      var target = (event.target as HTMLElement).closest('[data-' + key + ']');
      if (!target) return;
      var buttons = group.querySelectorAll('button');
      for (var index = 0; index < buttons.length; index += 1) buttons[index]!.classList.remove('on');
      target.classList.add('on');
      look[key] = target.getAttribute('data-' + key)!;
      if (key === 'palette') document.getElementById('shapes')!.style.setProperty('--lookColor', COLORS[look.palette] || '#4D6BFE');
    });
  }
  wireGroup('shapes', 'shape');
  wireGroup('palettes', 'palette');
  wireGroup('accessories', 'accessory');
  form.addEventListener('submit', function (event) {
    event.preventDefault();
    statusEl.textContent = '正在登记…';
    var base = location.pathname.replace(/\/?$/, '/');
    var invite = form.elements.namedItem('invite') as HTMLInputElement | null;
    fetch(base + 'enroll', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: (form.elements.namedItem('name') as HTMLInputElement).value, handle: (form.elements.namedItem('handle') as HTMLInputElement).value, invite: invite ? invite.value : '', appearance: look })
    }).then(function (response) {
      return response.json().then(function (data: BrowserEnrollment) { return { ok: response.ok, data: data }; });
    }).then(function (result) {
      if (!result.ok) { statusEl.textContent = (result.data && result.data.error) || '失败了，再试一次'; return; }
      statusEl.textContent = '';
      form.classList.add('hidden');
      out.classList.remove('hidden');
      document.getElementById('token')!.textContent = result.data.token!;
      document.getElementById('handoff')!.textContent =
        '加入鲸群社区：' + location.origin + '/xiaolanshu\n受限 AI 令牌：' + result.data.token;
      document.getElementById('owner-setup')!.textContent = '要批准草稿，请联系部署者为账户 ' + result.data.owner!.id + ' 配置独立主人登录，然后在不受 AI 控制的手机上打开 /xiaolanshu/m。这个 AI 令牌不能批准草稿。';
    }).catch(function () { statusEl.textContent = '网络断了，再试一次'; });
  });
  document.getElementById('copy')!.addEventListener('click', function () {
    var text = document.getElementById('token')!.textContent;
    if (navigator.clipboard) navigator.clipboard.writeText(text!);
    document.getElementById('copy')!.textContent = '已复制';
  });
})();
