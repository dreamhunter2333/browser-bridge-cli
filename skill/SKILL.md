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
# Install globally
npm i -g browser-bridge-cli

# Or use npx (no install)
npx browser-bridge-cli server start

# Start server + generate pairing code
browser-bridge server start
browser-bridge pair

# User enters 6-digit code in extension popup
```

## Usage

```bash
# Server management
browser-bridge server start [--host 0.0.0.0] [--port 9000] [--token xxx]
browser-bridge server stop
browser-bridge server status
browser-bridge server gen-pair

# Server status
browser-bridge info

# List tabs
browser-bridge tabs

# Execute JS in a tab
browser-bridge eval "document.title" -t <tab-id>

# Query DOM
browser-bridge query "h1" -t <tab-id>

# Execute JS file
browser-bridge eval-file script.js -t <tab-id>

# Create new tab
browser-bridge new-tab "https://example.com"

# Navigate
browser-bridge navigate "https://example.com" -t <tab-id>

# Screenshot
browser-bridge screenshot -o page.png -t <tab-id>
browser-bridge screenshot -f -o full.png -t <tab-id>

# PDF export
browser-bridge pdf -o page.pdf -t <tab-id>

# Network log
browser-bridge network -l 10

# Cookies
browser-bridge cookies -d example.com

# Raw CDP command
browser-bridge cdp "Input.dispatchMouseEvent" '{"type":"mousePressed","x":100,"y":200,"button":"left","clickCount":1}' -t <tab-id>

# Close tab
browser-bridge close-tab <tab-id>

# Manage clients
browser-bridge clients
browser-bridge switch <clientId>

# Pairing
browser-bridge pair
browser-bridge unpair

# Configuration
browser-bridge config get
browser-bridge config set server http://remote:52853
browser-bridge config reset

# Daemon (Linux)
browser-bridge server install-service --host 0.0.0.0 --token xxx
browser-bridge server install-service --uninstall
```

### CDP Examples

| Task | Command |
|------|---------|
| Click | `cdp "Input.dispatchMouseEvent" '{"type":"mousePressed","x":100,"y":200,"button":"left","clickCount":1}'` |
| Type | `cdp "Input.insertText" '{"text":"hello"}'` |
| Key | `cdp "Input.dispatchKeyEvent" '{"type":"keyDown","key":"Enter"}'` |
| DOM | `cdp "DOM.getDocument"` |
| Mobile | `cdp "Emulation.setDeviceMetricsOverride" '{"width":375,"height":812,"deviceScaleFactor":3,"mobile":true}'` |

## Workflow

1. Always run `info` first to check server and extension status
2. Use `tabs` to find the target tab ID
3. Pass `-t <tab-id>` to target a specific tab (omit for active tab)
4. Use `-k` flag on eval/query/cdp to keep debugger attached for consecutive operations
5. Run `detach` when done with CDP operations to remove the debugger warning bar
6. The `cdp` command gives access to ALL Chrome DevTools Protocol methods
