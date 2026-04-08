# Security Policy

## Scope

This repository contains the local BrowseVibe extension core. Security-sensitive areas include:

- gateway credential handling
- browser action approval boundaries
- DOM action targeting and selector fallback
- page data exposed to prompts and logs

## Reporting A Vulnerability

Please avoid opening a public issue for credential leaks, code execution issues, or bypasses of the approval model.

If GitHub private vulnerability reporting is enabled for the repository, use that channel. Otherwise contact the maintainer privately before disclosing details publicly.

## Supported Security Expectations

BrowseVibe aims to keep these guarantees in the open-source core:

- no bundled production secrets
- no automatic write actions without explicit page approval
- sensitive input fields blocked from `browser.type`
- browser actions limited to the active HTTP(S) tab

## Secret Handling

Do not commit:

- live gateway tokens
- session dumps containing private data
- screenshots or logs that expose secrets

If a secret has already been committed, rotate it immediately. Removing it from the current working tree is not sufficient on its own.
