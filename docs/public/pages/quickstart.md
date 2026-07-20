---
title: 'Quickstart'
description: 'Install Fluxmail, create the first administrator, and connect a Gmail, Outlook, or IMAP mailbox.'
updated: '2026-07-17'
---

Fluxmail runs on your computer or on a server you control. This guide gets the service ready for MCP, REST, and CLI clients.

## 1. Install Fluxmail

Choose a local installation for personal use and local development. Use Docker when clients will connect over a network or several people share the instance.

### Local installation

The local installation requires Node.js 20.20.x, or Node.js 22.22 or newer.

```bash
npm install -g fluxmail
```

Check that your shell can find the command:

```bash
which fluxmail
```

Some desktop apps start with a limited `PATH`. If an app cannot find `fluxmail`, use the absolute path printed by `which fluxmail` in that app's configuration.

To run Fluxmail without a global installation, replace `fluxmail` in local commands with `npx -y fluxmail@latest`.

Create the first administrator and log in. Fluxmail asks for a password without displaying it:

```bash
fluxmail setup --name "Your name" --email you@example.com
```

### Docker installation

Create a directory for Fluxmail and download the server files:

```bash
mkdir fluxmail && cd fluxmail
curl -fsSLO https://raw.githubusercontent.com/churichard/fluxmail/main/docker-compose.yml
curl -fsSL https://raw.githubusercontent.com/churichard/fluxmail/main/.env.example -o .env
docker compose up -d
docker compose exec fluxmail \
  fluxmail setup --name "Your name" --email you@example.com
```

Commands in the rest of this guide use the local `fluxmail` form. With Docker, run mailbox and status commands through `docker compose exec fluxmail`. For example:

```bash
docker compose exec fluxmail fluxmail status
```

Read [Deploy with Docker](/docs/deploy-with-docker) before exposing Fluxmail outside your computer. Remote OAuth connections need a public HTTPS URL and provider settings.

The login created by `fluxmail setup` lasts for up to 90 days. See [Authentication and instances](/docs/authentication-and-instances) for login, enrollment, sessions, and remote CLI profiles.

## 2. Connect a mailbox

Choose your email provider.

### Gmail or Google Workspace

Start the browser consent flow:

```bash
fluxmail accounts add gmail
```

Local connections use Fluxmail's built-in Google Desktop OAuth client. A remote server needs a Google Web client. See [Connect Gmail / Google Workspace](/docs/connect-gmail-to-mcp) for remote setup, custom OAuth credentials, and reconnection help.

### Microsoft 365 or Outlook.com

Microsoft mail requires an Entra app registration. Complete the local or hosted app setup in [Connect Outlook / Exchange](/docs/connect-outlook-to-mcp).

For a local installation, configure a public client and connect the mailbox:

```bash
fluxmail oauth configure outlook \
  --client-id <application-client-id> \
  --public-client
fluxmail accounts add outlook
```

For Docker, put the client ID in `.env` instead. The Outlook guide lists the client secret and public URL required for a remote server. Recreate the container, then connect the mailbox:

```dotenv
MICROSOFT_CLIENT_ID=<application-client-id>
```

```bash
docker compose up -d
docker compose exec fluxmail \
  fluxmail accounts add outlook
```

### IMAP and SMTP

Use the server names supplied by your email provider. Fluxmail asks for the mailbox password without displaying it:

```bash
fluxmail accounts add imap \
  --email you@example.com \
  --imap-host imap.example.com \
  --smtp-host smtp.example.com
```

See [Connect IMAP/SMTP](/docs/connect-an-imap-mailbox) for app passwords, custom ports and usernames, folder mapping, and Sent-copy behavior.

## 3. Check the setup

```bash
fluxmail status
fluxmail accounts list
```

The connected mailbox should appear as ready. If Fluxmail reports that the mailbox needs attention, follow the provider guide linked above.

## Choose an interface

Fluxmail is now ready. Continue with the interface your client uses:

| Interface | Next guide |
| --- | --- |
| MCP | [Connect an MCP client](/docs/connect-an-mcp-client) |
| REST API | [Build with REST](/docs/build-with-rest) |
| CLI | [Use the CLI](/docs/use-the-cli) |

MCP and REST expose email operations. The CLI connects mailboxes, manages access, creates API keys, and runs the service.
