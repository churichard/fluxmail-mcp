---
title: 'Deploy with Docker'
description: 'Run Fluxmail in Docker for remote access or a shared instance.'
updated: '2026-07-17'
---

The [`ghcr.io/churichard/fluxmail`](https://github.com/churichard/fluxmail/pkgs/container/fluxmail) image supports amd64 and arm64. Use Docker when MCP or REST clients connect over a network, or when several clients share one Fluxmail instance.

## Download the server files

```bash
mkdir fluxmail && cd fluxmail
curl -fsSLO https://raw.githubusercontent.com/churichard/fluxmail/main/docker-compose.yml
curl -fsSL https://raw.githubusercontent.com/churichard/fluxmail/main/.env.example -o .env
```

Review `.env` before starting the service.

## Choose the public URL

If Docker and your browser run on the same computer, leave `FLUXMAIL_PUBLIC_URL` unset. Fluxmail will use its local OAuth listener on port 8976.

For a remote deployment, expose Fluxmail through a public HTTPS address and set that address in `.env`:

```dotenv
FLUXMAIL_PUBLIC_URL=https://mail.example.com
```

Your reverse proxy should forward traffic to port 8977. Fluxmail requires authentication for MCP, REST, and CLI requests.

## Start Fluxmail

```bash
docker compose up -d
docker compose exec fluxmail \
  fluxmail setup --name "Your name" --email you@example.com
docker compose exec fluxmail fluxmail status
```

## Connect a mailbox

### Gmail or Google Workspace

A local Docker setup can use Fluxmail's built-in Google Desktop client. A remote server needs a Google Web client with the server's callback URL. Follow [Connect Gmail / Google Workspace](/docs/connect-gmail-to-mcp) before running:

```bash
docker compose exec fluxmail \
  fluxmail accounts add gmail
```

The command prints a Google consent URL. On a remote server, it prints a one-time connection link that expires after 10 minutes.

### Microsoft 365 or Outlook.com

Complete the hosted setup in [Connect Outlook / Exchange](/docs/connect-outlook-to-mcp). Keep the public URL in `.env` because it is deployment configuration:

```dotenv
FLUXMAIL_PUBLIC_URL=https://mail.example.com
```

Restart Fluxmail after changing `.env`, configure the OAuth application, then connect the mailbox:

```bash
docker compose up -d
docker compose exec fluxmail \
  fluxmail oauth configure outlook \
  --client-id <application-client-id>
docker compose exec fluxmail \
  fluxmail accounts add outlook
```

The configure command prompts for the client secret and stores it encrypted in SQLite. In orchestrated deployments, mount the secret and set `MICROSOFT_CLIENT_SECRET_FILE` to its absolute path instead.

Open the one-time link printed by the command. The link expires after 10 minutes.

### IMAP and SMTP

Pass the mailbox password through an environment variable so it does not appear in the command line:

```bash
export IMAP_PASSWORD='your-app-password'
docker compose exec -e IMAP_PASSWORD fluxmail \
  fluxmail accounts add imap \
  --email you@example.com \
  --imap-host imap.example.com \
  --smtp-host smtp.example.com \
  --imap-password-env IMAP_PASSWORD
```

See [Connect IMAP/SMTP](/docs/connect-an-imap-mailbox) for provider settings and folder mapping.

## Create an HTTP API key

MCP over HTTP and REST clients need an API key. Fluxmail displays the key once:

```bash
docker compose exec fluxmail \
  fluxmail apikey create --name desktop
```

The key can reach mailboxes available to its member. Use `--account <account-id>` to limit it to selected mailboxes, and see [Permissions](/docs/permissions) to choose a narrower permission profile.

Continue with [Connect an MCP client](/docs/connect-an-mcp-client) or [Build with REST](/docs/build-with-rest).
