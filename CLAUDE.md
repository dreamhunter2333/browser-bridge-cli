# CLAUDE.md

## Commands

```bash
# Development
bun run dev -- <command>              # Run CLI in dev mode
bun run dev:server                    # Run server in dev mode
bun run build                        # Build for npm
bun run test                         # Run Playwright e2e tests

# Production (after npm install -g)
browser-bridge server start
browser-bridge <command>
```

## Architecture

Three-process architecture for controlling an already-open browser via CLI:

```
CLI (TypeScript) --HTTP+token--> Bridge Server (:52853) --WebSocket--> Extension (service worker) --chrome.debugger/tabs--> Browser
```

**Bridge Server** (`src/server.ts`): HTTP API + WebSocket broker. Authenticates CLI via server token (`X-Browser-Bridge` header), authenticates extensions via per-client tokens. Supports multiple extension clients with active client switching. State persisted in `~/.browser-bridge/`.

**Extension** (`extension/background.js`): Chrome/Edge Manifest V3 service worker. Connects to bridge via WebSocket, dispatches actions using Chrome APIs and CDP (`chrome.debugger`). Uses `chrome.alarms` for keepalive (prevents SW termination). Popup UI (`popup.html/js`) manages pairing, whitelist, settings.

**CLI** (`src/cli.ts`): Commander-based CLI. Auto-starts bridge server if not running. Server management via `server` subcommand group.

### Auth Flow

1. CLI runs `pair` command -> bridge generates 6-digit code (5-min TTL)
2. User enters code in extension popup -> bridge issues per-client UUID token
3. Extension stores token in `chrome.storage.local`, uses it for reconnection
4. CLI uses server token from `~/.browser-bridge/token` for HTTP auth

### Key Design Decisions

- JS execution uses CDP `Runtime.evaluate` (bypasses page CSP), not `chrome.scripting.executeScript`
- Screenshot uses CDP `Page.captureScreenshot` (no window focus needed)
- Default auto-detach debugger after each command (avoids persistent warning bar)
- Whitelist blocks per-tab-URL actions only; tabs.list/ping/network etc. are unrestricted
- Extension reconnects via `chrome.alarms` not `setTimeout` (survives SW lifecycle)
- `bun build` bundles all dependencies into single JS files for npm distribution

### State Files (`~/.browser-bridge/`)

- `state.json` — serverToken, host, port
- `token` — serverToken (plaintext, for CLI quick read)
- `tokens.json` — per-client tokens keyed by name
- `config.json` — CLI persistent config (server, token, name)
- `server.pid` — running server PID
