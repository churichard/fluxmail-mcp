---
title: 'Overview'
description: 'How Fluxmail connects agents and apps to Gmail, Outlook, and IMAP through MCP, REST API, and CLI.'
updated: '2026-07-17'
---

Fluxmail is self-hosted email infrastructure for agents and apps. It connects to Gmail, Microsoft 365, Outlook.com, and IMAP/SMTP mailboxes, then provides one service for working with every connected account.

## Choose an interface

| Interface | Use it for |
| --- | --- |
| MCP | Give AI agents tools to read, search, draft, send, and organize email. |
| REST API | Add email to apps, internal tools, and backend workflows through a versioned JSON API. |
| CLI | Install and run Fluxmail, connect mailboxes, manage members and access, and create API keys. |

MCP and REST use the same mailbox operations, permissions, and provider integrations. The CLI configures and runs that service. You do not need a separate Gmail, Microsoft Graph, or IMAP integration for each client.

## How it works

You run Fluxmail on your computer or on a server you control. Agents connect over MCP, apps use the REST API, and the CLI manages either a local or remote named instance. The CLI signs in as a Fluxmail member. Local MCP clients use that member session over stdio, while remote MCP clients use a scoped API key over Streamable HTTP.

```text
Local agents   -> authenticated MCP stdio session -> Fluxmail -> Gmail API
Remote agents  -> scoped MCP HTTP API key --------->          -> Microsoft Graph
Apps and jobs  -> REST API ------------------------>          -> IMAP and SMTP
CLI operators  -> authenticated control plane ---->
```

Fluxmail stores its SQLite database and encrypted provider credentials on the machine where it runs. It does not copy email content to a service operated by Fluxmail. An MCP client may send content returned by Fluxmail to its model provider, depending on how that client works.

## Supported mailboxes

| Provider | Connection method | Notes |
| --- | --- | --- |
| Gmail and Google Workspace | Gmail API with OAuth | Fluxmail includes an OAuth app for local connections. Hosted connections need your own Google Cloud app. |
| Microsoft 365 and Outlook.com | Microsoft Graph with OAuth | You create and control the Microsoft Entra app registration. |
| Other email providers | IMAP for reading and SMTP for sending | The provider must allow IMAP and SMTP access. Some providers require an app password. |

You can connect several mailboxes to one Fluxmail instance. Members and account access rules decide which mailboxes each person can reach. Permission profiles separately control whether a client can only read mail, manage drafts and folders, or send and permanently delete messages.

## Choose where to run it

| Setup | Best for | Available interfaces |
| --- | --- | --- |
| Local process | One person using an agent on the same computer | MCP over stdio, plus the CLI |
| Local HTTP server | Local apps, scripts, or MCP clients that connect by URL | REST API, MCP over Streamable HTTP, plus the CLI |
| Docker server | Remote access, shared instances, or several clients | REST API, MCP over Streamable HTTP, plus the CLI |

The [Quickstart](/docs/quickstart) walks through both setups. [Authentication and instances](/docs/authentication-and-instances) explains member sessions, remote CLI profiles, and API keys. For provider-specific steps, see [Connect Gmail / Google Workspace](/docs/connect-gmail-to-mcp), [Connect Outlook / Exchange](/docs/connect-outlook-to-mcp), or [Connect IMAP/SMTP](/docs/connect-an-imap-mailbox).

## Read next

- [MCP tools](/docs/tools) lists the email operations available to agents.
- [Build with REST](/docs/build-with-rest) walks through common app and backend requests.
- [CLI reference](/docs/cli) covers installation, account setup, access, and server commands.
- [Permissions](/docs/permissions) explains profiles, custom policies, and mailbox scope.
- [Configuration](/docs/configuration) covers server settings, storage paths, and telemetry.
- [Teams and plans](/docs/teams-and-plans) covers members, shared mailboxes, and plan limits.
- [Authentication and instances](/docs/authentication-and-instances) covers login, enrollment, sessions, and remote CLI profiles.
- [Architecture](/docs/architecture) explains data storage and the server's internal structure.
