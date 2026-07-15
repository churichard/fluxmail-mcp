---
title: 'CLI reference'
description: 'Every command the Fluxmail CLI exposes for running the server and managing accounts, members, API keys, config, and licenses.'
updated: '2026-07-14'
---

> **Running under Docker?** Prefix any of these with `docker compose exec fluxmail` so the command runs inside the container, e.g. `docker compose exec fluxmail fluxmail accounts list`.

Install the CLI globally before using this reference:

```bash
npm install -g fluxmail
```

To run a command without a global installation, replace `fluxmail` with `npx -y fluxmail@latest`. Pin an exact version instead of `@latest` if you want to stay on one release.

<!-- BEGIN GENERATED:cli -->
| Command | Description | Options |
| --- | --- | --- |
| `fluxmail serve` | Run the HTTP server (MCP at /mcp and REST at /api/v1) | None |
| `fluxmail stdio` | Run as a stdio MCP server (for Claude Desktop / Claude Code local config) | `--member <member>`, `--account <account>`, `--profile <profile>`, `--allow <capability>` |
| `fluxmail accounts` | Manage connected email accounts | None |
| `fluxmail accounts add <provider>` | Connect a Gmail, Outlook, or IMAP account | `--reauthorize <account-id>`, `--owner <member>`, `--member <member>`, `--shared`, `--share-with <member>`, `--local`, `--hosted`, `--email <address>`, `--display-name <name>`, `--imap-host <host>`, `--imap-port <port>`, `--imap-security <mode>`, `--imap-user <user>`, `--imap-password-env <name>`, `--smtp-host <host>`, `--smtp-port <port>`, `--smtp-security <mode>`, `--smtp-user <user>`, `--smtp-password-env <name>`, `--sent-folder <path>`, `--drafts-folder <path>`, `--trash-folder <path>`, `--archive-folder <path>`, `--spam-folder <path>`, `--no-save-sent` |
| `fluxmail accounts configure <accountId>` | Set special folder paths for an IMAP account | `--sent-folder <path>`, `--drafts-folder <path>`, `--trash-folder <path>`, `--archive-folder <path>`, `--spam-folder <path>` |
| `fluxmail accounts list` | List connected accounts | None |
| `fluxmail accounts remove <accountId>` | Disconnect an account and delete its stored tokens | None |
| `fluxmail accounts assign <accountId>` | Change mailbox ownership | `--owner <member>`, `--member <member>`, `--shared` |
| `fluxmail accounts access <accountId>` | Set who can access a mailbox | `--owner-only`, `--shared`, `--share-with <member>` |
| `fluxmail members` | Manage members (people using this instance) | None |
| `fluxmail members add` | Add a member (subject to the plan seat limit) | `--name <name>`, `--email <email>`, `--role <role>` |
| `fluxmail members list` | List members with their mailbox and API key counts | None |
| `fluxmail members remove <memberId>` | Remove a member after reassigning or removing their mailboxes | None |
| `fluxmail members role <member> <role>` | Change a member role | None |
| `fluxmail apikey` | Manage API keys for the HTTP MCP and REST APIs | None |
| `fluxmail apikey capabilities` | List capabilities for API key permission policies | None |
| `fluxmail apikey create` | Create an API key (shown once) | `--name <name>`, `--member <member>`, `--account <account>`, `--profile <profile>`, `--allow <capability>`, `--admin <capability>` |
| `fluxmail apikey list` | List API keys | None |
| `fluxmail apikey accounts <keyId>` | Replace or clear an API key mailbox allowlist | `--account <account>`, `--all-accounts` |
| `fluxmail apikey permissions <keyId>` | Change the permissions for an API key | `--profile <profile>`, `--allow <capability>`, `--admin <capability>` |
| `fluxmail apikey revoke <keyId>` | Revoke an API key | None |
| `fluxmail license` | Manage the paid-tier license | None |
| `fluxmail license activate <key>` | Store a license key and validate it with the license server | None |
| `fluxmail license status` | Show the configured license and cached lease | None |
| `fluxmail license deactivate` | Release the license from this instance and remove the stored key and cached lease | None |
| `fluxmail config` | Persistent settings stored in the data dir, usable from any directory | None |
| `fluxmail config set <key> <value>` | Store a setting (shell env vars and local .env files still take precedence) | None |
| `fluxmail config unset <key>` | Remove a stored setting | None |
| `fluxmail config list` | Show stored settings (secret values are masked) | None |
| `fluxmail telemetry` | Manage anonymous usage telemetry | None |
| `fluxmail telemetry disable` | Stop sending anonymous usage telemetry | None |
| `fluxmail telemetry enable` | Allow anonymous usage telemetry | None |
| `fluxmail telemetry status` | Show whether anonymous usage telemetry is enabled | None |
| `fluxmail status` | Show accounts, members, entitlements, and provider availability | None |
<!-- END GENERATED:cli -->

For Gmail and Outlook, Fluxmail uses the hosted browser flow when `FLUXMAIL_PUBLIC_URL` is set to a non-loopback address and the local loopback flow otherwise. Hosted links expire after 10 minutes and work once. The `--hosted` and `--local` flags override the automatic choice; they cannot be used together or with an IMAP account. The provider name `microsoft` is accepted as an alias for `outlook`.

## IMAP account options

`fluxmail accounts add imap` accepts separate connection settings for incoming and outgoing mail:

```
--email <address>             Mailbox address (required)
--display-name <name>         Sender name
--imap-host <host>            IMAP hostname (required)
--imap-port <port>            Defaults to 993
--imap-security <mode>        tls (default) or starttls
--imap-user <user>            Defaults to the mailbox address
--imap-password-env <name>    Read the IMAP password from an environment variable
--smtp-host <host>            SMTP hostname (required)
--smtp-port <port>            Defaults to 587
--smtp-security <mode>        starttls (default) or tls
--smtp-user <user>            Defaults to the IMAP username
--smtp-password-env <name>    Read a separate SMTP password from an environment variable
--sent-folder <path>          Override the detected Sent folder
--drafts-folder <path>        Override the detected Drafts folder
--trash-folder <path>         Override the detected Trash folder
--archive-folder <path>       Override the detected Archive folder
--spam-folder <path>          Override the detected Spam folder
--no-save-sent                Do not save SMTP submissions in Sent
```

Without a password environment variable, Fluxmail prompts for the password in an interactive terminal. See [Connect an IMAP mailbox](/docs/connect-an-imap-mailbox) for setup examples and folder troubleshooting.

## MCP permission options

The named profiles are `read-only`, `read-write`, and `full`. Use repeated `--allow` options for a custom policy. `--profile` and `--allow` cannot be used together on the same command.

Permissions passed to `fluxmail stdio` apply to that local process. HTTP permissions are stored with the API key and can be changed later with `fluxmail apikey permissions`. See [Permissions](/docs/permissions) for the capability list and workflow requirements.
