# Fluxmail

Fluxmail is a self-hosted MCP server for Gmail and IMAP/SMTP mailboxes. It gives MCP clients one API for reading, searching, drafting, sending, and organizing email.

## Install

Fluxmail requires Node.js 20.20.x, or Node.js 22.22 or later.

```bash
npm install -g fluxmail
fluxmail members add --name "Your name" --email you@example.com
```

Then follow the [quickstart](../../docs/public/pages/quickstart.md) to connect a mailbox, choose who can use it, and configure your MCP client. The published guide is available at [fluxmail.ai/docs/quickstart](https://fluxmail.ai/docs/quickstart).

## Documentation

- [Tools](../../docs/public/pages/tools.md)
- [Permissions](../../docs/public/pages/permissions.md)
- [Configuration](../../docs/public/pages/configuration.md)
- [CLI reference](../../docs/public/pages/cli.md)
- [Gmail setup](../../docs/public/pages/connect-gmail-to-mcp.md)
- [IMAP setup](../../docs/public/pages/connect-an-imap-mailbox.md)

Fluxmail supports stdio for local clients and Streamable HTTP for Docker and remote deployments. Use an exact package version instead of `@latest` when you need a reproducible installation.

## License

Fluxmail is proprietary, source-available software. Production use is limited to your Fluxmail entitlement. See the [repository license](https://github.com/churichard/fluxmail-mcp/blob/main/LICENSE.md) for the full terms.
