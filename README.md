# Fluxmail

Fluxmail is a self-hosted MCP server that connects AI agents to your email. It talks to Gmail through the Gmail API; Outlook (Microsoft Graph) and IMAP adapters are next. Agents get one set of tools to read, search, draft, send, and organize mail, and those tools stay the same as more providers land.

- 14 MCP tools, served over stdio (Claude Desktop, Claude Code) or Streamable HTTP (Docker, remote deployments)
- One provider-agnostic model (folders, threads, drafts, a structured query language), so nothing above the provider layer knows it is talking to Gmail
- A single Docker container with SQLite storage; OAuth tokens are encrypted at rest with AES-256-GCM
- Free to self-host on the Personal plan (3 mailboxes, 1 member); paid plans add mailboxes and team members

## Getting started

### 1. Install

Requires Node 20+.

```bash
npm install -g fluxmail
```

### 2. Create Google OAuth credentials

Fluxmail uses your own Google Cloud OAuth app:

1. Create a project at [console.cloud.google.com](https://console.cloud.google.com) and enable the **Gmail API** (APIs & Services → Library).
2. Configure the **OAuth consent screen**: choose External and add yourself (plus anyone else who will connect an account) as test users. Testing mode is fine for self-hosting; Google does not require verification for up to 100 test users.
3. Create credentials → **OAuth client ID** → type **Web application**, with these authorized redirect URIs:
   - `http://localhost:8976/oauth/callback` (used by `fluxmail accounts add gmail`)
   - `<your FLUXMAIL_BASE_URL>/auth/google/callback` (only if you use the server-hosted flow on a remote deployment)

Fluxmail requests the full `https://mail.google.com/` scope because the unified API supports permanent delete, which Gmail's narrower scopes don't allow. While your consent screen is in Google's "Testing" status, refresh tokens expire 7 days after they are issued, even if Fluxmail uses them during that time. When a token expires, find the account ID with `fluxmail accounts list`, then run `fluxmail accounts add gmail --reauthorize <account-id>`. You can also publish the consent screen to "In production" for long-lived tokens.

### 3. Run Fluxmail and connect your Gmail

Two ways to run it; pick one.

**Option A: local process (stdio).** Simplest for personal use on one machine.

```bash
# Store your Google credentials once; they live in ~/.fluxmail/config.env
fluxmail config set GOOGLE_CLIENT_ID <your-client-id>.apps.googleusercontent.com
fluxmail config set GOOGLE_CLIENT_SECRET <your-client-secret>

# Connect your Gmail (opens a browser consent flow)
fluxmail accounts add gmail
```

**Option B: Docker (Streamable HTTP server).** For a shared or remote deployment; run from a clone of this repo.

```bash
cp .env.example .env               # fill in GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET
docker compose up -d

# Create an API key (shown once). You'll pass it to your agent in step 4.
# Pick any name that tells you which client the key is for, e.g. "laptop".
docker compose exec fluxmail fluxmail apikey create --name laptop

# Connect your Gmail: prints a consent URL; open it in your browser
docker compose exec fluxmail fluxmail accounts add gmail
```

### 4. Connect your agent

Follow the subsection matching how you ran Fluxmail in step 3.

#### Option A: stdio

Every client launches the same command: `fluxmail stdio`. Your Google credentials come from `fluxmail config set` (step 3), so the snippets need no environment variables. Two notes:

- Desktop apps sometimes launch with a minimal PATH and fail to find `fluxmail` (common with nvm installs). If that happens, use the absolute path from `which fluxmail` as the command.
- If you skipped `fluxmail config set`, add `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` to the client's env settings instead.

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

Open Settings -> Plugins -> MCPs -> Add server, then enter:

- Name: `Fluxmail`
- Type: `STDIO`
- Command to launch: `fluxmail`
- Argument: `stdio`

If the app cannot find `fluxmail`, use the absolute path from `which fluxmail` as the command.

Save, then make sure to restart the app in order for the changes to be picked up.

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
    command: "fluxmail"
    args: ["stdio"]
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
<summary>VS Code (Copilot agent mode)</summary>

Add to `.vscode/mcp.json` in a workspace, or run "MCP: Add Server" from the command palette:

```json
{
  "servers": {
    "fluxmail": {
      "type": "stdio",
      "command": "fluxmail",
      "args": ["stdio"]
    }
  }
}
```

</details>

<details>
<summary>Other MCP clients</summary>

Register `fluxmail` as the command with `stdio` as its argument, in whatever shape your client's config uses.

</details>

#### Option B: Streamable HTTP

Every client connects to `http://localhost:8977/mcp` (or your deployed URL) and authenticates with the header `Authorization: Bearer fmk_...`, using the API key from step 3.

<details>
<summary>Claude Code</summary>

```bash
claude mcp add --transport http fluxmail http://localhost:8977/mcp \
  --header "Authorization: Bearer fmk_..."
```

</details>

<details>
<summary>ChatGPT / Codex app</summary>

Open Settings -> Plugins -> MCPs -> Add server, then enter:

- Name: `Fluxmail`
- Type: `Streamable HTTP`
- URL: `http://localhost:8977/mcp`
- Header name: `Authorization`
- Header value: `Bearer fmk_...`

Save, then make sure to restart the app in order for the changes to be picked up.

</details>

<details>
<summary>Codex CLI</summary>

Add the following to `~/.codex/config.toml`:

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

Add to `~/.hermes/config.yaml`, then run `/reload-mcp` (or use the dashboard at `hermes dashboard`):

```yaml
mcp_servers:
  fluxmail:
    url: "http://localhost:8977/mcp"
    headers:
      Authorization: "Bearer fmk_..."
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
<summary>VS Code (Copilot agent mode)</summary>

Add to `.vscode/mcp.json` in a workspace, or run "MCP: Add Server" from the command palette:

```json
{
  "servers": {
    "fluxmail": {
      "type": "http",
      "url": "http://localhost:8977/mcp",
      "headers": { "Authorization": "Bearer fmk_..." }
    }
  }
}
```

</details>

<details>
<summary>ChatGPT chats (developer mode)</summary>

The instructions above configure Fluxmail for Codex inside the ChatGPT app. Developer-mode apps used from regular ChatGPT chats have a separate connection setup.

ChatGPT cannot connect directly to `localhost`. For a local Docker server, use OpenAI's [Secure MCP Tunnel](https://help.openai.com/en/articles/12584461-developer-mode-and-full-mcp-connectors-in-chatgpt-beta#h_8e76ef4c26) rather than exposing the server to the public internet. You can also deploy Fluxmail at a public HTTPS URL.

ChatGPT connectors support OAuth or no authentication; they cannot send Fluxmail's static bearer API key. Until Fluxmail supports MCP OAuth, run it with `FLUXMAIL_AUTH=none` only behind the secure tunnel or a network boundary you control. Then enable developer mode (Settings → Apps → Advanced Settings) and create an app pointing at your `/mcp` URL.

MCP OAuth support, which would remove this limitation, is on the roadmap.

</details>

<details>
<summary>Other MCP clients</summary>

Point the client at the `/mcp` URL and send `Authorization: Bearer fmk_...`. Clients that cannot set an authorization header are not compatible with API-key mode; use a trusted network with `FLUXMAIL_AUTH=none` instead.

</details>

## Tools

| Tool | Description |
|---|---|
| `list_accounts` | Connected accounts with status and capabilities |
| `get_status` | Server health: accounts, auth errors, plan limits |
| `list_folders` | Folders/labels with roles (inbox, sent, drafts, …) |
| `list_emails` | Metadata and snippets, filterable (folder, sender, unread, dates), paginated |
| `search_emails` | Full-text search with the same filters |
| `get_email` / `get_thread` | Full bodies and attachment metadata |
| `create_draft` / `update_draft` / `delete_draft` | Draft management, including reply drafts |
| `send_email` | Direct send, send a draft, or reply (`replyToMessageId`, `replyAll`) with correct threading |
| `forward_email` | Forward with quoted body and original attachments |
| `modify_emails` | Batch: read/unread, star, archive, trash, move, labels, delete |
| `download_attachment` | Inline base64 (up to 2 MB) or save to disk |

Fluxmail computes reply recipients on the server (Reply-To or From, plus the original To/Cc minus your own address for reply-all), so an agent can reply-all without assembling the recipient list itself.

## Configuration

Every setting is an environment variable, and there are three places to put one. In precedence order:

1. The shell environment (always wins)
2. `.env.local`, then `.env`, read from the working directory
3. `fluxmail config set <KEY> <value>`, stored in `<data dir>/config.env` and available no matter where you run the CLI from

For a personal setup, `fluxmail config set` is the simplest: set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` once and every command and server mode finds them. Use `fluxmail config list` to review stored settings (secret values are masked) and `fluxmail config unset <KEY>` to remove one.

| Env var | Default | Purpose |
|---|---|---|
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | (required for Gmail) | Your Google OAuth app |
| `FLUXMAIL_DATA_DIR` | `~/.fluxmail` (`/data` in Docker) | SQLite DB and autogenerated encryption key |
| `FLUXMAIL_ENCRYPTION_KEY` | autogenerated | 64 hex chars; encrypts OAuth tokens at rest |
| `FLUXMAIL_PORT` | `8977` | HTTP port |
| `FLUXMAIL_BASE_URL` | `http://localhost:8977` | Public URL, used for OAuth redirect URIs |
| `FLUXMAIL_AUTH` | `apikey` | `none` disables MCP auth (trusted networks only) |
| `FLUXMAIL_OAUTH_PORT` | `8976` | Loopback port for the CLI OAuth flow |
| `FLUXMAIL_OAUTH_HOST` | `127.0.0.1` | OAuth listener bind address (`0.0.0.0` in Docker) |
| `FLUXMAIL_LICENSE_KEY` | (none) | Paid-plan license key; usually set via `fluxmail license activate` |

## CLI

Running under Docker (Option B)? Prefix any of these with `docker compose exec fluxmail` so the command runs inside the container, e.g. `docker compose exec fluxmail fluxmail accounts list`.

```
fluxmail serve                      # HTTP server (MCP at /mcp)
fluxmail stdio                      # stdio MCP server
fluxmail accounts add gmail         # OAuth consent flow; add --member <id-or-email> to set an owner
fluxmail accounts add gmail --reauthorize <account-id>
fluxmail accounts list | remove <id>
fluxmail accounts assign <id> --member <id-or-email>   # or --shared
fluxmail members add --name <name> [--email <email>]   # people using this instance
fluxmail members list | remove <id>
fluxmail apikey create --name <name>  # key for the HTTP endpoint (shown once); name it after the client using it
fluxmail apikey create --name <name> --member <id-or-email>
fluxmail apikey list | revoke <id>
fluxmail config set <KEY> <value>   # persist settings in the data dir
fluxmail config list | unset <KEY>
fluxmail license activate <key>     # unlock paid-plan limits
fluxmail license status | deactivate
fluxmail status
```

## Architecture

```
packages/
  core/             # unified types, the EmailQuery language, the EmailProvider interface
  provider-gmail/   # Gmail adapter (googleapis): query translation, MIME, threading, labels
  server/           # EmailService, SQLite storage, OAuth, MCP tools, HTTP + stdio transports, CLI
```

MCP tools are thin wrappers over `EmailService`, which owns account routing, reply and forward computation, and plan limits. A future REST API or an expanded CLI would call the same service. Each provider implements one `EmailProvider` interface and declares a `capabilities` object, so tools can degrade cleanly where providers differ (IMAP has no labels, for example).

## Plans

Self-hosting is free on the **Personal** plan: 3 connected mailboxes and 1 member. Paid plans (Pro, Team, Enterprise) raise those limits for teams that share one instance — each person connects their own mailboxes, and a mailbox can also be shared. See [fluxmail.ai](https://fluxmail.ai) for current pricing.

A paid plan is unlocked with `fluxmail license activate <key>`. One license activates one instance, and enforcement keeps working offline. If the license lapses, the instance drops back to Personal limits. Deactivating, downgrading, or lapsing never deletes accounts or data.
