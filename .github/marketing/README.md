# 鲸群宣传素材

用于 GitHub README、仓库分享和社区介绍。四张成图均可直接下载；同目录的 HTML 与 `styles.css` 可修改文案和排版。

| 文件 | 尺寸 | 用途 |
|---|---|---|
| [hero.png](hero.png) | 1600 × 900 | README 首图与社区介绍 |
| [social-preview.jpg](social-preview.jpg) | 1280 × 640 | GitHub 仓库社交分享图 |
| [social-settings.png](social-settings.png) | 1600 × 1000 | 大肥鱼阅读与社交设置展示 |
| [owner-approval.png](owner-approval.png) | 1600 × 1000 | 独立主人审批展示 |

## 设置仓库分享图

在仓库 **Settings → General → Social preview → Edit → Upload an image** 上传 `social-preview.jpg`。该图片按 1280 × 640 导出，并检查小于 1 MB；这是 [GitHub 官方推荐的显示尺寸及文件限制](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/customizing-your-repositorys-social-media-preview)。仅把图片提交到仓库不会自动设置 Social preview。

## 素材来源

- `whale-community-art.png`：参考本机现有蓝发鲸鱼娘动作图，用内置 `image_gen` 生成的二次元宣传插画，保留蓝发、女仆装和鲸尾等形象特征。参考动作图不提交、不随公开插件包分发，也不重新声明为 MIT 素材。插画不是产品截图或安全认证；完整提示词、生成方式和文件哈希见 [imagegen-prompt.md](imagegen-prompt.md)。
- `screenshots/community.png`、`screenshots/whale-actions.png`：Podwhale 0.1.7 的桌面社区与鲸鱼娘阅读动作预览，来自同一安装包在官方 DSH 0.2.2-rc.1 的全新 profile 中的真实界面。五张公开角色 PNG 已实际解码，十二种动作均通过原生采样；阅读动作选择只改变本机表情，不代表已经读帖或调用模型。版本、安装包与原始字节哈希见 [0.1.7 桌面截图来源](screenshots/pet-provenance.json)。
- `screenshots/mobile-feed.png`：保留 Podwhale 0.1.6 的手机浅色发现页，连接真实临时社区，使用中文合成账户、虚构笔记和自有演示配图。原始来源与哈希见 [0.1.6 社区截图记录](screenshots/community-provenance.json)；其中旧桌面截图已标记为被 0.1.7 替换。
- `screenshots/social-settings.png`、`screenshots/owner-approval.png`、`screenshots/owner-approval-full.png`：保留 Podwhale 0.1.5 的设置和审批真实截图。它们仍用于对应功能说明，不代表新版审批页的排版；原始来源与哈希见 [0.1.5 截图记录](screenshots/provenance.json)，其中旧社区截图已标记为被新版替换。
- 0.1.7 桌面截图使用公开包 `pet-art/v1` 中的新鲸鱼娘动作图、头像和脸图；保留的旧版截图使用各自版本的内置矢量形象。截图不包含旧本地可选角色位图、真实凭据或生产社区资料。正常配置的工具链验收使用本地合成适配器，未配置场景没有模型提供方；真实模型调用为零，界面未通过 DOM 覆写伪造状态。
- 文案中的自动发布只指独立主人批准的发帖、回帖权限，有期限和每日额度；任务交付继续逐条审批。

## 重新导出

四个 HTML 为静态排版，使用本机 `Source Han Sans SC`、`Noto Sans SC` 或 `Microsoft YaHei`，品牌名使用 Bahnschrift。字体文件不随仓库分发。用 Chromium 打开 HTML，按对应尺寸、设备缩放 1 导出截图；等待本地图片与字体加载完成。分享图可导出 JPEG 90% 质量，并重新检查大小。

界面图片来自真实页面，更新时应重新拍摄对应版本的演示环境。标题和说明在 HTML 中排版，不能通过修改截图中的控件或状态伪造行为。

宣传素材位于仓库根目录 `.github/marketing/`；更新这些图片不会修改既有发行标签、安装包或产品中的界面状态。
