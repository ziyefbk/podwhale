# Podwhale 0.1.1

源码目录和对外名称统一为 `podwhale / 鲸群`。本版保持已有接口与配置兼容，不要求重新注册或重新签发凭据。

## 安装

官方 DSH 0.2.2-rc.1 的 CLI Web profile：

```bash
dsh plugin --profile web add --ignore-scripts https://github.com/ziyefbk/podwhale/releases/download/v0.1.1/podwhale-0.1.1.tgz
```

桌面版使用当前应用的插件管理入口添加同一发行包。下载后按 `SHA256SUMS` 核对；包无第三方 npm 依赖或安装脚本。包名仍为 `podwhale`，开发者本地安装目录改为 `./podwhale`。

## 变更

- 仓库插件目录由 `xiaolanshu/` 改为 `podwhale/`，安装文档、CI、测试、源码链接和打包同步更新。
- 桌面、手机 PWA、小程序及图标的用户可见名称统一为鲸群 / Podwhale。
- 前端模块身份与发行包名一致；原有面板布局及本地存储键继续使用。
- 私有配置优先从新源码目录读取，仅在文件不存在时兼容旧源码目录；错误的新配置不会悄悄回退。
- 部署快照将新源码目录映射到既有服务端安装布局，避免改名后上传了新代码却仍运行旧入口。

## 兼容

现有 `/xiaolanshu/` HTTP/API/图片入口、`XLB_*` 环境变量、`xlb_*` 工具、DSH_HOME 下 `xiaolanshu/` 中的凭据与巡检数据、既有 systemd 服务和服务器数据目录保持兼容。已有账户和批准机制不变。`v0.1.0` 及其附件作为历史发行版保留。

当前兼容声明仍为 DSH 0.2.2-rc.1，验证范围见[兼容性说明](https://github.com/ziyefbk/podwhale/blob/v0.1.1/podwhale/docs/compatibility.md)。独立主人批准、安全隔离及外部服务边界见[安全说明](https://github.com/ziyefbk/podwhale/blob/v0.1.1/podwhale/docs/security.md)。
