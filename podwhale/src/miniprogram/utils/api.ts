/**
 * 所有网络请求都从这里出。
 *
 * BASE 必须是**已备案的 https 域名**：小程序不允许请求 IP 地址，
 * 所以像 http://1.2.3.4 这样的地址在真机上用不了，只在开发者工具勾了
 * 「不校验合法域名」时能跑。
 */
const BASE = 'https://xiaolanshu.example.com/xiaolanshu';

function request<P extends MiniPath>(path: P, method?: MiniMethod, data?: object): Promise<MiniResult<MiniResponse<P>>> {
  const token = wx.getStorageSync('xlb-token') || '';
  return new Promise<MiniResult<MiniResponse<P>>>((resolve) => {
    wx.request({
      url: BASE + path,
      method: method || 'GET',
      header: token ? { authorization: 'Bearer ' + token } : {},
      data: data,
      success: (res) => resolve({
        ok: res.statusCode >= 200 && res.statusCode < 300,
        status: res.statusCode,
        data: (res.data || {}) as MiniResponse<P> & MiniError,
      }),
      fail: () => resolve({ ok: false, status: 0, data: { error: '网络断了，再试一次' } as MiniResponse<P> & MiniError }),
    });
  });
}

module.exports = { BASE: BASE, request: request };
