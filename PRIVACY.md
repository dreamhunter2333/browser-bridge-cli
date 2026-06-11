# Privacy Policy

Browser Bridge lets a user connect a paired CLI to their own Chrome or Edge tabs for debugging and automation tasks.

## Data Collection

Browser Bridge does not collect, sell, or share user data with the extension author or any third-party service.

The extension can access browser data only to perform commands requested by the user through their paired Bridge Server and CLI. Depending on the command, this may include:

- Tab metadata such as URL, title, active state, and tab id.
- Page content returned by JavaScript evaluation or DOM query commands.
- Screenshots or PDFs generated from a target tab.
- Network metadata for a target tab through Chrome DevTools Protocol.
- Cookies for a target tab URL context through Chrome DevTools Protocol.

## Data Transmission

Command results are sent from the browser extension to the Bridge Server configured by the user. By default, the Bridge Server runs locally at `127.0.0.1`.

If the user configures a remote Bridge Server, browser data may be transmitted to that user-configured server. Browser Bridge does not transmit data to servers operated by the extension author.

## Local Storage

The extension stores the following data in `chrome.storage.local`:

- Enabled or disabled state.
- Bridge Server WebSocket URL.
- Pairing token and client name.
- Whitelist settings.
- Idle timeout and retry settings.

The CLI and Bridge Server store their local state under `~/.browser-bridge/`.

## Permissions

Browser Bridge requests only the permissions needed for its browser-control purpose:

- `debugger`: Uses Chrome DevTools Protocol for tab automation, JavaScript evaluation, screenshots, PDF export, network inspection, cookies, and raw CDP commands.
- `tabs`: Lists, creates, activates, closes, navigates, and reloads browser tabs.
- `storage`: Stores pairing state and extension settings locally.
- `alarms`: Handles Manifest V3 service worker keepalive, reconnects, and idle timeout.

## Limited Use

Browser Bridge uses browser data only to provide user-requested browser debugging and automation features through the paired CLI and Bridge Server.

Browser Bridge does not sell user data, use user data for advertising, transfer user data for unrelated purposes, or use user data to determine creditworthiness or lending eligibility.

## User Control

Users can disable the extension from the popup at any time. Users can also unpair the extension, revoke stored credentials, reset CLI configuration, or stop the Bridge Server.

## Remote Code

Browser Bridge does not load or execute remotely hosted extension code.

## Contact

For privacy or security issues, open an issue at:

https://github.com/dreamhunter2333/browser-bridge-cli/issues
