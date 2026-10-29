<p align="center">
  <img src="docs/images/sessionbar-wordmark.svg" width="720" alt="SessionBar">
  <br>
  <sub>AI CLI Session Monitor</sub>
</p>

[English](README.md) | **简体中文**

## 最新动态

- **2026-10-30 · v1.1.0 运行时：** 统一 Provider 网络策略，显式安全重启、归属验证与资源回收；文件变化防抖后定向刷新。
- **2026-10-30 · Harness：** Kimi Code、ZCode、Cursor 原生上报；WorkBuddy 数据库/WAL 发现、DeepSeek Harness 快照与 Codex 身份修复。
- **2026-10-30 · Agent 详情：** 按需查看 Codex、Claude、DeepSeek 子 Agent，分页对话及原生执行/Flow 证据。
- **2026-10-30 · 界面与 Provider：** TUI Agents/Providers 检查器、安全内置命令框、稳定 Web 更新，明确缓存账单和用量数据。
- **2026-10-26 · 保留 v1.0.0 修复：** Codex 配额窗口去重、30 分钟会话保留、本地浏览器安全边界与归属明确的 Hook 清理。

> [!NOTE]
> 此处保留最近五条重要变动，完整记录及安装包见 [Releases](https://github.com/Guojiacheng2017/SessionBar/releases)。

> [!IMPORTANT]
> SessionBar 目前仍在持续完善中，部分 Agent、状态识别和平台行为可能尚未完全覆盖。
> 欢迎在实际使用后提交问题、建议和可复现的反馈，帮助项目改进。

SessionBar 是一个本地优先的 AI 编程会话监控工具。它从不同 Agent
Harness 中发现并规范化会话，按项目目录组织数据，并通过 TUI 或本地 Web
界面展示。

同一个项目可以同时包含多个 Claude Code、Codex、Gemini、Copilot 或 WorkBuddy
会话。SessionBar 会分别跟踪每个会话，而不是将整个项目误认为单个
Agent 进程。

### 支持的 Harness

<p>
  <kbd><img src="https://unpkg.com/@lobehub/icons-static-svg@latest/icons/claude-color.svg" width="14" height="14" alt=""> Claude Code</kbd>
  <kbd><img src="https://unpkg.com/@lobehub/icons-static-svg@latest/icons/openai.svg" width="14" height="14" alt=""> Codex</kbd>
  <kbd><img src="https://unpkg.com/@lobehub/icons-static-svg@latest/icons/gemini-color.svg" width="14" height="14" alt=""> Gemini CLI</kbd>
  <kbd><img src="https://unpkg.com/@lobehub/icons-static-svg@latest/icons/copilot-color.svg" width="14" height="14" alt=""> GitHub Copilot CLI</kbd>
  <kbd><img src="https://unpkg.com/@lobehub/icons-static-svg@latest/icons/claude-color.svg" width="14" height="14" alt=""> Claude Desktop</kbd>
  <kbd><img src="public/provider-icons/workbuddy.svg" width="14" height="14" alt=""> WorkBuddy Desktop</kbd>
  <kbd><img src="https://unpkg.com/@lobehub/icons-static-svg@latest/icons/moonshot.svg" width="14" height="14" alt=""> Kimi Code</kbd>
  <kbd><img src="https://unpkg.com/@lobehub/icons-static-svg@latest/icons/cursor.svg" width="14" height="14" alt=""> Cursor</kbd>
  <kbd><img src="https://unpkg.com/@lobehub/icons-static-svg@latest/icons/deepseek-color.svg" width="14" height="14" alt=""> DeepSeek Harness</kbd>
  <kbd>ZCode</kbd>
</p>

<table>
  <tr>
    <td colspan="2" align="center"><img src="docs/images/tui-landing.png" width="560" alt="SessionBar TUI 首页"><br><sub><b>TUI · 首页</b></sub></td>
  </tr>
  <tr>
    <td width="50%" align="center"><img src="docs/images/tui-sessions.png" alt="SessionBar TUI 项目、会话与活动详情"><br><sub><b>TUI · 会话</b></sub></td>
    <td width="50%" align="center"><img src="docs/images/tui-providers.png" alt="SessionBar TUI Provider 总览"><br><sub><b>TUI · Providers</b></sub></td>
  </tr>
  <tr>
    <td width="50%" align="center"><img src="docs/images/web-sessions.png" alt="SessionBar Web 会话总览"><br><sub><b>Web · 会话</b></sub></td>
    <td width="50%" align="center"><img src="docs/images/web-providers.png" alt="SessionBar Web Provider 总览"><br><sub><b>Web · Providers</b></sub></td>
  </tr>
</table>

> 截图于 2026-10-30 根据本次发布的实际 UI 生成，使用隔离的模拟项目、会话、系统指标和
> Provider 数值，不包含真实账户数据、凭据或个人路径。缺失字段仍显示为不可用；
> 实际数据覆盖范围取决于 Harness 和 Provider Adapter。

> SessionBar 使用终端自身的背景色；实际颜色和对比度会随终端主题变化。

## 功能

- 项目路径 → Session → Details；每个 Agent 会话保持独立。
- Overview、Activity、Usage、Flow、Raw 详情；未选择项目时展示系统状态。
- Provider 配额、余额、趋势与 Session 状态分离。
- 缓存 CPU、内存、负载、温度和网络读数。
- Alternate-screen TUI 渲染和后台降频。
- 每个状态目录一个 Relay，启动时动态分配端口。
- 按需查看子 Agent 和有来源证据的执行/Flow 视图；缺失的关系不作推断。
- 定向发现、防抖与 last-good 快照；内置命令不执行任意 Shell。

## 安装与更新

需要 **Node.js 22+、npm 和 Bun**。Node 运行 CLI、Landing 和 Relay；OpenTUI
Monitor 需要 Bun 原生 FFI。macOS 是主要测试平台；Linux 部分支持，部分桌面发现、
凭据和温度 Adapter 仅支持 macOS。当前不承诺 Windows 功能对等。

### 安装发布包

从 [GitHub Releases](https://github.com/Guojiacheng2017/SessionBar/releases/latest)
下载 `sessionbar-1.1.0.tgz` 和 `SHA256SUMS`，在下载目录运行：

```sh
shasum -a 256 -c SHA256SUMS
npm install --global ./sessionbar-1.1.0.tgz
sessionbar
```

这是 GitHub 发布包，不代表已发布到 npm Registry。
安装包与对应的校验文件应从同一个 Release 一起下载。

### 从源码安装

```sh
git clone --branch main https://github.com/Guojiacheng2017/SessionBar.git sessionbar
cd sessionbar
npm install
npm run build
npm link
sessionbar
```

无需全局链接时运行 `node dist/cli/cli.js`。源码安装更新：
在干净的 `main` 目录依次执行 `git pull --ff-only`、`npm install`、`npm run build`。
历史分叉时先整理本地工作，不要丢弃未发布的改动。

## 使用

Landing 自动启动 Relay。用上下方向键或 j/k 选择，Enter 执行。
快捷键：`1` Monitor、`2` Setup、`3` Status、`4` Settings、`W` Web、`Q` 退出。
按 `:` 或 Tab 打开内置命令框，支持补全和历史，不会执行任意 Shell 命令。

```sh
sessionbar monitor    # 实时终端面板 / Live terminal dashboard
sessionbar agents     # 按需查看子 Agent / Inspect observed sub-agents
sessionbar providers  # Provider 检查器 / Provider inspector
sessionbar status     # 单次状态输出 / One-shot status
sessionbar web        # 本地网页面板 / Local Web dashboard
sessionbar setup      # 配置 Hook 范围 / Configure hook scope
sessionbar harnesses  # 检查 Harness / Inspect harness availability
sessionbar prune      # 清理过期标记 / Remove stale markers
sessionbar stop       # 显式停止服务 / Explicitly stop the relay
sessionbar restart    # 安全重启并应用环境 / Safely restart with the current environment
```

Monitor 中先上下选择项目并 Enter，再上下选择其中的 Session。
Tab、方括号或 `1`–`5` 切换详情，`a` 或 Backspace 返回全部项目，
`v` 切换 Providers、`A` 切换 Agents、`r` 刷新、`/` 过滤、`w` 打开网页、`q` 退出。
未聚焦项目时显示全部 Session。Web 中点击项目和会话，向下滚动进入 Providers。
详情支持 `PageUp`、`PageDown`、`Home`、`End`，窄终端也可访问底部内容。

退出 TUI 只释放当前客户端，不会关闭其他客户端或浏览器标签。最后一个客户端
断开后有五分钟重连宽限；显式启动的无界面 Relay 不会仅因空闲而退出。
执行 `sessionbar stop` 显式停止。正常刷新不改变端口，显式重启或新进程可能获得新端口。
`sessionbar prune` 会先停止运行中的 Relay，再删除过期标记；属于维护操作，
不应作为日常刷新方式。

### Hook 与发现

```sh
sessionbar setup --local   # 当前项目 / Current project
sessionbar setup --global  # 所有项目 / All projects
```

交互应用激活 SessionBar 管理的 Hook；单次 Status 不安装 Hook。Harness 可能需重启
加载配置。Claude Code、Gemini CLI、Copilot、Cursor 使用 Hook；Codex 另有本地日志和
App Server 元数据。Kimi Code 与 ZCode 使用用户级原生 Hook，不宣称项目级配置。
Claude Desktop、WorkBuddy 读取本地文件，不注入 Desktop Hook；WorkBuddy 在存在
`sqlite3` 时还读取有界 SQLite/WAL 快照。DeepSeek Harness 读取 `~/.dsh` 的版本化
Checkpoint，与 DeepSeek API 余额独立。支持 Pi 生命周期回调，但不宣称通用 Pi 执行图
或 OpenCode 发现。详见 [输入 Adapter](docs/harness-input-adapters.md)。

自定义上报：

```sh
SESSIONBAR_AGENT=codex \
SESSIONBAR_SESSION_TYPE=Codex \
SESSIONBAR_PROJECT_DIR="$PWD" \
SESSIONBAR_SESSION_ID="agent-session-id" \
./report.sh working "Editing files"
```

`report.sh <status> <task_name> [server_port]` 在省略端口时读取状态目录。
Session ID 必须标识独立会话，不能仅标识项目。可选字段包括
`SESSIONBAR_CONTEXT_PERCENT`、`SESSIONBAR_TOKENS`、`SESSIONBAR_HOOK_EVENT`。
保留对旧 `AGENTBAR_*` 变量的兼容。

## 运行状态与存储

默认绑定 **127.0.0.1** 的可用端口，记录于 `~/.sessionbar/port`。同目录包含
`server.pid`、`server.log`、`sessions/`、`settings.json`、
`provider-usage-history.json`、`provider-last-good.json`、`session-usage-history.json`。
私有启动配置和 Codex 来源缓存同样存放于此。

```sh
SESSIONBAR_PORT=8989 sessionbar             # 可选固定端口 / Optional fixed port
SESSIONBAR_HOME="$HOME/.sessionbar-dev" sessionbar  # 独立状态 / Isolated state
```

`SESSION_BAR_PORT`、`PORT` 为兼容别名。显式端口被占用时可能启动失败。
状态和中间数据不应写入仓库。Session 无更新时在内存保留最多 30 分钟，
列表并非永久对话档案。
保留的行不代表 Agent 进程仍在运行；Harness 未上报的 Context 和 Usage 字段
仍显示为不可用。

POSIX 状态目录权限为 `0700`，更新后的状态文件为 `0600`。
这不是加密，也无法阻止同一用户身份的其他进程读取。

## Provider 数据

Adapter 包括 OpenAI/Codex、Anthropic、GitHub Copilot、DeepSeek、MiniMax、
Kimi、xAI 及兼容 CC Switch 配置，覆盖取决于凭据和上游接口。
不会从 Session Token 猜测缺失的账户配额。

[CC Switch](https://github.com/farion1231/cc-switch) 是可选只读集成，提供兼容凭据和
七天 API Token 历史。没有它也能运行监控和官方 Adapter。DeepSeek、Kimi 可使用
`SESSIONBAR_DEEPSEEK_API_KEY`、`SESSIONBAR_KIMI_API_KEY`。
WorkBuddy 可配置只读 `SESSIONBAR_WORKBUDDY_BALANCE_COMMAND` 输出校验后的余额 JSON。
本地 WorkBuddy Context/消耗不视为账户余额。Grok CLI 已安装并认证时，账单通过只读
ACP 接口采集；xAI Management API 需要启动环境同时包含
`SESSIONBAR_XAI_MANAGEMENT_API_KEY` 和 `SESSIONBAR_XAI_TEAM_ID`，本次不含 Web 凭据编辑器。
采集值保留原始来源时间。

Provider HTTP 共用 Relay 网络策略：显式代理环境优先，否则读取 macOS 现有系统代理，
再否则沿用正常系统路由。Loopback 始终直连，不开启代理或修改系统设置。
环境变化通过 `sessionbar restart` 应用，详见 [运行时边界与不支持的代理模式](docs/relay-runtime.md)。

```sh
SESSIONBAR_PROVIDER_POLL=0 sessionbar
SESSIONBAR_PROVIDER_POLL_MS=300000 sessionbar
```

默认五分钟采集，最短 30 秒。成功 Provider 数据最多保留 30 天；刷新失败显示
最后数值、原采集时间和 stale 标记，不续期。关闭轮询后仍可读取缓存，但不调用
订阅或 API Adapter。

## 隐私与安全

本次仅支持 Loopback HTTP，不要通过公共代理或端口转发暴露 Relay。浏览器请求
校验可信 Host 和同源 Origin。设备配对、LAN 网关和远程遥测不在本次发布中。

项目路径、标题和 Activity 可能包含私人信息，本地客户端可以看到。
Provider 凭据不返回 UI Payload。上游接口、外部 Icon 会产生网络请求。
可选 `--icloud` 将 Session 快照导出到用户 iCloud 目录。

本次生产依赖通过 `npm audit --omit=dev`，但不代表全面安全审计或能防御恶意
本地进程。不要提交凭据、个人配置或真实快照。
忽略规则属于本地配置，不在仓库中跟踪。暂存前，请在本地 `.gitignore` 或
`.git/info/exclude` 中排除凭据、`.env`、个人 Agent 配置、`node_modules/`、`dist/`，
并在提交前检查 `git status` 与 `git diff --cached`。

## 开发

源码按职责位于 `src/agents`、`cli`、`harness`、`hooks`、`providers`、`runtime`、`server`、`sessions`、
`shared`、`system`、`tui`、`web`；资源在 `public/`，测试在 `test/`。
截图与字标工具说明见 [scripts/docs/README.md](scripts/docs/README.md)。

```sh
npm run build
npm test
```

测试隔离 HOME、凭据与状态，使用模拟接口，不要求真实账户，也不发送模型请求。

添加回归测试，状态放在仓库外，保留未知值，并区分项目与 Session 身份。
实验中的费用、原生伴随应用及光学配对不在本次更新内。

## 贡献

欢迎提交代码、Bug Report、可复现的性能数据以及 Harness Adapter 改进。
提交贡献即表示同意相关修改可按本项目的 MIT License 发布。

## 前任工作与方向

[Orca](https://github.com/stablyai/orca)、[abtop](https://github.com/graykode/abtop)、
[Mole](https://github.com/tw93/mole)、[Rezi](https://github.com/RtlZeroMemory/Rezi)、
[OpenTUI](https://github.com/anomalyco/opentui) 探索了相邻的 Agent、终端与系统监控问题。
此列表说明领域背景，不代表代码借用、关联或背书。SessionBar 的方向是低开销、
隐私优先、按项目组织的全机编程 Agent 会话视图。

## 许可证

[MIT License](LICENSE)。第三方资源保留各自许可证。
Bundled Splide 和 README 字标字体归属见 [第三方声明](docs/THIRD_PARTY_NOTICES.md)。
