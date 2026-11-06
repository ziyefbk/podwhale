# TypeScript 开发与验收

`src/` 是唯一编辑源码。现有位置的 `.mjs`、`.js` 是受测、受审查、随包发行的编译产物。运行时仍只依赖 Node 内置模块；TypeScript、Node/React 类型只用于开发。React 实现由 DSH 提供。

```sh
cd podwhale
npm ci --ignore-scripts
npm run build
node check.mjs --local
```

`npm run typecheck` 只检查；`npm run build:check` 严格编译到内存，并逐文件检查 JS 是否与源码一致。`node check.mjs --local` 在源码仓库先执行同样的一致性检查，再测试生成的 JS；发行包不需要安装开发依赖。`pack-release.mjs` 也显式执行此门禁，因为 `npm pack --ignore-scripts` 不会执行生命周期钩子。

编译器开启 `strict`、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`、`useUnknownInCatchVariables` 和 `noEmitOnError`。构建额外拒绝显式 `any`、关闭检查的指令、漏编译源文件、无 TS 来源的业务 JS 和未注入的手机脚本。编译错误时不会覆盖任何现有产物；编译通过不代表数据或模型输出获得了信任。

## 输出路径与运行环境

- Node ESM 源码使用 `.mts`，保持原 `.mjs` 输出路径；Host `index.ts` 与脱敏模块保持原 `.js` 路径。配置文件、资源、`import.meta.url` 和远端安装布局不变。
- 桌面 `client.ts` 按经典脚本编译，由原 DSH ModuleLoader 加载；浏览器和每个小程序入口分别检查，不共享 Node 全局环境。
- 手机和注册页脚本从模板字符串中抽至 `src/browser/`；构建时内联编译结果，保留原 HTTP 路由和 CSP，不添加运行时源码读取。
- `src/host-types.mts` 是根据真实调用和 Host 验收维护的窄接口，不能替代官方 SDK 全部类型；更新宿主必须重跑真实安装验收。
- Node 22.5–22.12 使用 `node:sqlite` 时需要 `NODE_OPTIONS=--experimental-sqlite`；Node 22.13+ 不需要该标志，日常开发建议 Node 24。最低版本的标志要求来自 Node 本身，与 TS 编译无关。

## 本次迁移检查点

1. 原始基线：18 套、745 项全部通过。
2. 配置、传输、脱敏：严格检查与重新生成后的 745 项全部通过。
3. Host 隔离：最终信封 74 项定向回归通过；独立复核真实对象身份、8 工具、预算、提案权限和失败关闭。
4. 服务端：DB 15 项、媒体 17 项定向通过；补充旧记录、未知元数据及坏存储不被覆盖的验证。
5. UI：33 项渲染和交互回归通过；修复帖子集合去重写法及标签搜索误改通知状态两处问题。
6. 整合：18 套、750 项全部通过；继续验证构建失败保护、最低 Node 版本及同一 tgz 的真实 Host 安装。
7. 最终本地门禁：Node 24.22.2 与 Node 22.5.0（SQLite 标志）均为 19 套、780 项全部通过；57 个 TS 入口严格编译，55 份 JS 产物一致。另从暂存树重新导出干净目录，确认编译产物可复现。运行与测试脚本按 Node 的 ES2023 类型环境检查，浏览器、React 客户端和微信声明独立载入。

发行验收使用同一份 tgz 的 SHA-256，在官方 DSH 全新 home 中检查八工具、隔离自检、旧配置以及真实浏览器面板；结果记录于对应 PR，不写入生产 profile。

服务端仍以 Bearer 身份为权威、入库前脱敏、只保存令牌哈希。主人审批、撤销复验、摘要绑定和写锁均保留运行时检查。旧 `/xiaolanshu/`、`XLB_*`、`xlb_*`、私有数据和远端布局保持兼容。本次未实现 AGENTS 中的 Proxy 写入性能任务。

## 重构技能

采用 [Sentry code-simplifier，固定版本 e94f222](https://github.com/getsentry/skills/blob/e94f22214528d69899d09c627b3315ddc3544816/skills/code-simplifier/SKILL.md) 的保持行为和遵守项目约束原则。该目录只含技能说明，不含脚本；它不是专门的 JS→TS 迁移器。类型与运行规则另参考 [TypeScript strict](https://www.typescriptlang.org/tsconfig/strict.html)、[Node TypeScript](https://nodejs.org/api/typescript.html) 和 [Node 22.13 SQLite CLI 历史](https://nodejs.org/download/release/v22.13.0/docs/api/cli.html#--no-experimental-sqlite)。


检查范围：此次迁移覆盖原有 50 个 JS/MJS 文件及新增类型、构建保护测试。开发引导器 `tools/build.mjs` 保持 JS，以便在尚未编译源码时启动编译器。已有 `bench.mjs` 仍按旧 JSON 存储格式准备压测数据，其 SQLite 压测流程需另行更新；本次未将它计入功能验收。

最低版本验证还修复了三处兼容细节：Node 22.5 的 SQLite 空查询结果、Windows 上旧 SQLite 语句句柄的释放，以及不带 package.json 的暂存目录按 ESM 检查 `.js`。数据库修订测试使用真实 operator 子进程，保留审批与撤销的竞态屏障；自动远端部署的既有预检仍要求 Node 24。
