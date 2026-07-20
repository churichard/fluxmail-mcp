---
title: 'Local logs'
description: 'Find and configure Fluxmail local logs without allowing unbounded disk use.'
updated: '2026-07-19'
---

Fluxmail keeps a local record of command, MCP, REST, mailbox connection, scheduled send, and license failures. It also records a small number of service events, such as server startup. Successful requests and tool calls are not logged.

Logs stay on the machine where Fluxmail runs. Fluxmail does not upload them or include their text in anonymous telemetry.

## Read recent logs

Show the latest 100 entries:

```bash
fluxmail logs
```

Choose a different limit or show only errors:

```bash
fluxmail logs --tail 250
fluxmail logs --level error
```

Use `--json` to print the stored JSON record for each entry:

```bash
fluxmail logs --level warn --json
```

For Docker, run the same command inside the container:

```bash
docker compose exec fluxmail fluxmail logs --tail 100
```

## Files and disk limits

The active file is `<data dir>/logs/fluxmail.jsonl`. Fluxmail rotates it at 5 MiB and keeps three older files. The entire directory is limited to 20 MiB.

Fluxmail batches writes, limits repeated errors, and caps sustained log output at 1 MiB per hour after a 64 KiB burst. When it drops repeated or excessive records, it writes a `logging.records_suppressed` entry after capacity becomes available. If the file cannot be written, email operations continue and Fluxmail reports the problem on the console at most once per hour.

The supplied Docker Compose file also limits container console logs to three 5 MiB files.

## Configure logging

`FLUXMAIL_LOG_LEVEL` accepts `info`, `warn`, `error`, or `off`. The default is `info`.

`FLUXMAIL_LOG_DESTINATION` accepts `both`, `file`, or `console`. The default is `both`. One shot CLI commands still show errors in the terminal without printing a duplicate log line.

For example, keep errors in the rotating file without writing structured events to the console:

```toml
[logging]
level = "error"
destination = "file"
```

Environment variables take precedence over `config.toml`. Restart Fluxmail after changing either setting.

## Private information

Fluxmail does not log request bodies, response bodies, email content, headers, command arguments, credentials, configuration values, or raw provider responses. It also redacts common token and secret formats from error strings.

Error messages and stack traces can still contain email addresses, local file paths, or details returned by a provider. Review log entries before sharing them with anyone.
