---
title: 'Limit what a connection can do'
description: 'Give each MCP or REST connection only the Fluxmail email permissions it needs.'
updated: '2026-07-14'
---

Fluxmail can limit the email actions available to each MCP or REST connection. Give a research client read-only access, or let an inbox organizer manage messages without granting send or permanent-delete access.

Permissions control which MCP tools Fluxmail exposes and which REST routes or message actions a key can call.

Mailbox scope is separate from permissions. The member and optional account allowlist decide which mailboxes a connection can reach. The permission profile decides what it can do with those mailboxes. Fluxmail applies both checks to every connection.

## Choose a permission profile

<!-- BEGIN GENERATED:permission-profiles -->
| Profile | What it allows | Capabilities |
| --- | --- | --- |
| `read-only` | Read and search mail, inspect folders and scheduled sends, and download attachments. | `mail.read` |
| `read-write` | Read mail, manage drafts, organize messages, and move messages to or from Trash. | `mail.read`, `mail.drafts`, `mail.organize`, `mail.trash` |
| `full` | Use every Fluxmail email capability, including sending mail and permanently deleting messages. | `mail.read`, `mail.drafts`, `mail.organize`, `mail.trash`, `mail.delete`, `mail.send` |
<!-- END GENERATED:permission-profiles -->

Fluxmail uses `full` when you do not choose a profile. Set a narrower profile for clients that do not need every email action.

## Limit a local stdio connection

Pass a profile when your MCP client launches Fluxmail:

```bash
fluxmail stdio --member you@example.com --profile read-only
```

For a client config file, put the profile in the argument list:

```json
{
  "mcpServers": {
    "fluxmail": {
      "command": "fluxmail",
      "args": [
        "stdio",
        "--member",
        "you@example.com",
        "--profile",
        "read-only"
      ]
    }
  }
}
```

## Limit an HTTP connection

HTTP permissions belong to the API key. Each key also belongs to a member. Create a separate key for each MCP or REST client so you can change or revoke one connection without affecting the others.

```bash
fluxmail apikey create \
  --name research-agent \
  --member you@example.com \
  --profile read-only
fluxmail apikey create \
  --name inbox-agent \
  --member you@example.com \
  --profile read-write
```

The key is shown once. `fluxmail apikey list` shows each key ID and permission profile without revealing the secret.

Change an existing key by its ID:

```bash
fluxmail apikey permissions <key-id> --profile read-only
```

Existing keys and keys created without permission options use `full`. When `FLUXMAIL_AUTH=none`, the HTTP endpoint also uses `full` because there is no API key to identify the client. Only disable authentication behind a network boundary you control.

## Build a custom policy

Use repeated `--allow` options when the named profiles are too broad. List the available capabilities first:

```bash
fluxmail apikey capabilities
```

<!-- BEGIN GENERATED:permission-capabilities -->
| Capability | Actions |
| --- | --- |
| `mail.read` | List, search, and read mail; inspect status and folders; list scheduled sends; download attachments. |
| `mail.drafts` | Create, update, and delete drafts; cancel scheduled sends. |
| `mail.organize` | Mark read or unread, star, archive, move, and manage user labels. |
| `mail.trash` | Move messages to or from Trash. |
| `mail.delete` | Permanently delete messages. |
| `mail.send` | Send or schedule messages. |
<!-- END GENERATED:permission-capabilities -->

Create a custom HTTP key like this:

```bash
fluxmail apikey create \
  --name drafting-agent \
  --member you@example.com \
  --allow mail.read \
  --allow mail.drafts
```

The same options work with stdio:

```bash
fluxmail stdio \
  --member you@example.com \
  --allow mail.read \
  --allow mail.organize
```

Some workflows need more than one capability. Reply drafts need `mail.drafts` and `mail.read`; replies need `mail.send` and `mail.read`; forwarding also needs `mail.send` and `mail.read`.
