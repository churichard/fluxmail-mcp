---
title: 'Architecture'
description: 'Where Fluxmail keeps your data and how MCP, REST, and CLI requests reach each email provider.'
updated: '2026-07-17'
---

## Where your data lives

Fluxmail keeps its SQLite database on the machine where it runs. Google and Microsoft OAuth tokens and IMAP/SMTP passwords are encrypted at rest with AES-256-GCM. Your client talks to your email provider through the self-hosted Fluxmail process. Fluxmail does not copy email content to a service operated by Fluxmail. Content returned through MCP may be sent to the client's model provider, depending on how that client runs. The [code is source-available](https://github.com/churichard/fluxmail) under the [Fluxmail proprietary license](https://github.com/churichard/fluxmail/blob/main/LICENSE.md).

## How requests flow

Agents connect through MCP, while apps and backend workflows use REST. Both interfaces send email requests through the same service. Fluxmail selects the mailbox, checks access and plan limits, then passes the operation to Gmail, Microsoft Graph, or an IMAP/SMTP server. Account routing, replies, forwards, and provider capabilities stay consistent across MCP and REST.

The CLI is Fluxmail's control interface. It connects mailboxes, manages members and API keys, changes configuration, and starts the MCP and REST services. Local management commands call the control-plane route handlers in the Fluxmail process. Remote CLI profiles call those handlers over HTTPS. Each route resolves the member session or API key, applies the centralized access policy, and then calls the account, member, license, or mail service.

```text
Local CLI --------------------\
Remote CLI and REST -----------> routes -> principal -> policy -> services -> SQLite
HTTP MCP with an API key ------/
```

CLI management commands use the same database and provider connections as the running server. The CLI does not duplicate the MCP and REST mailbox-operation APIs.

Provider differences still affect the available behavior. Outlook uses Microsoft Graph conversations and folders. IMAP has folders instead of labels, uses the mail server's basic search, and has no server-side thread model. Fluxmail reconstructs IMAP threads from standard email headers.

## How permissions are enforced

Every authenticated request acts for one active member. Fluxmail first checks whether the member owns the mailbox, has an explicit grant, or can use it through `sharedWithAll`. It then applies an API key's optional account allowlist. An administrator can manage members and mailbox access, but the role does not grant access to private mailboxes.

Stdio reads the selected local member session. HTTP MCP accepts scoped API keys. REST accepts sessions and API keys. Session authority follows the member's current role. API key authority is the intersection of its stored capabilities, its optional account allowlist, and its owner's current role and mailbox access.

Administrative REST routes add a second check. A session owner must currently be an administrator. An API key also needs the capability for that route. Fluxmail has no memberless keys or unauthenticated mail mode.

Authentication and management operations append rows to `admin_audit_events`. Database triggers prevent these rows from being changed or deleted. The table stores stable identifiers and outcome codes, not passwords, tokens, request bodies, or provider credentials. Fluxmail does not send actor or resource identifiers through anonymous telemetry.

Attachments are returned as embedded MCP resources or raw REST responses. Every provider enforces the configured decoded-size limit before returning the file. The default limit is 10 MB, and the hard maximum is 25 MB.

REST send, scheduled-send, and forward requests use idempotency records in SQLite. Each record is scoped to the authenticated session or API key and retained for 24 hours. This prevents a client retry from repeating the provider call during that period.
