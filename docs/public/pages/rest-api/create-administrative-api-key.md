---
title: 'Create an API key'
description: 'Create an API key and return its plaintext secret once. Requires admin.api_keys.'
updated: '2026-07-15'
---

<!-- This page is generated from the OpenAPI schema. Run pnpm docs:generate to update it. -->

`POST /api/v1/admin/api-keys`

Create an API key and return its plaintext secret once. Requires admin.api_keys.

## Authentication

Pass a Fluxmail API key as a bearer token. The key owner must be an administrator, and the key must include the administrative capability named in the endpoint description.

Remote administrative requests require HTTPS. Requests from the local computer can use HTTP.

## Request

```bash
curl 'http://localhost:8977/api/v1/admin/api-keys' \
  -X POST \
  -H "Authorization: Bearer $FLUXMAIL_API_KEY" \
  -H "Content-Type: application/json" \
  --data '{
  "name": "reporting",
  "member": "you@example.com",
  "permissionProfile": "read-only"
}'
```

### Request body

Content type: `application/json`

<details>
<summary>JSON schema</summary>

```json
{
  "type": "object",
  "properties": {
    "name": {
      "type": "string",
      "minLength": 1,
      "maxLength": 200
    },
    "member": {
      "type": "string",
      "minLength": 1,
      "maxLength": 200
    },
    "accounts": {
      "type": [
        "array",
        "null"
      ],
      "items": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200
      },
      "maxItems": 100
    },
    "permissionProfile": {
      "type": "string",
      "enum": [
        "read-only",
        "read-write",
        "full"
      ]
    },
    "supplementalCapabilities": {
      "type": "array",
      "items": {
        "type": "string",
        "enum": [
          "admin.accounts",
          "admin.api_keys",
          "admin.license"
        ]
      },
      "maxItems": 3
    },
    "customCapabilities": {
      "type": "array",
      "items": {
        "type": "string",
        "enum": [
          "mail.read",
          "mail.drafts",
          "mail.organize",
          "mail.trash",
          "mail.delete",
          "mail.send",
          "admin.accounts",
          "admin.api_keys",
          "admin.license"
        ]
      },
      "minItems": 1,
      "maxItems": 9
    }
  },
  "required": [
    "name",
    "member"
  ],
  "additionalProperties": false,
  "example": {
    "name": "reporting",
    "member": "you@example.com",
    "permissionProfile": "read-only"
  }
}
```

</details>

## Responses

| Status | Description | Content type |
| --- | --- | --- |
| `201` | Created API key with one-time plaintext secret | `application/json` |
| `400` | Invalid request | `application/json` |
| `401` | Authentication required | `application/json` |
| `403` | Administrative access denied | `application/json` |
| `404` | Resource not found | `application/json` |
| `409` | Request conflict | `application/json` |
| `413` | Request body too large | `application/json` |
| `415` | Unsupported media type | `application/json` |
| `500` | Internal error | `application/json` |
| `502` | License could not be verified | `application/json` |

### 201 response

<details>
<summary>JSON schema</summary>

```json
{
  "type": "object",
  "properties": {
    "data": {
      "allOf": [
        {
          "type": "object",
          "properties": {
            "id": {
              "type": "string"
            },
            "name": {
              "type": "string"
            },
            "createdAt": {
              "type": "string"
            },
            "lastUsedAt": {
              "type": [
                "string",
                "null"
              ]
            },
            "memberId": {
              "type": [
                "string",
                "null"
              ]
            },
            "permissionProfile": {
              "type": "string",
              "enum": [
                "read-only",
                "read-write",
                "full",
                "custom"
              ]
            },
            "capabilities": {
              "type": "array",
              "items": {
                "type": "string",
                "enum": [
                  "mail.read",
                  "mail.drafts",
                  "mail.organize",
                  "mail.trash",
                  "mail.delete",
                  "mail.send",
                  "admin.accounts",
                  "admin.api_keys",
                  "admin.license"
                ]
              }
            },
            "supplementalCapabilities": {
              "type": "array",
              "items": {
                "type": "string",
                "enum": [
                  "admin.accounts",
                  "admin.api_keys",
                  "admin.license"
                ]
              }
            },
            "accountIds": {
              "type": [
                "array",
                "null"
              ],
              "items": {
                "type": "string"
              }
            }
          },
          "required": [
            "id",
            "name",
            "createdAt",
            "lastUsedAt",
            "memberId",
            "permissionProfile",
            "capabilities",
            "supplementalCapabilities",
            "accountIds"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "key": {
              "type": "string"
            }
          },
          "required": [
            "key"
          ],
          "additionalProperties": false
        }
      ]
    }
  },
  "required": [
    "data"
  ],
  "additionalProperties": false
}
```

</details>
