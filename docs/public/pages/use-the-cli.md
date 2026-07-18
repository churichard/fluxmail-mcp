---
title: 'Use the CLI'
description: 'Read and manage email, then configure the Fluxmail instance from the same command line.'
updated: '2026-07-18'
---

The Fluxmail CLI can read, draft, send, schedule, and organize email. It also configures and runs the service. Mail commands call the same authenticated REST operations for local and remote instances, so permissions and mailbox access rules stay the same across CLI, MCP, and REST.

Complete the [Quickstart](/docs/quickstart) before using the workflows below.

## Check the instance

```bash
fluxmail status
fluxmail accounts list
fluxmail members list
```

`fluxmail status` reports provider availability, connected mailboxes, and mailboxes that need to be reauthorized.

## Choose a mailbox

Mail commands use the only accessible mailbox when there is exactly one. If you can access several mailboxes, pass the global account option with an account ID or email address:

```bash
fluxmail --account you@example.com emails list --folder inbox
fluxmail -a <account-id> labels list
```

Fluxmail returns an error when it cannot choose one mailbox safely.

## Read and search email

List inbox messages, search across mail, or fetch a complete message or thread:

```bash
fluxmail emails list --folder inbox --unread-only --page-size 20
fluxmail emails search "quarterly report" --from ann@example.com
fluxmail emails get <message-id>
fluxmail threads get <thread-id>
```

List responses include `meta.nextPageToken` when another page is available. Pass it back with `--page-token`. New mail commands print the complete REST JSON envelope, including `data`, pagination metadata, and warnings.

Folders are navigable mailbox locations. Labels are Gmail user labels or Outlook categories:

```bash
fluxmail folders list
fluxmail labels list
```

Gmail user labels appear in both listings because Gmail uses them as mailbox views and message tags. IMAP mailboxes support folders but not labels.

## Draft, send, and forward

Build a message with flags:

```bash
fluxmail drafts create \
  --to ann@example.com \
  --subject "Quarterly report" \
  --body-file report.txt \
  --attach report.pdf

fluxmail emails send \
  --to ann@example.com \
  --subject "Quarterly report" \
  --body "The report is attached." \
  --attach report.pdf
```

Use `--html` or `--html-file` for an HTML body. Repeat `--to`, `--cc`, `--bcc`, and `--attach` as needed. If standard input is redirected and no body option is present, Fluxmail uses standard input as the plain-text body.

Reply, send an existing draft, schedule delivery, or forward a message:

```bash
fluxmail emails send --reply-to <message-id> --reply-all --body "Thanks, everyone."
fluxmail emails send --draft <draft-id>
fluxmail emails send --to ann@example.com --body "Later" --send-at 2026-08-01T12:00:00Z
fluxmail emails forward <message-id> --to lee@example.com --no-attachments
```

Fluxmail creates an idempotency key for each send or forward command. Pass `--idempotency-key` when a script needs to retry the same delivery request.

## Organize messages

Apply one action to one or more message IDs:

```bash
fluxmail emails modify mark-read <message-id>
fluxmail emails modify archive <message-id-1> <message-id-2>
fluxmail emails modify move <message-id> --folder Projects
fluxmail emails modify add-labels <message-id> --label Customer
```

The available actions are `mark-read`, `mark-unread`, `star`, `unstar`, `archive`, `trash`, `untrash`, `delete`, `move`, `add-labels`, and `remove-labels`. Label actions work with Gmail labels and Outlook categories.

List or cancel scheduled sends:

```bash
fluxmail scheduled list
fluxmail scheduled cancel <schedule-id>
```

## Download attachments

Choose the destination path explicitly:

```bash
fluxmail attachments download <message-id> <attachment-id> --output ./report.pdf
```

Fluxmail will not replace an existing file unless you pass `--force`. The command prints JSON metadata after it writes the attachment.

## Send exact REST JSON

Draft, send, forward, and modify commands accept an exact REST request body from a file or standard input:

```bash
fluxmail emails send --input request.json
fluxmail emails modify --input - < request.json
```

`--input` cannot be combined with flags that build the same request body. Send and forward commands still accept `--idempotency-key` with JSON input.

## Run the HTTP server

```bash
fluxmail serve
```

The server listens on port 8977 by default. It provides MCP at `/mcp` and REST at `/api/v1`.

For a local MCP client that uses stdio, the client launches this command instead:

```bash
fluxmail stdio
```

See [Connect an MCP client](/docs/connect-an-mcp-client) for client configuration and transport options.

## Manage mailboxes and members

Connect another mailbox or list the existing mailboxes:

```bash
fluxmail accounts add gmail
fluxmail accounts list
```

Administrators can invite members and share mailboxes with them:

```bash
fluxmail members add --name "Another person" --email person@example.com
fluxmail accounts access <account-id> --share-with person@example.com
```

See [Teams and plans](/docs/teams-and-plans) for mailbox sharing and plan limits.

## Manage API keys

Create a key for an HTTP MCP or REST client:

```bash
fluxmail apikey create --name local-client
```

Fluxmail shows the key once. You can list, change, or revoke keys without exposing their stored secrets:

```bash
fluxmail apikey list
fluxmail apikey permissions <key-id> --profile read-only
fluxmail apikey revoke <key-id>
```

See [Permissions](/docs/permissions) for profiles, custom capabilities, and mailbox restrictions.

## Use the CLI with Docker

Prefix commands with `docker compose exec fluxmail`:

```bash
docker compose exec fluxmail fluxmail status
docker compose exec fluxmail fluxmail accounts list
```

See [Deploy with Docker](/docs/deploy-with-docker) for remote server setup.

## Command reference

Run `fluxmail --help` or add `--help` to a command for terminal help:

```bash
fluxmail accounts add --help
fluxmail emails send --help
```

The [CLI reference](/docs/cli) lists every command and option.

## Update Fluxmail

Fluxmail checks npm for a newer stable release at most once every 24 hours when you run an interactive CLI command. The check runs in the background. If it finds a newer release, a later command prints an update notice to stderr. Registry and cache errors do not affect the command.

Update a global installation:

```bash
npm install -g fluxmail@latest
```

`npx -y fluxmail@latest` already downloads the current stable release. If you use an exact version with `npx`, change the version in the command when you are ready to update.

For Docker, pull the current image and recreate the service:

```bash
docker compose pull fluxmail
docker compose up -d
```

Fluxmail does not show update notices for MCP stdio, redirected output, CI, npm scripts, or `npx` runs. Skip the check for one command with the global option:

```bash
fluxmail --no-update-notifier status
```

Set `NO_UPDATE_NOTIFIER=1` in your shell or container environment to turn off update checks. This variable controls only CLI update checks and is not stored by `fluxmail config set`.
