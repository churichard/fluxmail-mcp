# Fluxmail

Fluxmail is self-hosted email infrastructure for agents and apps. It connects to Gmail, Microsoft 365, Outlook.com, and IMAP/SMTP mailboxes. Agents use MCP, apps and backend workflows use the versioned REST API, and operators use the CLI to connect accounts, manage access, and run the service.

## Install

Fluxmail requires Node.js 20.20.x, or Node.js 22.22 or later.

```bash
npm install -g fluxmail
fluxmail members add --name "Your name" --email you@example.com
```

Then follow the [quickstart](https://fluxmail.ai/docs/quickstart) to connect a mailbox and choose how you want to use Fluxmail: MCP, REST API, or CLI.

## Documentation

- [Overview](https://fluxmail.ai/docs/overview)
- [MCP tools](https://fluxmail.ai/docs/tools)
- [Build with REST](https://fluxmail.ai/docs/build-with-rest)
- [REST API](https://fluxmail.ai/docs/rest-api)
- [Permissions](https://fluxmail.ai/docs/permissions)
- [Configuration](https://fluxmail.ai/docs/configuration)
- [CLI reference](https://fluxmail.ai/docs/cli)
- [Gmail setup](https://fluxmail.ai/docs/connect-gmail-to-mcp)
- [Outlook setup](https://fluxmail.ai/docs/connect-outlook-to-mcp)
- [IMAP setup](https://fluxmail.ai/docs/connect-an-imap-mailbox)

Fluxmail supports stdio for local MCP clients. Its HTTP server provides Streamable HTTP MCP and REST for local, Docker, and remote deployments. Use an exact package version instead of `@latest` when you need a reproducible installation.

## License

Fluxmail is proprietary, source-available software. Production use is limited to your Fluxmail entitlement. See the [repository license](https://github.com/churichard/fluxmail/blob/main/LICENSE.md) for the full terms.
