---
title: 'Architecture'
description: 'Where Fluxmail keeps your data and how MCP, REST, and CLI requests reach each email provider.'
updated: '2026-07-17'
---

## Where your data lives

Fluxmail keeps its SQLite database on the machine where it runs. Google and Microsoft OAuth tokens and IMAP/SMTP passwords are encrypted at rest with AES-256-GCM. Your client talks to your email provider through the self-hosted Fluxmail process. Fluxmail does not copy email content to a service operated by Fluxmail. Content returned through MCP may be sent to the client's model provider, depending on how that client runs. The [code is source-available](https://github.com/churichard/fluxmail) under the [Fluxmail proprietary license](https://github.com/churichard/fluxmail/blob/main/LICENSE.md).

## How requests flow

Agents connect through MCP, while apps and backend workflows use REST. Both interfaces send email requests through the same service. Fluxmail selects the mailbox, checks access and plan limits, then passes the operation to Gmail, Microsoft Graph, or an IMAP/SMTP server. Account routing, replies, forwards, and provider capabilities stay consistent across MCP and REST.

The CLI is Fluxmail's control interface. It connects mailboxes, manages members and API keys, changes configuration, and starts the MCP and REST services. CLI commands that manage the instance use the same database and provider connections as the running server, but the CLI does not duplicate the MCP and REST mailbox-operation APIs.

Provider differences still affect the available behavior. Outlook uses Microsoft Graph conversations and folders. IMAP has folders instead of labels, uses the mail server's basic search, and has no server-side thread model. Fluxmail reconstructs IMAP threads from standard email headers.

## How permissions are enforced

Every connection acts for one member. Fluxmail first limits the connection to mailboxes that member can reach, then applies an optional account allowlist. An administrator can manage members and mailbox access, but the role does not grant access to private mailboxes.

Stdio connections receive their member, account scope, and permission policy when the process starts. MCP and REST requests over HTTP receive the same information from their API key. Fluxmail limits each request to that scope and checks its required capabilities before calling an email provider.

Administrative REST routes add a second check. The key must contain the capability for that route, and its owner must have the administrator role at the time of the request. Memberless keys retained from older installations use their explicit administrative capabilities. Mail routes can run without authentication under `FLUXMAIL_AUTH=none`, but administrative routes cannot.

Authenticated management mutations create rows in `admin_audit_events`. The table stores stable identifiers and outcome codes, not request data or secrets, and retains the newest 10,000 rows. Fluxmail does not send actor or resource identifiers through anonymous telemetry.

Attachments are returned as embedded MCP resources or raw REST responses. Every provider enforces the configured decoded-size limit before returning the file. The default limit is 10 MB, and the hard maximum is 25 MB.

REST send, scheduled-send, and forward requests use idempotency records in SQLite. Each record is scoped to an API key and retained for 24 hours. This prevents a client retry from repeating the provider call during that period.
