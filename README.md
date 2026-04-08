# BrowseVibe

**A browser agent for the web, under your control.**

BrowseVibe is the local extension core for a controlled browser agent. It runs as a Chrome side panel, connects directly to a local PicoClaw gateway, and keeps page actions behind explicit user approval.

## Open-Source Boundary

This repository contains the local, publishable core:

- the Chrome extension UI
- page snapshots and local `click` / `type` execution
- per-page approval for write actions
- direct WebSocket connection to a local PicoClaw gateway

Planned hosted or paid features such as cloud sync, shared workflows, audit logs, remote runs, and team controls should live outside this repository.

## Connection Model

BrowseVibe talks directly to PicoClaw's native Pico protocol endpoint:

- gateway WebSocket: `ws://<host>:<port>/pico/ws`
- session routing: `?session_id=<id>`
- auth: `Sec-WebSocket-Protocol: token.<gateway-pico-token>`

That works because the browser WebSocket API can send subprotocols directly. No local helper process is required.

## What You Need

The extension needs two values:

1. `Gateway WS URL`
   Example: `ws://127.0.0.1:18790/pico/ws`

2. `Gateway Pico Token`
   This is the effective PicoClaw gateway token, not a launcher token.

Token bootstrapping is still manual in this version. A better long-term fix should come from PicoClaw itself, for example a CLI command that prints the current gateway token for local clients.

## Load The Extension

1. Open `chrome://extensions`
2. Enable `Developer mode`
3. Click `Load unpacked`
4. Select the `extension/` folder from this repository
5. Click the extension action to open the side panel
6. In settings, enter:
   - Gateway WS URL: `ws://127.0.0.1:18790/pico/ws`
   - Gateway Pico Token: your current PicoClaw gateway token

## Current Scope

- Direct PicoClaw chat over the Pico protocol
- Current tab title, URL, selection, and headings injected as prompt context
- Browser snapshots of interactive elements on the active page
- Local browser actions: `browser.snapshot`, `browser.extract`, `browser.click`, `browser.type`
- One-time, per-page approval for `click` / `type`

Not implemented yet:

- Cross-tab browser automation
- Multi-agent routing
- Rich transcript history sync from PicoClaw

## Browser Automation Model

The extension exposes a local browser bridge:

- `background.js` enforces:
  - current active tab only
  - current page approval once for write actions
  - HTTP(S) pages only
- `content.js` provides:
  - DOM snapshots of visible interactive elements
  - selector fallback for element targeting
  - write protection for sensitive fields such as password or credit-card style inputs
- `sidebar.js` provides:
  - a Browser Snapshot panel
  - approval UI for page-scoped write access
  - automatic follow-up messages after actions run

## Assistant Action Format

When the model wants to act on the page, it should respond with exactly one fenced `browser-action` JSON block.

Example:

````text
```browser-action
{"action":"browser.click","target":{"elementId":"el-2","selector":"button[data-testid=\"continue\"]"}}
```
````

Supported actions:

- `browser.snapshot`
- `browser.extract`
- `browser.click`
- `browser.type`

For `click` and `type`, the extension will:

1. ask for approval once on the current page if needed
2. execute the action on the active tab only
3. collect a fresh browser snapshot
4. send the result back into the chat as a follow-up user message

## License

This repository is licensed under Apache-2.0. See [LICENSE](./LICENSE).
