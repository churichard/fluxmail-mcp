---
title: 'Build with REST'
description: 'Start the Fluxmail REST API and use it from an app, script, or backend workflow.'
updated: '2026-07-17'
---

Fluxmail provides one JSON API for Gmail, Outlook, and IMAP/SMTP mailboxes. Your app uses the same routes and response shapes for every provider.

## Start the API

Complete the [Quickstart](/docs/quickstart) through mailbox setup, then create an API key for your app:

```bash
fluxmail apikey create --name support-backend

fluxmail serve
```

Fluxmail displays the key once. Store it as a secret, then set it in the shell where you will make requests:

```bash
export FLUXMAIL_API_KEY='fmk_...'
export FLUXMAIL_API_URL='http://localhost:8977/api/v1'
```

Use HTTPS if the server runs on another machine.

## Find the mailbox

List the accounts available to the API key:

```bash
curl "$FLUXMAIL_API_URL/accounts" \
  -H "Authorization: Bearer $FLUXMAIL_API_KEY"
```

Copy the account ID from the response. API keys can be limited to selected mailboxes and permission profiles. See [Permissions](/docs/permissions) before issuing a key to a production app.

## Read messages

This request returns unread messages in the inbox:

```bash
curl "$FLUXMAIL_API_URL/accounts/<account-id>/messages?folder=inbox&unreadOnly=true" \
  -H "Authorization: Bearer $FLUXMAIL_API_KEY"
```

You can also filter by sender, recipient, subject, date, attachment presence, or provider query. See [List messages](/docs/rest-api/list-messages) for every parameter.

## Send from a backend workflow

Send and forward requests require an idempotency key. Reuse the same key when retrying one intended delivery so a network retry does not send the message twice.

```bash
curl "$FLUXMAIL_API_URL/accounts/<account-id>/send" \
  -X POST \
  -H "Authorization: Bearer $FLUXMAIL_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  --data '{
    "to": [{"email": "customer@example.com"}],
    "subject": "Payment received",
    "body": {"text": "We received your payment. Thank you."}
  }'
```

The same endpoint can schedule a delivery with `sendAt`. See [Send or schedule a message](/docs/rest-api/send-message) for the complete request body.

## Work with attachments

Message responses include attachment metadata. Download an attachment as raw bytes when you need to send a receipt, invoice, or uploaded file to another system:

```bash
curl "$FLUXMAIL_API_URL/accounts/<account-id>/messages/<message-id>/attachments/<attachment-id>" \
  -H "Authorization: Bearer $FLUXMAIL_API_KEY" \
  --output attachment.bin
```

For all mail and administrative routes, see the [REST API reference](/docs/rest-api). The OpenAPI 3.1 document is available at `/api/v1/openapi.json` without authentication.
