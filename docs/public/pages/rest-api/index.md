---
title: 'REST API'
description: 'Use Fluxmail from local scripts and applications through the versioned JSON API.'
updated: '2026-07-15'
---

Fluxmail exposes a REST API at `/api/v1` alongside its MCP endpoint. It uses the same connected mailboxes, permissions, and plan limits as MCP.

## Start locally

Complete the [quickstart](/docs/quickstart), then create an API key and start the HTTP server:

```bash
fluxmail apikey create \
  --name local-script \
  --member you@example.com

fluxmail serve
```

Copy the `fmk_...` key when Fluxmail displays it. The local base URL is `http://localhost:8977/api/v1`.

Pass the key as a bearer token. For example, list the accounts available to the key:

```bash
export FLUXMAIL_API_KEY='fmk_...'

curl http://localhost:8977/api/v1/accounts \
  -H "Authorization: Bearer $FLUXMAIL_API_KEY"
```

Use the returned account ID in mailbox routes. If you expose the HTTP server outside your computer, protect it with a firewall or reverse proxy and keep `FLUXMAIL_AUTH=apikey` enabled.

## Administrative access

Routes under `/api/v1/admin` always require a bearer key, even when `FLUXMAIL_AUTH=none` allows unauthenticated mail requests. The key owner must be an administrator, and the key needs the capability for the requested operation:

| Capability | Access |
| --- | --- |
| `admin.accounts` | Connect or reauthorize mailboxes and update IMAP settings. |
| `admin.api_keys` | List, create, update, and revoke API keys. |
| `admin.license` | Read license status and activate a license key. |

The first member is the initial administrator. Create an administrative key from a local terminal:

```bash
fluxmail apikey create \
  --name instance-admin \
  --member you@example.com \
  --profile full \
  --admin admin.accounts \
  --admin admin.api_keys \
  --admin admin.license
```

Remote administrative requests require HTTPS. Requests from the local computer can use HTTP.

## Endpoint reference

<!-- BEGIN GENERATED:rest-api-endpoints -->
| Endpoint | Description |
| --- | --- |
| [Create or reauthorize a connection](/docs/rest-api/create-administrative-connection) | Create or reauthorize a Gmail, Outlook, or IMAP connection. Requires admin.accounts. |
| [Test an IMAP connection](/docs/rest-api/test-administrative-imap-connection) | Test IMAP and SMTP settings without saving an account. Requires admin.accounts. |
| [Update IMAP folders](/docs/rest-api/update-administrative-imap-folders) | Update the folder overrides for an IMAP account. Requires admin.accounts. |
| [List API keys](/docs/rest-api/list-administrative-api-keys) | List API key metadata without returning plaintext secrets. Requires admin.api_keys. |
| [Create an API key](/docs/rest-api/create-administrative-api-key) | Create an API key and return its plaintext secret once. Requires admin.api_keys. |
| [Update an API key](/docs/rest-api/update-administrative-api-key) | Update the permissions or mailbox scope of an API key. Requires admin.api_keys. |
| [Revoke an API key](/docs/rest-api/revoke-administrative-api-key) | Revoke an API key. Requires admin.api_keys. |
| [Get license status](/docs/rest-api/get-administrative-license) | Get license status and usage without returning the configured license key. Requires admin.license. |
| [Activate a license](/docs/rest-api/activate-administrative-license) | Validate and activate a Fluxmail license key. Requires admin.license. |
| [Get API information](/docs/rest-api/get-api-info) | Return the Fluxmail version and the URL of the OpenAPI document. |
| [Get server status](/docs/rest-api/get-status) | Return provider and mailbox status for the accounts available to the API key. |
| [List accounts](/docs/rest-api/list-accounts) | List the email accounts available to the API key. |
| [List folders](/docs/rest-api/list-folders) | List folders in an email account. |
| [List messages](/docs/rest-api/list-messages) | List and filter messages in an email account. |
| [Get a message](/docs/rest-api/get-message) | Get one message by its provider ID. |
| [Get a thread](/docs/rest-api/get-thread) | Get a complete email thread by its provider ID. |
| [Create a draft](/docs/rest-api/create-draft) | Create a new draft or a reply draft in an email account. |
| [Replace a draft](/docs/rest-api/update-draft) | Replace the full content of an existing draft. |
| [Delete a draft](/docs/rest-api/delete-draft) | Delete an existing draft from an email account. |
| [Send or schedule a message](/docs/rest-api/send-message) | Send a message now or schedule it for a specified time. |
| [List scheduled sends](/docs/rest-api/list-scheduled-sends) | List scheduled messages in an email account. |
| [Cancel a scheduled send](/docs/rest-api/cancel-scheduled-send) | Cancel a pending scheduled send and keep its provider draft. |
| [Forward a message](/docs/rest-api/forward-message) | Forward a message to one or more recipients. |
| [Modify messages](/docs/rest-api/modify-messages) | Apply one mailbox action to a batch of messages. |
| [Download an attachment](/docs/rest-api/download-attachment) | Download one attachment as raw bytes. |
<!-- END GENERATED:rest-api-endpoints -->

## Common behavior

- JSON responses put results in `data`. Paginated responses provide `meta.nextPageToken`.
- Send and forward requests require an `Idempotency-Key` header. Their endpoint pages explain safe retries.
- API keys use the profiles and capabilities described in [Permissions](/docs/permissions).
- Errors return an `error` object with a stable `code` and `message`.

## OpenAPI schema

The OpenAPI 3.1 schema is available without authentication:

```text
http://localhost:8977/api/v1/openapi.json
```

Use the schema or the endpoint pages for request parameters, JSON bodies, and response details.
