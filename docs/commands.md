# Command reference

[Documentation](README.md) · [中文](commands_CN.md) · [Deployment](deployment.md)

Examples use `browser-bridge-cli`; `npx browser-bridge-cli` and `bunx browser-bridge-cli` work too. Replace sample IDs with IDs from your selected browser.

## Command map

| Task | Commands |
| --- | --- |
| Status and browser selection | `info`, `clients`, `switch <clientId>` |
| Tabs | `tabs`, `tab <id>`, `new-tab [url]`, `activate <id>`, `close-tab <id>`, `navigate <url>`, `reload` |
| Groups | `groups [list]`, `groups get`, `create`, `update`, `delete`, `move`, `add-tabs`, `remove-tabs` |
| Input | `click`, `hover`, `move`, `scroll`, `type`, `press` |
| DOM and scripts | `query <selector>`, `eval <expression>`, `eval-file <file>` |
| Export and inspection | `screenshot`, `pdf`, `network`, `cookies` |
| Native protocol | `cdp <method> [params]`, `cdp-events`, `detach` |
| [Live sharing](tab-sharing.md) | `share start`, `share links`, `share status <url>`, `share stop <url>` |
| [Pairing and controls](deployment.md) | `pair`, `unpair`, `disable`, `whitelist` |
| [Server](deployment.md) | `server start`, `stop`, `status`, `gen-pair`, `install-service` |
| [Configuration](deployment.md) | `config get`, `set <key> <value>`, `reset` |

Run `<command> --help` for its complete syntax. Global options are `-s, --server <url>` and `--token <token>`; they apply to browser commands, while `server ...` operates on the local server machine.

Page commands generally accept `-t, --tab <id>` (otherwise the active tab). `eval`, `eval-file`, `query`, input and raw `cdp` accept `-k, --keep-attached`. Retain attachment across a native sequence, release held input, then `detach -t <id>`. Ordinary debugger attachments expire after five idle minutes; live sharing retains its own capture lease.

## Tabs and groups

```bash
browser-bridge-cli tabs
browser-bridge-cli tabs --json --group -1 --window 1
browser-bridge-cli tab 101
browser-bridge-cli new-tab https://example.com
browser-bridge-cli activate 101
browser-bridge-cli navigate https://example.com -t 101
browser-bridge-cli reload --no-cache -t 101
browser-bridge-cli close-tab 101

browser-bridge-cli groups                          # Same as groups list
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

- `tabs --json` exposes metadata including `groupId`; `-1` means ungrouped. `--group` and `--window` filter tabs. Plain-text output is preserved.
- Group list/get/create/update/move return metadata and ordered `tabIds`. Filters include window, title pattern, color and collapsed/expanded state.
- Colors: `grey`, `blue`, `red`, `yellow`, `green`, `pink`, `purple`, `cyan`, `orange`.
- Groups require existing tabs. `delete` dissolves a group and keeps its tabs open; removing its last tab removes the empty group. `update --title ''` clears the title.
- `add-tabs` can move tabs from another group/window. `move` moves the whole group within/between normal windows; `--index -1` means the end.
- IDs belong to the selected browser session. Each group command pins that browser for all requests. Mutations check every affected tab against the whitelist before changing the browser.
- Requires an extension with the `tabGroups` permission; reload an unpacked extension after updating.

## Mouse, wheel and keyboard

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

Selector targets use main-document CSS and must match exactly one visible element. `click`/`hover` scroll into view and reject covered targets. Coordinates and wheel deltas are viewport CSS pixels. Positive deltas scroll down/right; `scroll` defaults to down 500 when no direction/delta is supplied. Explicit zeros remain zero. Wheel origin defaults to the viewport center; target nested containers using `--selector` or paired `--x/--y`.

`type` inserts text into the focused field without keyboard events. `press` forwards caller-supplied key, `--code`, `--key-code`, optional `--text`, comma-separated native `--commands`, and `--modifiers` (Alt=1, Control=2, Meta=4, Shift=8; add values to combine). Key mapping, combinations and platform behavior are the caller's responsibility.

Default `--phase press` sends down/up. For manual sequences use `--phase down -k` and `--phase up`, keep the same explicit tab and selected browser, retain attachment on intermediate events, and release every key before detaching. Each input command pins its browser and tab, fails if that browser disconnects, and detaches unless `-k` is set. `{ "ok": true }` confirms dispatch; verify the page outcome separately.

Automated pointer input shows a compact blue pointer with a white outline in the page, screenshots and live shares. Its tip marks the input position. It does not intercept clicks and darkens while pressed. It hides after three seconds without mouse input; further mouse input resets the timer or shows it again. Navigation removes it immediately. It works over modal dialogs and supports Trusted Types pages. The popup’s **Show operation cursor** switch saves your preference and immediately hides current markers when turned off. Mouse input still works with the marker disabled.

## DOM and JavaScript

```bash
browser-bridge-cli query 'button,a,input' --visible -l 20 -t 123
browser-bridge-cli query 'button,a,input' --in-viewport -l 20 -t 123
browser-bridge-cli eval 'document.title' -t 123
browser-bridge-cli eval-file script.js -t 123
```

`--visible` checks layout visibility, including offscreen elements. `--in-viewport` also requires viewport intersection. Neither tests occlusion; filtering happens before `--limit`. Script files are read from the CLI machine, then evaluated in the target page. Browser-protected pages remain subject to native restrictions; see [troubleshooting](deployment.md#troubleshooting).

## Screenshots, PDF, network and cookies

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

Long screenshots stitch slices at the current viewport width. The default height cap is 30000; use `--max-height` for very tall/infinite pages. Fixed elements are hidden after the first slice, while sticky elements remain unless `--hide-sticky` is set.

Network inspection uses a per-tab CDP cache, not extension-wide `webRequest`. Logging begins with debugger attachment and does not recover earlier traffic. `network --clear` without `-t` clears all tab caches. Cookies are read through the target tab's CDP URL context; filters narrow that result.

## Native CDP, files and events

```bash
browser-bridge-cli cdp DOM.getDocument '{}' -t 123 -k
browser-bridge-cli cdp DOM.querySelector '{"nodeId":1,"selector":"input[type=file]"}' -t 123 -k
browser-bridge-cli cdp DOM.setFileInputFiles '{"nodeId":42,"files":["/absolute/path/file.pdf"]}' -t 123 -k
browser-bridge-cli detach -t 123
```

Use node IDs returned by preceding calls; `1`/`42` above are placeholders. Paths belong to the **browser machine**. Files on a remote CLI machine are not transferred automatically. Native `Input.dispatchDragEvent` supports file drops and HTML5 drag data; verify website acceptance after dispatch.

<details>
<summary>Event polling, dynamic file inputs and child iframe sessions</summary>

```bash
browser-bridge-cli cdp-events -t 123
browser-bridge-cli cdp Page.enable '{}' -t 123 -k
browser-bridge-cli cdp Page.setInterceptFileChooserDialog '{"enabled":true}' -t 123 -k
# Trigger the upload control, then read events using the returned stream/cursor.
browser-bridge-cli cdp-events -t 123 --stream STREAM --since 0 --method Page.fileChooserOpened
# Use the event's backendNodeId with DOM.setFileInputFiles.
browser-bridge-cli cdp Page.setInterceptFileChooserDialog '{"enabled":false}' -t 123 -k
browser-bridge-cli cdp-events --stop -t 123
browser-bridge-cli detach -t 123
```

Start capture before the action. Reads are non-destructive buffered polling, not blocking waits or a WebSocket subscription. Preserve the returned stream ID/cursor; `--stream` rejects stale streams. Capture is capped at 500 events / 2 MiB per tab. `dropped:true` requires checking current state; `attached:false` requires explicitly establishing a new session.

Raw `cdp --session <id>` targets child iframe sessions (Chrome 125+); `cdp-events --session <id>` filters their events. Discover session IDs through native `Target.setAutoAttach` / `Target.attachedToTarget`; same-process frames use execution contexts. Forward an observed event's session ID when setting files in a child session. Rediscover IDs after navigation/detachment.

Keep the same tab/browser and `-k` throughout native sequences. Stop event capture and detach when finished. Native protocol support is limited to the CDP domains exposed by `chrome.debugger`.

</details>
