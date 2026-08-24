# SessionBar

[English](README.md) | **简体中文**

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
  <kbd><img src="public/provider-icons/workbuddy.svg" width="14" height="14" alt=""> WorkBuddy Desktop</kbd>
</p>

<table>
  <tr>
    <td width="50%" align="center"><img src="docs/images/tui-landing.png" alt="SessionBar TUI 首页"><br><sub><b>TUI · 首页</b></sub></td>
    <td width="50%" align="center"><img src="docs/images/tui-providers.png" alt="SessionBar TUI Provider 总览"><br><sub><b>TUI · Providers</b></sub></td>
  </tr>
  <tr>
    <td width="50%" align="center"><img src="docs/images/web-sessions.png" alt="SessionBar Web 会话总览"><br><sub><b>Web · 会话</b></sub></td>
    <td width="50%" align="center"><img src="docs/images/web-providers.png" alt="SessionBar Web Provider 总览"><br><sub><b>Web · Providers</b></sub></td>
  </tr>
</table>

> 截图使用隔离的示例项目、会话、Harness 和 Provider 数值，不包含本机路径、
> 账户余额、凭据或其他用户专属数据。

> SessionBar 使用终端自身的背景色；实际颜色和对比度会随终端主题变化。

## 功能

- 以项目为第一层级，在项目内选择会话并查看详细信息。
- 分别显示 Agent、会话 ID、任务、状态、更新时间、Context 和 Usage。
- 提供 Overview、Activity、Usage、Flow、Raw 和 System 详情页。
- 支持 Claude Code、Codex、Gemini CLI、GitHub Copilot CLI、WorkBuddy Desktop 及可扩展 Hook。
- 在不向 UI 暴露凭据的前提下展示 Provider 配额和用量。
- 缓存 CPU、内存、负载、温度和网络状态。
- 使用 alternate screen 稳定渲染；失去焦点时自动降低轮询频率。
- 每台机器只运行一个本地 Relay，并动态选择 loopback 端口。

## 环境要求

- macOS 或 Linux
- Node.js 22 或更高版本
- npm
- 建议安装 Bun，以运行 OpenTUI Monitor

### 可选 Provider 集成

[CC Switch](https://github.com/farion1231/cc-switch) 是可选集成。检测到其本地
数据库后，SessionBar 会以只读方式获取兼容 API Provider 的七日 Token 历史，
并发现兼容的 DeepSeek 或 Kimi 凭据。SessionBar 不会安装、启动或修改
CC Switch。

未安装 CC Switch 时，会话监控和官方 Provider Adapter 仍可正常工作。DeepSeek
和 Kimi 余额也可分别通过 `SESSIONBAR_DEEPSEEK_API_KEY` 与
`SESSIONBAR_KIMI_API_KEY` 接入；除非有其他受支持的数据源上报，否则不会显示
这两者的本地 Token 历史。

## 安装

### 从源码安装

```sh
git clone https://github.com/Guojiacheng2017/SessionBar.git sessionbar
cd sessionbar
npm install
npm run build
npm link
```

执行 `npm link` 后，当前 Node.js 环境中会注册全局 `sessionbar` 命令。

不注册全局命令也可以直接运行：

```sh
npm install
npm run build
node dist/cli/cli.js
```

### 更新源码安装

```sh
git pull
npm install
npm run build
```

## 快速开始

打开交互式首页：

```sh
sessionbar
```

应用会自动启动本地 Relay。首页快捷键：

- `1` 或 `Enter`：打开实时 Monitor
- `2`：选择局部或全局 Hook 范围
- `3`：输出当前会话状态
- `4`：打开 SessionBar 设置
- `W`：启动或打开 Web 面板
- `Q`：退出

也可以直接进入指定功能：

```sh
sessionbar monitor    # 实时终端面板 / Live terminal dashboard
sessionbar status     # 单次状态输出 / One-shot terminal status
sessionbar web        # 本地网页面板 / Local Web dashboard
sessionbar setup      # 配置 Hook 范围 / Configure hook scope
sessionbar harnesses  # 检查 Harness / Inspect supported harnesses
sessionbar prune      # 清理过期标记 / Remove stale markers
sessionbar stop       # 显式停止服务 / Explicitly stop the relay
```

Monitor 按项目优先导航：

1. 使用 `Up`/`Down` 或 `j`/`k` 选择项目。
2. 按 `Enter` 查看该项目中的会话。
3. 使用 `Up`/`Down` 选择具体会话。
4. 使用 `[`/`]` 或数字键切换详情 Tab。
5. 按 Backspace 或 `a` 返回所有项目，按 `q` 退出。

## Hook 配置

选择仅监控当前项目，或监控机器上的所有项目：

```sh
sessionbar setup --local   # 当前项目 / Current project's .claude/settings.json
sessionbar setup --global  # 全局配置 / Global ~/.claude/settings.json
```

打开交互式 SessionBar 应用后，已配置的 Hook 才会激活。SessionBar 只移除
自己管理的 Hook。Hook 请求使用较短的连接超时，因此 Relay 不可用时不会阻塞
Agent Harness。

规范化上报命令：

```sh
SESSIONBAR_AGENT=codex \
SESSIONBAR_SESSION_TYPE=Codex \
SESSIONBAR_PROJECT_DIR="$PWD" \
SESSIONBAR_SESSION_ID="agent-session-id" \
./report.sh working "Editing files" "$SESSIONBAR_PORT"
```

`report.sh` 参数为 `report.sh <status> <task_name> <server_port>`。

| 变量 | 用途 |
| --- | --- |
| `SESSIONBAR_AGENT` | 稳定的小写 Agent 标识，如 `claude`、`codex` |
| `SESSIONBAR_SESSION_TYPE` | 面向用户的 Agent 名称 |
| `SESSIONBAR_PROJECT_DIR` | 项目绝对路径 |
| `SESSIONBAR_SESSION_ID` | 单个 Agent 会话的稳定 ID |
| `SESSIONBAR_CONTEXT_PERCENT` | 可选的 Context 使用百分比 |
| `SESSIONBAR_TOKENS` | 可选的当前 Token 数量 |
| `SESSIONBAR_HOOK_EVENT` | 可选的原生生命周期或工具事件 |

为了兼容已有安装，SessionBar 仍接受旧的 `AGENTBAR_*` 变量。

## 运行时和端口

每个状态目录只允许存在一个 Relay 实例。默认监听 `127.0.0.1`，自动选择可用
端口，并将最终端口写入：

```text
~/.sessionbar/port
```

TUI、Web、Hook 和 CLI 使用同一份运行时状态。如需指定端口：

```sh
SESSIONBAR_PORT=8989 sessionbar
```

兼容变量 `SESSION_BAR_PORT` 和 `PORT` 也可使用。固定端口不是默认方向；如果已被
其他进程占用，启动会失败。

## 状态目录

所有中间数据存储在 `~/.sessionbar/`，不会写入项目根目录或系统临时目录。

| 路径 | 内容 |
| --- | --- |
| `~/.sessionbar/port` | 当前动态端口 |
| `~/.sessionbar/server.pid` | Relay 进程 ID |
| `~/.sessionbar/server.log` | Relay 诊断日志 |
| `~/.sessionbar/sessions/` | 活跃 Hook 标记 |
| `~/.sessionbar/settings.json` | 用户设置 |
| `~/.sessionbar/provider-usage-history.json` | Provider 用量采样 |

开发或测试时可通过 `SESSIONBAR_HOME` 使用隔离的状态目录。

## Provider 数据

Provider 轮询与 Session 状态相互独立。凭据仅从环境变量或兼容的本地客户端中
读取，不会发送到 TUI、Web UI、Session Payload 或日志。

当前数据源包括 OpenAI/Codex、Anthropic、GitHub Copilot、DeepSeek、MiniMax、
Kimi、xAI 和兼容的 CC Switch 配置。默认每五分钟刷新：

- OpenAI/Codex 的订阅配额和已完成日期的 Token bucket 来自官方账户 API；
  安装 CC Switch 后，在官方当日 bucket 发布前由其补充今天的实时 Token 总量。
- DeepSeek 与 Kimi 的余额来自各自 Provider API；安装 CC Switch 后，可用其
  本地请求历史展示 Token 趋势。

```sh
SESSIONBAR_PROVIDER_POLL=0 sessionbar
SESSIONBAR_PROVIDER_POLL_MS=300000 sessionbar
```

最短轮询间隔为 30 秒。缺失的数据保持 Unknown；SessionBar 不会通过 Session
Token 猜测 Provider 配额或余额。

## 性能配置

TUI 获得焦点时，Session 和 System 数据默认每秒轮询；仅当可见模型变化时才
重新渲染。终端或浏览器页面进入后台后会自动降低刷新频率。

```sh
SESSIONBAR_TUI_POLL_MS=1000 sessionbar monitor
SESSIONBAR_TUI_REFRESH_MS=500 sessionbar monitor
SESSIONBAR_SYSTEM_SAMPLE_MS=2000 sessionbar monitor
```

## 开发

```text
src/
  cli/        命令入口和 Landing Page
  hooks/      Harness 配置和事件规范化
  providers/  配额、订阅和用量 Adapter
  server/     Relay、运行时状态和设置
  sessions/   Session 身份、合并、保留和详情
  shared/     共享类型和项目工具
  system/     主机状态采集
  tui/        OpenTUI Monitor 和 Transport
  web/        浏览器面板
public/       Web 入口和样式
test/         Node.js 测试
```

构建和测试：

```sh
npm run build
npm test
```

提交 Pull Request 前：

1. 将状态保存在 `~/.sessionbar` 或隔离的 `SESSIONBAR_HOME` 中。
2. 为行为变化添加有针对性的测试。
3. 执行 `npm test` 并确保全部通过。
4. 不猜测 Provider 数据，未知字段应保持不可用状态。
5. 始终区分 Project Identity 和 Session Identity。

## 更新日志

### 尚未发布

- 防止已退出的旧进程删除当前 Server 的运行端口与锁文件。

## 贡献者

欢迎提交代码、Bug Report、可复现的性能数据以及 Harness Adapter 改进。提交
贡献即表示同意相关修改可按本项目的 MIT License 发布。

## 相关工作与长期方向

目前已有多个独立项目探索编程 Agent 工作空间的不同部分。这里列出它们，是为了
说明这一领域和 SessionBar 的位置，并不表示 SessionBar 的实现参考了这些项目：

| 项目 | 主要方向 |
| --- | --- |
| [Orca](https://github.com/stablyai/orca) | 在桌面、移动端和远程环境中运行与控制 Agent Fleet。 |
| [abtop](https://github.com/graykode/abtop) | 实时展示 Agent Session、Context、Token、Limit 和进程状态的终端可观测工具。 |
| [Mole](https://github.com/tw93/mole) | 面向本地系统维护与监控的完整命令行交互体验。 |
| [Rezi](https://github.com/RtlZeroMemory/Rezi) 与 [OpenTUI](https://github.com/anomalyco/opentui) | 用于构建有状态终端应用的 TypeScript Framework。 |

SessionBar 的长期方向，是成为一台电脑上所有编程 Agent Session 的本地、低开销
控制界面：不依赖具体 Harness，按 Project 组织，默认保护隐私，并同时提供 TUI
和 Web UI。它应帮助用户发现、观察、比较、定位和恢复 Session，但不接管各个
Agent 实际执行工作的方式。

以上项目彼此独立。列出它们不代表依赖、隶属、背书或代码派生关系。

## 许可证

SessionBar 使用 [MIT License](LICENSE)。第三方依赖仍遵循各自的许可证和
版权声明。
