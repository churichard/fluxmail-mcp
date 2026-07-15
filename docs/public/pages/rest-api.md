---
title: 'REST API'
description: 'Use Fluxmail from local scripts and applications through the versioned JSON API.'
updated: '2026-07-14'
---

Fluxmail serves a REST API at `/api/v1` alongside its MCP endpoint. The API uses the same connected mailboxes, member access rules, permission profiles, plan limits, and scheduled-send worker as MCP.

## Start the API locally

Connect a mailbox and create a member first. The [quickstart](/docs/quickstart) covers those steps. Then create an API key for the member that will make requests:

```bash
fluxmail apikey create \
  --name local-script \
  --member you@example.com
```

Copy the `fmk_...` value when Fluxmail displays it. The plaintext key cannot be shown again.

Start the HTTP server:

```bash
fluxmail serve
```

The local REST base URL is `http://localhost:8977/api/v1`. Check the server and save your key in the shell:

```bash
export FLUXMAIL_API_KEY='fmk_...'

curl http://localhost:8977/api/v1
curl http://localhost:8977/api/v1/status \
  -H "Authorization: Bearer $FLUXMAIL_API_KEY"
```

The same routes work in Docker and remote deployments. The HTTP server is not restricted to loopback, so use the host firewall and reverse proxy to control network access. Keep `FLUXMAIL_AUTH=apikey` unless the server is behind a trusted network boundary.

## Find an account ID

Mailbox routes include the account ID in the path. List the accounts available to the API key:

```bash
curl http://localhost:8977/api/v1/accounts \
  -H "Authorization: Bearer $FLUXMAIL_API_KEY"
```

A successful JSON response puts the result in `data`. A shortened response looks like this:

```json
{
  "data": [
    {
      "id": "acct_123",
      "provider": "gmail",
      "email": "you@example.com",
      "status": "active"
    }
  ]
}
```

The account object also includes provider capabilities and sharing metadata.

## Read mail

List messages with optional filters:

```bash
curl "http://localhost:8977/api/v1/accounts/acct_123/messages?folder=inbox&unreadOnly=true&pageSize=25" \
  -H "Authorization: Bearer $FLUXMAIL_API_KEY"
```

List responses contain an array in `data`. When another page exists, pass `meta.nextPageToken` back as `pageToken`:

```json
{
  "data": [],
  "meta": {
    "nextPageToken": "provider-token"
  }
}
```

The message list accepts `folder`, `text`, `from`, `to`, `subject`, `unreadOnly`, `starredOnly`, `hasAttachment`, `after`, `before`, `rawProviderQuery`, `pageSize`, and `pageToken`. Boolean query values must be `true` or `false`. Page size can be 1 through 100.

Fetch one message or a complete thread:

```bash
curl http://localhost:8977/api/v1/accounts/acct_123/messages/msg_123 \
  -H "Authorization: Bearer $FLUXMAIL_API_KEY"

curl http://localhost:8977/api/v1/accounts/acct_123/threads/thread_123 \
  -H "Authorization: Bearer $FLUXMAIL_API_KEY"
```

Download an attachment as raw bytes:

```bash
curl http://localhost:8977/api/v1/accounts/acct_123/messages/msg_123/attachments/att_123 \
  -H "Authorization: Bearer $FLUXMAIL_API_KEY" \
  --output report.pdf
```

Fluxmail sets `Content-Type`, `Content-Length`, and `Content-Disposition`. `FLUXMAIL_MAX_ATTACHMENT_MB` controls the decoded-size limit.

## Create and update drafts

Addresses are objects with a required `email` and an optional `name`. A draft body can contain plain text, HTML, or both:

```bash
curl http://localhost:8977/api/v1/accounts/acct_123/drafts \
  -X POST \
  -H "Authorization: Bearer $FLUXMAIL_API_KEY" \
  -H "Content-Type: application/json" \
  --data '{
    "to": [{"email": "ann@example.com", "name": "Ann"}],
    "subject": "Project update",
    "body": {"text": "The report is ready."}
  }'
```

Replace a draft with `PUT /api/v1/accounts/:accountId/drafts/:draftId`. Delete it with `DELETE` at the same URL. `PUT` replaces the full draft rather than applying a partial update.

To create a reply draft, include `replyToMessageId`. If `to` is omitted, Fluxmail derives the recipients from the original message. Set `replyAll` to `true` to include the original To and Cc recipients. Reply drafts require both `mail.drafts` and `mail.read`.

## Send mail safely

Send, schedule, and forward requests require an `Idempotency-Key` header. Use a new UUID for each intended delivery:

```bash
curl http://localhost:8977/api/v1/accounts/acct_123/send \
  -X POST \
  -H "Authorization: Bearer $FLUXMAIL_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  --data '{
    "to": [{"email": "ann@example.com"}],
    "subject": "Project update",
    "body": {"text": "The report is ready."}
  }'
```

You can send an existing draft with `{"draftId":"draft_123"}`. To reply, send message content with `replyToMessageId` and optional `replyAll`.

Add an ISO 8601 `sendAt` value with a timezone to schedule the message:

```json
{
  "draftId": "draft_123",
  "sendAt": "2026-07-20T09:00:00-04:00"
}
```

Scheduled requests return `202`. List them at `GET /api/v1/accounts/:accountId/scheduled-sends`. Cancel a pending item with `DELETE /api/v1/accounts/:accountId/scheduled-sends/:scheduleId`. Canceling leaves the provider draft in place.

Forward a message with:

```bash
curl http://localhost:8977/api/v1/accounts/acct_123/messages/msg_123/forward \
  -X POST \
  -H "Authorization: Bearer $FLUXMAIL_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  --data '{"to":[{"email":"bob@example.com"}],"comment":"For your review."}'
```

Original attachments are included unless `includeAttachments` is `false`.

### How retries work

Fluxmail scopes each idempotency key to the authenticated API key and keeps the result for 24 hours.

- Repeating the same request returns the stored response and sets `Idempotency-Replayed: true`.
- Reusing the key with different request data returns `409 idempotency_conflict`.
- A request that is still running, or whose provider outcome became uncertain during a restart, returns `409 idempotency_in_progress` with `Retry-After: 1`.

Do not retry an uncertain request with a new idempotency key. Check the Sent folder first. Fluxmail will not repeat the provider call under the original key while its record is retained.

## Organize messages

Batch actions use one request body:

```bash
curl http://localhost:8977/api/v1/accounts/acct_123/messages/actions \
  -X POST \
  -H "Authorization: Bearer $FLUXMAIL_API_KEY" \
  -H "Content-Type: application/json" \
  --data '{"messageIds":["msg_123"],"action":"archive"}'
```

Available actions are `markRead`, `markUnread`, `star`, `unstar`, `archive`, `trash`, `untrash`, `delete`, `move`, `addLabels`, and `removeLabels`. A move needs `folder`. Label actions need `labels`. Use the dedicated actions for archive, Trash, and system labels so the API can apply the correct permission.

## Permissions and errors

API keys use the same profiles and capabilities as MCP. See [Limit what a connection can do](/docs/permissions). Every mailbox response includes `Cache-Control: no-store`.

Errors have a stable JSON shape:

```json
{
  "error": {
    "code": "invalid_request",
    "message": "Request validation failed."
  }
}
```

| Status | Meaning |
| --- | --- |
| `400` | The path, query, headers, or JSON body failed validation. |
| `401` | The bearer API key is missing or invalid. |
| `403` | The key lacks a capability, or the instance is over its plan limit. |
| `404` | The resource does not exist or is outside the key's mailbox scope. |
| `409` | An idempotency conflict occurred, or the mailbox needs new authorization. |
| `422` | The email provider does not support the requested capability. |
| `429` | The provider rate limit was reached. |
| `503` | The email provider is unavailable. |

## OpenAPI contract

The OpenAPI 3.1 document is public and contains no mailbox data or credentials:

```text
http://localhost:8977/api/v1/openapi.json
```

It describes request bodies, parameters, response envelopes, error responses, and bearer authentication for every route. Fluxmail does not serve an interactive API console.
