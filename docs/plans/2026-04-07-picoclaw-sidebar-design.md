# BrowseVibe Browser Sidebar Design

## Goal

Build a browser sidebar that behaves like an internal `webchat` surface for the agent while still letting the agent operate on the real browser context.

For the first slice, optimize for the shortest path to a working prototype:

- prioritize `picoclaw`
- reuse the existing Pico protocol
- defer browser automation to a separate bridge API
- do not depend on launcher
- do not require a local companion daemon

## Why This Is Not "Just Another Channel"

The browser integration has two distinct responsibilities:

1. `conversation surface`
   - chat transcript
   - agent session selection
   - plan display
   - human approvals
2. `browser execution surface`
   - current tab metadata
   - selection and DOM context
   - future click/type/extract actions

Treating both as one "channel" would overfit the channel abstraction. The sidebar should be an internal conversation surface. The browser control path should stay a separate tool bridge.

## Constraint From PicoClaw

PicoClaw already exposes a usable chat transport:

- gateway WebSocket: `GET /pico/ws`
- upstream protocol: Pico channel `message.send`, `message.create`, `message.update`, `typing.start`, `typing.stop`

The key constraint is auth bootstrapping.

The gateway accepts Pico auth through the WebSocket subprotocol. That means a Chrome extension can connect directly without a helper process, as long as it already knows the effective gateway Pico token.

## Architectural Decision

Use a pure extension client.

### Components

- Chrome extension side panel
- extension background script
- extension content script
- local PicoClaw gateway

### Responsibilities

#### Extension side panel

- render chat transcript
- persist local settings
- connect to local bridge over WebSocket
- append current browser context to outbound prompts

#### Background script

- open the side panel on action click
- fetch the active tab context from the content script
- own the future `browserBridge.executeAction` message path

#### Content script

- read:
  - title
  - URL
  - selected text
  - top headings

## Session Model

V1 uses one extension-owned main session persisted in local storage.

That keeps the first prototype aligned with how internal chat surfaces usually work:

- one long-lived agent conversation
- browser context injected per message

Later, add:

- tab-scoped sessions
- pinned task sessions
- explicit "attach this tab to session" behavior

## Message Flow

1. User opens the side panel.
2. The side panel opens `<gateway ws url>?session_id=<id>`.
3. The socket authenticates with `Sec-WebSocket-Protocol: token.<gateway-pico-token>`.
4. User submits a message.
5. The side panel asks the background script for current tab context.
6. The side panel wraps the prompt with that browser context.
7. The side panel sends Pico `message.send`.
8. PicoClaw streams `typing.*` and `message.*` events back to the side panel.

## Deferred Browser Action API

Reserve a separate action surface instead of folding this into chat transport.

Planned shape:

- `browser.snapshot`
- `browser.tabs.list`
- `browser.tabs.focus`
- `browser.click`
- `browser.type`
- `browser.extract`

V1 only exposes a placeholder `browserBridge.executeAction` path so the extension architecture already has a stable seam.

## File Layout

```text
extension/manifest.json
extension/background.js
extension/content.js
extension/sidebar.html
extension/sidebar.css
extension/sidebar.js
```

## Risks

- The extension still needs a manual token bootstrap in V1.
- Prompt-injected browser context needs careful trimming to avoid accidental oversharing.
- PicoClaw session history is not yet hydrated into the extension UI; transcript starts from the current side panel runtime.

## Success Criteria

- the side panel can connect to PicoClaw without modifying PicoClaw
- the user can chat from the browser side panel
- each message can include current tab context
- the code already has a clean seam for future browser actions
