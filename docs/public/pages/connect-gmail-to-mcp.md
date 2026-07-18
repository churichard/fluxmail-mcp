---
title: 'Connect Gmail / Google Workspace'
description: 'Connect a Gmail or Google Workspace mailbox, configure Google OAuth, and reconnect expired tokens.'
updated: '2026-07-17'
---

Fluxmail includes a Google Desktop OAuth client, so you can connect Gmail locally without creating Google Cloud credentials. The local flow uses PKCE, and your OAuth tokens stay with the Fluxmail server you run.

This setup works with personal Gmail and Google Workspace mailboxes.

Fluxmail's built-in app requests Google's `gmail.modify` permission. You can read, draft, send, and organize mail, including moving messages to Trash. Gmail does not allow immediate permanent deletion with this permission.

## Connect Gmail

Choose the setup that matches how you run Fluxmail.

For a fresh local instance, create the first administrator and log in:

```bash
fluxmail setup --name "Your name" --email you@example.com
```

### Local stdio

Start the browser consent flow:

```bash
fluxmail accounts add gmail
```

### Docker or a remote server

If Docker runs on the same computer as your browser, leave `FLUXMAIL_PUBLIC_URL` unset. Docker Compose publishes the local callback at `http://127.0.0.1:8976/oauth/callback`.

For a remote deployment, expose Fluxmail through a public HTTPS address. You must also [use your own Google OAuth app](#use-your-own-google-oauth-app), because Google requires each hosted callback address to be registered. Add the public address to `.env`:

```dotenv
FLUXMAIL_PUBLIC_URL=https://mail.example.com
```

The value must match the public HTTPS address whose callback URI you registered in Google Cloud.

Start or recreate the container, then run the same mailbox command inside it:

```bash
docker compose up -d
docker compose exec fluxmail \
  fluxmail setup --name "Your name" --email you@example.com
docker compose exec fluxmail \
  fluxmail accounts add gmail
```

On local Docker, the command prints a Google consent URL and waits for the callback on `127.0.0.1:8976`. On a remote deployment with `FLUXMAIL_PUBLIC_URL` set, it prints a one-time connection link instead. Open the link in your browser, choose the Google account, and approve access. Hosted links expire after 10 minutes and do not require an admin API key.

Fluxmail uses the hosted flow whenever `FLUXMAIL_PUBLIC_URL` is set. Without it, `fluxmail accounts add gmail` uses the local callback at `http://127.0.0.1:8976/oauth/callback`. For troubleshooting, pass `--hosted` or `--local` to choose a flow explicitly.

## Use your own Google OAuth app

Use a custom Google client if you prefer to manage the OAuth consent screen yourself. A remote server with `FLUXMAIL_PUBLIC_URL` needs a Web client because Google's Desktop clients only support callbacks on the computer running the CLI.

Fluxmail requests the full `https://mail.google.com/` scope when you configure a custom client. This preserves the permanent-delete action. Your Google OAuth app must be approved for that restricted scope before you make it available to other users.

### Create a Google Cloud project

1. Open [Google Cloud Console](https://console.cloud.google.com) and create or select a project.
2. Go to **APIs & Services → Library** and enable the **Gmail API**.
3. Open the Google Auth Platform setup and configure the OAuth consent screen.
4. Choose an **External** audience unless the app is restricted to people in your Google Workspace organization.
5. If the app is in Testing, add every Google account that will connect to Fluxmail as a test user.

[Google allows up to 100 test users](https://support.google.com/cloud/answer/15549945) while an app has a Testing publishing status. Users see an unverified-app warning during authorization.

### Create OAuth credentials for a local connection

Go to **Google Auth Platform → Clients → Create client**, then choose **Desktop app**. Download the OAuth client JSON after Google creates it. Desktop apps cannot keep this credential confidential, but Google's token endpoint still requires the generated client secret.

Save both values from the JSON in Fluxmail's config:

```bash
fluxmail config set GOOGLE_CLIENT_ID <your-client-id>.apps.googleusercontent.com
fluxmail config set GOOGLE_CLIENT_SECRET <your-client-secret>
```

Fluxmail uses PKCE when it exchanges the local authorization code.

### Create OAuth credentials for a hosted connection

Go to **Google Auth Platform → Clients → Create client**, then choose **Web application**. Add `<your FLUXMAIL_PUBLIC_URL>/auth/google/callback` as an authorized redirect URI.

For example, a server available at `https://mail.example.com` uses:

```text
https://mail.example.com/auth/google/callback
```

Copy the client ID and client secret, then add both values to the server's `.env`:

```dotenv
GOOGLE_CLIENT_ID=<your-client-id>.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=<your-client-secret>
```

Restart Fluxmail after changing environment variables. `fluxmail config list` shows stored secrets in masked form.

### Create a hosted link through the API

A product backend can create a hosted connection link without running the CLI. The API key needs `admin.accounts`, and its owner must still be an administrator:

```bash
curl -X POST "$FLUXMAIL_PUBLIC_URL/api/v1/admin/connections" \
  -H "Authorization: Bearer $FLUXMAIL_ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"provider":"gmail","ownerMemberId":"you@example.com"}'
```

The response contains `data.connectionUrl` and `data.expiresAt`. Send the URL to the user, but keep the admin API key on your backend. To reconnect an existing mailbox, send `reauthorizeAccountId` instead of `ownerMemberId`. The endpoint also accepts `provider: "outlook"`.

## Avoid seven-day token expiration with a custom app

For an External app with a Testing publishing status, [Google expires the authorization after seven days](https://developers.google.com/identity/protocols/oauth2#expiration). Move the app to **In production** in Google Auth Platform if you want a longer-lived connection.

Personal-use apps with fewer than 100 users do not have to complete Google verification, but Google may continue to show an unverified-app warning. Verification requirements differ if you make the app available more broadly.

## Reconnect Gmail later

If Google revokes or expires the token, list the accounts to find the account ID:

```bash
fluxmail accounts list
```

Reconnect a local mailbox:

```bash
fluxmail accounts add gmail --reauthorize <account-id>
```

For Docker or HTTP, run the command inside the container:

```bash
docker compose exec fluxmail \
  fluxmail accounts add gmail --reauthorize <account-id>
```

Open the printed link and choose the Google account that matches the mailbox you are reconnecting.

Reauthorization updates the stored token for the same mailbox. It does not add another mailbox or change the mailbox owner.

## How Gmail labels work

Fluxmail returns Gmail user labels in both folder and label listings. The folder listing lets clients navigate a label as a mailbox view. The label listing describes tags that can be added to or removed from messages, including the label colors configured in Gmail.

Adding a label by name creates it when it does not exist. Removing a missing label has no effect. Use the dedicated read, star, archive, trash, and move actions for Gmail system labels.

Continue with [Connect an MCP client](/docs/connect-an-mcp-client), [Build with REST](/docs/build-with-rest), or [Use the CLI](/docs/use-the-cli).
