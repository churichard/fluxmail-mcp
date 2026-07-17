<p align="center">
  <img src="docs/assets/fluxmail-banner.png" alt="Fluxmail" width="100%">
</p>

<p align="center"><a href="https://github.com/churichard/fluxmail/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/churichard/fluxmail/ci.yml?branch=main&amp;style=flat-square&amp;label=CI&amp;logo=github"></a> <a href="https://www.npmjs.com/package/fluxmail"><img alt="npm version" src="https://img.shields.io/npm/v/fluxmail?style=flat-square&amp;logo=npm&amp;color=1f4fcc"></a> <a href="https://github.com/churichard/fluxmail/pkgs/container/fluxmail"><img alt="Container image" src="https://img.shields.io/badge/GHCR-container-2496ED?style=flat-square&amp;logo=docker&amp;logoColor=white"></a></p>

Fluxmail is self-hosted email infrastructure for agents and apps. It connects to Gmail, Microsoft 365, Outlook.com, and IMAP/SMTP mailboxes. Agents use MCP, apps and backend workflows use the versioned REST API, and operators use the CLI to connect accounts, manage access, and run the service.

## Get started

Fluxmail requires Node.js 20.20.x, or Node.js 22.22 or later.

```bash
npm install -g fluxmail
fluxmail setup --name "Your name" --email you@example.com
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
- [Architecture](https://fluxmail.ai/docs/architecture)
- [Teams and plans](https://fluxmail.ai/docs/teams-and-plans)
- [Authentication and instances](https://fluxmail.ai/docs/authentication-and-instances)

## Plans and license

The Personal plan supports three mailboxes and one member. Paid plans raise those limits for teams that share an instance. See [Fluxmail pricing](https://fluxmail.ai/pricing) for current details.

Fluxmail is proprietary, source-available software. You may inspect, test, and privately modify the source, but production use is limited to your Fluxmail entitlement. Redistribution, hosted resale, competing use, and bypassing license controls are not permitted. See [LICENSE.md](LICENSE.md) for the full terms.
