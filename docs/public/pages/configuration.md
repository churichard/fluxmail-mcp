---
title: 'Configuration'
description: 'Environment variables and telemetry controls for the self-hosted Fluxmail MCP server.'
updated: '2026-07-14'
---

## Environment variables

Every setting is an environment variable, and there are three places to put one. In precedence order:

1. The shell environment (always wins)
2. `.env.local`, then `.env`, read from the working directory
3. `fluxmail config set <KEY> <value>`, stored in `<data dir>/config.env` and available no matter where you run the CLI from

For a personal setup, `fluxmail config set` is the simplest way to save OAuth application settings. Gmail needs `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. A local Outlook connection needs `MICROSOFT_CLIENT_ID`; hosted Outlook connections also need `MICROSOFT_CLIENT_SECRET`. IMAP accounts do not use these settings. Use `fluxmail config list` to review stored settings (secret values are masked) and `fluxmail config unset <KEY>` to remove one.

<!-- BEGIN GENERATED:configuration -->
| Environment variable | Default | Purpose |
| --- | --- | --- |
| `GOOGLE_CLIENT_ID` | `required for Gmail` | Google OAuth client ID. |
| `GOOGLE_CLIENT_SECRET` | `required for Gmail` | Google OAuth client secret. |
| `MICROSOFT_CLIENT_ID` | `required for Outlook` | Microsoft Entra application client ID. |
| `MICROSOFT_CLIENT_SECRET` | `required for hosted Outlook connections` | Microsoft Entra application client secret. |
| `MICROSOFT_TENANT_ID` | `common` | Microsoft Entra tenant ID or verified domain. |
| `FLUXMAIL_DATA_DIR` | `~/.fluxmail (/data in Docker)` | Directory for the SQLite database, stored config, and generated encryption key. |
| `FLUXMAIL_DB_PATH` | `<data dir>/fluxmail.db` | Override the SQLite database path. |
| `FLUXMAIL_ENCRYPTION_KEY` | `generated automatically` | A 64-character hexadecimal key used to encrypt provider credentials. |
| `FLUXMAIL_PORT` | `8977` | HTTP server port. |
| `FLUXMAIL_PUBLIC_URL` | `http://localhost:<FLUXMAIL_PORT>` | Public base URL used for the MCP endpoint and hosted OAuth callbacks. |
| `FLUXMAIL_AUTH` | `apikey` | HTTP authentication mode. Use none only behind a trusted network boundary. |
| `FLUXMAIL_OAUTH_PORT` | `8976` | Port for the local OAuth callback listener. |
| `FLUXMAIL_OAUTH_HOST` | `127.0.0.1` | Bind address for the local OAuth callback listener. |
| `FLUXMAIL_MAX_ATTACHMENT_MB` | `10` | Largest decoded attachment returned through MCP, from 1 through 25 MB. |
| `FLUXMAIL_LICENSE_KEY` | `none` | Paid-plan license key, normally stored with fluxmail license activate. |
| `FLUXMAIL_TELEMETRY` | `1` | Set to 0 to turn off anonymous CLI and MCP usage telemetry. |
| `DO_NOT_TRACK` | `unset` | Set to 1 to turn off anonymous usage telemetry. |
<!-- END GENERATED:configuration -->

With `FLUXMAIL_AUTH=apikey`, each HTTP API key can have its own MCP permission profile. `FLUXMAIL_AUTH=none` gives every HTTP client the full tool set, so use it only behind a network boundary you control. See [Limit what an MCP client can do](/docs/permissions) for profiles and custom policies.

For the full command set, see the [CLI reference](/docs/cli).

## Telemetry

Fluxmail sends anonymous usage events to its PostHog project by default. Events record the CLI command or MCP tool used, transport, outcome, duration, selected feature modes, a random installation ID, and basic runtime information such as the Fluxmail version, Node.js version, operating system, and CPU architecture. PostHog person profiles and GeoIP lookup are disabled.

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
