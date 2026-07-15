<p align="center">
  <img src="docs/assets/fluxmail-banner.png" alt="Fluxmail" width="100%">
</p>

<p align="center"><a href="https://github.com/churichard/fluxmail-mcp/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/churichard/fluxmail-mcp/ci.yml?branch=main&amp;style=flat-square&amp;label=CI&amp;logo=github"></a> <a href="https://www.npmjs.com/package/fluxmail"><img alt="npm version" src="https://img.shields.io/npm/v/fluxmail?style=flat-square&amp;logo=npm&amp;color=1f4fcc"></a> <a href="https://github.com/churichard/fluxmail-mcp/pkgs/container/fluxmail-mcp"><img alt="Container image" src="https://img.shields.io/badge/GHCR-container-2496ED?style=flat-square&amp;logo=docker&amp;logoColor=white"></a></p>

Fluxmail is a self-hosted email server for Gmail, Microsoft 365, Outlook.com, and IMAP/SMTP mailboxes. AI agents can use MCP over stdio or Streamable HTTP. Scripts and applications can use the versioned REST API.

## Get started

Fluxmail requires Node.js 20.20.x, or Node.js 22.22 or later.

```bash
npm install -g fluxmail
fluxmail members add --name "Your name" --email you@example.com
```

Then follow the [quickstart](docs/public/pages/quickstart.md) to connect a mailbox, choose who can use it, and configure your MCP client. The published version is available at [fluxmail.ai/docs/quickstart](https://fluxmail.ai/docs/quickstart).

## Documentation

- [Overview](docs/public/pages/overview.md)
- [Tools](docs/public/pages/tools.md)
- [REST API](docs/public/pages/rest-api/index.md)
- [Permissions](docs/public/pages/permissions.md)
- [Configuration](docs/public/pages/configuration.md)
- [CLI reference](docs/public/pages/cli.md)
- [Gmail setup](docs/public/pages/connect-gmail-to-mcp.md)
- [Outlook setup](docs/public/pages/connect-outlook-to-mcp.md)
- [IMAP setup](docs/public/pages/connect-an-imap-mailbox.md)
- [Architecture](docs/public/pages/architecture.md)
- [Teams and plans](docs/public/pages/teams-and-plans.md)

The source for Fluxmail's public documentation lives in [`docs/public`](docs/public). Add and order pages in [`docs/public/pages/meta.json`](docs/public/pages/meta.json); `manifest.json` is generated for compatibility with the existing site integration. The REST endpoint pages and other generated reference sections come from the server implementation. Run `pnpm docs:generate` after changing tools, REST routes, commands, configuration, or permissions, and run `pnpm docs:check` before committing.

Run `pnpm docs:preview` to generate the public references and open them in the Fluxmail documentation site. The script finds a sibling Fluxmail checkout automatically. Set `FLUXMAIL_WEB_ROOT` if the site lives somewhere else. The preview uses this worktree as its source and does not change the site's pinned submodule.

## Repository layout

```text
packages/
  core/             unified types and provider interface
  provider-gmail/   Gmail adapter
  provider-imap/    IMAP and SMTP adapter
  provider-outlook/ Microsoft Graph adapter
  server/           service, storage, MCP and REST transports, and CLI
```

## Plans and license

The Personal plan supports three mailboxes and one member. Paid plans raise those limits for teams that share an instance. See [Fluxmail pricing](https://fluxmail.ai/pricing) for current details.

Fluxmail is proprietary, source-available software. You may inspect, test, and privately modify the source, but production use is limited to your Fluxmail entitlement. Redistribution, hosted resale, competing use, and bypassing license controls are not permitted. See [LICENSE.md](LICENSE.md) for the full terms.
