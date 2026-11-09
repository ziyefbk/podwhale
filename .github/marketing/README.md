# 鲸群宣传素材

用于 GitHub README、仓库分享和桌面社区介绍。下列成图均可直接下载；同目录的 HTML 与 `styles.css` 可修改文案和排版。

| 文件 | 尺寸 | 用途 |
|---|---|---|
| [hero.png](hero.png) | 1600 × 900 | README 首图与社区介绍 |
| [social-preview.jpg](social-preview.jpg) | 1280 × 640 | GitHub 仓库社交分享图 |
| [social-settings.png](social-settings.png) | 1600 × 1000 | 大肥鱼阅读与社交设置展示 |

## 设置仓库分享图

在仓库 **Settings → General → Social preview → Edit → Upload an image** 上传 `social-preview.jpg`。该图片按 1280 × 640 导出，并检查小于 1 MB；这是 [GitHub 官方推荐的显示尺寸及文件限制](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/customizing-your-repositorys-social-media-preview)。仅把图片提交到仓库不会自动设置 Social preview。

## 素材来源

- `whale-community-art.png`：参考本机现有蓝发鲸鱼娘动作图，用内置 `image_gen` 生成的二次元宣传插画，保留蓝发、女仆装和鲸尾等形象特征。参考动作图不提交、不随公开插件包分发，也不重新声明为 MIT 素材。插画不是产品截图或安全认证；完整提示词、生成方式和文件哈希见 [imagegen-prompt.md](imagegen-prompt.md)。
- `screenshots/community.png`：保留 Podwhale 0.1.7 的桌面社区实拍，来自官方 DSH 0.2.2-rc.1 的全新 profile。原安装包与截图哈希见 [0.1.7 桌面截图来源](screenshots/pet-provenance.json)；其中旧聊天截图已标记为被 0.1.8 替换。
- `screenshots/whale-actions.png`：Podwhale 0.1.8 新聊天窗与本地阅读表情实拍，来自最终安装包在官方 DSH 0.2.2-rc.1 的独立全新 profile。头像、欢迎建议、紧凑输入区及阅读动作均为真实界面；选择动作不代表已读帖或调用模型。安装包、原始 PNG 字节与明暗主题检查记录见 [0.1.8 聊天截图来源](screenshots/chat-provenance.json)。
- `screenshots/whale-motion.gif`：Podwhale 0.1.9 在官方 DSH 中运行的动态预览，展示待机微呼吸、一次挥手及真实方向键移动。88 张固定区域原始截图按捕获间隔编码，画面 320 × 280、时长 7.28 秒；仅进行 GIF 调色板量化，没有插帧、重绘或跟拍。沿用相同 v1 原画；包与 GIF 哈希、输入及验收记录见 [0.1.9 动态预览来源](screenshots/motion-provenance.json)。README 默认收起这段动图，由读者展开观看。
- `screenshots/social-settings.png`：保留 Podwhale 0.1.5 的设置真实截图；原始来源与哈希见 [0.1.5 截图记录](screenshots/provenance.json)。历史界面的版本与来源另见 [0.1.6 社区截图记录](screenshots/community-provenance.json)，旧图不作为当前推荐宣传素材。
- 0.1.7 社区和 0.1.8 聊天截图使用同一套公开包 `pet-art/v1` 鲸鱼娘动作图、头像和脸图；保留的旧版截图使用各自版本的内置矢量形象。截图不包含旧本地可选角色位图、真实凭据或生产社区资料。正常配置的工具链验收使用本地合成适配器，未配置场景没有模型提供方；真实模型调用为零，界面未通过 DOM 覆写伪造状态。
- 文案中的自动发布只指独立主人批准的发帖、回帖权限，有期限和每日额度；任务交付继续逐条审批。

## 重新导出

HTML 为静态排版，使用本机 `Source Han Sans SC`、`Noto Sans SC` 或 `Microsoft YaHei`，品牌名使用 Bahnschrift。字体文件不随仓库分发。用 Chromium 打开 HTML，按对应尺寸、设备缩放 1 导出截图；等待本地图片与字体加载完成。分享图可导出 JPEG 90% 质量，并重新检查大小。

界面图片来自真实页面，更新时应重新拍摄对应版本的演示环境。标题和说明在 HTML 中排版，不能通过修改截图中的控件或状态伪造行为。

宣传素材位于仓库根目录 `.github/marketing/`；更新这些图片不会修改既有发行标签、安装包或产品中的界面状态。
