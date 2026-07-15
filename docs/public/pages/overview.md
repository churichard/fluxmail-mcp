---
title: 'Overview'
description: 'What Fluxmail MCP does, how it connects AI agents to email, and where to begin.'
updated: '2026-07-14'
---

Fluxmail is a self-hosted MCP server for Gmail, Microsoft 365, Outlook.com, and IMAP/SMTP mailboxes. It gives MCP clients one set of tools for working with email, regardless of the provider behind each account.

An agent can use Fluxmail to read and search messages, follow threads, download attachments, create drafts, send or schedule mail, and organize the inbox. The exact tools available to a client depend on the permissions you give that connection.

## How it works

You run Fluxmail on your computer or on a server you control. Your MCP client connects to it over stdio or Streamable HTTP, and Fluxmail talks to each email provider on the client's behalf.

```text
AI agent -> stdio or Streamable HTTP -> Fluxmail -> Gmail API
                                                -> Microsoft Graph
                                                -> IMAP and SMTP
```

Fluxmail stores its SQLite database and encrypted provider credentials on the machine where it runs. It does not copy email content to a service operated by Fluxmail. Your MCP client may send content returned by the server to its model provider, depending on how that client works.

## Supported mailboxes

| Provider | Connection method | Notes |
| --- | --- | --- |
| Gmail and Google Workspace | Gmail API with OAuth | You create and control the Google Cloud OAuth app. |
| Microsoft 365 and Outlook.com | Microsoft Graph with OAuth | You create and control the Microsoft Entra app registration. |
| Other email providers | IMAP for reading and SMTP for sending | The provider must allow IMAP and SMTP access. Some providers require an app password. |

You can connect several mailboxes to one Fluxmail instance. Members and account access rules decide which mailboxes each person can reach. Permission profiles separately control whether a client can only read mail, manage drafts and folders, or send and permanently delete messages.

## Choose a setup

| Setup | Best for | Transport |
| --- | --- | --- |
| Local process | One person using an agent on the same computer | stdio |
| Docker server | Remote access, shared instances, or several MCP clients | Streamable HTTP |

The [Quickstart](/docs/quickstart) walks through both setups. For provider-specific steps, see [Connect Gmail to the MCP server](/docs/connect-gmail-to-mcp), [Connect Outlook to the MCP server](/docs/connect-outlook-to-mcp), or [Connect an IMAP mailbox](/docs/connect-an-imap-mailbox).

## Read next

- [Tools](/docs/tools) lists the email operations available to agents.
- [Permissions](/docs/permissions) explains profiles, custom policies, and mailbox scope.
- [Configuration](/docs/configuration) covers server settings, storage paths, and telemetry.
- [Teams and plans](/docs/teams-and-plans) covers members, shared mailboxes, and plan limits.
- [Architecture](/docs/architecture) explains data storage and the server's internal structure.
