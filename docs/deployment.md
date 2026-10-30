# Deployment and troubleshooting

[Documentation](README.md) · [中文](deployment_CN.md) · [Quick start](../README.md#quick-start)

## Local setup and multiple browsers

Start the Bridge and generate a pairing code:

```bash
browser-bridge-cli server start
browser-bridge-cli server gen-pair
```

In the extension popup, enable the extension, set `ws://127.0.0.1:52853/ext`, enter the code and click **Pair**. `pair` without a remote server is also a shortcut to generate an extension pairing code. Generate a new code for every browser or remote CLI; each is single-use and expires in five minutes.

```bash
browser-bridge-cli info
browser-bridge-cli clients
browser-bridge-cli switch CLIENT_ID
browser-bridge-cli tabs
browser-bridge-cli whitelist
browser-bridge-cli disable
```

Replace `CLIENT_ID` with an ID from `clients`. The active client routes normal commands. Tab/group IDs are specific to that browser session. Manage whitelist patterns, extension pairing, operation cursor visibility, idle timeout and failure thresholds from the popup; `whitelist` only displays settings. `disable` disconnects the selected extension until enabled again.

## Remote setup

CLI, Bridge Server and browser extension can run together, on two machines, or on three machines. Replace `bridge-host` below with the Bridge machine's reachable hostname/IP.

### Two machines: browser and Bridge together

```text
Machine B: CLI ── HTTP ── Machine A: Bridge ── local WebSocket ── Machine A: extension
```

On **Machine A**, stop any existing local Bridge before changing its bind address. `server start` does not reconfigure an already-running process:

```bash
browser-bridge-cli server stop
browser-bridge-cli server start --host 0.0.0.0 --port 52853
browser-bridge-cli server gen-pair
```

Pair the extension on A using `ws://127.0.0.1:52853/ext`. Generate a **second** code on A, then pair the CLI on **Machine B**:

```bash
browser-bridge-cli pair --server http://bridge-host:52853 -n remote-cli
browser-bridge-cli info
browser-bridge-cli tabs
```

Enter the second code when prompted. Pairing saves the remote server URL and CLI client token; subsequent commands can omit `--server`.

### Three machines: Bridge, browser and CLI separate

```text
Machine C: CLI ── HTTP ── Machine A: Bridge ── WebSocket ── Machine B: extension
```

Start the Bridge on A as above. In the extension on **B**, use `ws://bridge-host:52853/ext` and a code generated on A. Generate another code on A and pair the CLI on **C** with the same `pair --server` command.

The Bridge machine must allow inbound TCP 52853 from its clients. Use a private network, VPN, SSH tunnel or HTTPS/WSS reverse proxy for remote access. Keep the server token on the Bridge machine; paired clients receive their own revocable tokens. See [sharing authentication](tab-sharing.md#authentication) for viewer access.

## Configuration and server management

Inspect saved settings:

```bash
browser-bridge-cli config get                       # Tokens are masked
```

To disconnect a remote CLI, revoke its credential **before** changing or clearing its saved server URL, token or paired name:

```bash
browser-bridge-cli unpair
```

`unpair` attempts server-side revocation, then clears local credentials. If it reports local clearing only, server-side revocation is not confirmed. `config reset` is a separate local-only operation; it cannot revoke a credential and must not precede `unpair` when revocation is intended:

```bash
browser-bridge-cli config reset
```

For an independent configuration change, use `config set <key> <value>` (`server`, `token` or `name`). Prefer `pair --server` to set up a remote CLI's matching server, credential and paired name together.

Run `server ...` only on the Bridge machine and do not pass `--server`. To change its host or port, stop it and then start it with the new settings:

```bash
browser-bridge-cli server status
browser-bridge-cli server stop
browser-bridge-cli server start --host 127.0.0.1 --port 52853
browser-bridge-cli server gen-pair
```

On Linux, `server install-service` installs a systemd user service; use `server install-service --uninstall` to remove it. `server start` and `install-service` also accept `--token` for an explicitly managed server credential.

Resolution order: CLI flags → `BROWSER_BRIDGE_URL` / `BROWSER_BRIDGE_TOKEN` → saved config → local server state. For one-off remote access, use `--server` plus a **client** token or the environment variables. Local browser commands can auto-start a local server; remote clients never start the remote server.

<details>
<summary>State files and credential roles</summary>

State is under `~/.browser-bridge/`:

| File | Purpose |
| --- | --- |
| `state.json`, `token` | Local server address and admin token. |
| `tokens.json` | Paired client credentials managed by the server. |
| `config.json` | CLI server URL, client token and name. |
| `server.pid` | Local server process ID. |
| `shares.json` | Persistent share definitions and login settings. |

The server token authorizes administrative operations such as generating pairing codes and revoking clients. Extension tokens authenticate WebSockets. Remote CLI tokens authorize browser commands, not pairing-code generation or server administration. Revocation disconnects the corresponding WebSocket client.

Pairing is rate limited: HTTP five attempts/minute/IP, WebSocket five failed attempts/connection. Treat state files as credentials and avoid sharing them.

</details>

## Permissions and boundaries

| Extension permission | Use |
| --- | --- |
| `tabs` | Tab metadata and tab operations. |
| `tabGroups` | Native group queries, edits and membership. |
| `debugger` | Page input, scripts, captures, network, cookies and native CDP. |
| `storage` | Pairing and popup settings. |
| `alarms` | MV3 keepalive, reconnect and idle checks. |
| `offscreen` | Browser-native encoding for live sharing. |

The whitelist checks configured tab/page actions and all tabs affected by group mutations. Tab/group metadata listing and network/cookie retrieval are outside that check. Browser-native restrictions still apply even when a URL is whitelisted. Read the [privacy policy](../PRIVACY.md) for data handling.

## Troubleshooting

| Symptom | Check / action |
| --- | --- |
| No browser connected | Run `info`; enable the popup toggle, verify the WebSocket URL and pair using a fresh code. |
| Wrong browser or tab | Run `clients`, `switch`, then `tabs`; pass an explicit `-t`. Rediscover IDs after browser restarts. |
| Missing group actions | Install matching CLI/extension versions; reload an unpacked extension and verify `tabGroups` permission. |
| `Blocked by whitelist` | Adjust patterns in the popup. An enabled but empty whitelist blocks all sites; group edits check every affected member. |
| `The extensions gallery cannot be scripted` | Chrome rejects debugger attachment to protected extension-gallery pages, including affected Web Store dashboard URLs. The tab title/URL can still be listed; page scripting/input is unavailable through this bridge. Complete that operation manually. |
| Debugger attachment fails elsewhere | Check for a protected internal page or another debugger/DevTools session; retry on an ordinary webpage after resolving the conflict. |
| Selector input is ambiguous/covered | Choose one visible main-document CSS match. `query --visible` alone does not test occlusion. |
| Extension turns off | Check popup idle timeout and consecutive-failure settings, then enable it again. |
| Remote connection fails | Check bind address, firewall, HTTP vs WebSocket URLs and the saved CLI configuration. Generate codes on the Bridge machine. |
| Sharing is blank or text is small | Use localhost/HTTPS with supported WebCodecs, check the source tab and [viewer limits](tab-sharing.md#viewer-and-capture). A narrow viewer fits the existing source width. |
