---
name: browser-bridge-cli
description: Control Chrome/Edge browser via CLI. Execute JS, query DOM, manage tabs, take screenshots, send CDP commands through a browser extension bridge. Use when user wants to interact with browser pages, automate browser tasks, scrape web content, or control browser tabs.
---

# Browser Bridge CLI

Control an already-open Chrome/Edge browser through a paired extension.

## Architecture

```
CLI --HTTP+token--> Bridge Server (:52853) --WebSocket--> Extension (service worker) --chrome.debugger/tabs--> Browser
```

## Prerequisites

- **Node.js** >= 20 or **Bun** >= 1.0
- **Browser extension** installed from the Chrome Web Store or loaded from this repository's `extension/` directory
- **Bridge server** running and extension paired

## Setup (one-time)

```bash
# 1. Start server
npx browser-bridge-cli server start

# 2. Open extension popup → enable toggle

# 3. Generate pairing code
npx browser-bridge-cli server gen-pair

# 4. Enter the 6-digit code in extension popup → click Pair
```

## Live tab sharing

```bash
browser-bridge-cli share start                 # Start all three viewer modes
browser-bridge-cli share links --tab 123       # Get three links; fixed-tab target is optional
npx browser-bridge-cli share status '<permanent-viewer-url>'
npx browser-bridge-cli share stop '<permanent-viewer-url>'
```

- Sharing runs on the Bridge server's existing port under `/share/<stable-hash>/`. The CLI prints the URL and exits; Bridge manages capture. Saved definitions survive server restarts. No URL token or browser session storage is required.
- `share start` initializes all three modes. `share links [--tab <id>]` returns `links.tab` (fixed tab), `links.active` (follow active tab), and `links.browser` (selectable sidebar/top tabs). The fixed target defaults to the current tab; `--client` selects the browser. Capture starts only after a compatible viewer completes its WebSocket handshake.
- The stable hash uses the paired client name and tab ID or mode. Browser restarts may change tab IDs. Reopen the same link after Bridge/browser reconnection; the Bridge must be running. `share stop` removes the saved share definition.
- Loopback listeners allow viewing without login. Outside loopback, configure `--username` and a password environment variable (default `BROWSER_BRIDGE_SHARE_PASSWORD`, overridden by `--password-env`). Browser HTTP Basic login protects both pages and streams. Do not put credentials into URLs; use HTTPS for public access.
- Viewer clicks, drag, scroll, direct typing, Chinese IME commits and plain-text paste are supported. Remote clipboard reads are not synchronized. Ctrl+A/Cmd+A are forwarded without forcing select-all. Keep the viewer separate from the source tab.
- All sharing uses browser-native WebCodecs VP8 in an extension offscreen document, binary video on both network hops, up to 1080p and a 2 Mbps / ~15 fps target. No system libraries or transport flags; reload the updated extension with `offscreen` permission. Unsupported codecs produce explicit errors. The viewer requires localhost or HTTPS; `share status` reports `transport: "vp8"`. Canvas fits available space without resizing the source tab.
- Loading the viewer HTML or reading status does not attach a debugger. The last viewer disconnect releases capture and its debugger lease immediately; the idle in-memory channel is destroyed within 5 minutes of the last confirmed viewer liveness. The permanent link remains and recreates the channel on opening. A connected but inactive viewer does not time out.
- Existing CLI commands run normally during sharing without extra `--keep-attached`. Ordinary debugger connections detach after five idle minutes; tab operations refresh the timeout and live capture keeps it alive. One capture per source tab; multiple share paths may coexist on one Bridge port.
- `links.browser` filters internal pages, whitelist-blocked pages and the viewer. Retain sessions requested for manual testing and clean temporary test artifacts when finished.

## Usage

```bash
# Server management
npx browser-bridge-cli server start [--host 0.0.0.0] [--port 9000] [--token xxx]
npx browser-bridge-cli server stop
npx browser-bridge-cli server status
npx browser-bridge-cli server gen-pair

# Server status
npx browser-bridge-cli info

# List tabs
npx browser-bridge-cli tabs

# Execute JS in a tab
npx browser-bridge-cli eval "document.title" -t <tab-id>

# Query DOM
npx browser-bridge-cli query "h1" -t <tab-id>

# Execute JS file
npx browser-bridge-cli eval-file script.js -t <tab-id>

# Create new tab
npx browser-bridge-cli new-tab "https://example.com"

# Navigate
npx browser-bridge-cli navigate "https://example.com" -t <tab-id>

# Screenshot
npx browser-bridge-cli screenshot -o page.png -t <tab-id>
npx browser-bridge-cli screenshot -f -o full.png -t <tab-id>
npx browser-bridge-cli screenshot --long --max-height 12000 -o long.png -t <tab-id>
npx browser-bridge-cli screenshot --long --hide-sticky -o long.png -t <tab-id>

# PDF export
npx browser-bridge-cli pdf -o page.pdf -t <tab-id>

# Network log
npx browser-bridge-cli network -l 10

# Cookies
npx browser-bridge-cli cookies -d example.com

# Raw CDP command
npx browser-bridge-cli cdp "Input.dispatchMouseEvent" '{"type":"mousePressed","x":100,"y":200,"button":"left","clickCount":1}' -t <tab-id>

# Capture native events BEFORE the action; retains the debugger connection
npx browser-bridge-cli cdp-events -t <tab-id>
npx browser-bridge-cli cdp-events -t <tab-id> --stream <stream-id> --since <cursor> --method Page.fileChooserOpened

# Send a native command to an observed child session (Chrome 125+)
npx browser-bridge-cli cdp DOM.getDocument '{}' -t <tab-id> -k --session <session-id>

# Stop event capture; release debugger separately with detach
npx browser-bridge-cli cdp-events -t <tab-id> --stop

# Close tab
npx browser-bridge-cli close-tab <tab-id>

# Manage clients
npx browser-bridge-cli clients
npx browser-bridge-cli switch <clientId>

# Pairing
npx browser-bridge-cli pair
npx browser-bridge-cli unpair

# Configuration
npx browser-bridge-cli config get
npx browser-bridge-cli config set server http://remote:52853
npx browser-bridge-cli config reset

# Daemon (Linux)
npx browser-bridge-cli server install-service --host 0.0.0.0 --token xxx
npx browser-bridge-cli server install-service --uninstall
```

### CDP Examples

| Task | Command |
|------|---------|
| Click | `npx browser-bridge-cli cdp "Input.dispatchMouseEvent" '{"type":"mousePressed","x":100,"y":200,"button":"left","clickCount":1}'` |
| Type | `npx browser-bridge-cli cdp "Input.insertText" '{"text":"hello"}'` |
| Key | `npx browser-bridge-cli cdp "Input.dispatchKeyEvent" '{"type":"keyDown","key":"Enter"}'` |
| DOM | `npx browser-bridge-cli cdp "DOM.getDocument"` |
| Mobile | `npx browser-bridge-cli cdp "Emulation.setDeviceMetricsOverride" '{"width":375,"height":812,"deviceScaleFactor":3,"mobile":true}'` |

## Workflow

1. Always run `info` first to check server and extension status
2. Use `tabs` to find the target tab ID
3. Pass `-t <tab-id>` to target a specific tab (omit for active tab)
4. Use `-k` flag on eval/query/cdp to keep debugger attached for consecutive operations
5. Run `detach` when done with CDP operations to remove the debugger warning bar
6. The `cdp` command forwards native methods in the CDP domains supported by `chrome.debugger`; unsupported domains are not emulated

### Files and drag/drop through native CDP

- Use the same explicit `-t` and `-k` for every CDP call in a sequence; keep the selected browser client unchanged. Rediscover node/object/session IDs after detachment or navigation.
- For an existing file input: `DOM.getDocument` → `DOM.querySelector` → `DOM.setFileInputFiles` with the returned `nodeId` and absolute `files` paths on the **browser machine**. Remote CLI-local files are not transferred automatically.
- For dynamic inputs: start `cdp-events`, enable `Page`, enable `Page.setInterceptFileChooserDialog`, then trigger the chooser. Read `Page.fileChooserOpened`; pass its `backendNodeId` to `DOM.setFileInputFiles`. Forward the event's `sessionId` using `--session` when present. Disable interception afterwards.
- For file drops: send `Input.dispatchDragEvent` with `dragEnter`, `dragOver`, then `drop` at observed CSS-pixel coordinates, carrying `data: {items: [], files: [absolutePath], dragOperationsMask: 1}`. Verify the page accepted the files.
- For HTML5 element dragging: enable `Input.setInterceptDrags`, initiate mouse input, read `Input.dragIntercepted`, and forward its native `data` in drag events. Complete mouse release and disable interception. Mouse clicks/keys require both pressed/down and released/up events.
- `cdp-events` is non-blocking buffered polling. Reads are non-destructive; preserve `streamId` and resume after `cursor`. The cursor covers all events, even when filtered. Capture is capped at 500 events/2 MiB per tab; `dropped:true` means inspect state before retrying. `attached:false` means stop and explicitly establish a new session. `--stream` rejects stale captures after restart/stop/reattach.
- Discover OOPIF sessions using `Target.setAutoAttach` with `flatten:true` and `Target.attachedToTarget`. Route commands using its `params.sessionId`; nested frames need recursive auto-attach. Same-process frames use execution contexts instead.
- Finish with `cdp-events --stop -t <tab-id>` and `detach -t <tab-id>`. Setting files or dispatching a drop is not proof that the website completed an upload.
