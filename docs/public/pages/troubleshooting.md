---
title: 'Troubleshooting'
description: 'Fix common Fluxmail installation, mailbox connection, and authentication problems.'
updated: '2026-07-17'
---

Start by checking the service and connected mailboxes:

```bash
fluxmail status
fluxmail accounts list
```

For Docker, prefix each command with `docker compose exec fluxmail`.

## The fluxmail command is not found

Check whether your shell can find the command:

```bash
which fluxmail
```

If that prints nothing, install Fluxmail globally or run it through `npx`:

```bash
npm install -g fluxmail
npx -y fluxmail@latest status
```

Some apps use a limited `PATH`. Run `which fluxmail` in your terminal and use the returned absolute path in the app's configuration.

## The browser cannot finish connecting a mailbox

Local OAuth connections expect the browser and Fluxmail to run on the same computer. Check that port 8976 is available.

A remote server needs `FLUXMAIL_PUBLIC_URL` set to its public HTTPS address. Gmail also needs a Google Web client, and Outlook needs a Microsoft Entra client secret. Follow [Deploy with Docker](/docs/deploy-with-docker) and the setup guide for [Gmail](/docs/connect-gmail-to-mcp) or [Outlook](/docs/connect-outlook-to-mcp).

## A mailbox needs to be reconnected

Run `fluxmail status` to confirm which mailbox needs attention. Then follow the reconnection steps for [Gmail](/docs/connect-gmail-to-mcp), [Outlook](/docs/connect-outlook-to-mcp), or [IMAP/SMTP](/docs/connect-an-imap-mailbox).

Reconnecting updates the saved credentials without changing the mailbox owner or access rules.

## MCP or REST returns 401

HTTP clients must send the API key as a bearer token:

```text
Authorization: Bearer fmk_...
```

Fluxmail shows an API key only when you create it. If the key was lost or revoked, create a new one and update the client.

## MCP or REST returns 403

The API key does not have permission for the requested operation or mailbox. Check its permission profile and mailbox allowlist:

```bash
fluxmail apikey list
```

See [Permissions](/docs/permissions) to change the profile or mailbox scope.

## A Docker server does not respond

Check the container status and recent logs:

```bash
docker compose ps
docker compose logs --tail=100 fluxmail
```

Confirm that port 8977 is reachable and that your reverse proxy forwards requests to it. See [Deploy with Docker](/docs/deploy-with-docker) for the expected public URL and authentication settings.

## A configuration import fails

`fluxmail config migrate` preserves the source file whether the command succeeds or fails. Read the error before changing any files. A key mismatch means the configured key differs from `<data dir>/encryption.key` or cannot decrypt the existing database. Restore the key that was used with the database, then retry the command.

Do not replace the key just to clear the error. Provider credentials and encrypted instance settings cannot be decrypted with a different key.

If `config.toml` already exists, move it aside only when the env file should replace its deployment settings. After a successful import, run `fluxmail config show` and `fluxmail oauth status` before removing the old file.

## An OAuth application cannot be changed

Run `fluxmail oauth status` and check the source. An application with an `environment` or `environment-file` source is controlled by deployment overrides. Remove the complete provider override group, restart Fluxmail, then run `fluxmail oauth configure` or `fluxmail oauth reset` again.
