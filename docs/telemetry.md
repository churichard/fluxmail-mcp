# Telemetry

Fluxmail uses PostHog to count active installations and understand which CLI and MCP features people use. Telemetry is on by default. It runs in the background, and analytics failures do not affect commands or MCP calls.

## What Fluxmail sends

Every event contains a random installation ID, the Fluxmail version, the Node.js version, operating system, and architecture. The ID lives at `<data dir>/telemetry.id`. It is separate from the licensing instance ID and is not derived from an email address, license key, hostname, IP address, or machine identifier.

| Event                | `product_surface` | Other properties                                                           |
| -------------------- | ----------------- | -------------------------------------------------------------------------- |
| `cli command used`   | `cli`             | Command name, such as `accounts add` or `status`                           |
| `mcp server started` | `mcp`             | Transport: `stdio` or `http`                                               |
| `mcp tool called`    | `mcp`             | Tool, transport, outcome, error code, duration, and selected feature modes |

Use the same `product_surface` property in the other Fluxmail products. Set it to `landing_page` on the marketing site and `mail_app` in Fluxmail Mail. PostHog can then filter or compare all four products in one project.

PostHog person profiles and GeoIP lookup are disabled. The PostHog SDK adds its library name, library version, and server marker.

## What Fluxmail does not send

Telemetry does not include:

- Command arguments or option values
- Email addresses, recipients, or connected account details
- Account, message, thread, draft, schedule, or attachment IDs
- Search queries, subjects, message bodies, labels, or folder names
- Attachment names, local file paths, or downloaded content
- OAuth credentials, API keys, license keys, passwords, or config values
- Error messages, stack traces, or provider responses

## Turn telemetry off

Disable telemetry for the installation:

```bash
fluxmail telemetry disable
```

The command stores the choice in the Fluxmail data directory. It takes precedence over `FLUXMAIL_TELEMETRY=1`, and the disable command itself does not send an event.

Check or change the setting with:

```bash
fluxmail telemetry status
fluxmail telemetry enable
```

You can also set `FLUXMAIL_TELEMETRY=0` or `DO_NOT_TRACK=1` in the process environment. Either variable keeps telemetry disabled after `fluxmail telemetry enable`.

## Suggested PostHog reports

Use unique installation IDs rather than total event counts when measuring adoption.

- Active installations: unique users for `mcp tool called` or `cli command used`
- Product usage: relevant events, broken down by `product_surface`
- MCP feature adoption: `mcp tool called`, broken down by `tool`
- CLI feature adoption: `cli command used`, broken down by `command`
- Transport adoption: `mcp server started`, broken down by `transport`
- Reliability: `mcp tool called`, broken down by `outcome` and then `error_code`
- Scheduled sending: `mcp tool called` filtered to `tool = send_email`, broken down by `scheduled`
