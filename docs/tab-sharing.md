# CLI tab sharing

Sharing is served by the existing Bridge HTTP server, on the same host and port
(default `127.0.0.1:52853`). `/api/...` serves CLI commands, `/ext` connects the
extension, and `/share/<stable-hash>/` serves viewers and their WebSockets.

## Start and use

```bash
browser-bridge-cli server start
browser-bridge-cli share start                 # Start all three viewer modes
browser-bridge-cli share links --tab 123       # Get three links; fixed-tab target is optional
browser-bridge-cli share status 'http://127.0.0.1:52853/share/HASH/'
browser-bridge-cli share stop 'http://127.0.0.1:52853/share/HASH/'
```

Use `share start` to initialize sharing, and `share links [--tab <id>]` to get
all three links. Both return `links.tab`, `links.active` and `links.browser`.
The fixed-tab target defaults to the current tab; `--client` selects the browser.
Capture starts only after a compatible viewer connects, independently of the CLI process. No second listener or viewer port is started. `share stop`
removes that share's saved definition and releases its capture without stopping
the Bridge or another share.

The path hashes the paired browser's name and tab ID, `active`, or `browser`.
It contains no credential or fragment token. Share definitions are saved in
`~/.browser-bridge/shares.json`; reopening a saved URL after a Bridge restart
starts the share again when the browser is connected. Browser names and target IDs
must stay the same. Tab IDs may change after a browser restart; fixed-tab links
never silently switch to a different target. The server must be running to serve
the link.

## Authentication

Loopback listeners (`127.0.0.1`, `localhost`, `::1`) require no viewer login by
default. Only loopback Host headers are accepted, and foreign browser origins
are rejected. The existing CLI and extension token authentication stays unchanged.

A Bridge listening outside loopback requires a username and password for each
share, even when the viewing connection originates locally. The browser uses
its standard HTTP Basic login prompt; WebSocket upgrades use the same login.
Passwords are supplied from an environment variable, not embedded in URLs.

```bash
# Set BROWSER_BRIDGE_SHARE_PASSWORD securely in the CLI environment first.
browser-bridge-cli server start --host 0.0.0.0
browser-bridge-cli share start --username viewer
browser-bridge-cli share status 'http://bridge-host:52853/share/HASH/' --username viewer
```

The default password variable is `BROWSER_BRIDGE_SHARE_PASSWORD`; override its
name with `--password-env`. Login protection may also be enabled on loopback by
supplying a username and password. Existing share login settings persist across
restarts. For public networks, use HTTPS through a reverse proxy that preserves
`/share/<hash>/` and its `stream`, `status`, and `stop` subpaths and supports
WebSocket upgrades. HTTP Basic credentials need TLS on untrusted networks.

## Viewer and capture

- Browser mode (`links.browser`) has a searchable sidebar with collapse, resizing and a
  top-tab option. It excludes internal pages, whitelist-blocked pages and its own
  viewer. Selecting a tab activates and shares it. Closing it selects another
  available webpage. External tab activation does not change manual selection.
- Active mode pauses on restricted pages and resumes when a webpage is selected.
  Switching releases held keys/buttons and discards input from the old frame.
- Fixed mode keeps its target even if another tab is activated. Closing that
  target stops capture. A disconnected browser can be retried by reopening the
  permanent URL after reconnection.
- Click, drag, scroll, text, Chinese IME commits and plain-text paste are supported.
  Click the input in the picture before typing. Ctrl+A/Cmd+A are forwarded without
  forcing select-all. Remote clipboard reads, browser chrome and OS dialogs are
  not included; host-intercepted shortcuts may not reach the source.
- Screencast bounds are 1920 × 1080, preserving the source aspect ratio. The
  viewer fits available space without resizing the source viewport; a very wide
  source still displays small text in a narrow panel.
- One controller per share and one capture lease per source tab. Different share
  paths can coexist on the Bridge port; two shares cannot capture the same tab
  simultaneously. The viewer skips outdated frames and updates tab rows only
  when their listing changes.
- Other CLI commands work with their normal options while sharing. Physical
  detach is deferred while a capture lease exists. Ordinary debugger connections
  detach after five idle minutes; operations refresh the deadline and live
  capture keeps it alive. A crashed capture's lease expires after 45 seconds.

## WebCodecs streaming

All three link modes use VP8 streaming by default.
No transport or JPEG-quality flag is needed. Reload the updated extension first:
its offscreen document and `offscreen` permission are required.

The extension captures PNG frames locally and encodes VP8 using browser-native
WebCodecs in `video.html`. No native executables or system libraries are required.
Chrome runtime messages use local base64 data; both network WebSocket hops carry
binary encoded chunks. Bridge forwards the chunks without transcoding.

VP8 targets 2 Mbps and at most about 15 fps. Actual throughput depends on page
changes and encoder performance. Identical PNG frames are skipped. No frames are
encoded while no viewer is connected or the outgoing buffer is congested. VP8
is lossy, not lossless text streaming.

Unsupported encoders/decoders and codec errors are reported explicitly. Reconnects
and tab switches resume with a keyframe. `share status` reports `transport: "vp8"`.
A secure viewer context (localhost or HTTPS) is required for WebCodecs.

## Viewer idle timeout

Loading the HTML page or reading `share status` does not attach a debugger. Capture starts only after a viewer completes the WebSocket handshake and a shareable source tab exists. If no source tab is available, the viewer remains connected in a paused state without an attachment.

When the viewer disconnects, the screencast, encoder and share lease are released immediately. The in-memory channel remains available for a quick reconnect and is destroyed no later than 5 minutes after the viewer was last confirmed alive. HTTP status requests do not create or reset the channel. The saved definition and permanent URL remain, so reopening the link recreates the channel. A connected viewer keeps the share alive even without keyboard or mouse input. Explicit `share stop` still removes the definition.
