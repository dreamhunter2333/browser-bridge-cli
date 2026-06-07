# Browser Bridge CLI

[English](./README.md) | [中文](./README_CN.md)

Control an already-open Chrome/Edge browser via CLI through a browser extension.

```mermaid
graph LR
    CLI["CLI (TypeScript)"]
    Bridge["Bridge Server (:52853)"]
    Ext["Extension (Service Worker)"]
    Browser["Browser Page"]

    CLI -->|"HTTP + token"| Bridge
    Bridge -->|"WebSocket"| Ext
    Ext -->|"chrome.debugger / tabs"| Browser
```

## Install

```bash
# Global install
npm i -g browser-bridge-cli

# Or use directly (no install)
npx browser-bridge-cli info

# Or with Bun
bunx browser-bridge-cli info
```

### Install as AI Agent Skill

```bash
# Install to Claude Code
npx skills add dreamhunter2333/browser-bridge-cli/skill --agent claude-code

# Install to multiple agents
npx skills add dreamhunter2333/browser-bridge-cli/skill --agent claude-code codex

# Install globally
npx skills add dreamhunter2333/browser-bridge-cli/skill --agent claude-code -g
```

## Prerequisites

- Node.js >= 20 or [Bun](https://bun.sh/) >= 1.0
- Chrome or Edge browser

## Supported Platforms

- Windows, macOS, and Linux are supported for normal CLI usage, including `server start`, `server stop`, `server status`, pairing, tab control, screenshots, PDF export, network logs, cookies, and raw CDP commands.
- `server install-service` is Linux-only because it installs a systemd user service. On Windows and macOS, start the bridge with `server start` instead.
- CI runs build and e2e tests on both `ubuntu-latest` and `windows-latest`.

## Setup

### 1. Load browser extension

Download the extension zip from [GitHub Releases](https://github.com/dreamhunter2333/browser-bridge-cli/releases), or use the `extension/` directory from the source code.

1. Open Chrome/Edge → `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** → select the unzipped extension directory

### 2. Start server + pair

```bash
# 1. Start server
npx browser-bridge-cli server start

# 2. Open extension popup → enable toggle → (optional: set server URL)

# 3. Generate pairing code
npx browser-bridge-cli server gen-pair

# 4. Enter the 6-digit code in extension popup → click Pair
```

## Deployment Topologies

Rule: run every `server ...` command on the Bridge Server machine. Server-side commands use local state on that machine, so do not pass `--server` to them. On a remote CLI machine, `pair` must use `--server http://<server-host>:52853` to choose which server to connect to. Do not copy the server token to remote CLI machines.

<details>
<summary><strong>Two-Machine Deployment: Extension + Server on one machine, CLI remote</strong></summary>

Use this mode when Chrome/Edge and the Bridge Server run on the same machine, while CLI commands come from any other machine.

```mermaid
graph LR
    CLI["Machine B: CLI Client"]
    Host["Machine A: Browser Host"]
    Bridge["Bridge Server"]
    Ext["Extension Client"]
    Browser["Chrome/Edge"]

    CLI -->|"HTTP API: http://HOST:52853 + token"| Bridge
    Bridge -->|"WebSocket: ws://127.0.0.1:52853/ext"| Ext
    Ext -->|"chrome.debugger / tabs"| Browser
    Host --- Bridge
    Host --- Ext
    Host --- Browser
```

### Machine A: Browser Host

Install the extension and start the bridge on an address reachable from Machine B:

```bash
npx browser-bridge-cli server start --host 0.0.0.0 --port 52853 --token <server-token>
```

In the extension popup:

1. Enable the extension toggle.
2. Keep the server URL as `ws://127.0.0.1:52853/ext`, or use `ws://localhost:52853/ext`.
3. Generate a pairing code on Machine A. This is a server-side operation; run it locally on Machine A and do not pass `--server`:

```bash
npx browser-bridge-cli server gen-pair
```

4. Enter the 6-digit code in the extension popup and click **Pair**.

Notes:

- Machine A must allow inbound TCP `52853` from Machine B.
- Keep `<server-token>` on Machine A. Remote CLI clients should pair and use their own client tokens.
- Use a private network, VPN, SSH tunnel, or HTTPS reverse proxy for remote access when possible.

### Machine B: Remote CLI Client

Ask the operator on Machine A to run `npx browser-bridge-cli server gen-pair` locally again, because pairing codes are one-time-use. Then pair the CLI with the server running on Machine A. The `--server` option is required here because this command runs on the remote CLI machine:

```bash
npx browser-bridge-cli pair --server http://<browser-machine-ip>:52853 -n <cli-name>
```

Enter a fresh pairing code generated on Machine A. The CLI stores its token in `~/.browser-bridge/config.json`.

Then run commands from Machine B:

```bash
npx browser-bridge-cli info
npx browser-bridge-cli tabs
npx browser-bridge-cli new-tab https://example.com
```

For one-off commands without saved config:

```bash
npx browser-bridge-cli --server http://<browser-machine-ip>:52853 --token <client-token> tabs
```

Do not run `server start`, `server stop`, `server status`, `server gen-pair`, or `server install-service` from Machine B. Those commands belong on Machine A.

</details>

<details>
<summary><strong>Three-Machine Deployment: Server, Extension, and CLI on separate machines</strong></summary>

Browser Bridge can run with each role on a different machine:

```mermaid
graph LR
    CLI["Machine C: CLI Client"]
    Bridge["Machine A: Bridge Server"]
    Ext["Machine B: Extension Client"]
    Browser["Machine B: Chrome/Edge"]

    CLI -->|"HTTP API: http://SERVER:52853 + token"| Bridge
    Ext -->|"WebSocket: ws://SERVER:52853/ext"| Bridge
    Ext -->|"chrome.debugger / tabs"| Browser
```

Use this mode when the browser is open on one machine, the long-running bridge server is hosted on another machine, and commands are sent from a third machine.

### Machine A: Bridge Server

Start the server on an address reachable by the other two machines:

```bash
npx browser-bridge-cli server start --host 0.0.0.0 --port 52853 --token <server-token>
```

Notes:

- Open TCP port `52853` in the firewall or security group.
- Use a VPN, SSH tunnel, reverse proxy with HTTPS, or a private network when possible. Do not expose an unauthenticated public endpoint.
- Keep `<server-token>` on Machine A. It can generate pairing codes and revoke client tokens.
- On Linux, you can run it as a user service:

```bash
npx browser-bridge-cli server install-service --host 0.0.0.0 --port 52853 --token <server-token>
```

Generate one pairing code for each client. Pairing codes are one-time-use and expire in 5 minutes. This is a server-side operation; run it locally on Machine A and do not pass `--server`:

```bash
npx browser-bridge-cli server gen-pair
```

### Machine B: Browser + Extension Client

Install and load the extension on the machine where Chrome/Edge is running.

In the extension popup:

1. Enable the extension toggle.
2. Set the server URL to `ws://<server-ip>:52853/ext`.
3. Enter a pairing code generated on Machine A.
4. Click **Pair**.

After pairing, this machine keeps a WebSocket connection to Machine A. The browser itself does not need to run the CLI.

### Machine C: CLI Client

Install or run the CLI on the command machine:

```bash
npx browser-bridge-cli pair --server http://<server-ip>:52853 -n <cli-name>
```

Enter a fresh pairing code generated on Machine A. If the previous code was used by the extension, ask Machine A to run `npx browser-bridge-cli server gen-pair` locally again. The `--server` option is required because this command runs on the CLI machine and must choose the remote server. The CLI stores its client token in `~/.browser-bridge/config.json`.

After that, commands can omit `--server` if the config was saved:

```bash
npx browser-bridge-cli info
npx browser-bridge-cli tabs
npx browser-bridge-cli new-tab https://example.com
```

Or pass the server explicitly for one command:

```bash
npx browser-bridge-cli --server http://<server-ip>:52853 tabs
```

### Token Model

- Server token: admin credential for Machine A. It can generate pairing codes and revoke tokens.
- Extension client token: stored by the browser extension after pairing. It lets the extension authenticate its WebSocket connection.
- CLI client token: stored by Machine C after `pair --server`. It can execute browser commands but cannot generate pairing codes or manage the server.

If you want to skip interactive CLI pairing, put a CLI client token in config or environment variables. Do not use the server token on remote CLI machines:

```bash
npx browser-bridge-cli config set server http://<server-ip>:52853
npx browser-bridge-cli config set token <client-token>

# or
export BROWSER_BRIDGE_URL=http://<server-ip>:52853
export BROWSER_BRIDGE_TOKEN=<client-token>
```

</details>

## CLI Commands

`bunx browser-bridge-cli ...` can be used anywhere `npx browser-bridge-cli ...` appears below.

```bash
# Server management
npx browser-bridge-cli server start [--host 0.0.0.0] [--port 9000] [--token xxx]
npx browser-bridge-cli server stop
npx browser-bridge-cli server status
npx browser-bridge-cli server gen-pair
npx browser-bridge-cli server install-service [--uninstall]   # systemd daemon (Linux)

# Pairing
npx browser-bridge-cli pair [-n name]               # Local: generate code for extension
npx browser-bridge-cli pair --server http://remote   # Remote: enter code to pair CLI
npx browser-bridge-cli unpair                        # Revoke + clear credentials

# Configuration
npx browser-bridge-cli config get                    # Show config (tokens masked)
npx browser-bridge-cli config set <key> <value>      # Set server, token, or name
npx browser-bridge-cli config reset                  # Clear all config

# Browser control
npx browser-bridge-cli info                          # Server status + clients
npx browser-bridge-cli tabs                          # List all tabs
npx browser-bridge-cli tab <id>                      # Tab details
npx browser-bridge-cli eval <expr> [-t id] [-k]      # Execute JS
npx browser-bridge-cli eval-file <file> [-t id]      # Execute JS file
npx browser-bridge-cli query <selector> [-t id]      # Query DOM
npx browser-bridge-cli new-tab [url]                 # Create tab
npx browser-bridge-cli close-tab <id>                # Close tab
npx browser-bridge-cli activate <id>                 # Switch tab
npx browser-bridge-cli navigate <url> [-t id]        # Navigate
npx browser-bridge-cli reload [-t id] [--no-cache]   # Reload
npx browser-bridge-cli screenshot [-o file] [-f]     # Screenshot
npx browser-bridge-cli pdf [-o file] [-t id]         # PDF export
npx browser-bridge-cli network [-l limit] [--clear]  # Network log
npx browser-bridge-cli cookies [-u url] [-d domain]  # Cookies
npx browser-bridge-cli cdp <method> [params] [-t id] # Raw CDP command
npx browser-bridge-cli detach [-t id]                # Detach debugger
npx browser-bridge-cli clients                       # List clients
npx browser-bridge-cli switch <clientId>             # Switch active client
```

Global options: `-s, --server <url>`, `--token <token>`

Config priority: CLI flags > env vars (`BROWSER_BRIDGE_URL`, `BROWSER_BRIDGE_TOKEN`) > `~/.browser-bridge/config.json` > `~/.browser-bridge/state.json`

## Development

```bash
bun install
bun run dev -- info          # Run CLI in dev mode
bun run dev:server           # Run server in dev mode
bun run build                # Build for npm
bun run test                 # Run Playwright e2e tests
```

## Security

- Bridge binds to `127.0.0.1` by default
- Server token controls admin operations (pair code generation, token revocation)
- Client tokens can execute browser commands but cannot generate pair codes
- Rate limiting on pairing (HTTP: 5/min per IP, WS: 5 failures per connection)
- Pairing codes are one-time-use, expire in 5 minutes
- Token revoke disconnects WS clients
- Whitelist restricts per-tab operations by URL pattern

## License

MIT
