---
title: 'Forward a message'
description: 'Forward a message to one or more recipients.'
updated: '2026-07-15'
---

<!-- This page is generated from the OpenAPI schema. Run pnpm docs:generate to update it. -->

`POST /api/v1/accounts/{accountId}/messages/{messageId}/forward`

Forward a message to one or more recipients.

## Authentication

Pass a Fluxmail API key as a bearer token. The key determines the member, mailbox scope, and permissions for the request.

## Request

```bash
curl 'http://localhost:8977/api/v1/accounts/acct_123/messages/msg_123/forward' \
  -X POST \
  -H "Authorization: Bearer $FLUXMAIL_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  --data '{
  "to": [
    {
      "email": "person@example.com"
    }
  ]
}'
```

### Parameters

| Name | Location | Required | Type | Details |
| --- | --- | --- | --- | --- |
| `accountId` | path | Yes | `string` | Minimum length: 1. |
| `messageId` | path | Yes | `string` | Minimum length: 1. |
| `Idempotency-Key` | header | Yes | `string` | A unique key for one intended delivery. Reuse it when retrying the same request. Minimum length: 1. Maximum length: 255. Pattern: `^[\x21-\x7e]+$`. |

### Request body

Content type: `application/json`

<details>
<summary>JSON schema</summary>

```json
{
  "type": "object",
  "properties": {
    "to": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "email": {
            "type": "string",
            "format": "email"
          },
          "name": {
            "type": "string",
            "minLength": 1
          }
        },
        "required": [
          "email"
        ],
        "additionalProperties": false
      },
      "minItems": 1
    },
    "cc": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "email": {
            "type": "string",
            "format": "email"
          },
          "name": {
            "type": "string",
            "minLength": 1
          }
        },
        "required": [
          "email"
        ],
        "additionalProperties": false
      }
    },
    "comment": {
      "type": "string"
    },
    "includeAttachments": {
      "type": "boolean",
      "default": true,
      "description": "Include attachments from the original message. Defaults to true."
    }
  },
  "required": [
    "to"
  ],
  "additionalProperties": false
}
```

</details>

## Safe retries

Fluxmail keeps each idempotency result for 24 hours and scopes it to the authenticated API key.

- Repeating a completed request with the same key returns the stored response and sets `Idempotency-Replayed: true`.
- Reusing the key with different request data returns `409 idempotency_conflict`.
- A request that is still running, or whose outcome became uncertain during a restart, returns `409 idempotency_in_progress` with `Retry-After: 1`.

Reuse the original key when retrying the same request. If the outcome is uncertain, do not create a new key. Check the Sent folder before deciding whether to start a new delivery.

## Responses

| Status | Description | Content type |
| --- | --- | --- |
| `200` | Forward sent | `application/json` |
| `400` | Invalid request | `application/json` |
| `401` | Authentication required | `application/json` |
| `403` | Permission or plan denied | `application/json` |
| `404` | Resource not found | `application/json` |
| `409` | Request conflict | `application/json` |
| `422` | Unsupported capability | `application/json` |
| `429` | Provider rate limit | `application/json` |
| `500` | Internal error | `application/json` |
| `503` | Provider unavailable | `application/json` |

### 200 response

<details>
<summary>JSON schema</summary>

```json
{
  "type": "object",
  "properties": {
    "data": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string"
        },
        "threadId": {
          "type": "string"
        },
        "warnings": {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      },
      "required": [
        "id",
        "threadId"
      ],
      "additionalProperties": false
    },
    "warnings": {
      "type": "array",
      "items": {
        "type": "string"
      }
    }
  },
  "required": [
    "data"
  ],
  "additionalProperties": false
}
```

</details>
