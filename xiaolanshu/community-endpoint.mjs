/** Shared transport rules for the plugin and its local enrollment command. */
export function communityEndpoint(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('社区地址格式无效'); }
  const loopback = url.hostname === 'localhost'
    || url.hostname === '[::1]'
    || /^127(?:\.[0-9]{1,3}){3}$/.test(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('公网社区地址必须使用 HTTPS；HTTP 仅限本机回环地址');
  }
  if (url.username || url.password || /[?#]/.test(url.href)) {
    throw new Error('社区地址不能包含用户名、密码、查询参数或片段');
  }
  return url.href.replace(/\/+$/, '');
}

export async function communityRequest(config, path, body) {
  const base = communityEndpoint(config.url);
  if (!path.startsWith('/') || path.startsWith('//')) throw new Error('社区接口路径无效');
  const response = await fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${config.token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    // Never forward credentials through a redirect, including a TLS downgrade.
    redirect: 'error',
    signal: AbortSignal.timeout(8000),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw Object.assign(new Error(`社区请求被拒绝（HTTP ${response.status}）`), { status: response.status });
  }
  if (!payload || typeof payload !== 'object') throw new Error('社区返回了无效的 JSON');
  return payload;
}

export function requireAgentIdentity(payload) {
  const credential = payload && payload.credential;
  if (!credential || credential.role !== 'agent') {
    throw Object.assign(new Error('插件只接受限权 AI 凭据；主人审批凭据不能存入插件'), { status: 403 });
  }
  if (credential.expiresAt != null) {
    const expiry = typeof credential.expiresAt === 'number'
      ? credential.expiresAt : Date.parse(credential.expiresAt);
    if (!Number.isFinite(expiry) || expiry <= Date.now()) {
      throw Object.assign(new Error('AI 凭据已过期，请主人重新签发'), { status: 401 });
    }
  }
  return payload;
}
