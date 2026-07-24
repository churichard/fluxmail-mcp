---
title: 'Build with REST'
description: 'Connect an app or script to the Fluxmail REST API and make your first requests.'
updated: '2026-07-17'
---

Fluxmail provides the same REST API for Gmail, Outlook, and IMAP/SMTP mailboxes. This guide follows a common workflow: find a mailbox, list its messages, fetch one message, and mark it as read.

## Start the API

Complete the [Quickstart](/docs/quickstart), then create an API key for your app and start the server:

```bash
fluxmail apikey create --name local-app

fluxmail serve
```

Fluxmail displays the key once. Store it as a secret, then set the API key and base URL in the shell where you will make requests:

```bash
export FLUXMAIL_API_KEY='fmk_...'
export FLUXMAIL_API_URL='http://localhost:8977/api/v1'
```

Use HTTPS when the server runs on another machine.

If Fluxmail runs in Docker, create the key inside the container. Docker Compose already runs the server:

```bash
docker compose exec fluxmail \
  fluxmail apikey create --name local-app
```

Set `FLUXMAIL_API_URL` to the public URL from [Deploy with Docker](/docs/deploy-with-docker), followed by `/api/v1`.

## Find the mailbox

List the mailboxes available to the API key:

```bash
curl "$FLUXMAIL_API_URL/accounts" \
  -H "Authorization: Bearer $FLUXMAIL_API_KEY"
```

Copy the account ID from `data`. You will use it in mailbox requests. API keys can be limited to selected mailboxes and permission profiles through [Permissions](/docs/permissions).

Folders and labels are separate resources. Use `/accounts/<account-id>/folders` for navigable mailbox locations. Use `/accounts/<account-id>/labels` for Gmail user labels or Outlook categories. Gmail user labels appear in both responses because they are navigable views and message tags. IMAP accounts return an unsupported capability error for labels.

## List messages

Get the 10 most recent inbox messages:

```bash
curl "$FLUXMAIL_API_URL/accounts/<account-id>/messages?folder=inbox&pageSize=10" \
  -H "Authorization: Bearer $FLUXMAIL_API_KEY"
```

List responses contain message metadata and snippets. Add filters such as `read=false`, `from=person@example.com`, or `text=invoice` when needed. The `query` parameter accepts [portable search syntax](/docs/email-search).

If the response includes `meta.nextPageToken`, pass it as `pageToken` with the same account, query, and page size. Check `meta.incomplete` before treating an empty page as no matches. See [List messages](/docs/rest-api/list-messages) for all filters.

## Get the complete message

Use an ID from the list response to fetch the message body and attachment metadata:

```bash
curl "$FLUXMAIL_API_URL/accounts/<account-id>/messages/<message-id>" \
  -H "Authorization: Bearer $FLUXMAIL_API_KEY"
```

Use [Get a thread](/docs/rest-api/get-thread) instead when you need the complete conversation.

## Mark the message as read

After your app processes a message, it can mark that message as read:

```bash
curl "$FLUXMAIL_API_URL/accounts/<account-id>/messages/actions" \
  -X POST \
  -H "Authorization: Bearer $FLUXMAIL_API_KEY" \
  -H "Content-Type: application/json" \
  --data '{
    "messageIds": ["<message-id>"],
    "action": "markRead"
  }'
```

The same endpoint can archive, star, move, label, trash, or permanently delete messages. See [Modify messages](/docs/rest-api/modify-messages) before using those actions.

## Continue building

- [Create a draft](/docs/rest-api/create-draft) or [send and reply](/docs/rest-api/send-message).
- [Download an attachment](/docs/rest-api/download-attachment).
- Browse the complete [REST API reference](/docs/rest-api), or load the OpenAPI 3.1 document from `/api/v1/openapi.json`.
