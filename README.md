<p align="center">
  <img src="docs/assets/fluxmail-banner.png" alt="Fluxmail" width="100%">
</p>

<p align="center"><a href="https://github.com/churichard/fluxmail-mcp/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/churichard/fluxmail-mcp/ci.yml?branch=main&amp;style=flat-square&amp;label=CI&amp;logo=github"></a> <a href="https://www.npmjs.com/package/fluxmail"><img alt="npm version" src="https://img.shields.io/npm/v/fluxmail?style=flat-square&amp;logo=npm&amp;color=1f4fcc"></a> <a href="https://github.com/churichard/fluxmail-mcp/pkgs/container/fluxmail-mcp"><img alt="Container image" src="https://img.shields.io/badge/GHCR-container-2496ED?style=flat-square&amp;logo=docker&amp;logoColor=white"></a></p>

`fluxmail-mcp` is a self-hosted MCP server that connects AI agents to Gmail and IMAP/SMTP mailboxes. Agents get one set of tools to read, search, draft, send, and organize mail.

- 16 MCP tools, served over stdio (Claude Desktop, Claude Code) or Streamable HTTP (Docker, remote deployments)
- One provider-agnostic model (folders, threads, drafts, a structured query language), so nothing above the provider layer knows it is talking to Gmail
- A single Docker container with SQLite storage; OAuth tokens and mailbox passwords are encrypted at rest with AES-256-GCM
- Free to self-host on the Personal plan (3 mailboxes, 1 member); paid plans add mailboxes and team members

## Getting started

```bash
npm install -g fluxmail
```

To run Fluxmail without installing it globally, replace `fluxmail` in any local CLI command with `npx -y fluxmail@latest`. For example:

```bash
npx -y fluxmail@latest accounts add gmail
```

See the [quickstart](https://fluxmail.ai/docs/quickstart) for how to connect to your email provider and AI agent.

## Tools

| Tool                                             | Description                                                                  |
| ------------------------------------------------ | ---------------------------------------------------------------------------- |
| `list_accounts`                                  | Connected accounts with status and capabilities                              |
| `get_status`                                     | Server health: accounts, auth errors, plan limits                            |
| `list_folders`                                   | Folders/labels with roles (inbox, sent, drafts, …)                           |
| `list_emails`                                    | Metadata and snippets, filterable (folder, sender, unread, dates), paginated |
| `search_emails`                                  | Full-text search with the same filters                                       |
| `get_email` / `get_thread`                       | Full bodies and attachment metadata                                          |
| `create_draft` / `update_draft` / `delete_draft` | Draft management, including reply drafts                                     |
| `send_email`                                     | Send now or schedule with `sendAt`; supports drafts and threaded replies     |
| `list_scheduled_emails`                          | List pending and failed scheduled sends                                      |
| `cancel_scheduled_email`                         | Cancel a scheduled send before delivery                                      |
| `forward_email`                                  | Forward with quoted body and original attachments                            |
| `modify_emails`                                  | Batch: read/unread, star, archive, trash, move, labels, delete               |
| `download_attachment`                            | Inline base64 (up to 2 MB) or save to disk                                   |

`fluxmail-mcp` computes reply recipients on the server (Reply-To or From, plus the original To/Cc minus your own address for reply-all), so an agent can reply-all without assembling the recipient list itself.

## Configuration

Every setting is an environment variable, and there are three places to put one. In precedence order:

1. The shell environment (always wins)
2. `.env.local`, then `.env`, read from the working directory
3. `fluxmail config set <KEY> <value>`, stored in `<data dir>/config.env` and available no matter where you run the CLI from

For a personal setup, `fluxmail config set` is the simplest: set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` once and every command and server mode finds them. Use `fluxmail config list` to review stored settings (secret values are masked) and `fluxmail config unset <KEY>` to remove one.

| Env var                                     | Default                           | Purpose                                                            |
| ------------------------------------------- | --------------------------------- | ------------------------------------------------------------------ |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | (required for Gmail)              | Your Google OAuth app                                              |
| `FLUXMAIL_DATA_DIR`                         | `~/.fluxmail` (`/data` in Docker) | SQLite DB and autogenerated encryption key                         |
| `FLUXMAIL_ENCRYPTION_KEY`                   | autogenerated                     | 64 hex chars; encrypts provider credentials at rest                |
| `FLUXMAIL_PORT`                             | `8977`                            | HTTP port                                                          |
| `FLUXMAIL_PUBLIC_URL`                       | `http://localhost:8977`           | Public HTTPS URL for remote Gmail setup                            |
| `FLUXMAIL_AUTH`                             | `apikey`                          | `none` disables MCP auth (trusted networks only)                   |
| `FLUXMAIL_OAUTH_PORT`                       | `8976`                            | Loopback port for the CLI OAuth flow                               |
| `FLUXMAIL_OAUTH_HOST`                       | `127.0.0.1`                       | OAuth listener bind address (`0.0.0.0` in Docker)                  |
| `FLUXMAIL_LICENSE_KEY`                      | (none)                            | Paid-plan license key; usually set via `fluxmail license activate` |
| `FLUXMAIL_TELEMETRY`                        | `1`                               | Set to `0` to turn off anonymous usage telemetry                   |

## Connect Gmail

For a local installation, run:

```bash
fluxmail accounts add gmail
```

For Docker or a remote server, set `FLUXMAIL_PUBLIC_URL` to the server's public HTTPS address. Register `<FLUXMAIL_PUBLIC_URL>/auth/google/callback` as an authorized redirect URI in Google Cloud, then run the same command on the server:

```bash
docker compose exec fluxmail fluxmail accounts add gmail
```

Open the printed URL in your browser, then select Continue with Google. The link expires after 10 minutes and works once. Fluxmail selects the local or hosted flow from `FLUXMAIL_PUBLIC_URL`; use `--local` or `--hosted` only when you need to override that choice.

## CLI

Using Docker? Prefix these commands with `docker compose exec fluxmail`, for example `docker compose exec fluxmail fluxmail accounts list`.

```
fluxmail serve                      # HTTP server (MCP at /mcp)
fluxmail stdio                      # stdio MCP server
fluxmail accounts add gmail         # OAuth consent flow; add --member <id-or-email> to set an owner
fluxmail accounts add gmail --reauthorize <account-id>
fluxmail accounts add imap --email <address> --imap-host <host> --smtp-host <host>
fluxmail accounts configure <id> --sent-folder <path|auto>
fluxmail accounts list | remove <id>
fluxmail accounts assign <id> --member <id-or-email>   # or --shared
fluxmail members add --name <name> [--email <email>]   # people using this instance
fluxmail members list | remove <id>
fluxmail apikey create --name <name>  # key for the HTTP endpoint (shown once); name it after the client using it
fluxmail apikey create --name <name> --member <id-or-email>
fluxmail apikey list | revoke <id>
fluxmail config set <KEY> <value>   # persist settings in the data dir
fluxmail config list | unset <KEY>
fluxmail telemetry status | enable | disable
fluxmail license activate <key>     # unlock paid-plan limits
fluxmail license status | deactivate
fluxmail status
```

## Telemetry

Fluxmail sends anonymous usage events to Fluxmail's PostHog project. These events show which CLI commands, MCP transports, and MCP tools are in use. They include the Fluxmail and Node.js versions, operating system, architecture, outcomes, and timing.

Fluxmail does not send command arguments, email addresses, account or message IDs, search queries, subjects, message bodies, attachment names, file paths, API keys, license keys, or error messages. PostHog person profiles and GeoIP lookup are disabled. Each installation is counted with a random ID stored in the Fluxmail data directory.

To turn telemetry off, run:

```bash
fluxmail telemetry disable
```

Use `fluxmail telemetry status` to check the setting and `fluxmail telemetry enable` to turn it back on. Fluxmail also respects `FLUXMAIL_TELEMETRY=0` and `DO_NOT_TRACK=1`. See [docs/telemetry.md](docs/telemetry.md) for the event list and the PostHog reports these events support.

## Architecture

```
packages/
  core/             # unified types, the EmailQuery language, the EmailProvider interface
  provider-gmail/   # Gmail adapter (googleapis): query translation, MIME, threading, labels
  provider-imap/    # IMAP/SMTP adapter: folders, search, MIME parts, synthetic threads
  server/           # EmailService, SQLite storage, OAuth, MCP tools, HTTP + stdio transports, CLI
```

MCP tools are thin wrappers over `EmailService`, which owns account routing, reply and forward computation, and plan limits. A future REST API or an expanded CLI would call the same service. Each provider implements one `EmailProvider` interface and declares a `capabilities` object, so tools can degrade cleanly where providers differ (IMAP has no labels, for example).

## Plans

Self-hosting is free on the **Personal** plan: 3 connected mailboxes and 1 member. Paid plans (Pro, Team, Enterprise) raise those limits for teams that share one instance. Each person can connect their own mailboxes, and a mailbox can also be shared. See [fluxmail.ai](https://fluxmail.ai) for current pricing.

A paid plan is unlocked with `fluxmail license activate <key>`. One license activates one instance, and enforcement keeps working offline. If the license lapses, the instance drops back to Personal limits. Deactivating, downgrading, or lapsing never deletes accounts or data.

## License

Fluxmail is proprietary, source-available software. You may inspect, test, and privately modify the source, but production use is limited to your Fluxmail entitlement. Redistribution, hosted resale, competing use, and bypassing license controls are not permitted. See [LICENSE.md](LICENSE.md) for the full terms.
