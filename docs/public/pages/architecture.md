---
title: 'Architecture'
description: 'Where the self-hosted Fluxmail MCP server keeps your data and how the codebase is structured.'
updated: '2026-07-14'
---

## Where your data lives

Fluxmail keeps its SQLite database on the machine where it runs. Google OAuth tokens and IMAP/SMTP passwords are encrypted at rest with AES-256-GCM. Your agent talks to your email provider through the self-hosted Fluxmail process. Fluxmail does not copy email content to a service operated by Fluxmail. Content returned through MCP is handled by the MCP client and may be sent to the client's model provider, depending on how that client runs. The [code is source-available](https://github.com/churichard/fluxmail-mcp) under the [Fluxmail proprietary license](https://github.com/churichard/fluxmail-mcp/blob/main/LICENSE.md).

## How Fluxmail is built

Fluxmail is a small monorepo:

```
packages/
  core/             # unified types, the EmailQuery language, the EmailProvider interface
  provider-gmail/   # Gmail adapter (googleapis): query translation, MIME, threading, labels
  provider-imap/    # IMAP/SMTP adapter: folders, search, MIME parts, synthetic threads
  server/           # EmailService, SQLite storage, OAuth, MCP tools, HTTP + stdio transports, CLI
```

MCP tools are thin wrappers over `EmailService`, which owns account routing, reply and forward computation, and plan limits. Each provider implements one `EmailProvider` interface and declares a `capabilities` object, so the tools handle provider differences explicitly. IMAP has folders instead of labels, uses its server's basic search, and has no server-side thread model. Fluxmail reconstructs its threads from standard email headers. Outlook (Microsoft Graph) support is in progress.

## How permissions are enforced

Every connection acts for one member. Fluxmail first limits the connection to mailboxes that member can reach, then applies an optional account allowlist. An administrator can manage members and mailbox access, but the role does not grant access to private mailboxes.

Stdio connections receive their member, account scope, and permission policy when the process starts. Streamable HTTP connections receive the same information from their API key. Fluxmail registers only the tools and `modify_emails` actions allowed by that policy, then checks mailbox access and capabilities again when a tool runs.

Attachments are returned as embedded MCP resources. The Gmail and IMAP providers enforce the configured decoded-size limit before returning the file. The default limit is 10 MB, and the hard maximum is 25 MB.
