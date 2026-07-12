# Fluxmail

Fluxmail is a self-hosted MCP server that connects AI agents to Gmail and IMAP/SMTP mailboxes. It gives MCP clients a consistent set of tools to read, search, draft, send, and organize email.

## Install

Fluxmail requires Node.js 20 or later.

```bash
npm install -g fluxmail
```

## Connect Gmail

Create a Google Cloud OAuth client with the Gmail API enabled, then save its credentials:

```bash
fluxmail config set GOOGLE_CLIENT_ID <your-client-id>.apps.googleusercontent.com
fluxmail config set GOOGLE_CLIENT_SECRET <your-client-secret>
fluxmail accounts add gmail
```

The last command opens Google's consent flow in your browser.

## Connect IMAP

```bash
fluxmail accounts add imap \
  --email you@example.com \
  --imap-host imap.example.com \
  --smtp-host smtp.example.com
```

Fluxmail prompts for the password and stores it encrypted. Use `--imap-password-env <name>` for Docker or scripted setup.

## Connect an MCP client

Configure your client to launch `fluxmail stdio`. For example, with Claude Code:

```bash
claude mcp add fluxmail -- fluxmail stdio
```

Or with Codex CLI:

```bash
codex mcp add fluxmail -- fluxmail stdio
```

Fluxmail also supports Streamable HTTP for Docker and remote deployments.

See the [setup guide](https://fluxmail.ai/docs/quickstart) for Google OAuth configuration, Docker deployment, supported MCP clients, environment variables, and the complete tool list.

## License

See the [repository](https://github.com/churichard/fluxmail-mcp) for license terms.
