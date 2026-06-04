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

- **Bun** or **Node.js** installed
- **Browser extension** loaded from `${SKILL_BASE_DIR}/extension/` directory
- **Bridge server** running and extension paired

## Setup (one-time)

```bash
# Install dependencies
cd "${SKILL_BASE_DIR}" && bun install   # or: npm install

# Start bridge server
bun "${SKILL_BASE_DIR}/bridge/src/server.ts"          # or: npx tsx "${SKILL_BASE_DIR}/bridge/src/server.ts"

# Generate pairing code
bun "${SKILL_BASE_DIR}/cli/src/index.ts" pair          # or: npx tsx "${SKILL_BASE_DIR}/cli/src/index.ts" pair

# User enters 6-digit code in extension popup
```

## Usage

All commands use this pattern:

```bash
# Bun
bun "${SKILL_BASE_DIR}/cli/src/index.ts" <command> [args]

# Node.js (no bun)
npx tsx "${SKILL_BASE_DIR}/cli/src/index.ts" <command> [args]
```

Prefer bun if available, fall back to npx tsx.

### Common Commands

```bash
# Server status
bun "${SKILL_BASE_DIR}/cli/src/index.ts" info

# List tabs
bun "${SKILL_BASE_DIR}/cli/src/index.ts" tabs

# Execute JS in a tab
bun "${SKILL_BASE_DIR}/cli/src/index.ts" eval "document.title" -t <tab-id>

# Query DOM
bun "${SKILL_BASE_DIR}/cli/src/index.ts" query "h1" -t <tab-id>

# Execute JS file
bun "${SKILL_BASE_DIR}/cli/src/index.ts" eval-file script.js -t <tab-id>

# Create new tab
bun "${SKILL_BASE_DIR}/cli/src/index.ts" new-tab "https://example.com"

# Navigate
bun "${SKILL_BASE_DIR}/cli/src/index.ts" navigate "https://example.com" -t <tab-id>

# Screenshot
bun "${SKILL_BASE_DIR}/cli/src/index.ts" screenshot -o page.png -t <tab-id>

# Full page screenshot
bun "${SKILL_BASE_DIR}/cli/src/index.ts" screenshot -f -o full.png -t <tab-id>

# PDF export
bun "${SKILL_BASE_DIR}/cli/src/index.ts" pdf -o page.pdf -t <tab-id>

# Network log
bun "${SKILL_BASE_DIR}/cli/src/index.ts" network -l 10

# Cookies
bun "${SKILL_BASE_DIR}/cli/src/index.ts" cookies -d example.com

# Raw CDP command (any Chrome DevTools Protocol method)
bun "${SKILL_BASE_DIR}/cli/src/index.ts" cdp "Input.dispatchMouseEvent" '{"type":"mousePressed","x":100,"y":200,"button":"left","clickCount":1}' -t <tab-id>

# Close tab
bun "${SKILL_BASE_DIR}/cli/src/index.ts" close-tab <tab-id>

# Manage clients
bun "${SKILL_BASE_DIR}/cli/src/index.ts" clients
bun "${SKILL_BASE_DIR}/cli/src/index.ts" switch <clientId>

# Generate new pairing code
bun "${SKILL_BASE_DIR}/cli/src/index.ts" pair

# Disable extension
bun "${SKILL_BASE_DIR}/cli/src/index.ts" disable
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

## Security

- Bridge binds to `127.0.0.1` by default
- CLI authenticates via server token (`~/.browser-bridge/token`)
- Each extension has independent client token (generated on pairing)
- Pairing codes are one-time-use, expire in 5 minutes
- Whitelist restricts per-tab operations by URL pattern
