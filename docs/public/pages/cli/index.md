---
title: 'CLI reference'
description: 'Run the Fluxmail server and manage accounts, members, API keys, configuration, and licenses from the command line.'
updated: '2026-07-15'
---

The Fluxmail CLI starts MCP and REST servers and manages the local Fluxmail instance.

## Install the CLI

Install Fluxmail globally:

```bash
npm install -g fluxmail
```

To run a command without a global installation, replace `fluxmail` with `npx -y fluxmail@latest`. Pin an exact version instead of `@latest` to stay on one release.

If Fluxmail runs under Docker, prefix each command with `docker compose exec fluxmail`. For example:

```bash
docker compose exec fluxmail fluxmail accounts list
```

## Command reference

<!-- BEGIN GENERATED:cli-command-reference -->
| Command | Description |
| --- | --- |
| [`fluxmail serve`](/docs/cli/serve) | Run the HTTP server (MCP at /mcp and REST at /api/v1) |
| [`fluxmail stdio`](/docs/cli/stdio) | Run as a stdio MCP server (for Claude Desktop / Claude Code local config) |
| [`fluxmail accounts`](/docs/cli/accounts) | Manage connected email accounts |
| [`fluxmail accounts add`](/docs/cli/accounts-add) | Connect a Gmail, Outlook, or IMAP account |
| [`fluxmail accounts configure`](/docs/cli/accounts-configure) | Set special folder paths for an IMAP account |
| [`fluxmail accounts list`](/docs/cli/accounts-list) | List connected accounts |
| [`fluxmail accounts remove`](/docs/cli/accounts-remove) | Disconnect an account and delete its stored tokens |
| [`fluxmail accounts assign`](/docs/cli/accounts-assign) | Change mailbox ownership |
| [`fluxmail accounts access`](/docs/cli/accounts-access) | Set who can access a mailbox |
| [`fluxmail members`](/docs/cli/members) | Manage members (people using this instance) |
| [`fluxmail members add`](/docs/cli/members-add) | Add a member (subject to the plan seat limit) |
| [`fluxmail members list`](/docs/cli/members-list) | List members with their mailbox and API key counts |
| [`fluxmail members remove`](/docs/cli/members-remove) | Remove a member after reassigning or removing their mailboxes |
| [`fluxmail members role`](/docs/cli/members-role) | Change a member role |
| [`fluxmail apikey`](/docs/cli/apikey) | Manage API keys for the HTTP MCP and REST APIs |
| [`fluxmail apikey capabilities`](/docs/cli/apikey-capabilities) | List capabilities for API key permission policies |
| [`fluxmail apikey create`](/docs/cli/apikey-create) | Create an API key (shown once) |
| [`fluxmail apikey list`](/docs/cli/apikey-list) | List API keys |
| [`fluxmail apikey accounts`](/docs/cli/apikey-accounts) | Replace or clear an API key mailbox allowlist |
| [`fluxmail apikey permissions`](/docs/cli/apikey-permissions) | Change the permissions for an API key |
| [`fluxmail apikey revoke`](/docs/cli/apikey-revoke) | Revoke an API key |
| [`fluxmail license`](/docs/cli/license) | Manage the paid-tier license |
| [`fluxmail license activate`](/docs/cli/license-activate) | Store a license key and validate it with the license server |
| [`fluxmail license status`](/docs/cli/license-status) | Show the configured license and cached lease |
| [`fluxmail license deactivate`](/docs/cli/license-deactivate) | Release the license from this instance and remove the stored key and cached lease |
| [`fluxmail config`](/docs/cli/config) | Persistent settings stored in the data dir, usable from any directory |
| [`fluxmail config set`](/docs/cli/config-set) | Store a setting (shell env vars and local .env files still take precedence) |
| [`fluxmail config unset`](/docs/cli/config-unset) | Remove a stored setting |
| [`fluxmail config list`](/docs/cli/config-list) | Show stored settings (secret values are masked) |
| [`fluxmail telemetry`](/docs/cli/telemetry) | Manage anonymous usage telemetry |
| [`fluxmail telemetry disable`](/docs/cli/telemetry-disable) | Stop sending anonymous usage telemetry |
| [`fluxmail telemetry enable`](/docs/cli/telemetry-enable) | Allow anonymous usage telemetry |
| [`fluxmail telemetry status`](/docs/cli/telemetry-status) | Show whether anonymous usage telemetry is enabled |
| [`fluxmail status`](/docs/cli/status) | Show accounts, members, entitlements, and provider availability |
<!-- END GENERATED:cli-command-reference -->

Add `--help` to a command to view its usage in the terminal. For example, run `fluxmail accounts add --help`.

## Gmail and Outlook connections

Fluxmail uses the hosted browser flow when `FLUXMAIL_PUBLIC_URL` is a non-loopback address. Otherwise, it uses the local loopback flow. Hosted links expire after 10 minutes and work once.

The `--hosted` and `--local` options override the automatic choice. You cannot combine them or use them with an IMAP account. The provider name `microsoft` is an alias for `outlook`.

## IMAP account options

`fluxmail accounts add imap` accepts separate settings for incoming and outgoing mail. Without a password environment variable, Fluxmail prompts for the password in an interactive terminal.

See [Connect IMAP/SMTP](/docs/connect-an-imap-mailbox) for a complete setup example and help with folder detection.

## MCP permission options

The named profiles are `read-only`, `read-write`, and `full`. Use repeated `--allow` options to build a custom policy. You cannot combine `--profile` and `--allow` on the same command.

Permissions passed to `fluxmail stdio` apply to that process. HTTP permissions are stored with the API key and can be changed with `fluxmail apikey permissions`. See [Permissions](/docs/permissions) for the capability list and workflow requirements.
