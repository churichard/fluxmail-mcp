---
title: 'Connect Gmail to the MCP server'
description: 'Create a Google OAuth app, connect Gmail or Google Workspace, and reconnect an expired token.'
updated: '2026-07-14'
---

Fluxmail connects to Gmail through a Google Cloud OAuth app that you own. Your Google credentials and OAuth tokens stay with the Fluxmail server you run.

This setup works with personal Gmail accounts and Google Workspace accounts.

## 1. Create a Google Cloud project

1. Open [Google Cloud Console](https://console.cloud.google.com) and create or select a project.
2. Go to **APIs & Services → Library** and enable the **Gmail API**.
3. Open the Google Auth Platform setup and configure the OAuth consent screen.
4. Choose an **External** audience unless the app is restricted to people in your Google Workspace organization.
5. If the app is in Testing, add every Google account that will connect to Fluxmail as a test user.

[Google allows up to 100 test users](https://support.google.com/cloud/answer/15549945) while an app has a Testing publishing status. Users see an unverified-app warning during authorization.

## 2. Create OAuth credentials

Go to **APIs & Services → Credentials → Create credentials → OAuth client ID**, then choose **Web application**.

Add the redirect URI for each way you plan to run Fluxmail:

| Setup                       | Authorized redirect URI                           |
| --------------------------- | ------------------------------------------------- |
| Local stdio or local Docker | `http://localhost:8976/oauth/callback`            |
| Remote server               | `<your FLUXMAIL_PUBLIC_URL>/auth/google/callback` |

For example, a server available at `https://mail.example.com` uses:

```text
https://mail.example.com/auth/google/callback
```

Copy the client ID and client secret after Google creates them.

## 3. Connect Gmail

Choose the setup that matches how you run Fluxmail.

Create the member who will own the mailbox if they do not exist yet:

```bash
fluxmail members add --name "Your name" --email you@example.com
```

### Local stdio

Store the Google credentials in Fluxmail's local config, then start the browser consent flow:

```bash
fluxmail config set GOOGLE_CLIENT_ID <your-client-id>.apps.googleusercontent.com
fluxmail config set GOOGLE_CLIENT_SECRET <your-client-secret>
fluxmail accounts add gmail --owner you@example.com
```

The credentials are saved in `~/.fluxmail/config.env`. `fluxmail config list` shows stored settings with secret values masked.

### Docker or a remote server

Add the Google credentials to the server's `.env` file:

```dotenv
GOOGLE_CLIENT_ID=<your-client-id>.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=<your-client-secret>
```

If Docker runs on the same computer as your browser, leave `FLUXMAIL_PUBLIC_URL` unset. Docker Compose publishes the local callback at `http://localhost:8976/oauth/callback`.

For a remote deployment, expose Fluxmail through a public HTTPS address and add it to `.env`:

```dotenv
FLUXMAIL_PUBLIC_URL=https://mail.example.com
```

The value must match the public HTTPS address whose callback URI you registered in Google Cloud.

Start or recreate the container, then run the same account command inside it:

```bash
docker compose up -d
docker compose exec fluxmail \
  fluxmail members add --name "Your name" --email you@example.com
docker compose exec fluxmail \
  fluxmail accounts add gmail --owner you@example.com
```

On local Docker, the command prints a Google consent URL and waits for the callback on `localhost:8976`. On a remote deployment with `FLUXMAIL_PUBLIC_URL` set, it prints a one-time connection link instead. Open the link in your browser, choose the Google account, and approve access. Hosted links expire after 10 minutes and do not require an admin API key.

Fluxmail uses the hosted flow whenever `FLUXMAIL_PUBLIC_URL` is set. Without it, `fluxmail accounts add gmail --owner you@example.com` uses the local callback at `http://localhost:8976/oauth/callback`. For troubleshooting, pass `--hosted` or `--local` to choose a flow explicitly.

## Optional: avoid seven-day token expiration

For an External app with a Testing publishing status, [Google expires the authorization after seven days](https://developers.google.com/identity/protocols/oauth2#expiration). Move the app to **In production** in Google Auth Platform if you want a longer-lived connection.

Personal-use apps with fewer than 100 users do not have to complete Google verification, but Google may continue to show an unverified-app warning. Verification requirements differ if you make the app available more broadly.

## Reconnect Gmail later

If Google revokes or expires the token, list the accounts to find the account ID:

```bash
fluxmail accounts list
```

Reconnect a local account:

```bash
fluxmail accounts add gmail --reauthorize <account-id>
```

For Docker or HTTP, run the command inside the container:

```bash
docker compose exec fluxmail \
  fluxmail accounts add gmail --reauthorize <account-id>
```

Open the printed link and choose the Google account that matches the mailbox you are reconnecting.

Reauthorization updates the stored token for the same mailbox. It does not add another account or change the mailbox owner.

Return to the [Quickstart](/docs/quickstart) to connect Fluxmail to your AI agent.
