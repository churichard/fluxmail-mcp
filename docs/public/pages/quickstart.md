---
title: 'Quickstart'
description: 'Install Fluxmail, connect Gmail, Outlook, or IMAP, then choose MCP, REST API, or CLI.'
updated: '2026-07-17'
---

Fluxmail is self-hosted email infrastructure for agents and apps. It connects to Gmail, Microsoft 365, Outlook.com, and IMAP/SMTP mailboxes and runs on a machine you control.

This guide covers installation and mailbox setup, then shows how to connect an MCP client, call the REST API, or manage the service through the CLI. Fluxmail includes a Google Desktop OAuth client for local Gmail connections. Microsoft mail uses your Microsoft Entra app registration, and generic IMAP accounts use credentials from your email provider.

## Choose how to run Fluxmail

Both setups support Gmail, Microsoft mail, and IMAP/SMTP. Choose based on how your clients will reach Fluxmail.

| Setup | Best for | Interfaces |
| --- | --- | --- |
| [Local setup](#local-setup) | One person, local agents, scripts, and development | MCP over stdio or HTTP, REST API, and CLI |
| [Docker server](#docker-setup) | Remote access, shared instances, or several clients | MCP over Streamable HTTP, REST API, and CLI |

The HTTP server also provides the [REST API](/docs/rest-api) at `/api/v1`. You can run it on your computer without Docker by running `fluxmail serve` after connecting a mailbox and creating an API key.

## Local setup

Use this path when Fluxmail and its clients run on the same computer. An MCP client can launch Fluxmail over stdio without a separate server process. REST and HTTP MCP clients use `fluxmail serve`.

### 1. Install the CLI

The local setup requires Node.js 20.20.x, or Node.js 22.22 or newer.

Install Fluxmail globally so the `fluxmail` command is available to your shell and MCP clients:

```bash
npm install -g fluxmail
```

Check that your shell can find it:

```bash
which fluxmail
```

Keep that path handy. Some desktop apps start with a limited `PATH`. If your client cannot find `fluxmail`, use the absolute path returned by this command.

To run Fluxmail without installing it globally, replace `fluxmail` in any local command with `npx -y fluxmail@latest`.

Initialize the local instance. Fluxmail asks for a password without displaying it, creates the first administrator, and logs the CLI in:

```bash
fluxmail setup --name "Your name" --email you@example.com
```

The local login lasts for up to 90 days. Run `fluxmail login --instance local` when it expires or after you log out.

### 2. Connect an email account

Choose one provider:

#### Option A: Gmail or Google Workspace

Start the browser consent flow:

```bash
fluxmail accounts add gmail
```

Fluxmail uses its built-in Google Desktop client with PKCE unless you [configure your own app](/docs/connect-gmail-to-mcp#use-your-own-google-oauth-app).

#### Option B: Microsoft 365 or Outlook.com

Microsoft mail requires an Entra app registration. Before continuing, complete the **Register the application** and **Configure the local callback** sections of [Connect Outlook / Exchange](/docs/connect-outlook-to-mcp).

Store the application client ID, then start the browser consent flow:

```bash
fluxmail config set MICROSOFT_CLIENT_ID <application-client-id>
fluxmail accounts add outlook
```

#### Option C: IMAP and SMTP

Find the IMAP and SMTP hostnames for your email provider, then run the command below. Fluxmail asks for the mailbox password without displaying it:

```bash
fluxmail accounts add imap \
  --email you@example.com \
  --imap-host imap.example.com \
  --smtp-host smtp.example.com
```

The [IMAP setup guide](/docs/connect-an-imap-mailbox) covers app passwords, custom ports and usernames, folder mapping, and Sent-copy behavior.

### 3. Choose an interface

#### MCP over stdio

Every stdio client launches `fluxmail stdio`. Fluxmail uses the member logged in to the selected local instance. These examples use the default `full` profile, which includes every tool. See [Limit what an MCP client can do](/docs/permissions) if you want to restrict a connection.

<details>
<summary>Claude Code</summary>

```bash
claude mcp add fluxmail -- fluxmail stdio
```

</details>

<details>
<summary>Claude Desktop</summary>

Add to `claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "fluxmail": {
      "command": "fluxmail",
      "args": ["stdio"]
    }
  }
}
```

</details>

<details>
<summary>ChatGPT / Codex app</summary>

Open Settings → Plugins → MCPs → Add server, then enter:

- Name: `Fluxmail`
- Type: `STDIO`
- Command to launch: `fluxmail`
- Arguments: `stdio`

Save, then restart the app so it picks up the change.

</details>

<details>
<summary>Codex CLI</summary>

```bash
codex mcp add fluxmail -- fluxmail stdio
```

Or in `~/.codex/config.toml`:

```toml
[mcp_servers.fluxmail]
command = "fluxmail"
args = ["stdio"]
```

</details>

<details>
<summary>Cursor</summary>

Add to `~/.cursor/mcp.json` (or `.cursor/mcp.json` in a project):

```json
{
  "mcpServers": {
    "fluxmail": {
      "command": "fluxmail",
      "args": ["stdio"]
    }
  }
}
```

</details>

<details>
<summary>Hermes</summary>

Add to `~/.hermes/config.yaml`, then run `/reload-mcp` (or use the dashboard at `hermes dashboard`):

```yaml
mcp_servers:
  fluxmail:
    command: 'fluxmail'
    args: ['stdio']
```

</details>

<details>
<summary>Gemini CLI</summary>

Add to `~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "fluxmail": {
      "command": "fluxmail",
      "args": ["stdio"]
    }
  }
}
```

</details>

<details>
<summary>Other stdio clients</summary>

Register `fluxmail` as the command with `stdio` as its argument.

</details>

#### Test the MCP connection

Ask your agent:

> What are the latest 5 emails in my inbox?

If it returns the messages, the connection is working.

#### REST API

Create an API key and start the local HTTP server:

```bash
fluxmail apikey create --name local-app

fluxmail serve
```

Copy the `fmk_...` key when Fluxmail displays it, then test the API in another terminal:

```bash
export FLUXMAIL_API_KEY='fmk_...'

curl http://localhost:8977/api/v1/accounts \
  -H "Authorization: Bearer $FLUXMAIL_API_KEY"
```

The local REST base URL is `http://localhost:8977/api/v1`. Continue with [Build with REST](/docs/build-with-rest) for message, attachment, and sending examples.

#### CLI

The CLI connects mailboxes, manages access, creates API keys, and runs the service. These commands confirm that the local instance is ready:

```bash
fluxmail status
fluxmail accounts list
fluxmail members list
```

See the [CLI reference](/docs/cli) for every command. Email operations such as reading and sending are available through MCP and REST.

## Docker setup

Use this path for a remote deployment, a shared instance, or any MCP or REST client that connects by URL. The Docker image is published for amd64 and arm64 as [`ghcr.io/churichard/fluxmail`](https://github.com/churichard/fluxmail/pkgs/container/fluxmail).

### 1. Download the server config

```bash
mkdir fluxmail && cd fluxmail
curl -fsSLO https://raw.githubusercontent.com/churichard/fluxmail/main/docker-compose.yml
curl -fsSL https://raw.githubusercontent.com/churichard/fluxmail/main/.env.example -o .env
```

Review the settings in `.env` before continuing. If Docker runs on the same computer as your browser, leave `FLUXMAIL_PUBLIC_URL` unset and Fluxmail will use its local OAuth listener on port 8976. For a remote deployment, expose Fluxmail through a public HTTPS address and set `FLUXMAIL_PUBLIC_URL` to that address, such as `https://mail.example.com`.

### 2. Connect an email account

Choose one provider:

#### Option A: Gmail or Google Workspace

Fluxmail uses its built-in Google Desktop client for a local Docker setup. If you set `FLUXMAIL_PUBLIC_URL` for a remote server, [configure a Google Web client](/docs/connect-gmail-to-mcp#use-your-own-google-oauth-app) with that server's callback URL.

```bash
docker compose up -d
docker compose exec fluxmail \
  fluxmail setup --name "Your name" --email you@example.com
docker compose exec fluxmail \
  fluxmail accounts add gmail
```

On local Docker, the command prints a Google consent URL and waits for the callback on `127.0.0.1:8976`. On a remote deployment with `FLUXMAIL_PUBLIC_URL` set, it prints a one-time connection link instead. Open the link in your browser, choose the Google account, and approve access. Hosted links expire after 10 minutes. The CLI must be logged in to create one.

#### Option B: Microsoft 365 or Outlook.com

Complete the hosted setup in [Connect Outlook / Exchange](/docs/connect-outlook-to-mcp). Add the Entra application client ID and secret to `.env`, along with `FLUXMAIL_PUBLIC_URL`:

```dotenv
MICROSOFT_CLIENT_ID=<application-client-id>
MICROSOFT_CLIENT_SECRET=<client-secret-value>
FLUXMAIL_PUBLIC_URL=https://mail.example.com
```

Start Fluxmail, initialize the instance, and connect the mailbox:

```bash
docker compose up -d
docker compose exec fluxmail \
  fluxmail setup --name "Your name" --email you@example.com
docker compose exec fluxmail \
  fluxmail accounts add outlook
```

Open the one-time link, then continue to Microsoft and approve access. The link expires after 10 minutes.

#### Option C: IMAP and SMTP

Find your provider's IMAP and SMTP hostnames. Start the container, then pass the mailbox password through an environment variable so it does not appear in the command line:

```bash
docker compose up -d
docker compose exec fluxmail \
  fluxmail setup --name "Your name" --email you@example.com
export IMAP_PASSWORD='your-app-password'
docker compose exec -e IMAP_PASSWORD fluxmail \
  fluxmail accounts add imap \
  --email you@example.com \
  --imap-host imap.example.com \
  --smtp-host smtp.example.com \
  --imap-password-env IMAP_PASSWORD
```

The [IMAP setup guide](/docs/connect-an-imap-mailbox) covers app passwords, custom ports and usernames, folder mapping, and Sent-copy behavior.

### 3. Create an API key

Create a key for the HTTP client. Fluxmail displays the key once, so copy it when it appears:

```bash
docker compose exec fluxmail \
  fluxmail apikey create --name laptop
```

The key can reach mailboxes available to that member. Add `--account <account-id>` one or more times to narrow it further. New API keys use the `full` profile by default. See [Limit what an MCP client can do](/docs/permissions) to choose a narrower profile or change the key later.

### 4. Choose an HTTP interface

#### MCP over Streamable HTTP

Every HTTP client connects to `http://localhost:8977/mcp`, or your deployed `/mcp` URL, and sends the API key in the `Authorization: Bearer fmk_...` header.

<details>
<summary>Claude Code</summary>

```bash
claude mcp add --transport http fluxmail http://localhost:8977/mcp \
  --header "Authorization: Bearer fmk_..."
```

</details>

<details>
<summary>Claude Desktop</summary>

Claude Desktop's [built-in remote connectors](https://support.anthropic.com/en/articles/11503834-building-custom-integrations-via-remote-mcp-servers) accept OAuth or no authentication, so they cannot send Fluxmail's static API key. Use the local [`mcp-remote`](https://github.com/geelen/mcp-remote) bridge instead.

Add this to `claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "fluxmail": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote@latest",
        "http://localhost:8977/mcp",
        "--allow-http",
        "--transport",
        "http-only",
        "--header",
        "Authorization:${FLUXMAIL_AUTH_HEADER}"
      ],
      "env": {
        "FLUXMAIL_AUTH_HEADER": "Bearer fmk_..."
      }
    }
  }
}
```

Replace `fmk_...` with the API key from step 3, then restart Claude Desktop. This bridge requires Node.js and npm on the same computer as Claude Desktop.

</details>

<details>
<summary>ChatGPT / Codex app</summary>

Open Settings → Plugins → MCPs → Add server, then enter:

- Name: `Fluxmail`
- Type: `Streamable HTTP`
- URL: `http://localhost:8977/mcp`
- Header name: `Authorization`
- Header value: `Bearer fmk_...`

Save, then restart the app so it picks up the change.

</details>

<details>
<summary>Codex CLI</summary>

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.fluxmail]
url = "http://localhost:8977/mcp"
http_headers = { Authorization = "Bearer fmk_..." }
```

</details>

<details>
<summary>Cursor</summary>

Add to `~/.cursor/mcp.json` (or `.cursor/mcp.json` in a project):

```json
{
  "mcpServers": {
    "fluxmail": {
      "url": "http://localhost:8977/mcp",
      "headers": { "Authorization": "Bearer fmk_..." }
    }
  }
}
```

</details>

<details>
<summary>Hermes</summary>

Add to `~/.hermes/config.yaml`, then run `/reload-mcp`:

```yaml
mcp_servers:
  fluxmail:
    url: 'http://localhost:8977/mcp'
    headers:
      Authorization: 'Bearer fmk_...'
```

</details>

<details>
<summary>Gemini CLI</summary>

Add to `~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "fluxmail": {
      "httpUrl": "http://localhost:8977/mcp",
      "headers": { "Authorization": "Bearer fmk_..." }
    }
  }
}
```

</details>

<details>
<summary>ChatGPT.com (developer mode)</summary>

The ChatGPT / Codex app entry above configures Codex inside the ChatGPT app. Developer-mode apps used from regular ChatGPT chats have a separate setup.

ChatGPT cannot connect directly to `localhost`. For a local Docker server, use OpenAI's [Secure MCP Tunnel](https://help.openai.com/en/articles/12584461-developer-mode-and-full-mcp-connectors-in-chatgpt-beta#h_8e76ef4c26) instead of exposing the server to the public internet. You can also deploy Fluxmail at a public HTTPS URL.

ChatGPT connectors currently support OAuth or no authentication, so they cannot send Fluxmail's API key. Fluxmail does not offer an unauthenticated MCP mode. ChatGPT developer-mode apps are not compatible until Fluxmail supports MCP OAuth.

</details>

<details>
<summary>Other HTTP clients</summary>

Point the client at `http://localhost:8977/mcp` and send `Authorization: Bearer fmk_...`. Clients that cannot set an authorization header are not compatible with the HTTP MCP endpoint.

</details>

#### Test the MCP connection

Ask your agent:

> What are the latest 5 emails in my inbox?

If it returns the messages, the connection is working.

#### REST API

The same server exposes REST at `/api/v1`. Test it with the API key from step 3:

```bash
export FLUXMAIL_API_KEY='fmk_...'

curl https://mail.example.com/api/v1/accounts \
  -H "Authorization: Bearer $FLUXMAIL_API_KEY"
```

Replace `https://mail.example.com` with the public URL of your Fluxmail instance. Continue with [Build with REST](/docs/build-with-rest) for common app and backend requests.

#### CLI

Run administrative commands inside the container:

```bash
docker compose exec fluxmail fluxmail status
docker compose exec fluxmail fluxmail accounts list
```

See the [CLI reference](/docs/cli) for the complete command list.

## Next steps

- See [MCP tools](/docs/tools) for the full tool set an agent can call.
- See [Build with REST](/docs/build-with-rest) for app and backend examples.
- See [Limit what an MCP client can do](/docs/permissions) to restrict local connections and API keys.
- See [Connect Gmail / Google Workspace](/docs/connect-gmail-to-mcp) for Google OAuth setup and reconnection help.
- See [Connect Outlook / Exchange](/docs/connect-outlook-to-mcp) for Microsoft Entra setup and reconnection help.
- See [Connect IMAP/SMTP](/docs/connect-an-imap-mailbox) for IMAP/SMTP setup and folder mapping.
- See [Configuration](/docs/configuration) for environment variables.
- See [CLI reference](/docs/cli) for every `fluxmail` command.
- See [Teams & plans](/docs/teams-and-plans) for members, shared mailboxes, and paid-plan licensing.
- See [Authentication and instances](/docs/authentication-and-instances) for login, enrollment, remote profiles, and sessions.
- See [Architecture](/docs/architecture) for where your data lives and how Fluxmail is built.
