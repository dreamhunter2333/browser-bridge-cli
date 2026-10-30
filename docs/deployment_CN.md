# 部署与排错

[文档导航](README.md) · [English](deployment.md) · [快速开始](../README_CN.md#快速开始)

## 本机部署与多浏览器

启动 Bridge 并生成配对码：

```bash
browser-bridge-cli server start
browser-bridge-cli server gen-pair
```

打开扩展弹窗并启用扩展，服务器地址设为 `ws://127.0.0.1:52853/ext`，输入配对码并点击 **Pair**。不带远程服务器的 `pair` 也是生成扩展配对码的快捷方式。每个浏览器或远程 CLI 单独使用一个码，每码仅可用一次，5 分钟过期。

```bash
browser-bridge-cli info
browser-bridge-cli clients
browser-bridge-cli switch CLIENT_ID
browser-bridge-cli tabs
browser-bridge-cli whitelist
browser-bridge-cli disable
```

将 `CLIENT_ID` 换成 `clients` 返回的 ID，普通命令发往活跃客户端。标签页／分组 ID 属于该浏览器会话。白名单、扩展配对、空闲时间和失败阈值在弹窗中管理；`whitelist` 只查看设置，`disable` 断开所选扩展，需重新启用后连接。

## 远程部署

CLI、Bridge Server、浏览器扩展可同机，也可分布在两台或三台机器。下文的 `bridge-host` 需替换为 Bridge 机器可访问的主机名／IP。

### 两台机器：浏览器与 Bridge 同机

```text
机器 B：CLI ── HTTP ── 机器 A：Bridge ── 本地 WebSocket ── 机器 A：扩展
```

在**机器 A** 执行：

```bash
browser-bridge-cli server start --host 0.0.0.0 --port 52853
browser-bridge-cli server gen-pair
```

A 上的扩展通过 `ws://127.0.0.1:52853/ext` 配对。在 A 上生成**第二个**配对码，再在**机器 B** 配对 CLI：

```bash
browser-bridge-cli pair --server http://bridge-host:52853 -n remote-cli
browser-bridge-cli info
browser-bridge-cli tabs
```

按提示输入第二个码。配对会保存远程服务器 URL 和 CLI client token，后续命令可省略 `--server`。

### 三台机器：Bridge、浏览器与 CLI 分离

```text
机器 C：CLI ── HTTP ── 机器 A：Bridge ── WebSocket ── 机器 B：扩展
```

A 按前述方式启动 Bridge。**B** 上的扩展使用 `ws://bridge-host:52853/ext`，输入 A 生成的配对码；A 再生成另一个码，**C** 使用同样的 `pair --server` 命令配对 CLI。

Bridge 机器需允许客户端访问 TCP 52853。远程连接使用内网、VPN、SSH 隧道或 HTTPS/WSS 反向代理。Server token 留在 Bridge 机器，配对客户端各自获得可撤销的凭据。观看端权限见[远控认证](tab-sharing_CN.md#认证)。

## 配置与服务器管理

```bash
browser-bridge-cli config get                       # token 脱敏
browser-bridge-cli config set server http://bridge-host:52853
browser-bridge-cli config set name remote-cli
browser-bridge-cli config reset
browser-bridge-cli unpair                           # 撤销／清理远程 CLI 凭据

browser-bridge-cli server status
browser-bridge-cli server stop
browser-bridge-cli server start --host 127.0.0.1 --port 52853
browser-bridge-cli server gen-pair
browser-bridge-cli server install-service           # Linux systemd 用户服务
browser-bridge-cli server install-service --uninstall
```

`config reset` 只清理保存的 CLI 配置，不会撤销 token。`server ...` 只在 Bridge 所在机器执行，不加 `--server`。`server start` 和 `install-service` 也支持 `--token`，用于显式管理服务器凭据。

配置优先级：CLI 参数 → `BROWSER_BRIDGE_URL`／`BROWSER_BRIDGE_TOKEN` → 已保存配置 → 本机服务器状态。单次远程调用可用 `--server` 搭配 **client token**，或使用环境变量。本机浏览器命令可自动启动本地服务器；远程 CLI 不会启动远程服务器。

<details>
<summary>状态文件与凭据分工</summary>

状态保存在 `~/.browser-bridge/`：

| 文件 | 用途 |
| --- | --- |
| `state.json`、`token` | 本地服务器地址及管理 token。 |
| `tokens.json` | 服务器管理的配对客户端凭据。 |
| `config.json` | CLI 的服务器 URL、client token 与名称。 |
| `server.pid` | 本地服务器进程 ID。 |
| `shares.json` | 持久分享定义与登录设置。 |

Server token 可生成配对码、撤销客户端等；扩展 token 用于 WebSocket 认证；远程 CLI token 可执行浏览器命令，不能生成配对码或管理服务器。撤销 token 会断开对应 WebSocket 客户端。

配对有速率限制：HTTP 每 IP 每分钟 5 次，WebSocket 每连接最多 5 次失败。状态文件包含凭据，不应公开。

</details>

## 权限与能力边界

| 扩展权限 | 用途 |
| --- | --- |
| `tabs` | 标签页信息与操作。 |
| `tabGroups` | 原生分组查询、修改和成员管理。 |
| `debugger` | 页面输入、脚本、截图、网络、Cookie 和原生 CDP。 |
| `storage` | 配对与弹窗设置。 |
| `alarms` | MV3 保活、重连和空闲检查。 |
| `offscreen` | 实时远控的浏览器原生编码。 |

白名单检查指定的标签页／页面操作及分组修改涉及的所有标签；标签页／分组元信息列表、网络及 Cookie 读取不在此检查范围。URL 加入白名单也不能解除浏览器原生限制。数据处理见[隐私政策](../PRIVACY.md)。

## 常见问题

| 现象 | 检查／处理 |
| --- | --- |
| 没有连接浏览器 | 执行 `info`，检查扩展开关、WebSocket 地址，并用新码配对。 |
| 操作了错误浏览器／标签 | 执行 `clients`、`switch`、`tabs`，显式指定 `-t`；浏览器重启后重新获取 ID。 |
| 缺少分组功能 | 使用版本匹配的 CLI／扩展，重新加载本地扩展并确认 `tabGroups` 权限。 |
| `Blocked by whitelist` | 在弹窗中修改规则；启用但为空的白名单会拦截所有站点，分组操作检查全部受影响成员。 |
| `The extensions gallery cannot be scripted` | Chrome 禁止调试器连接受保护的扩展商店页面，部分 Web Store 后台 URL 也受影响。可列出标题／URL，但不能通过 Bridge 操作正文，需手动完成。 |
| 其他页面无法连接调试器 | 检查受保护的内部页面及其他调试器／DevTools 占用，解决冲突后在普通网页重试。 |
| 选择器匹配多个元素／被遮挡 | 使用主文档中唯一可见的 CSS 匹配；`query --visible` 本身不检查遮挡。 |
| 扩展自动关闭 | 检查弹窗中的空闲时间与连续失败设置，然后重新启用。 |
| 远程无法连接 | 检查监听地址、防火墙、HTTP 与 WebSocket 地址和 CLI 保存的配置；配对码必须在 Bridge 机器生成。 |
| 远控黑屏／文字过小 | 使用支持 WebCodecs 的 localhost／HTTPS 页面，检查源标签及[观看限制](tab-sharing_CN.md#观看与采集)；窄观看窗口会按源页面宽度缩放。 |
