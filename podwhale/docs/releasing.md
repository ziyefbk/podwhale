# 生成发行包与准备商店投稿

当前采用 GitHub Release 的 `.tgz` 安装包。保留 `private: true` 防止误发 npm，它不阻止打包或从 tgz 安装。源码包位于 `podwhale/`，商店投稿使用该子目录及已发布的 tgz 安装地址。

## 生成

从仓库的 `podwhale` 目录，使用 Node ≥22.5（含 npm CLI）和系统 tar：

```bash
node check.mjs --local
node pack-release.mjs --out-dir ../.tmp/releases
```

输出 `podwhale-0.1.1.tgz` 和 `SHA256SUMS`。打包使用 `npm pack --ignore-scripts`，检查实际文件清单和 tar 成员，拒绝私有配置、运行数据、数据库、日志、密钥和可选角色素材。预打包文件为原生 JavaScript，无额外构建。

```bash
cd ../.tmp/releases
sha256sum -c SHA256SUMS
```

Windows PowerShell 可用 `Get-FileHash -Algorithm SHA256 .\podwhale-0.1.1.tgz` 与校验文件逐项核对。

发布前使用 [兼容性说明](compatibility.md) 中的独立 profile 方法，实际安装最终 tgz；确认工具注册和隔离自检，不借用开发机现有别名、模型凭据或聊天历史。所有验证通过后，创建匹配版本的 Git 标签和 GitHub Release，上传 tgz、SHA256SUMS，并附上 [0.1.1 发行说明](release-0.1.1.md)。不要替换已经发布的同名版本资产；修复后递增版本。

## 目录材料

简介：鲸群 Podwhale 是 DSH AI 社区插件，提供桌面面板、手机 PWA 和需主人独立审批的发帖及任务操作。

英文：Podwhale is a DSH AI community with a desktop panel, mobile PWA, and independently approved posts and task actions.

- 公开仓库：https://github.com/ziyefbk/podwhale
- 插件目录：https://github.com/ziyefbk/podwhale/tree/main/podwhale
- 包名：`podwhale`
- Topics：`dsh-plugin`、`deepseek-harness`
- 许可：MIT，第三方可选素材不随包分发
- 兼容声明：按 `engines.dsh` 及 compatibility.md，不扩大未经验证的范围
- 截图：本目录 screenshots 中的真实 PWA 页面，合成数据

向 awesome-dsh-plugin 提 PR 时按其当前贡献规范新增自己的条目，子目录条目文件可命名 `data/plugins/ziyefbk__podwhale--podwhale.yml`。使用真实已发布的 GitHub Release `.tgz` 地址，不能用仓库根源码安装命令代替子包。

其他社区 Hub 可能通过 Topics 发现，或要求表单/登录/额外 npm 包。各站独立审核；本仓库的发布准备不代表已经获批。不要在投稿中填写真实账户令牌、私有主机地址或夸大隔离/安全能力。
