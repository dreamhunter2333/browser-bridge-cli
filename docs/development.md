# Development and releases

[Documentation](README.md) · [中文](development_CN.md) · [Contributor instructions](../CLAUDE.md)

This guide contains implementation and maintainer details. Installation and everyday operations start in the [README](../README.md).

## Architecture

```text
CLI (TypeScript)
  └─ HTTP /api + X-Browser-Bridge token
       └─ Bridge Server (:52853)
            ├─ WebSocket /ext → MV3 extension → chrome.debugger / tabs / tabGroups
            └─ /share/<hash>/ → viewer HTML + input/video WebSocket
```

The Bridge routes requests to the selected extension client, namespaces request IDs and expires pending commands after 30 seconds. Page work uses `chrome.debugger`, subject to browser-protected-page restrictions. Group work uses native `chrome.tabGroups` / `chrome.tabs` APIs; group mutations preflight affected tabs against the whitelist.

Input and group commands pin a browser for multi-request operations. CDP input also retains the target tab for its sequence. Most commands detach after completing; `-k` retains attachment with a five-minute idle timeout. Capture leases defer physical detachment during live sharing.

The extension's DOM cursor is click-through, uses a closed shadow root and a manual popover to remain above modal dialogs, and avoids HTML injection for Trusted Types compatibility. Long screenshots stitch PNG rows. Sharing encodes frames as VP8 in an offscreen document and forwards binary chunks without server transcoding; see [sharing internals](tab-sharing.md#webcodecs-streaming).

## Source map

| Location | Responsibility |
| --- | --- |
| `src/cli.ts` | CLI commands, validation, input sequences and output. |
| `src/groups.ts` | Group command registration, browser pinning and metadata enrichment. |
| `src/client.ts` | Configuration, local auto-start and authenticated HTTP calls. |
| `src/server.ts` | HTTP API, pairing, client routing and WebSocket broker. |
| `src/share.ts`, `src/share-view.ts` | Share lifecycle, authentication, transport and viewer. |
| `extension/background.js` | Browser APIs, CDP, whitelist, cursor, debugger/capture leases. |
| `extension/popup.html`, `extension/popup.js` | Pairing, enable/disable, whitelist and settings. |
| `extension/video.html`, `extension/video.js` | Offscreen video encoding. |
| `tests/` | CLI/server/extension integration and behavior regressions. |
| `skills/` | Independently installable agent workflows. |
| `.github/workflows/` | Cross-platform tests and tagged releases. |

## Build and test

Install dependencies and build:

```bash
bun install
bun run build
```

### Test prerequisites

The suite requires the Chromium runtime matching the project's Playwright version (`channel: 'chromium'`). It starts temporary browser profiles and does not attach to an installed Chrome, Edge or EGO session. An existing matching Playwright cache can be reused; `bun install` alone does not prepare the browser executable.

<details>
<summary>Preparing a fresh disposable environment or CI runner</summary>

Download the test runtime into the Playwright cache in that environment:

```bash
bun x playwright install chromium
```

For a Linux CI runner that also needs system dependencies:

```bash
bun x playwright install --with-deps chromium
```

These are environment preparation steps, separate from running tests. Do not install a user's system browser without authorization.

</details>

With the runtime ready, run:

```bash
bun run test
```

The suite isolates CLI/server state using HOME/USERPROFILE in `tests/helpers.ts`; never point test state at a real `~/.browser-bridge/`.

### Local development

Choose one server mode. CLI development auto-starts a background Bridge when needed:

```bash
bun run dev -- info
```

For foreground server development, stop the background Bridge first, then keep this terminal running:

```bash
bun run dev -- server stop
bun run dev:server
```

Use another terminal for `bun run dev -- <command>`. Do not run foreground and background servers on the same port. The build and test commands above do not require starting a development server.

CI builds and tests on Ubuntu and Windows for pull requests and pushes to `main` / `feat/**`. Linux uses Xvfb; failures upload `test-results` for seven days. Coverage includes group CRUD/moves/whitelist/invalid inputs, input routing and cleanup, cursor screenshots/modal/Trusted Types, debugger idle behavior, sharing and video geometry/keyframes. A suite pass does not imply that a particular installed Chrome/Edge/EGO build was tested; report local-browser checks separately.

## Release pipeline

A `v*` tag triggers `.github/workflows/publish.yml`:

1. Set up Bun, Node.js 24 and npm with trusted publishing support.
2. Install dependencies and build the bundled CLI/server.
3. ZIP the contents of `extension/` as `browser-bridge-extension-v<version>.zip`.
4. Publish the package to npm using GitHub OIDC.
5. Create a GitHub Release with the extension ZIP attached.

The publish workflow does not run the test suite itself: verify the corresponding test workflow before tagging. npm and GitHub Release publication are automated; Chrome Web Store submission is a separate manual step.

<details>
<summary>One-time npm Trusted Publisher configuration</summary>

In the npm package's Trusted Publisher settings, select GitHub Actions:

| Field | Value |
| --- | --- |
| Organization/user | `dreamhunter2333` |
| Repository | `browser-bridge-cli` |
| Workflow filename | `publish.yml` |
| Environment | Leave empty unless the job is changed to use one. |

Allow npm publishing. The workflow requires `id-token: write`; GitHub Release creation requires `contents: write`. No long-lived npm token is needed. The repository/workflow identity must match npm's configuration.

</details>

### Release checklist

Replace `X.Y.Z` with the intended new version; do not reuse or move an already-published tag.

1. Synchronize `package.json` and `extension/manifest.json` versions and update relevant guides/skills/privacy permissions.
2. Run `bun run build` and `bun run test` for behavior changes. Commit intended changes and push `main`.
3. Confirm the Ubuntu/Windows test workflow for that exact commit succeeds.
4. Tag that commit and push:

   ```bash
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

5. Confirm Publish succeeds, `npm view browser-bridge-cli version` reports the new version, and the GitHub Release contains the extension ZIP.
6. Follow the store upload steps below. A successful GitHub/npm release does not mean the store version is live.

### Chrome Web Store upload

1. Download the **ZIP asset attached to the GitHub Release**. Do not use a source archive, locally repackaged folder or CRX.
2. Verify the ZIP's `manifest.json` version matches the release and inspect any permission changes.
3. Sign in to the correct publisher account in the Developer Dashboard, open the existing Browser Bridge item and upload the new ZIP in its package section.
4. Complete any required permission/privacy declarations. `tabGroups` manages native groups; `offscreen` supports local video encoding. Keep declarations consistent with [PRIVACY.md](../PRIVACY.md).
5. Submit for review and verify the dashboard status. Review submission, approval and public availability are separate states.

Chrome may reject extension debugger control of its own store/dashboard (`The extensions gallery cannot be scripted`). In that case, perform the upload through normal browser UI manually. Do not weaken browser protections to bypass this restriction.

## Documentation maintenance

Keep README focused on installation, features and user workflows. Put command semantics in `commands*`, remote/config/error guidance in `deployment*`, viewer behavior in `tab-sharing*`, and implementation/release details here. Add links through [the documentation index](README.md), keep English/Chinese editions synchronized, and keep installable skills self-contained.
