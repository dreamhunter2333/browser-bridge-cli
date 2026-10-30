# Browser Bridge CLI

[English](README.md) | [中文](README_CN.md) · [文档导航](docs/README.md) · [版本发布](https://github.com/dreamhunter2333/browser-bridge-cli/releases)

从终端或 AI Agent 控制你已经打开的 Chrome / Edge，通过配对扩展复用已有标签页和登录状态，支持本机与跨机器使用。

## 功能总览

| 类别 | 支持能力 |
| --- | --- |
| 标签页与分组 | 列出、查看、新建、激活、导航、刷新、关闭标签页，按窗口／分组筛选；分组增删改查、改名改色、折叠展开、跨窗口移动、标签移入移出。 |
| 鼠标与键盘 | 点击、双击、右键、悬停、移动、滚轮、文本输入、key code 与修饰键；操作光标在页面、截图和远控中可见。 |
| DOM 与 JavaScript | CSS 选择器查询、可见元素／视口过滤、执行表达式或本地脚本文件。 |
| 截图与导出 | 视口、整页、区域及拼接长截图，高度上限与固定／粘性页头处理，PDF 导出。 |
| 网络与 Cookie | 读取／清空每个标签页的网络日志，按 URL、域名、名称筛选 Cookie。 |
| 实时远控 | 固定标签、跟随活跃标签、可切换标签三种链接；点击、拖动、滚轮、文本及中文输入法；持久观看链接。 |
| 高级操作 | 文件上传、拖放、读取浏览器事件，以及发送原生浏览器命令。 |
| 多浏览器 | 配对多个 Chrome / Edge 实例，查看客户端并切换控制目标。 |
| 部署与控制 | CLI／服务器／浏览器本机或分离部署，一次性配对码、可撤销凭据、站点白名单、空闲停用、Linux systemd 服务。 |

## 快速开始

需要 Node.js 20+ 或 Bun 1.0+，以及 Chrome / Edge。常规 CLI 支持 macOS、Windows、Linux。

**1. 安装 CLI 和扩展。**

```bash
npm install -g browser-bridge-cli
```

从 [Chrome 应用商店](https://chromewebstore.google.com/detail/browser-bridge/cmakbjpcmibhleibmgaiflpoencnelol)安装 Browser Bridge，或加载 [GitHub Releases](https://github.com/dreamhunter2333/browser-bridge-cli/releases) 中的 ZIP。商店审核可能晚于版本发布，体验最新功能请使用对应版本的 Release 扩展。

<details>
<summary>手动加载扩展／不全局安装 CLI</summary>

下载并解压 `browser-bridge-extension-v<version>.zip`，打开 `chrome://extensions` 或 `edge://extensions`，启用**开发者模式**，点击**加载已解压的扩展程序**并选择解压目录。从源码安装时选择 `extension/`。更新后重新加载；标签分组需要 `tabGroups` 权限。

示例中的 `browser-bridge-cli` 也可替换为 `npx browser-bridge-cli` 或 `bunx browser-bridge-cli`。

</details>

**2. 启动本地 Bridge 并配对。**

```bash
browser-bridge-cli server start
browser-bridge-cli server gen-pair
```

打开扩展弹窗，启用扩展，保留 `ws://127.0.0.1:52853/ext`，输入 6 位配对码并点击 **Pair**。每个码仅能使用一次，5 分钟过期。

**3. 找到标签页并操作。**

```bash
browser-bridge-cli info
browser-bridge-cli tabs
browser-bridge-cli query 'button,a,input' --in-viewport -t 123
browser-bridge-cli screenshot -t 123 -o page.png
```

将 `123` 换成 `tabs` 返回的标签页 ID。本机命令自动读取 `~/.browser-bridge/`。完整参数可用 `browser-bridge-cli --help` 或 `<command> --help` 查看。

## 文档入口

| 文档 | 内容 |
| --- | --- |
| [命令参考](docs/commands_CN.md) | 完整命令地图、标签页／分组、输入、DOM、截图、网络、CDP 文件及事件。 |
| [实时远控](docs/tab-sharing_CN.md) | 三种观看模式、远程输入、认证、采集生命周期与串流限制。 |
| [部署与排错](docs/deployment_CN.md) | 配对、多浏览器、配置、两台／三台机器部署、权限与常见错误。 |
| [隐私政策](PRIVACY.md) | 数据流向、本地存储、权限与用户控制。 |

<details>
<summary>示例：标签分组、键鼠操作、实时远控</summary>

```bash
browser-bridge-cli tabs --json --group -1
browser-bridge-cli groups create 101 102 --title Work --color blue
browser-bridge-cli groups add-tabs 12 103
browser-bridge-cli groups update 12 --collapsed
browser-bridge-cli groups move 12 --window 2 --index -1
browser-bridge-cli groups delete 12                 # 保留组内标签页

browser-bridge-cli click '#search' -t 123
browser-bridge-cli type 'hello' -t 123
browser-bridge-cli press Enter --key-code 13 -t 123
browser-bridge-cli scroll down 500 -t 123
browser-bridge-cli screenshot --long --max-height 12000 -t 123 -o long.png

browser-bridge-cli share start                     # 返回三种观看链接
browser-bridge-cli share links --tab 123
```

</details>

<details>
<summary>AI Agent 技能</summary>

可安装[浏览器控制技能](skills/browser-bridge-cli/SKILL.md)、[网站工作流技能生成器](skills/browser-bridge-cli-skill-generator/SKILL.md)，或同时安装：

```bash
npx skills add dreamhunter2333/browser-bridge-cli/skills/browser-bridge-cli --agent claude-code codex
npx skills add dreamhunter2333/browser-bridge-cli/skills/browser-bridge-cli-skill-generator --agent claude-code codex
```

按需只保留一个 agent；加 `-g` 可全局安装。

</details>

<details>
<summary>产品预览</summary>

![Browser Bridge CLI 介绍](docs/browser-bridge-intro.png)

</details>

开发者文档：[开发与发布](docs/development_CN.md)。

MIT 许可证。
