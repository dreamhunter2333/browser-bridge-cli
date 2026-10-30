# 实时远控

[文档导航](README.md) · [English](tab-sharing.md) · [部署与排错](deployment_CN.md)

通过浏览器观看并操作已配对的源标签页。共享使用 Bridge 已有端口，默认 `127.0.0.1:52853`，观看链接为 `/share/<固定hash>/`。

## 开始使用

```bash
browser-bridge-cli server start
browser-bridge-cli share start
browser-bridge-cli share links --tab 123
browser-bridge-cli share status 'http://127.0.0.1:52853/share/HASH/'
browser-bridge-cli share stop 'http://127.0.0.1:52853/share/HASH/'
```

将 `123`、`HASH` 替换为实际结果。`share start` 初始化三种模式，`share links [--tab <id>]` 返回全部链接：

| 返回字段 | 模式 | 行为 |
| --- | --- | --- |
| `links.tab` | 固定标签 | 保持指定源标签，不跟随其他标签激活。 |
| `links.active` | 跟随活跃标签 | 跟随当前源标签；受限页面暂停，回到可操作页面后继续。 |
| `links.browser` | 可切换标签 | 在观看页侧栏／顶部选择源标签。 |

固定标签默认取当前标签，`--client <id>` 指定浏览器。兼容观看端完成连接后才开始采集，CLI 退出不影响共享。无需另开端口。`share stop` 删除该链接的持久定义并释放采集，不关闭 Bridge 或其他分享。

分享定义保存在 `~/.browser-bridge/shares.json`，Bridge 重启后重新访问原链接可恢复。链接不含凭据，hash 来自已配对浏览器名称及 tab ID／模式；浏览器名和目标 ID 需要保持一致。浏览器重启可能改变标签 ID，固定链接不会悄悄切到其他目标。访问时 Bridge 必须运行。

## 认证

监听回环地址（`127.0.0.1`、`localhost`、`::1`）时默认不要求观看端登录，只接受回环 Host 并拒绝外部浏览器 origin。CLI 和扩展原有 token 认证保持不变。

Bridge 监听非回环地址时，每个分享必须配置用户名和密码，即使观看连接来自本机。先安全地设置 CLI 环境中的 `BROWSER_BRIDGE_SHARE_PASSWORD`，再执行：

```bash
browser-bridge-cli server start --host 0.0.0.0
browser-bridge-cli share start --username viewer
browser-bridge-cli share status 'http://bridge-host:52853/share/HASH/' --username viewer
```

浏览器通过标准 HTTP Basic 登录，WebSocket 使用相同认证。默认密码变量名为 `BROWSER_BRIDGE_SHARE_PASSWORD`，可用 `--password-env` 更改；回环监听也可主动配置登录保护，设置会跨重启保存。凭据不放入 URL；不可信网络使用 HTTPS，反向代理需保留分享路径及 `stream`／`status`／`stop` 子路径并支持 WebSocket。

## 观看与采集

- 可切换模式提供搜索、折叠、调宽的侧栏和顶部标签布局，过滤内部页、白名单拦截页和观看页。手动选择会激活源标签，外部激活不会替换手动选择；关闭所选标签后选择其他可用页面。
- 跟随模式切换标签时释放已按下的键／按钮，并丢弃旧画面的输入；固定模式关闭目标后停止采集。浏览器重连后可重新打开持久链接。
- 支持点击、拖动、滚轮、文本、中文输入法提交、纯文本粘贴。先点击画面中的输入框再输入。Ctrl+A／Cmd+A 原样转发，不强制全选；不读取远程剪贴板，不包含浏览器工具栏或操作系统弹窗，宿主截获的快捷键可能无法到达源页面。
- 画面保持源宽高比，最大 1920 × 1080。观看页适应面板大小，不改变源视口；源窗口很宽而观看面板很窄时，文字会缩小。
- 每个分享只允许一个控制者，每个源标签只有一个采集 lease；同端口可有多个分享路径，但两个分享不能同时采集同一源标签。
- 其他 CLI 命令可正常运行，采集 lease 存在时延迟实际 detach。普通连接空闲 5 分钟分离，操作刷新计时，实时采集保持连接；崩溃采集的 lease 在 45 秒后过期。

<details>
<summary>WebCodecs 串流与采集生命周期</summary>

## WebCodecs 串流

三种模式均使用 VP8，无需传输模式或 JPEG 质量参数，也不需要系统编码库。扩展通过 `video.html` offscreen document 的原生 WebCodecs 编码；需使用含 `offscreen` 权限的扩展。观看页需 localhost 或 HTTPS，编解码不支持时明确报错。

扩展在本地采集 PNG 帧并编码 VP8；扩展内部消息使用本地 base64，网络两段 WebSocket 均使用二进制编码块，Bridge 只转发、不转码。

目标为 2 Mbps、最多约 15 fps，实际吞吐取决于页面变化和编码性能；相同帧跳过，无观看者或发送拥堵时不编码。VP8 为有损编码。重连／切换标签使用关键帧恢复，`share status` 返回 `transport: "vp8"`。

## 空闲与断开

只加载观看 HTML 或读取状态不会连接调试器。观看端完成 WebSocket 握手且存在可共享源标签时才开始采集；暂无可用源标签时保持暂停连接。

最后一个观看端断开后立即释放录屏、编码器和采集 lease。空闲内存通道会在最后确认观看端存活后的 5 分钟内销毁，状态请求不创建或刷新通道。持久定义和链接保留，再次打开会重建通道；连接中的观看者无需持续键鼠输入来保活。

</details>
