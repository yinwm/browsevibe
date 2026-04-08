# Privacy

BrowseVibe is designed to keep browser actions local by default.

## What The Extension Accesses

BrowseVibe may access:

- the current page URL and title
- selected text and visible headings
- a snapshot of visible interactive elements such as links, buttons, and inputs
- user-provided gateway settings stored in Chrome local storage
- chat messages sent through the side panel to the configured local gateway

## What The Extension Does Not Do By Default

This repository does not include:

- cloud sync
- background remote runs
- telemetry or analytics
- automatic exfiltration of full page contents to a hosted BrowseVibe service

## How Data Flows

- Page context and browser snapshots are collected inside the extension.
- Write actions such as `browser.click` and `browser.type` require a one-time approval on the current page.
- Chat traffic is sent only to the gateway URL configured by the user.
- Browser snapshot data is used to drive local action planning and display in the side panel.

## Local Storage

BrowseVibe stores configuration and local page sessions in `chrome.storage.local`, including:

- `gatewayWsUrl`
- `gatewayPicoToken`
- local page-scoped session history

Users are responsible for the security of their local browser profile and gateway credentials.

## Sensitive Inputs

The extension blocks `browser.type` on obviously sensitive fields such as password and payment-style inputs.

## Open-Source Boundary

This repository covers the local extension core only. If hosted services are added later, they should document their own privacy posture separately.
