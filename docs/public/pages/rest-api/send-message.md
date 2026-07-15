---
title: 'Send or schedule a message'
description: 'Send a message now or schedule it for a specified time.'
updated: '2026-07-15'
---

<!-- This page is generated from the OpenAPI schema. Run pnpm docs:generate to update it. -->

`POST /api/v1/accounts/{accountId}/send`

Send a message now or schedule it for a specified time.

## Authentication

Pass a Fluxmail API key as a bearer token. The key determines the member, mailbox scope, and permissions for the request.

## Request

```bash
curl 'http://localhost:8977/api/v1/accounts/acct_123/send' \
  -X POST \
  -H "Authorization: Bearer $FLUXMAIL_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  --data '{
  "draftId": "draft_123"
}'
```

### Parameters

| Name | Location | Required | Type | Details |
| --- | --- | --- | --- | --- |
| `accountId` | path | Yes | `string` | Minimum length: 1. |
| `Idempotency-Key` | header | Yes | `string` | A unique key for one intended delivery. Reuse it when retrying the same request. Minimum length: 1. Maximum length: 255. Pattern: `^[\x21-\x7e]+$`. |

### Request body

Content type: `application/json`

<details>
<summary>JSON schema</summary>

```json
{
  "anyOf": [
    {
      "type": "object",
      "properties": {
        "draftId": {
          "type": "string",
          "minLength": 1,
          "example": "draft_123"
        },
        "sendAt": {
          "type": "string",
          "format": "date-time"
        }
      },
      "required": [
        "draftId"
      ],
      "additionalProperties": false
    },
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
          }
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
        "bcc": {
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
        "subject": {
          "type": "string"
        },
        "body": {
          "type": "object",
          "properties": {
            "text": {
              "type": "string"
            },
            "html": {
              "type": "string"
            }
          },
          "additionalProperties": false
        },
        "replyToMessageId": {
          "type": "string",
          "minLength": 1,
          "example": "msg_123"
        },
        "replyAll": {
          "type": "boolean",
          "description": "Requires replyToMessageId when true."
        },
        "attachments": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "filename": {
                "type": "string",
                "minLength": 1
              },
              "mimeType": {
                "type": "string",
                "minLength": 1
              },
              "content": {
                "type": "string",
                "format": "byte",
                "pattern": "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$",
                "description": "Base64-encoded content"
              },
              "contentId": {
                "type": "string",
                "minLength": 1
              },
              "disposition": {
                "type": "string",
                "enum": [
                  "inline",
                  "attachment"
                ]
              }
            },
            "required": [
              "filename",
              "mimeType",
              "content"
            ],
            "additionalProperties": false
          }
        },
        "sendAt": {
          "type": "string",
          "format": "date-time"
        }
      },
      "required": [
        "body"
      ],
      "additionalProperties": false
    }
  ]
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
| `200` | Message sent | `application/json` |
| `202` | Message scheduled | `application/json` |
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

### 202 response

<details>
<summary>JSON schema</summary>

```json
{
  "type": "object",
  "properties": {
    "data": {
      "type": "object",
      "properties": {
        "scheduleId": {
          "type": "string"
        },
        "accountId": {
          "type": "string"
        },
        "draftId": {
          "type": "string"
        },
        "sendAt": {
          "type": "string"
        },
        "status": {
          "type": "string",
          "enum": [
            "pending",
            "sending",
            "sent",
            "failed",
            "canceled"
          ]
        },
        "attempts": {
          "type": "integer",
          "minimum": 0
        },
        "subject": {
          "type": "string"
        },
        "to": {
          "type": "string"
        },
        "lastError": {
          "type": "string"
        },
        "sentMessageId": {
          "type": "string"
        },
        "sentThreadId": {
          "type": "string"
        }
      },
      "required": [
        "scheduleId",
        "accountId",
        "draftId",
        "sendAt",
        "status",
        "attempts"
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
