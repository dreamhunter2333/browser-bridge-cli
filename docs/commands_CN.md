# 命令参考

[文档导航](README.md) · [English](commands.md) · [部署与排错](deployment_CN.md)

示例统一使用 `browser-bridge-cli`，也可替换为 `npx browser-bridge-cli` 或 `bunx browser-bridge-cli`。示例 ID 需要替换为所选浏览器的真实 ID。

## 命令地图

| 任务 | 命令 |
| --- | --- |
| 状态与浏览器选择 | `info`、`clients`、`switch <clientId>` |
| 标签页 | `tabs`、`tab <id>`、`new-tab [url]`、`activate <id>`、`close-tab <id>`、`navigate <url>`、`reload` |
| 分组 | `groups [list]`、`groups get`、`create`、`update`、`delete`、`move`、`add-tabs`、`remove-tabs` |
| 输入 | `click`、`hover`、`move`、`scroll`、`type`、`press` |
| DOM 与脚本 | `query <selector>`、`eval <expression>`、`eval-file <file>` |
| 导出与检查 | `screenshot`、`pdf`、`network`、`cookies` |
| 原生协议 | `cdp <method> [params]`、`cdp-events`、`detach` |
| [实时远控](tab-sharing_CN.md) | `share start`、`share links`、`share status <url>`、`share stop <url>` |
| [配对与控制](deployment_CN.md) | `pair`、`unpair`、`disable`、`whitelist` |
| [服务器](deployment_CN.md) | `server start`、`stop`、`status`、`gen-pair`、`install-service` |
| [配置](deployment_CN.md) | `config get`、`set <key> <value>`、`reset` |

完整语法用 `<command> --help` 查看。全局选项为 `-s, --server <url>` 和 `--token <token>`，用于浏览器命令；`server ...` 操作的是本机服务器。

页面命令通常支持 `-t, --tab <id>`，省略时使用活跃标签。`eval`、`eval-file`、`query`、输入与原生 `cdp` 支持 `-k, --keep-attached`。连续原生操作期间保留连接，释放按键后再执行 `detach -t <id>`。普通调试连接空闲 5 分钟自动分离；实时远控通过独立的采集 lease 保留连接。

## 标签页与分组

```bash
browser-bridge-cli tabs
browser-bridge-cli tabs --json --group -1 --window 1
browser-bridge-cli tab 101
browser-bridge-cli new-tab https://example.com
browser-bridge-cli activate 101
browser-bridge-cli navigate https://example.com -t 101
browser-bridge-cli reload --no-cache -t 101
browser-bridge-cli close-tab 101

browser-bridge-cli groups                          # 等同于 groups list
browser-bridge-cli groups list --window 1 --title 'Work*' --color blue --expanded
browser-bridge-cli groups get 12
browser-bridge-cli groups create 101 102 --title Work --color blue
browser-bridge-cli groups update 12 --title Research --color purple --collapsed
browser-bridge-cli groups update 12 --expanded
browser-bridge-cli groups add-tabs 12 103 104
browser-bridge-cli groups remove-tabs 103
browser-bridge-cli groups move 12 --index 0
browser-bridge-cli groups move 12 --window 2 --index -1
browser-bridge-cli groups delete 12
```

- `tabs --json` 返回包括 `groupId` 的元信息，`-1` 表示未分组；`--group`、`--window` 筛选标签页，原有纯文本格式保留。
- 分组查询、创建、更新、移动返回属性及按标签栏顺序排列的 `tabIds`，可按窗口、标题模式、颜色和折叠／展开状态筛选。
- 颜色支持 `grey`、`blue`、`red`、`yellow`、`green`、`pink`、`purple`、`cyan`、`orange`。
- 分组必须包含已有标签页。`delete` 解散分组并保留标签页，最后一个标签移出时空组自动消失；`update --title ''` 清空组名。
- `add-tabs` 可从其他组／窗口移入标签。`move` 将整组移动到普通窗口内或其他普通窗口，`--index -1` 表示末尾。
- ID 属于所选浏览器会话。每条分组命令固定同一浏览器执行全部请求；修改前检查所有受影响标签页的白名单。
- 需要含 `tabGroups` 权限的扩展，本地加载的扩展更新后需重新加载。

## 鼠标、滚轮与键盘

```bash
browser-bridge-cli click '#submit' -t 123
browser-bridge-cli click --x 100 --y 200 --button right -t 123
browser-bridge-cli click '#item' --count 2 -t 123
browser-bridge-cli hover '#menu' -t 123
browser-bridge-cli move 100 200 -t 123
browser-bridge-cli scroll down 500 -t 123
browser-bridge-cli scroll up 300 --selector '.results' -t 123
browser-bridge-cli scroll 0 --delta-x 200 --x 100 --y 200 -t 123
browser-bridge-cli type 'hello 世界' -t 123
browser-bridge-cli press Enter --key-code 13 -t 123
browser-bridge-cli press a --code KeyA --key-code 65 --modifiers 2 -t 123
browser-bridge-cli press a --code KeyA --key-code 65 --modifiers 4 --commands selectAll -t 123
```

选择器限定主文档 CSS，必须匹配唯一可见元素。`click`／`hover` 自动滚动并拒绝被遮挡目标。坐标和滚轮增量使用视口 CSS 像素，正数向下／向右；未指定方向或增量时 `scroll` 默认向下 500，显式零保持为零。滚轮默认作用于视口中心，可用 `--selector` 或同时指定 `--x/--y` 定位嵌套容器。

`type` 向已聚焦输入框插入文本，不触发键盘事件。`press` 透传调用方提供的 key、`--code`、`--key-code`、可选 `--text`、逗号分隔的原生 `--commands` 和 `--modifiers`（Alt=1、Control=2、Meta=4、Shift=8，相加组合）。键位映射、组合和平台行为由调用方处理。

默认 `--phase press` 发送按下／释放。手动序列可用 `--phase down -k` 和 `--phase up`，保持同一显式标签页及所选浏览器，中间事件保留连接，释放全部按键后再分离。每条输入命令固定浏览器及标签，浏览器断开则失败，未加 `-k` 时自动分离。`{ "ok": true }` 只确认发送成功，需另行验证页面结果。

自动鼠标输入显示小尺寸蓝色尖标，带白色轮廓，顶点对应输入位置，按下时颜色加深；不拦截点击，并出现在页面截图和远控画面中；最后一次鼠标输入后 3 秒自动隐藏，继续输入会重新计时或再次显示；页面导航会立即移除。可显示在模态弹窗上方，兼容 Trusted Types 页面。

## DOM 与 JavaScript

```bash
browser-bridge-cli query 'button,a,input' --visible -l 20 -t 123
browser-bridge-cli query 'button,a,input' --in-viewport -l 20 -t 123
browser-bridge-cli eval 'document.title' -t 123
browser-bridge-cli eval-file script.js -t 123
```

`--visible` 检查布局可见性，保留屏幕外元素；`--in-viewport` 额外要求与视口相交。两者均不检查遮挡，先过滤再应用 `--limit`。脚本文件从 CLI 所在机器读取，再在目标页面执行。浏览器受保护页面仍受原生限制，见[排错说明](deployment_CN.md#常见问题)。

## 截图、PDF、网络与 Cookie

```bash
browser-bridge-cli screenshot -t 123 -o viewport.png
browser-bridge-cli screenshot --full -t 123 -o full.png
browser-bridge-cli screenshot --x 0 --y 0 --width 800 --height 600 -t 123 -o clip.png
browser-bridge-cli screenshot --long --max-height 12000 --hide-sticky -t 123 -o long.png
browser-bridge-cli pdf -t 123 -o page.pdf
browser-bridge-cli network -l 20 -t 123
browser-bridge-cli network --clear -t 123
browser-bridge-cli cookies --url https://example.com --domain example.com --name session -t 123
```

长截图以当前视口宽度分片拼接，默认最大高度 30000；超长／无限滚动页面用 `--max-height` 限制。第一片后隐藏 fixed 元素，sticky 元素默认保留，可通过 `--hide-sticky` 隐藏。

网络检查使用每个标签页的 CDP 缓存，无需扩展级 `webRequest` 权限；调试器连接后开始记录，不会补取之前的请求。`network --clear` 不带 `-t` 时清空所有标签的缓存。Cookie 通过目标标签页 CDP 的 URL 上下文读取，再按条件筛选。

## 原生 CDP、文件与事件

```bash
browser-bridge-cli cdp DOM.getDocument '{}' -t 123 -k
browser-bridge-cli cdp DOM.querySelector '{"nodeId":1,"selector":"input[type=file]"}' -t 123 -k
browser-bridge-cli cdp DOM.setFileInputFiles '{"nodeId":42,"files":["/absolute/path/file.pdf"]}' -t 123 -k
browser-bridge-cli detach -t 123
```

使用前序命令实际返回的 node ID，示例的 `1`／`42` 只是占位。路径属于**浏览器所在机器**，不会自动传输远程 CLI 的本地文件。原生 `Input.dispatchDragEvent` 支持文件拖放及 HTML5 拖动数据，发送后仍需确认网站是否接收。

<details>
<summary>事件轮询、动态上传控件与 iframe 子会话</summary>

```bash
browser-bridge-cli cdp-events -t 123
browser-bridge-cli cdp Page.enable '{}' -t 123 -k
browser-bridge-cli cdp Page.setInterceptFileChooserDialog '{"enabled":true}' -t 123 -k
# 触发上传控件，再使用返回的 stream/cursor 读取事件。
browser-bridge-cli cdp-events -t 123 --stream STREAM --since 0 --method Page.fileChooserOpened
# 使用事件中的 backendNodeId 调用 DOM.setFileInputFiles。
browser-bridge-cli cdp Page.setInterceptFileChooserDialog '{"enabled":false}' -t 123 -k
browser-bridge-cli cdp-events --stop -t 123
browser-bridge-cli detach -t 123
```

先启动事件采集，再触发操作。读取是非破坏性的缓存轮询，不是阻塞等待或 WebSocket 订阅。保存返回的 stream ID／cursor，`--stream` 会拒绝过期流。缓存上限为每标签 500 条／2 MiB；`dropped:true` 时先检查当前状态，`attached:false` 时需显式建立新会话。

原生 `cdp --session <id>` 可操作 iframe 子会话（Chrome 125+），`cdp-events --session <id>` 过滤子会话事件。通过原生 `Target.setAutoAttach`／`Target.attachedToTarget` 发现 session ID；同进程 frame 使用 execution context。设置子会话文件时透传实际事件的 session ID，导航或分离后重新获取 ID。

连续原生操作始终保持同一标签页／浏览器并使用 `-k`，完成后停止事件采集并分离连接。协议支持范围以 `chrome.debugger` 开放的 CDP domain 为准。

</details>
