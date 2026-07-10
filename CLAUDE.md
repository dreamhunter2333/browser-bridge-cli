# CLAUDE.md

## Project

Browser Bridge CLI controls an already-open Chrome/Edge browser from a CLI through a paired Manifest V3 extension.

Core topology:

```text
CLI (TypeScript) --HTTP + X-Browser-Bridge token--> Bridge Server (:52853)
Bridge Server --WebSocket /ext--> Extension service worker
Extension --chrome.debugger / tabs APIs--> Browser tabs
```

## Commands

```bash
# Development
bun run dev -- <command>             # Run CLI from src/cli.ts
bun run dev:server                   # Run bridge server from src/server.ts
bun run build                        # Bundle src/cli.ts and src/server.ts to dist/
bun run test                         # Run Playwright e2e tests

# Production after npm install -g
browser-bridge-cli server start
browser-bridge-cli <command>

# Release
bun run build
git tag v<version>
```

## Important Files

- `src/cli.ts` — Commander CLI and browser command implementations.
- `src/client.ts` — CLI config resolution, local server auto-start, HTTP request helpers.
- `src/server.ts` — HTTP API, WebSocket broker, pairing, auth, active client routing.
- `extension/background.js` — MV3 service worker, WebSocket client, Chrome APIs and CDP dispatch.
- `extension/popup.html` / `extension/popup.js` — popup UI for enable/disable, pairing, whitelist, settings.
- `tests/e2e.test.ts` / `tests/helpers.ts` — Playwright tests for server, extension, CLI, screenshots.
- `skills/browser-bridge-cli/SKILL.md` — installable Browser Bridge CLI agent skill.
- `skills/browser-bridge-cli-skill-generator/SKILL.md` — skill for creating website workflow skills backed by Browser Bridge CLI.
- `docs/browser-bridge-intro.png` — README/Chrome Web Store product image.
- `docs/browser-bridge-icon.png` — source product icon used to derive extension icons.

## CLI Surface

Primary browser commands:

- `info`, `tabs`, `tab`, `activate`, `new-tab`, `close-tab`
- `eval`, `eval-file`, `query`, `cdp`, `detach`
- `navigate`, `reload`, `screenshot`, `pdf`, `network`, `cookies`
- `pair`, `unpair`, `disable`, `whitelist`, `clients`, `switch`

Management commands:

- `server start|stop|status|gen-pair|install-service`
- `config get|set|reset`

CLI config precedence is explicit flags, environment variables, saved config, then local server state.

## State And Auth

State lives under `~/.browser-bridge/`:

- `state.json` — server token, host, port.
- `token` — server token for quick local reads.
- `tokens.json` — extension/CLI client tokens keyed by client name.
- `config.json` — CLI persistent config (`server`, `token`, `name`).
- `server.pid` — local server PID.

Auth model:

1. Server owns a master token used by local/admin CLI calls.
2. `pair.request` creates a one-time 6-digit code with 5 minute TTL.
3. Extension or remote CLI submits the code and receives a client UUID token.
4. All CLI HTTP calls authenticate with `X-Browser-Bridge`.
5. Client tokens can execute browser commands; only the server token can generate pairing codes.

## Architecture Notes

- The bridge supports multiple extension clients and one active client. `clients` lists them; `switch <clientId>` changes the active target.
- Browser actions are routed through the extension over WebSocket. Request IDs are namespaced by client ID and time out after 30 seconds.
- JS execution and most advanced actions use CDP via `chrome.debugger`, not `chrome.scripting.executeScript`, so page CSP is bypassed.
- CDP commands default to auto-detach after each command to avoid a persistent Chrome debugger warning bar.
- Screenshots use `Page.captureScreenshot`; long screenshots stitch viewport captures with PNG row copying.
- The extension uses `chrome.alarms` for keepalive and reconnect because MV3 service workers do not reliably survive `setTimeout`.
- Whitelist enforcement only applies to tab/page actions. Non-page actions like `tabs.list`, `ping`, and network log retrieval are intentionally unrestricted.
- `bun build` bundles all dependencies into single JS files for npm distribution.

## Extension Notes

- Manifest: `extension/manifest.json`.
- Required permissions: `tabs`, `debugger`, `storage`, `alarms`.
- Popup state is stored in `chrome.storage.local`.
- The extension auto-disables after idle timeout or too many consecutive command failures.
- Chrome Web Store uploads should use the extension zip asset from the GitHub Release. Do not upload CRX unless intentionally using Verified CRX Uploads.
- For a Web Store release, bump `extension/manifest.json` version. Keep it in sync with `package.json` unless there is a deliberate reason not to.

## Testing Notes

- Use `bun run test` for the full Playwright suite.
- Tests isolate CLI/server state by overriding HOME/USERPROFILE through helpers in `tests/helpers.ts`.
- `launchBrowserWithExtension()` uses a temporary Chromium user data dir and cleans it up on context close.
- `runCli()` creates an isolated temp home when no env is supplied, so tests should not write to the real `~/.browser-bridge/`.
- Screenshot tests inspect PNG dimensions and pixels; avoid changing screenshot behavior without updating assertions.

## Release Checklist

1. Bump `package.json` and `extension/manifest.json`.
2. Run `bun run build`.
3. Run tests when behavior changed: `bun run test`.
4. Commit the version bump.
5. Tag and push:

   ```bash
   git tag v<version>
   git push
   git push origin v<version>
   ```

6. For Chrome Web Store, use the extension zip asset attached to the GitHub Release and upload that zip. Web Store signs the CRX automatically.

## Development Guidelines

- Prefer small, targeted changes. Avoid speculative abstractions.
- Preserve the CLI command surface and output formats unless intentionally changing behavior.
- Keep server token and client token responsibilities separate.
- When adding browser actions, decide whether the action is tab-scoped and should be whitelist-checked.
- Avoid writing tests or commands that touch the user's real `~/.browser-bridge/`; use isolated HOME envs.
- Do not commit generated temporary screenshots or icon candidates. Keep only intentional assets in `docs/` and `extension/icons/`.
