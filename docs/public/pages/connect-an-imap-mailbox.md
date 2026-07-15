---
title: 'Connect IMAP/SMTP'
description: 'Connect any mailbox with IMAP and SMTP access, set its security options, and correct special-folder mappings.'
updated: '2026-07-15'
---

Fluxmail can connect to email providers that offer IMAP for reading mail and SMTP for sending it.

## 1. Find your provider settings

Before you start, find the IMAP and SMTP settings from your email provider. Some providers require an app password instead of your usual account password.

Fluxmail defaults to IMAP over TLS on port 993 and SMTP with STARTTLS on port 587. It uses the mailbox address as the username for both connections. You can override each of these settings when you connect the account.

## 2. Connect the mailbox

Choose the setup that matches how you run Fluxmail.

Create the member who will own the mailbox if they do not exist yet:

```bash
fluxmail members add --name "Your name" --email you@example.com
```

### Local terminal

Run:

```bash
fluxmail accounts add imap \
  --owner you@example.com \
  --email you@example.com \
  --imap-host imap.example.com \
  --smtp-host smtp.example.com
```

Fluxmail prompts for the password without showing it on screen.

If your provider uses different settings, pass the matching options:

```bash
fluxmail accounts add imap \
  --owner you@example.com \
  --email you@example.com \
  --display-name 'Your Name' \
  --imap-host imap.example.com \
  --imap-port 143 \
  --imap-security starttls \
  --imap-user your-username \
  --smtp-host smtp.example.com \
  --smtp-port 465 \
  --smtp-security tls \
  --smtp-user your-username
```

Both security options accept `tls` or `starttls`. Fluxmail checks both connections before saving the account. Mailbox passwords are encrypted at rest with AES-256-GCM in Fluxmail's local SQLite database.

### Connect through REST

An administrative client can test settings without saving them at `POST /api/v1/admin/imap/tests`, then connect the mailbox at `POST /api/v1/admin/connections`. The API key needs `admin.accounts`.

```bash
curl "$FLUXMAIL_PUBLIC_URL/api/v1/admin/connections" \
  -X POST \
  -H "Authorization: Bearer $FLUXMAIL_ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  --data '{
    "provider": "imap",
    "owner": "you@example.com",
    "email": "you@example.com",
    "imap": {
      "host": "imap.example.com",
      "port": 993,
      "security": "tls",
      "user": "you@example.com",
      "password": "app-password"
    },
    "smtp": {
      "host": "smtp.example.com",
      "port": 587,
      "security": "starttls",
      "user": "you@example.com",
      "password": "app-password"
    },
    "saveSent": true
  }'
```

Fluxmail tests IMAP and SMTP within 30 seconds before it writes the account. The response does not echo either password. Reauthorization keeps the existing `saveSent` value and folder overrides when those fields are omitted.

Update folder mappings with `PATCH /api/v1/admin/accounts/:accountId/imap/folders`. A string sets a folder path. `null` removes an override and restores automatic detection. Fluxmail validates every requested path before saving any of them.

### Docker or another non-interactive environment

An interactive terminal is not always available in Docker, CI, or a script. Put the password in an environment variable and pass its name to Fluxmail:

```bash
IMAP_PASSWORD='your-app-password' \
  fluxmail accounts add imap \
  --owner you@example.com \
  --email you@example.com \
  --imap-host imap.example.com \
  --smtp-host smtp.example.com \
  --imap-password-env IMAP_PASSWORD
```

The password value stays out of the command line. Fluxmail uses the IMAP password for SMTP too. If the SMTP password is different, set another environment variable and pass it with `--smtp-password-env`.

For Docker, make the variable available inside the container:

```bash
export IMAP_PASSWORD='your-app-password'
docker compose exec -e IMAP_PASSWORD fluxmail \
  fluxmail accounts add imap \
  --owner you@example.com \
  --email you@example.com \
  --imap-host imap.example.com \
  --smtp-host smtp.example.com \
  --imap-password-env IMAP_PASSWORD
```

## If a special folder is missing or incorrect

Fluxmail looks for Sent, Drafts, Trash, Archive, and Spam folders using the server's special-use flags first, then common folder names such as `Sent Items` and `Junk Mail`. It prints a warning when a folder is missing or ambiguous, but still connects the account.

Fluxmail does not create a missing folder or guess when several folders match. An action that needs an unresolved folder returns an error. This prevents an archive or trash command from moving mail to the wrong place.

Set the right folder path with the account ID from `fluxmail accounts list`:

```bash
fluxmail accounts configure <account-id> --sent-folder 'Sent Items'
fluxmail accounts configure <account-id> --trash-folder 'Deleted Messages'
```

You can configure `--sent-folder`, `--drafts-folder`, `--trash-folder`, `--archive-folder`, and `--spam-folder`. Pass `auto` to remove an override and let Fluxmail detect that folder again:

```bash
fluxmail accounts configure <account-id> --trash-folder auto
```

## Optional: avoid duplicate Sent messages

Fluxmail normally saves an SMTP submission in the resolved Sent folder. Some mail services already save SMTP submissions themselves. If yours does, add `--no-save-sent` when you connect the account so each message appears only once:

```bash
fluxmail accounts add imap \
  --owner you@example.com \
  --email you@example.com \
  --imap-host imap.example.com \
  --smtp-host smtp.example.com \
  --no-save-sent
```

## How Fluxmail works with IMAP

Fluxmail uses IMAP to read and organize the mailbox, and SMTP to send messages. The available behavior depends partly on the mail server:

- Each message lives in a folder. Your agent can move messages between folders, but IMAP accounts do not support label actions.
- Fluxmail builds threads from the standard `References`, `In-Reply-To`, and `Message-ID` headers.
- Searches run through the IMAP server, so results depend on what that server can index.

Your agent can read and search mail, work with attachments and drafts, send or schedule messages, reply, forward, and organize messages into folders.
