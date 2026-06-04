# CLAUDE.md

## Commands

```bash
# Start bridge server
bun bridge/src/server.ts                    # or: npx tsx bridge/src/server.ts
bun bridge/src/server.ts --host 0.0.0.0 --port 9000  # custom bind

# CLI
bun cli/src/index.ts <command>              # or: npx tsx cli/src/index.ts <command>

# Install deps
bun install
```

## Architecture

Three-process architecture for controlling an already-open browser via CLI:

```
CLI (TypeScript) --HTTP+token--> Bridge Server (:52853) --WebSocket--> Extension (service worker) --chrome.debugger/tabs--> Browser
```

**Bridge Server** (`bridge/src/server.ts`): HTTP API + WebSocket broker. Authenticates CLI via server token (`X-Browser-Bridge` header), authenticates extensions via per-client tokens. Supports multiple extension clients with active client switching. State persisted in `~/.browser-bridge/`.

**Extension** (`extension/background.js`): Chrome/Edge Manifest V3 service worker. Connects to bridge via WebSocket, dispatches actions using Chrome APIs and CDP (`chrome.debugger`). Uses `chrome.alarms` for keepalive (prevents SW termination). Popup UI (`popup.html/js`) manages pairing, whitelist, settings.

**CLI** (`cli/src/index.ts`): Commander-based CLI. Auto-starts bridge server if not running. Detects runtime (bun vs node/tsx).

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

### State Files (`~/.browser-bridge/`)

- `state.json` — serverToken, host, port
- `token` — serverToken (plaintext, for CLI quick read)
- `tokens.json` — per-client tokens keyed by name
