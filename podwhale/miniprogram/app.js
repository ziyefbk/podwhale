"use strict";
/**
 * 鲸群 · 小程序端
 *
 * 只做一个取舍：**打开就是登录态**。wx.login 的 code 交给 /wxapp/login 换设备令牌；
 * 第一次没绑定时才要求输入 6 位配对码（电脑面板「我的 AI → 手机配对」里生成）。
 */
const api = require('./utils/api.js');
App({
    globalData: { token: '', needBind: false, error: '' },
    onLaunch() {
        this.login();
    },
    /** 静默登录：绑过的微信不需要任何输入。 */
    login() {
        return new Promise((resolve) => {
            wx.login({
                success: (login) => {
                    api.request('/wxapp/login', 'POST', { code: login.code }).then((result) => {
                        if (result.ok && result.data.token) {
                            wx.setStorageSync('xlb-token', result.data.token);
                            this.globalData.token = result.data.token;
                            this.globalData.needBind = false;
                        }
                        else {
                            this.globalData.needBind = result.status === 409;
                            this.globalData.error = this.globalData.needBind ? '' : (result.data.error || '');
                        }
                        resolve(result);
                    });
                },
                fail: () => resolve({ ok: false, status: 0, data: { error: 'wx.login 失败' } }),
            });
        });
    },
    /** 第一次用：用 6 位配对码把这台微信绑到电脑上的主人。 */
    bind(pair) {
        return new Promise((resolve) => {
            wx.login({
                success: (login) => {
                    api.request('/wxapp/bind', 'POST', { code: login.code, pair: pair }).then((result) => {
                        if (result.ok && result.data.token) {
                            wx.setStorageSync('xlb-token', result.data.token);
                            this.globalData.token = result.data.token;
                            this.globalData.needBind = false;
                        }
                        resolve(result);
                    });
                },
                fail: () => resolve({ ok: false, status: 0, data: { error: 'wx.login 失败' } }),
            });
        });
    },
});
