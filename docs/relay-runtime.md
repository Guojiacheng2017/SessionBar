# Relay 运行架构与网络策略

本次调整建立所有 Provider 共用的运行边界。CLI/TUI/Web 与未来 GUI 连接同一个本机服务；Provider HTTP 请求、外部工具的环境和直接子进程由 Relay 管理。没有新增网络设置 UI，没有启动或配置代理服务，也没有针对 Grok、GPT 或某个端口做特殊规则。

## 连接与所有权

```text
CLI / TUI / Web / future GUI
          │ 本机 HTTP / SSE（固定直连）
          ▼
       Node Relay ── Provider HTTP dispatcher ── 外部 HTTPS 服务
          │
          ├─ stdio / exec ── 外部工具（使用自身网络实现）
          └─ 本地文件、SQLite、last-good 缓存
```

Relay 拥有采集与进程生命周期；界面不复制采集逻辑。Web 的图标 CDN 仍由浏览器请求，不属于 Provider 出站通道。VPN/TUN 是操作系统路由，SessionBar 不开启、关闭或改写它；“direct”只表示不使用应用代理，不意味着绕过系统 VPN。

## 默认网络策略

1. 启动环境显式设置了 `HTTP_PROXY`、`HTTPS_PROXY` 或 `ALL_PROXY`（含小写形式）时，以这组配置为准，不混入系统代理。小写优先；显式空值保留清空含义。HTTPS 未设置时依次回退 ALL_PROXY、HTTP_PROXY。支持 `NO_PROXY`、端口、域名/通配符与 IP CIDR 绕过。
2. 没有上述覆盖时，在 macOS 只读执行 `scutil --proxy`，使用已有 HTTP、HTTPS、SOCKS5 代理及例外规则。不会运行 `networksetup -set*`、启动代理软件、猜端口或修改路由。
3. 没有应用代理配置时，按操作系统正常路由连接。
4. 所有 loopback 目标始终直连，包括本机 HTTP、健康检查、SSE 和 IPv4/IPv6 loopback；不依赖用户手动设置 NO_PROXY。

Provider HTTP 使用一个明确的 Undici dispatcher，避免依赖不同 Node 22 小版本是否默认理解代理变量。只增加一个无传递依赖的 `undici` 包。每个请求和重定向目标分别应用策略，保持调用方的方法、认证、body 与证书验证。网络层提供 15 秒请求期限，覆盖响应体；原适配器更短的期限仍有效。没有新增即时自动重试或收费请求。

系统代理在每次采集周期/手动刷新开始时重读，不另设后台轮询。读取失败时保留最近已知策略并报告问题；首次读取失败不假装已应用系统设置。明确观察到不支持的新配置时，替换旧策略并标为 unsupported。环境变量则是 Relay 启动快照，须显式 restart 更新。

`/health` 的 `runtime.network` 只暴露来源、策略修订号、状态和安全错误码，不包含代理地址、认证或账户密钥。它描述网络策略能力，不代表某个额度接口已成功返回。

## 配置更新

- 新启动的 Relay 继承启动者环境；普通客户端附着不改变既有 Relay 的环境。
- CLI 比较私有启动配置指纹，发现不同会提示使用 `sessionbar restart`，不会让多个终端或未来 GUI 相互覆盖配置。
- 指纹保存于 `startup-config.json`（POSIX 0600），可能涉及低熵秘密，不能作为公开健康信息；公开 `config_revision` 是随机值。
- `sessionbar restart` 先验证当前 owner，发送 TERM 并有界等待真正退出，再启动新实例。没有确认退出时报告失败，不删他人锁、不强杀未知 PID。
- 已有 `settings.json` 和凭据文件继续由采集周期读取。手动刷新与定时刷新共享一个在途任务，避免并发采集；环境配置与文件配置的生效边界不混用。
- Node executable 从启动 CLI 保留到 Relay，包括 TUI 的 Bun 重执行。配置继承承诺针对环境变量，不包含任意 `node --flag` 命令行选项。

重启可能改变本机动态端口，应使用新输出的地址。退出一个窗口/TUI 只释放该客户端；没有客户端时按既有默认五分钟宽限退出。`stop` 才是明确停止服务，并等待退出后报告结果。

## 关闭与资源清理

关闭先停止接收新采集任务和调度，结束 HTTP/SSE 连接，再取消在途 HTTP、终止登记的直接子进程并有界等待，最后释放实例锁。对自行启动并跟踪的子进程使用 TERM，宽限后才 KILL；不会扫描或杀死其他工具实例。现有本地 SQLite 读取与网络能力分开，不会因 PAC 不支持而阻止本地数据读取。

外部 CLI 在自身网络实现中解释投影的环境变量。不能保证它们都支持同样的 NO_PROXY、SOCKS、证书或例外语法；系统代理到子进程环境的投影属于尽力兼容。共享生命周期保证直接登记的 child，不承诺清理用户 shell 命令自行派生的所有孙进程。系统采样器继续使用其已有取消与短超时机制。

Bun 1.3 的 bare `undici` 兼容层会忽略 dispatcher；实际 Undici fetch 的 chunked body 在该运行时也存在兼容差异。因此本机客户端显式加载安装包，Bun 使用 request + 流桥接，Node 使用 fetch。不会通过临时修改进程代理变量来实现本机直连。回归覆盖 SSE 分块、POST、空响应和主动取消。

## 当前支持边界

- macOS 全局静态 HTTP/HTTPS/SOCKS5 代理已实现。SOCKS5 在所用 Undici 中仍为实验功能；socks5/socks5h 都将目标域名交给代理解析，并有本机握手/认证测试。
- PAC/WPAD 需要按目标 URL 求值，本次没有下载或执行 PAC。遇到这类系统配置明确返回 `system-pac-unsupported`，不静默改成直连。
- 仅有接口级代理而没有全局配置时返回 `system-scoped-proxy-unsupported`；没有实现完整的按目的路由选择接口级代理。
- Linux/Windows 目前遵循启动环境和操作系统路由，没有新增桌面代理配置读取器。
- 保留现有 TLS 校验及运行环境的证书选项，不禁用证书验证、不安装证书。

## Reset 与数据新鲜度

Provider 列表中的 Reset 是采集时从 resetAt 等字段生成的 `autoResetIn` 文本。last-good 会保留它；它目前不会因为墙钟流逝自行重新计算。因此 Reset 仍显示日期/时间，不能证明 GPT 或其他 Provider 的额度网络请求成功。成功数据时间戳独立保留，重复聚合已有观察不会把它刷新为“刚采集”。本次没有改动 Reset UI 或各 Provider 的业务解析。

## 验证方法

`npm test` 使用 `--import test/isolateEnvironment.mjs`，每个测试进程得到独立临时 HOME、状态目录和配置目录，清除真实凭据/命令环境，默认禁用真实 Provider 发现，退出清理。测试可在自身代码中明确注入假配置。

回归使用本机 HTTP、CONNECT、SOCKS5 假服务，保留地址 `provider.invalid` 只在测试中解析至 loopback。覆盖环境/系统策略选择、绕过规则、系统设置更新、超时、取消、子进程回收、CLI 复用/restart/stop，以及 Bun SSE。不会访问真实账户、调用 Management API、发送模型请求、读取浏览器 Cookie 或消费 reset card。

### 本次验证记录（2026-10-26）

- 当前工作树完整 `npm test`：711 项通过，0 失败、0 跳过；包含同工作区其他正在开发的功能测试，数量不等于本次新增测试数。
- Node v26.8.1；Bun v1.3.14 的实际本机传输回归通过。
- 对 `https://chatgpt.com/backend-api/wham/usage` 只做未认证 GET（不读凭据、不发 Authorization、不读响应体）：原 Node 默认 fetch 在 10 秒超时；共享 Relay 网络策略在约 6.5 秒收到 HTTP 401。
- 仅在另一个诊断进程内移除代理环境变量后，网络策略来源为 system，约 6.6 秒收到同样的 HTTP 401。说明既有 macOS 系统代理路径可用，不依赖终端导出的代理变量。
- 401 是未认证请求的预期结果，只验证 HTTP 连通性，不证明真实账户额度已刷新。没有为验证重启用户现有 Relay，也没有运行真实账户采集或 reset 操作。
