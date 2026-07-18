---
title: 'Configuration'
description: 'Environment variables and telemetry controls for the self-hosted Fluxmail server.'
updated: '2026-07-17'
---

## Environment variables

Every setting is an environment variable, and there are three places to put one. In precedence order:

1. The shell environment (always wins)
2. `.env.local`, then `.env`, read from the working directory
3. `fluxmail config set <KEY> <value>`, stored in `<data dir>/config.env` and available no matter where you run the CLI from

Fluxmail includes a Google Desktop OAuth client for local Gmail connections. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` to use another Google OAuth client. Hosted Gmail connections need a custom Web client. A local Outlook connection needs `MICROSOFT_CLIENT_ID`; hosted Outlook connections also need `MICROSOFT_CLIENT_SECRET`. IMAP accounts do not use these settings. Use `fluxmail config list` to review stored settings (secret values are masked) and `fluxmail config unset <KEY>` to remove one.

By default, Fluxmail processes that use the same data directory also open the same SQLite database. They share encrypted credentials, saved configuration, members, API keys, license state, and the telemetry setting. The processes can run different Fluxmail releases as long as each release supports the store format in that directory. Fluxmail exits without changing the database when the store format is not supported.

Store format 1 is the compatibility baseline. Before a format migration, Fluxmail writes one database backup to the `backups` directory next to the database. Releases from before the format check can open format 1, but update those installations before a later Fluxmail release moves the store to a newer format.

Set `FLUXMAIL_DATA_DIR` to create a separate installation. `FLUXMAIL_DB_PATH` changes only the database location. Fluxmail still reads the encryption key and saved configuration from the data directory. Shell variables and working-directory `.env` files can also give one process different settings from other processes that share the store.

<!-- BEGIN GENERATED:configuration -->
| Environment variable | Default | Purpose |
| --- | --- | --- |
| `GOOGLE_CLIENT_ID` | `Fluxmail Desktop OAuth app` | Override the built-in Google OAuth client ID. |
| `GOOGLE_CLIENT_SECRET` | `Fluxmail Desktop OAuth app` | Override the built-in Google OAuth client secret. Required with GOOGLE_CLIENT_ID. |
| `MICROSOFT_CLIENT_ID` | `required for Outlook` | Microsoft Entra application client ID. |
| `MICROSOFT_CLIENT_SECRET` | `required for hosted Outlook connections` | Microsoft Entra application client secret. |
| `MICROSOFT_TENANT_ID` | `common` | Microsoft Entra tenant ID or verified domain. |
| `FLUXMAIL_DATA_DIR` | `~/.fluxmail (/data in Docker)` | Directory for the SQLite database, stored config, and generated encryption key. |
| `FLUXMAIL_DB_PATH` | `<data dir>/fluxmail.db` | Override the SQLite database path. |
| `FLUXMAIL_ENCRYPTION_KEY` | `generated automatically` | A 64-character hexadecimal key used to encrypt provider credentials. |
| `FLUXMAIL_PORT` | `8977` | HTTP server port. |
| `FLUXMAIL_PUBLIC_URL` | `http://localhost:<FLUXMAIL_PORT>` | Public base URL used for HTTP APIs and hosted OAuth callbacks. |
| `FLUXMAIL_TRUST_PROXY` | `0` | Trust Forwarded, X-Forwarded-Proto, and X-Forwarded-For headers from a reverse proxy. |
| `FLUXMAIL_OAUTH_PORT` | `8976` | Port for the local OAuth callback listener. |
| `FLUXMAIL_OAUTH_HOST` | `127.0.0.1` | Bind address for the local OAuth callback listener. |
| `FLUXMAIL_MAX_ATTACHMENT_MB` | `10` | Largest decoded attachment returned through MCP or REST, from 1 through 25 MB. |
| `FLUXMAIL_LICENSE_KEY` | `none` | Paid-plan license key, normally stored with fluxmail license activate. |
| `FLUXMAIL_TELEMETRY` | `1` | Set to 0 to turn off anonymous CLI, MCP, and REST usage telemetry. |
| `DO_NOT_TRACK` | `unset` | Set to 1 to turn off anonymous usage telemetry. |
<!-- END GENERATED:configuration -->

HTTP MCP requests require an API key. REST requests accept an active member session or API key. Each API key has its own permission profile and optional mailbox allowlist. See [Permissions](/docs/permissions) for profiles and custom policies, and [Authentication and instances](/docs/authentication-and-instances) for login and session storage.

For the full command set, see the [CLI reference](/docs/cli).

## Telemetry

Fluxmail sends anonymous usage events to its PostHog project by default. Events record the CLI command, MCP tool, or REST operation used, along with transport, outcome, duration, selected feature modes, a random installation ID, and basic runtime information such as the Fluxmail version, Node.js version, operating system, and CPU architecture. PostHog person profiles and GeoIP lookup are disabled.

Fluxmail never sends command arguments, email or account data, message identifiers, search queries, labels, attachment details, file paths, credentials, configuration values, or error text. Telemetry runs in the background and cannot interrupt commands or email operations.

Turn it off for the installation:

```bash
fluxmail telemetry disable
```

Check the setting or turn it back on:

```bash
fluxmail telemetry status
fluxmail telemetry enable
```

You can also set `FLUXMAIL_TELEMETRY=0` or `DO_NOT_TRACK=1`. A saved disabled setting takes priority over `FLUXMAIL_TELEMETRY=1`.
