# 大肥鱼聊天与微信接口

## 桌宠直聊

点击桌宠或聚焦后按 Enter / 空格，打开独立聊天窗。聊天窗更多菜单里的“鲸群社区”仍能进入社区面板。Enter 发送、Shift+Enter 换行，输入法组合期间不发送；Esc 收起。

使用当前 DSH 已配置的模型，不要求把模型令牌交给插件。打开窗口不会调用模型；发出消息后，Host 真实进入模型请求时才播放思考动作。支持停止、保留失败草稿、重试和清空本插件记录。关闭窗口不等同于停止生成，重新打开会读取 Host 的真实状态。

表情面板仅控制本机展示。0.1.9 沿用 v1 每动作四个独立图格，调整循环和细微动态；手选表情按完整循环、约 3–5 秒后恢复自动，同动作重选从头播放。悬停/聚焦的一次性挥手、满足条件时的空闲伸展，以及欢迎立绘微呼吸，都不会触发消息、读帖或写入。真实生成状态、拖动及反馈保留原有优先级；输入、隐藏与减少动态效果会停止对应的自动展示。布局与素材说明见[鲸鱼娘素材](character-art.md)。

聊天不调用工具，不访问社区、工作区、其它 agent 或主聊天。输入与回复在 Host 脱敏后才进入模型请求或本插件记录。每轮使用全新受限原生 agent，只传递本会话最近的成功回合，不恢复任意 DSH session。模型回复只提取已提交且完成的 assistant 文本，不输出 reasoning、工具块或失败 attempt。

每条输入最多 4000 字符，一次最多生成 2048 tokens；每个会话只运行一个任务，Host 最多并行两个任务。本地会话槽位最多 16 个（桌面一个、微信最多 15 个）；清空内容不删除槽位，修改白名单也不会自动删除旧会话。保留最近六个成功回合与有界请求回执。重复请求 ID 不会启动新的模型请求；复用 ID 却更改正文会被拒绝。

本插件记录位于 `DSH_HOME/xiaolanshu/companion.json`，与社区数据库、巡检和主聊天分开。清空只清除本插件窗口记录；DSH 自己的原生会话、诊断及模型服务商的数据仍由它们独立管理。

桌面聊天路由每次都经过 DSH `connection.requestRejection(req)`，没有 connection、没有有效浏览器身份或检查失败时拒绝，不回退成仅验证 localhost。浏览器只用同源凭据，不接收模型令牌或微信桥接令牌。

## 微信适配器

微信接口默认关闭。适配器是显式启动的独立进程，复用已安装 WeChatAgent 的 Reader SSE、账号/微信版本核验及原生发送回执；不自行 Hook、提取数据库密钥、启动微信或登录账号，也不连接或抢占原来的 OneBot WebSocket。

当前只审核并支持 [sourcepro5/WeChatAgent 的固定提交 38c1060](https://github.com/sourcepro5/WeChatAgent/tree/38c1060ce500a294d69a4a2f9e07ca1b63a08b06)。启动前会校验入口及依赖闭包文件哈希；其它版本或改动过的源码会被拒绝，需要重新审阅适配。上游微信原生组件、Python、客户端与登录由 WeChatAgent 管理，不随鲸群 npm 包提供。

Reader SSE 是广播。真实启用前，应为指定聊天保留单一 AI 回复链，避免原 WeChatAgent 与鲸群各回复一次；Reader 和原生发送服务仍须运行。这里只支持文字；群聊须明确 @ 本账号。图片、语音及文件不交给模型或下载器处理。

### 配置

先在 WeChatAgent 完成账号、Reader 和原生发送验证。取得其可信 OneBot `self_id` 与 `user_id` / `group_id`；不使用昵称或模型自报的身份。

在 DSH 开发者工具中查看 `location.origin`，取得插件同源的本机 HTTP 地址。它不是模型 API 地址，也不是社区公网服务器。以下命令从插件目录执行，替换所有占位值：

```powershell
node companion-setup.mjs --init-wechat --wechat-root "C:\path\to\WeChatAgent" --host-url "http://127.0.0.1:PORT" --account SELF_ID --peer "private:SELF_ID:PEER_ID"
```

可重复 `--account` 和 `--peer`，最多 15 个聊天；群聊格式为 `group:SELF_ID:GROUP_ID`。占位符须替换为上游提供的真实 OneBot 数字 ID，不能填写昵称或自己的 ID 作为聊天目标。初始化拒绝覆盖已有配置，不隐式轮换凭据。生成文件位于 `DSH_HOME/xiaolanshu/`：

- `companion-wechat-access.json`：Host 只保存令牌 SHA256、允许账号与聊天；
- `companion-wechat-client.json`：独立适配器使用的本机地址与客户端凭据，仅用于本机，不发给模型或前端。

命令只输出文件位置，不输出令牌。随后显式启动：

```powershell
node wechat-relay.mjs --config "C:\path\to\DSH_HOME\xiaolanshu\companion-wechat-client.json"
```

停用或恢复 Host 接口：

```powershell
node companion-setup.mjs --disable-wechat
node companion-setup.mjs --enable-wechat
```

停用也会使正在处理的适配器请求失败；适配器发送前会重新核对上游账号和聊天白名单。消息超时或发送不确定时不盲目重发。真实发信验收必须由使用者在单一测试会话完成，模拟测试不代表已连接真实微信。

## HTTP 合同

桌面路径前缀：`/xiaolanshu/api/companion`。

| 方法和路径 | 用途 |
|---|---|
| `GET /`（实际为无尾斜杠的前缀） | 读取本机桌面会话和最新任务；`?jobId=` 查询指定任务 |
| `POST /messages` | `{requestId,text}`，幂等提交后立即返回 202 和任务 |
| `POST /cancel` | `{jobId}`，取消当前任务 |
| `DELETE /`（无尾斜杠） | 清空本插件桌面记录；忙时拒绝 |
| `POST /wechat/messages` | `{selfId,peerType,peerId,senderId,messageId,text}` |
| `POST /wechat/status` | `{selfId,peerType,peerId,senderId,jobId}` |

微信路径要求回环 TCP、回环 Host、没有浏览器/转发请求头、独立 Bearer 令牌、精确账号和聊天白名单。微信不能使用桌面 cookie 替代桥接令牌。回复目标固定为真实入站事件，模型不能指定收件人。桌面与每个微信账号/聊天分别保存上下文；微信入口不能取得桌面私聊记录或批准社区操作。

上述文件默认被 git 和公开归档排除。不要在 Issue、聊天、截图或投稿正文中粘贴凭据。公开包仍为零第三方 npm 运行依赖。
