# Fluxmail

Fluxmail is a self-hosted MCP server for Gmail, Microsoft 365, Outlook.com, and IMAP/SMTP mailboxes. It gives MCP clients one API for reading, searching, drafting, sending, and organizing email.

## Install

Fluxmail requires Node.js 20.20.x, or Node.js 22.22 or later.

```bash
npm install -g fluxmail
fluxmail members add --name "Your name" --email you@example.com
```

Then follow the [quickstart](https://fluxmail.ai/docs/quickstart) to connect a mailbox, choose who can use it, and configure your MCP client.

## Documentation

- [Overview](https://fluxmail.ai/docs/overview)
- [Tools](https://fluxmail.ai/docs/tools)
- [Permissions](https://fluxmail.ai/docs/permissions)
- [Configuration](https://fluxmail.ai/docs/configuration)
- [CLI reference](https://fluxmail.ai/docs/cli)
- [Gmail setup](https://fluxmail.ai/docs/connect-gmail-to-mcp)
- [Outlook setup](https://fluxmail.ai/docs/connect-outlook-to-mcp)
- [IMAP setup](https://fluxmail.ai/docs/connect-an-imap-mailbox)

Fluxmail supports stdio for local clients and Streamable HTTP for Docker and remote deployments. Use an exact package version instead of `@latest` when you need a reproducible installation.

## License

Fluxmail is proprietary, source-available software. Production use is limited to your Fluxmail entitlement. See the [repository license](https://github.com/churichard/fluxmail-mcp/blob/main/LICENSE.md) for the full terms.
