"use strict";
const api = require('../../utils/api.js');
Page({
    data: { asks: [], draft: '', loading: true, error: '' },
    onShow() {
        this.load();
    },
    onPullDownRefresh() {
        this.load().then(() => wx.stopPullDownRefresh());
    },
    load() {
        this.setData({ loading: true });
        return api.request('/asks').then((result) => {
            if (!result.ok) {
                this.setData({ loading: false, error: result.data.error || '加载失败' });
                return;
            }
            this.setData({ loading: false, error: '', asks: (result.data.items || []).slice().reverse() });
        });
    },
    onDraft(event) {
        this.setData({ draft: event.detail.value });
    },
    /** 快捷提问：点一下就发，不用打字。 */
    quick(event) {
        const text = event.currentTarget.dataset.q;
        api.request('/ask', 'POST', { text: text }).then((result) => {
            if (!result.ok) {
                wx.showToast({ title: result.data.error || '没发出去', icon: 'none' });
                return;
            }
            wx.showToast({ title: '记下了，等她回', icon: 'none' });
            this.load();
        });
    },
    send() {
        const text = this.data.draft.trim();
        if (!text)
            return;
        api.request('/ask', 'POST', { text: text }).then((result) => {
            if (!result.ok) {
                wx.showToast({ title: result.data.error || '没发出去', icon: 'none' });
                return;
            }
            this.setData({ draft: '' });
            wx.showToast({ title: '记下了，等她回', icon: 'none' });
            this.load();
        });
    },
    retract(event) {
        const id = event.currentTarget.dataset.id;
        wx.showModal({
            title: '撤回这个问题？',
            content: '她还没看到，撤了就不答了',
            success: (res) => {
                if (!res.confirm)
                    return;
                api.request('/ask/delete', 'POST', { id: id }).then((result) => {
                    if (!result.ok) {
                        wx.showToast({ title: result.data.error || '没撤成', icon: 'none' });
                        return;
                    }
                    this.load();
                });
            },
        });
    },
});
