# Fluxmail

[Fluxmail](https://github.com/churichard/fluxmail-mcp) is a self-hosted MCP server that connects AI agents to Gmail and IMAP/SMTP mailboxes. It gives MCP clients a consistent set of tools to read, search, draft, send, and organize email.

## Install

Fluxmail requires Node.js 20.20.x, or Node.js 22.22 or later.

```bash
npm install -g fluxmail
```

To run Fluxmail without installing it globally, replace `fluxmail` in any local CLI command with `npx -y fluxmail@latest`. For example:

```bash
npx -y fluxmail@latest accounts add gmail
```

## Connect Gmail

Create a Google Cloud OAuth client with the Gmail API enabled, then save its credentials:

```bash
fluxmail config set GOOGLE_CLIENT_ID <your-client-id>.apps.googleusercontent.com
fluxmail config set GOOGLE_CLIENT_SECRET <your-client-secret>
fluxmail accounts add gmail
```

For a local installation, the last command starts Google's consent flow in your browser.

For Docker or a remote server, set `FLUXMAIL_PUBLIC_URL` to the server's public HTTPS address and register `<FLUXMAIL_PUBLIC_URL>/auth/google/callback` as an authorized redirect URI in Google Cloud. Run the command on the server, then open the printed URL in your local browser:

```bash
docker compose exec fluxmail fluxmail accounts add gmail
```

Open the printed link, then select Continue with Google. The link expires after 10 minutes and works once. Fluxmail selects the flow from `FLUXMAIL_PUBLIC_URL`; `--local` and `--hosted` override that selection when needed.

## Connect IMAP

```bash
fluxmail accounts add imap \
  --email you@example.com \
  --imap-host imap.example.com \
  --smtp-host smtp.example.com
```

Fluxmail prompts for the password and stores it encrypted. Use `--imap-password-env <name>` for Docker or scripted setup.

## Connect an MCP client

Configure your client to launch Fluxmail through `npx`. For example, with Claude Code:

```bash
claude mcp add fluxmail -- npx -y fluxmail@latest stdio
```

Or with Codex CLI:

```bash
codex mcp add fluxmail -- npx -y fluxmail@latest stdio
```

Replace `@latest` with an exact version to keep your MCP client on that version. If you installed Fluxmail globally, you can use `fluxmail stdio` instead.

Fluxmail also supports Streamable HTTP for Docker and remote deployments.

See the [setup guide](https://fluxmail.ai/docs/quickstart) for Google OAuth configuration, Docker deployment, supported MCP clients, environment variables, and the complete tool list.

## Telemetry

Fluxmail reports anonymous CLI and MCP feature usage to PostHog. It does not send command arguments, mailbox data, message content, account or message IDs, file paths, secrets, or error messages. Run `fluxmail telemetry disable` to turn it off. Use `fluxmail telemetry status` to check the setting or `fluxmail telemetry enable` to turn it back on. `FLUXMAIL_TELEMETRY=0` and `DO_NOT_TRACK=1` also disable telemetry. The [telemetry reference](https://github.com/churichard/fluxmail-mcp/blob/main/docs/telemetry.md) lists every event and property.

## License

See the [repository](https://github.com/churichard/fluxmail-mcp) for license terms.
