---
title: 'Connect Outlook / Exchange'
description: 'Register a Microsoft Entra application and connect Microsoft 365 or Outlook.com to Fluxmail.'
updated: '2026-07-15'
---

Fluxmail connects to Microsoft 365 and Outlook.com through Microsoft Graph. You create the Microsoft Entra app registration, and Fluxmail stores its OAuth tokens on the server you run.

This integration supports Exchange Online mailboxes in Microsoft 365 and personal Outlook.com accounts, including Hotmail addresses. For an on-premises Exchange server without Microsoft Graph access, use [IMAP and SMTP](/docs/connect-an-imap-mailbox).

## 1. Register the application

1. Open the [Microsoft Entra admin center](https://entra.microsoft.com/).
2. Go to **Identity > Applications > App registrations**, then select **New registration**.
3. Enter a name for the app.
4. Choose the supported account types. Select an option that includes personal Microsoft accounts if you need Outlook.com or Hotmail.
5. Register the application, then copy its **Application (client) ID**.

The default `MICROSOFT_TENANT_ID=common` accepts work, school, and personal accounts when the app registration supports them. For a single-tenant app, set `MICROSOFT_TENANT_ID` to its Directory (tenant) ID or verified tenant domain.

## 2. Add Microsoft Graph permissions

Open **API permissions** for the app registration and add these delegated Microsoft Graph permissions:

- `User.Read`
- `Mail.ReadWrite`
- `Mail.Send`

Fluxmail also requests standard OpenID Connect and offline access scopes during sign-in so it can identify the mailbox and refresh access tokens. An Entra administrator may need to grant consent when organizational policy blocks user consent.

## 3. Choose a callback

Add the redirect URI for each way you plan to run Fluxmail. One app registration can contain both local and hosted callbacks.

| Setup | Platform | Redirect URI |
| --- | --- | --- |
| Local stdio or local Docker | Mobile and desktop applications | `http://localhost:8976/oauth/microsoft/callback` |
| Remote server | Web | `<your FLUXMAIL_PUBLIC_URL>/auth/microsoft/callback` |

For the local callback, open **Authentication**, add the Mobile and desktop applications platform with the custom redirect URI, and enable **Allow public client flows**.

For a remote server, add the Web platform and its public HTTPS callback. For example, a server at `https://mail.example.com` uses:

```text
https://mail.example.com/auth/microsoft/callback
```

Create a client secret under **Certificates & secrets** for hosted connections. Copy the secret value when Entra displays it. Fluxmail does not need a client secret for the local callback.

## 4. Connect the mailbox

Create the member who will own the mailbox if they do not exist yet:

```bash
fluxmail members add --name "Your name" --email you@example.com
```

### Local stdio

Store the application client ID, then start the browser consent flow:

```bash
fluxmail config set MICROSOFT_CLIENT_ID <application-client-id>
fluxmail accounts add outlook --owner you@example.com
```

If the app is restricted to one tenant, store that tenant too:

```bash
fluxmail config set MICROSOFT_TENANT_ID <tenant-id-or-domain>
```

Fluxmail listens on `http://localhost:8976`, prints a Microsoft authorization URL, and waits for the redirect. Choose the mailbox you want to connect and approve access.

### Local Docker

Add the client ID to `.env` and leave `FLUXMAIL_PUBLIC_URL` unset:

```dotenv
MICROSOFT_CLIENT_ID=<application-client-id>
# MICROSOFT_TENANT_ID=common
```

Start Fluxmail and run the account command inside the container:

```bash
docker compose up -d
docker compose exec fluxmail \
  fluxmail members add --name "Your name" --email you@example.com
docker compose exec fluxmail \
  fluxmail accounts add outlook --owner you@example.com
```

Docker Compose publishes the callback listener to `localhost:8976` on the host, so the browser can return to the waiting command.

### Remote server

Add the application client ID, client secret, and public server URL to `.env`:

```dotenv
MICROSOFT_CLIENT_ID=<application-client-id>
MICROSOFT_CLIENT_SECRET=<client-secret-value>
# MICROSOFT_TENANT_ID=common
FLUXMAIL_PUBLIC_URL=https://mail.example.com
```

Recreate the container and start the account command:

```bash
docker compose up -d
docker compose exec fluxmail \
  fluxmail accounts add outlook --owner you@example.com
```

Open the printed connection link in your browser, continue to Microsoft, and approve access. The link expires after 10 minutes and works once.

## Create hosted connection links through the API

A product backend can create a hosted link without running the CLI. The API key needs `admin.accounts`, and its owner must still be an administrator:

```bash
curl -X POST "$FLUXMAIL_PUBLIC_URL/api/v1/admin/connections" \
  -H "Authorization: Bearer $FLUXMAIL_ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"provider":"outlook","owner":"you@example.com"}'
```

The response contains `data.connectionUrl` and `data.expiresAt`. Send the URL to the user, but keep the admin API key on your backend. To reconnect an existing mailbox, send `reauthorizeAccountId` instead of `owner`. The endpoint also accepts `provider: "gmail"`.

`POST /auth/connections` remains available for existing integrations. It has the same authentication requirement and no longer bypasses authentication under `FLUXMAIL_AUTH=none`.

## Reconnect Outlook later

List accounts to find the account ID:

```bash
fluxmail accounts list
```

Reconnect the mailbox with the same flow used during setup:

```bash
fluxmail accounts add outlook --reauthorize <account-id>
```

For Docker, prefix the command with `docker compose exec fluxmail`. Choose the Microsoft account that matches the mailbox you are reconnecting. Reauthorization updates the stored tokens without changing the mailbox owner or access rules.

Return to the [Quickstart](/docs/quickstart) to connect Fluxmail to your AI agent.
