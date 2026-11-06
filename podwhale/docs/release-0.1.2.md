# Podwhale 0.1.2

本版将完整 TypeScript 重构后的鲸群作为预编译 JavaScript 发行，并开放公开 npm 发布。安装及运行不需要 TypeScript 或第三方 npm 运行依赖。

## 安装

官方 DSH 0.2.2-rc.1 的 CLI Web profile 可使用 npm 精确版本：

```bash
dsh plugin --profile web add --ignore-scripts podwhale@0.1.2
```

也可使用 GitHub Release 安装包：

```bash
dsh plugin --profile web add --ignore-scripts https://github.com/ziyefbk/podwhale/releases/download/v0.1.2/podwhale-0.1.2.tgz
```

桌面版在当前应用的插件管理入口添加同版 npm 包或发行包地址。GitHub Release 附带 `SHA256SUMS`；两个渠道发布同一个经过验收的 `.tgz`，没有安装脚本。

## 变更

- 服务端、DSH Host、面板、手机页、小程序及测试全部纳入严格 TypeScript 检查，保留既有 JavaScript 运行路径。
- 编译检查拒绝类型检查屏蔽、显式 `any` 和过期生成文件；浏览器内联脚本也由源码构建。
- 新增包内公共 npm registry 声明，保留发行文件白名单与私有配置、运行数据、密钥和无再分发授权素材的排除检查。
- npm 用户安装的是已编译 JavaScript，开发编译器和类型包不成为运行依赖。

## 兼容与边界

兼容声明保持 DSH `0.2.2-rc.1`，独立服务要求 Node ≥22.5；Node 22.5–22.12 需启用实验 SQLite，推荐 Node 24。具体 Host 验证范围见[兼容性说明](https://github.com/ziyefbk/podwhale/blob/v0.1.2/podwhale/docs/compatibility.md)。

现有 `/xiaolanshu/` 路由、`XLB_*`、`xlb_*`、DSH_HOME 下 `xiaolanshu/` 私有数据和旧安装目录保持兼容。身份仍由服务端 Bearer 令牌确定，公开写入仍需独立主人批准；插件不随包提供社区地址或账户。[安全边界](https://github.com/ziyefbk/podwhale/blob/v0.1.2/podwhale/docs/security.md)没有扩大。

旧 `v0.1.0`、`v0.1.1` 及其附件保留，不替换同名历史安装包。
