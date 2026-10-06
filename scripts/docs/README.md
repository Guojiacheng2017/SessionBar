# Documentation Screenshots / 文档截图

These tools render the real built Landing, OpenTUI monitor, and Web dashboard
with synthetic data. They never read personal harness files or provider accounts,
install hooks, or start the production relay.

这些工具通过模拟数据运行真实的 Landing、OpenTUI Monitor 和 Web 页面。
它们不读取个人 Harness 文件或 Provider 账户，不安装 Hook，不启动生产 Relay。

Prerequisites / 前置条件: Node.js 22+, Bun, Python 3 (POSIX PTY), and a browser.

```sh
npm run build
# Use the bundled xterm module and stylesheet from a local Playwright trace viewer.
# 使用本地 Playwright Trace Viewer 内附的 xterm 模块和样式文件。
SESSIONBAR_XTERM_MODULE=/path/to/playwright-core/lib/vite/traceViewer/assets/xtermModule-XXXX.js \
SESSIONBAR_XTERM_CSS=/path/to/playwright-core/lib/vite/traceViewer/xtermModule.XXXX.css \
node scripts/docs/previewServer.mjs
```

Use the loopback URL printed by the preview server / 打开预览服务输出的回环地址:

- `/`: real Web Sessions; scroll down for Providers / 真实 Web Sessions，向下滚动进入 Providers。
- `/__preview/terminal?view=landing`: real colored Landing / 真实彩色首页。
- `/__preview/terminal?view=monitor`: real Monitor; select a project with Enter,
  select Activity with `2`, switch Providers with `v` / 真实 Monitor；Enter 打开项目，
  `2` 选择 Activity，`v` 切换 Providers。

Click the terminal before using its keyboard controls. Capture the terminal
element or the Web viewport using Playwright. Store the five PNGs in
`docs/images/`; keep browser traces and intermediate output under
`~/.sessionbar/readme-preview/`. Stop the preview with Ctrl-C after capture.
The preview's dynamically assigned port is not the production relay port.

使用键盘前先点击终端。通过 Playwright 截取终端元素或 Web 视口，将五张 PNG
放在 `docs/images/`；浏览器记录和中间数据保存在 `~/.sessionbar/readme-preview/`。
截图完成后 Ctrl-C 停止预览。预览的动态端口与生产 Relay 端口无关。

## Wordmark / 字标

The README wordmark uses outlined Lobster Two Bold Italic with the landing
screen's rainbow palette. It is transparent and contains no embedded font,
scripts, or external resources. The application's ASCII logo is unchanged.

README 字标使用 Lobster Two Bold Italic 的文字轮廓，沿用首页的彩虹配色。
背景透明，不内嵌字体、脚本或外部资源；应用内 ASCII 标题保持不变。

Font source / 字体来源：[Google Fonts](https://github.com/google/fonts/tree/main/ofl/lobstertwo),
Pablo Impallari and Igino Marini; SIL Open Font License 1.1.

```sh
# Keep fontkit and the font outside the project; they are generation tools only.
# fontkit 和字体保存在项目外，仅用于生成。
node scripts/docs/generateWordmark.mjs /path/to/LobsterTwo-BoldItalic.ttf /path/to/fontkit
```
