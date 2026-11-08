# 源站入口加固

本目录用于 Linux 宿主机运行 Node、Docker bridge 容器运行 Caddy 的部署。先核实拓扑再安装；不能把桥接容器需要访问的 Node 地址直接改成宿主机 loopback。

## 应用保护

社区服务在鉴权和路由分发前限制全局与来源请求速率，并单独限制无效凭据。连接数、HTTP 头、请求体和请求时间也有上限。健康检查使用短时共享缓存，业务写入后失效。用 `node check.mjs --local` 运行真实 HTTP 回归。

`XLB_TRUST_PROXY` 默认关闭。只有在以下条件都验证后才设为 `1`：

- Node 端口只允许实际受信代理及宿主机本地操作访问。
- 代理用连接的真实来源覆盖 `X-Forwarded-For`，不采用访客自行提交的值。
- 代理没有把未受信上游的头当成真实地址。

现有平台或以后接入 CDN 时，都必须重新核实真实来源链路和限流效果。不能直接信任任意转发头。

## 8790 端口隔离

`network-guard.py` 读取受保护的配置，按 Docker compose 标签和网络解析当前代理容器。它只管理专用防火墙链及匹配应用 TCP 端口的 INPUT 跳转：允许 loopback、精确代理 IPv4 地址和 bridge 入接口，其余来源拒绝；IPv6 同端口也拒绝其他来源。它不改变 SSH、其他端口、Docker NAT、UFW 或供应商防火墙规则。

配置保存在仓库外 `/etc/podwhale-network-guard.json`，由 root 拥有，权限 `0600`。填写实际私有值，不要提交到 Git：

```json
{
  "port": 8790,
  "appHost": "填写实际私网绑定地址",
  "proxyProject": "填写实际compose项目",
  "proxyService": "填写实际代理服务",
  "proxyNetwork": "填写实际bridge网络"
}
```

将工具安装到 `/usr/local/libexec/podwhale-network-guard.py`，将配套 service/timer 安装到 `/etc/systemd/system/`。均应由 root 拥有、不可由应用用户修改。Node service 还需 `Requires=` 和 `After=podwhale-network-guard.service`，防止规则安装失败时继续启动。模板每 30 秒重新解析容器地址；代理不可见时保持拒绝，代理重建后自动更新允许地址。

操作接口：

```sh
sudo python3 /usr/local/libexec/podwhale-network-guard.py --apply --config /etc/podwhale-network-guard.json
sudo python3 /usr/local/libexec/podwhale-network-guard.py --check --config /etc/podwhale-network-guard.json
```

先备份配置和规则，建立经确认正在等待的独立定时回滚，再应用规则。回滚只撤销本次修改和自有链，不可全量 flush 或恢复整个 Docker 动态规则集。安装后检查：

1. 用新的 TCP 连接验证 SSH，禁用 SSH 连接复用。
2. HTTPS 页面、健康检查、鉴权和受限 AI 凭据继续正常。
3. 代理可到达应用，其他容器和外部来源无法直连应用端口。
4. IPv4/IPv6 规则、自有链顺序、代理地址刷新和 timer 均正确。
5. 确认以上结果后撤销定时回滚。

日常刷新用 `--apply` 或启动 oneshot service；显式停止/重启被 Node `Requires` 的 service 可能连带停止 Node。移除前先关闭代理信任、恢复依赖配置，避免留下可伪造转发头的直接入口。

## 代理和公网边界

`Caddyfile.community.example` 只提供社区路径的请求体、超时和转发头配置示例。`timeouts` 需实际安装的 Caddy 支持；先用 `caddy validate` 检查候选，再热加载，保留其他网站配置。

同一站点已有不带匹配条件的 `handle` 兜底时，社区代理应放在 `handle /xiaolanshu/*` 内，与兜底互斥匹配；直接把顶层 `reverse_proxy /xiaolanshu/*` 加在兜底后，会使请求先被兜底代理接走并可能返回 404。使用 `handle` 保留原路径，服务端继续处理 `/xiaolanshu/` 前缀。参见 [Caddy handle 说明](https://caddyserver.com/docs/caddyfile/directives/handle)。

单文件 bind mount 的配置要保留原 inode，不能直接 rename 替换后假设容器已看到新文件。若 Caddy 的管理 API 已关闭，确认它以 `caddy run --config` 启动且没有 `--resume` 后，可用 `SIGUSR1` 重新加载文件；无需为重载开放管理 API。候选配置校验和回滚流程都应采用实际可用的重载方式。

这些限制降低源站接口被滥用的风险，不能消除公网 IP 或抵抗超出服务器带宽的大流量攻击。接入 CDN/WAF 需要可管理域名及平台配置，并应限制源站仅接受可信回源。仅添加域名解析不会隐藏 IP。云安全组需单独在云平台核实；UFW 状态不能代表 Docker 发布端口或云安全组的实际策略。

参考：[Docker 防火墙](https://docs.docker.com/engine/network/packet-filtering-firewalls/)、[Caddy 转发头与超时](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)、[Caddy 路径超时](https://caddyserver.com/docs/caddyfile/directives/timeouts)。
