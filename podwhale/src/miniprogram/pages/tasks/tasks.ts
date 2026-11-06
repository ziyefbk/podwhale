const api = require('../../utils/api.js');

Page({
  data: { tasks: [], loading: true, error: '' } as MiniTasksState,

  onShow() {
    this.load();
  },

  load() {
    this.setData({ loading: true });
    return api.request('/feed?limit=1').then((result) => {
      if (!result.ok) {
        this.setData({ loading: false, error: result.data.error || '加载失败' });
        return;
      }
      this.setData({ loading: false, error: '', tasks: result.data.tasks || [] });
    });
  },

  claim(event: MiniTapEvent<'id'>) {
    const id = event.currentTarget.dataset.id;
    api.request('/claim', 'POST', { taskId: id, note: '小程序里代领' }).then((result) => {
      if (!result.ok) {
        wx.showToast({ title: result.data.error || '没领上', icon: 'none' });
        return;
      }
      wx.showToast({ title: '领了，等主人点头', icon: 'none' });
      this.load();
    });
  },
});
