---
title: 'Architecture'
description: 'Where the self-hosted Fluxmail server keeps your data and how the codebase is structured.'
updated: '2026-07-15'
---

## Where your data lives

Fluxmail keeps its SQLite database on the machine where it runs. Google and Microsoft OAuth tokens and IMAP/SMTP passwords are encrypted at rest with AES-256-GCM. Your client talks to your email provider through the self-hosted Fluxmail process. Fluxmail does not copy email content to a service operated by Fluxmail. Content returned through MCP may be sent to the client's model provider, depending on how that client runs. The [code is source-available](https://github.com/churichard/fluxmail-mcp) under the [Fluxmail proprietary license](https://github.com/churichard/fluxmail-mcp/blob/main/LICENSE.md).

## How Fluxmail is built

Fluxmail is a small monorepo:

```
packages/
  core/             # unified types, the EmailQuery language, the EmailProvider interface
  provider-gmail/   # Gmail adapter (googleapis): query translation, MIME, threading, labels
  provider-imap/    # IMAP/SMTP adapter: folders, search, MIME parts, synthetic threads
  provider-outlook/ # Microsoft Graph adapter: folders, conversations, drafts, attachments
  server/           # EmailService, SQLite storage, OAuth, MCP and REST transports, CLI
```

MCP tools and REST routes are thin wrappers over `EmailService`, which owns account routing, reply and forward computation, and plan limits. Each provider implements one `EmailProvider` interface and declares a `capabilities` object, so both APIs handle provider differences the same way. Outlook uses Microsoft Graph conversations and folders. IMAP has folders instead of labels, uses its server's basic search, and has no server-side thread model. Fluxmail reconstructs IMAP threads from standard email headers.

## How permissions are enforced

Every connection acts for one member. Fluxmail first limits the connection to mailboxes that member can reach, then applies an optional account allowlist. An administrator can manage members and mailbox access, but the role does not grant access to private mailboxes.

Stdio connections receive their member, account scope, and permission policy when the process starts. MCP and REST requests over HTTP receive the same information from their API key. Fluxmail limits each request to that scope and checks its required capabilities before calling an email provider.

Administrative REST routes add a second check. The key must contain the capability for that route, and its owner must have the administrator role at the time of the request. Memberless keys retained from older installations use their explicit administrative capabilities. Mail routes can run without authentication under `FLUXMAIL_AUTH=none`, but administrative routes cannot.

Authenticated management mutations create rows in `admin_audit_events`. The table stores stable identifiers and outcome codes, not request data or secrets, and retains the newest 10,000 rows. Fluxmail does not send actor or resource identifiers through anonymous telemetry.

Attachments are returned as embedded MCP resources or raw REST responses. Every provider enforces the configured decoded-size limit before returning the file. The default limit is 10 MB, and the hard maximum is 25 MB.

REST send, scheduled-send, and forward requests use idempotency records in SQLite. Each record is scoped to an API key and retained for 24 hours. This prevents a client retry from repeating the provider call during that period.
