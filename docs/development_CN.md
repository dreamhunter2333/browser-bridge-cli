# 开发与发布

[文档导航](README.md) · [English](development.md) · [开发约定](../CLAUDE.md)

本篇面向开发者与维护者，包含实现和发布细节。安装及日常操作从 [README](../README_CN.md) 开始。

## 架构

```text
CLI（TypeScript）
  └─ HTTP /api + X-Browser-Bridge token
       └─ Bridge Server (:52853)
            ├─ WebSocket /ext → MV3 扩展 → chrome.debugger / tabs / tabGroups
            └─ /share/<hash>/ → 观看页 + 输入／视频 WebSocket
```

Bridge 将请求路由到所选扩展客户端，隔离请求 ID，并在 30 秒后终止未完成请求。页面操作使用 `chrome.debugger`，仍受浏览器保护页面限制；分组操作使用原生 `chrome.tabGroups`／`chrome.tabs`，修改前预检所有受影响标签的白名单。

输入和分组命令在多次请求中固定浏览器，CDP 输入序列也固定目标标签。多数命令完成后分离调试器，`-k` 保留连接并设置 5 分钟空闲超时。实时采集通过 lease 延迟实际分离。

DOM 操作光标不拦截输入，通过 closed shadow root 和 manual popover 显示在模态弹窗上方，避免 HTML 注入以兼容 Trusted Types。长截图拼接 PNG 像素行；实时远控在 offscreen document 中编码 VP8，服务器直接转发二进制数据，不转码，详见[串流实现](tab-sharing_CN.md#webcodecs-串流)。

## 代码导航

| 位置 | 职责 |
| --- | --- |
| `src/cli.ts` | 命令、校验、输入序列与输出。 |
| `src/groups.ts` | 分组命令注册、浏览器固定及元信息补充。 |
| `src/client.ts` | 配置、本地自动启动、带认证的 HTTP 请求。 |
| `src/server.ts` | HTTP API、配对、客户端路由和 WebSocket broker。 |
| `src/share.ts`、`src/share-view.ts` | 分享生命周期、认证、传输及观看页。 |
| `extension/background.js` | 浏览器 API、CDP、白名单、光标、调试器／采集 lease。 |
| `extension/popup.html`、`extension/popup.js` | 配对、开关、白名单及设置。 |
| `extension/video.html`、`extension/video.js` | Offscreen 视频编码。 |
| `tests/` | CLI／服务器／扩展集成及行为回归。 |
| `skills/` | 可独立安装的 Agent 工作流。 |
| `.github/workflows/` | 跨平台测试与标签发布。 |

## 构建与测试

安装依赖并构建：

```bash
bun install
bun run build
```

### 测试前置条件

测试需要与项目 Playwright 版本匹配的 Chromium 运行时（`channel: 'chromium'`），使用临时浏览器 profile，不会连接已安装的 Chrome、Edge 或 EGO 会话。可复用已有的匹配 Playwright 缓存，单独执行 `bun install` 不会准备浏览器可执行文件。

<details>
<summary>准备全新的临时环境或 CI runner</summary>

在该环境中将测试运行时下载到 Playwright 缓存：

```bash
bun x playwright install chromium
```

Linux CI runner 如还需要系统依赖：

```bash
bun x playwright install --with-deps chromium
```

以上是独立的环境准备步骤，准备后再运行测试。未经授权不要安装用户的系统浏览器。

</details>

运行时就绪后执行：

```bash
bun run test
```

测试通过 `tests/helpers.ts` 中的 HOME／USERPROFILE 隔离 CLI／服务器状态，不要使用真实的 `~/.browser-bridge/`。

### 本地开发

服务器模式二选一。CLI 开发会按需自动启动后台 Bridge：

```bash
bun run dev -- info
```

开发前台服务器时，先停止后台 Bridge，再保持该终端运行：

```bash
bun run dev -- server stop
bun run dev:server
```

在另一个终端执行 `bun run dev -- <command>`。不要在相同端口同时运行前台和后台服务器；前述构建与测试无需启动开发服务器。

CI 对 PR 和推送到 `main`／`feat/**` 的提交在 Ubuntu、Windows 构建并测试。Linux 使用 Xvfb，失败上传 `test-results`，保留 7 天。覆盖分组增删改查／移动／白名单／错误输入、输入路由与清理、光标截图／模态弹窗／Trusted Types、调试器空闲、远控及视频尺寸／关键帧回归。测试套件通过不代表某个本机 Chrome／Edge／EGO 版本已实测，本机结果应单独说明。

## 发布流水线

`v*` 标签触发 `.github/workflows/publish.yml`：

1. 配置 Bun、Node.js 24 及支持 Trusted Publishing 的 npm。
2. 安装依赖并打包 CLI／服务器。
3. 将 `extension/` 内容压缩为 `browser-bridge-extension-v<version>.zip`。
4. 使用 GitHub OIDC 发布 npm 包。
5. 创建 GitHub Release 并附加扩展 ZIP。

发布工作流本身不执行完整测试，打标签前需确认对应测试工作流。npm 和 GitHub Release 已自动化；Chrome 应用商店提交是独立的手动步骤。

<details>
<summary>npm Trusted Publisher 一次性配置</summary>

在 npm 包的 Trusted Publisher 设置中选择 GitHub Actions：

| 字段 | 值 |
| --- | --- |
| Organization/user | `dreamhunter2333` |
| Repository | `browser-bridge-cli` |
| Workflow filename | `publish.yml` |
| Environment | 留空；只有工作流实际配置 environment 后才填写。 |

允许 npm publish。工作流需要 `id-token: write`，创建 GitHub Release 需要 `contents: write`，不需要长期 npm token；仓库／工作流身份必须与 npm 配置一致。

</details>

### 发布检查

将 `X.Y.Z` 换成新版本号，不复用或移动已发布标签。

1. 同步 `package.json` 和 `extension/manifest.json` 版本，更新受影响文档／技能／隐私权限说明。
2. 行为变化运行 `bun run build`、`bun run test`，提交所需变更并推送 `main`。
3. 确认该提交的 Ubuntu／Windows 测试成功。
4. 在此提交打标签并推送：

   ```bash
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

5. 确认 Publish 成功、`npm view browser-bridge-cli version` 返回新版本，并检查 GitHub Release 的扩展 ZIP。
6. 按下面步骤上传商店。GitHub／npm 发布成功不等于商店版本已上线。

### Chrome 应用商店上传

1. 下载 **GitHub Release 附件中的扩展 ZIP**，不使用源码压缩包、本地重新打包目录或 CRX。
2. 检查 ZIP 内 `manifest.json` 的版本与发布一致，并核对权限变化。
3. 用正确发布者账号登录 Developer Dashboard，打开已有 Browser Bridge 项目，在软件包管理中上传新 ZIP。
4. 补全后台要求的权限／隐私声明：`tabGroups` 用于原生分组管理，`offscreen` 用于本地视频编码；与 [PRIVACY.md](../PRIVACY.md) 保持一致。
5. 提交审核并确认后台状态。已提交、审核通过和商店公开可用是不同状态。

Chrome 可能拒绝扩展调试器控制商店／后台，报错 `The extensions gallery cannot be scripted`。此时通过正常浏览器 UI 手动上传，不降低浏览器安全保护来绕过限制。

## 文档维护

README 聚焦安装、功能与使用流程。命令语义放在 `commands*`，远程部署／配置／排错放在 `deployment*`，观看行为放在 `tab-sharing*`，实现与发布放在本篇。新增入口加入[文档导航](README.md)，同步中英文版本，安装式技能保持自包含。
