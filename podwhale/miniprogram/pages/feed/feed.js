"use strict";
const api = require('../../utils/api.js');
const app = getApp();
const KINDS = ['全部', '技术', '科研', '求帮忙', '生活', '吐槽', '搞钱', '职场', '日常'];
Page({
    data: {
        kinds: KINDS,
        kind: '全部',
        notes: [],
        shown: [],
        needBind: false,
        bindCode: '',
        loading: true,
        open: '',
        error: '',
        draftTitle: '',
        draftText: '',
        draftKind: '日常',
        composing: false,
    },
    onShow() {
        this.setData({ needBind: app.globalData.needBind });
        if (!app.globalData.needBind)
            this.load();
    },
    onPullDownRefresh() {
        this.load().then(() => wx.stopPullDownRefresh());
    },
    load() {
        this.setData({ loading: true });
        return api.request('/feed?limit=30').then((result) => {
            if (result.status === 401) {
                // 令牌失效（换过令牌/清过数据）：静默重登一次，不行再要求绑定。
                return app.login().then((again) => {
                    this.setData({ needBind: app.globalData.needBind, loading: false });
                    if (again.ok)
                        return this.load();
                    return null;
                });
            }
            if (!result.ok) {
                this.setData({ loading: false, error: result.data.error || '加载失败' });
                return null;
            }
            this.setData({
                loading: false,
                error: '',
                notes: result.data.posts || [],
                needBind: false,
            });
            this.applyFilter();
            return null;
        });
    },
    pickKind(event) {
        this.setData({ kind: event.currentTarget.dataset.kind });
        this.applyFilter();
    },
    /** WXML 不能调方法，过滤结果要落在 data 上。 */
    applyFilter() {
        const kind = this.data.kind;
        const shown = kind === '全部' ? this.data.notes : this.data.notes.filter((note) => note.kind === kind);
        this.setData({ shown: shown });
    },
    toggle(event) {
        const id = event.currentTarget.dataset.id;
        this.setData({ open: this.data.open === id ? '' : id });
    },
    onBindInput(event) {
        this.setData({ bindCode: event.detail.value });
    },
    submitBind() {
        const pair = this.data.bindCode.trim();
        if (!/^[0-9]{6}$/.test(pair)) {
            wx.showToast({ title: '配对码是 6 位数字', icon: 'none' });
            return;
        }
        app.bind(pair).then((result) => {
            if (!result.ok) {
                wx.showToast({ title: result.data.error || '没绑上', icon: 'none' });
                return;
            }
            wx.showToast({ title: '绑好了', icon: 'success' });
            this.setData({ needBind: false });
            this.load();
        });
    },
    openComposer() {
        this.setData({ composing: true });
    },
    closeComposer() {
        this.setData({ composing: false });
    },
    onTitle(event) {
        this.setData({ draftTitle: event.detail.value });
    },
    onText(event) {
        this.setData({ draftText: event.detail.value });
    },
    pickDraftKind(event) {
        this.setData({ draftKind: event.currentTarget.dataset.kind });
    },
    publish() {
        const text = this.data.draftText.trim();
        if (!text)
            return;
        api.request('/post', 'POST', {
            title: this.data.draftTitle.trim(),
            text: text,
            kind: this.data.draftKind,
            via: 'h5',
        }).then((result) => {
            if (!result.ok) {
                wx.showToast({ title: result.data.error || '没发出去', icon: 'none' });
                return;
            }
            this.setData({ composing: false, draftTitle: '', draftText: '' });
            wx.showToast({ title: '发了', icon: 'success' });
            this.load();
        });
    },
    remove(event) {
        const id = event.currentTarget.dataset.id;
        wx.showModal({
            title: '删掉这条笔记？',
            content: '删了就回不来了',
            success: (res) => {
                if (!res.confirm)
                    return;
                api.request('/delete', 'POST', { postId: id }).then((result) => {
                    if (!result.ok) {
                        wx.showToast({ title: result.data.error || '没删成', icon: 'none' });
                        return;
                    }
                    wx.showToast({ title: '删了', icon: 'success' });
                    this.load();
                });
            },
        });
    },
});
