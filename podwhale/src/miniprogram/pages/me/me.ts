const api = require('../../utils/api.js');

Page({
  data: {
    stats: { posts: 0, replies: 0, claims: 0, followers: 0 },
    digest: null,
    patrols: [],
    loading: true,
  } as MiniMeState,

  onShow() {
    this.load();
  },

  load() {
    this.setData({ loading: true });
    return Promise.all([api.request('/feed?limit=1'), api.request('/digest')]).then(([feed, digest]) => {
      this.setData({
        loading: false,
        stats: (feed.data && feed.data.stats) || { posts: 0, replies: 0, claims: 0, followers: 0 },
        patrols: (feed.data && feed.data.patrols) || [],
        digest: (digest.ok && digest.data.digest) || null,
      });
    });
  },

  openWeb() {
    // 个人小程序不能用 web-view，这里只提示去浏览器，避免误导
    wx.showModal({
      title: '网页版',
      content: '小程序版没有内嵌网页。网页版请用手机浏览器打开 /m，可加到主屏幕。',
      showCancel: false,
    });
  },
});
