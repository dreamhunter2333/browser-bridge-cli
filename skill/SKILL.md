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
- **Browser extension** loaded from `${SKILL_BASE_DIR}/extension/` directory
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

# PDF export
npx browser-bridge-cli pdf -o page.pdf -t <tab-id>

# Network log
npx browser-bridge-cli network -l 10

# Cookies
npx browser-bridge-cli cookies -d example.com

# Raw CDP command
npx browser-bridge-cli cdp "Input.dispatchMouseEvent" '{"type":"mousePressed","x":100,"y":200,"button":"left","clickCount":1}' -t <tab-id>

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
6. The `cdp` command gives access to ALL Chrome DevTools Protocol methods
