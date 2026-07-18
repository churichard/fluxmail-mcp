---
title: 'Use the CLI'
description: 'Manage a Fluxmail instance, its mailboxes, members, API keys, and server processes.'
updated: '2026-07-17'
---

The Fluxmail CLI configures and runs the service. Email operations such as reading, drafting, and sending are available through MCP and REST.

Complete the [Quickstart](/docs/quickstart) before using the workflows below.

## Check the instance

```bash
fluxmail status
fluxmail accounts list
fluxmail members list
```

`fluxmail status` reports provider availability, connected mailboxes, and mailboxes that need to be reauthorized.

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
