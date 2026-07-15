---
title: 'Update draft'
description: 'Replace the content of an existing draft (full replacement, not a patch).'
updated: '2026-07-15'
---

<!-- This page is generated from the MCP tool definitions. Run pnpm docs:generate to update it. -->

`update_draft`

Replace the content of an existing draft (full replacement, not a patch).

## Permissions

Required capabilities: `mail.drafts`.

## Inputs

| Name | Required | Type | Details |
| --- | --- | --- | --- |
| `draftId` | Yes | `string` | Minimum length: 1. |
| `accountId` | No | `string` | Account to operate on. Optional when exactly one account is connected. Minimum length: 1. |
| `to` | No | array of `string` | Recipients, each "Name <a@x.com>" or "a@x.com" |
| `cc` | No | array of `string` | Recipients, each "Name <a@x.com>" or "a@x.com" |
| `bcc` | No | array of `string` | Recipients, each "Name <a@x.com>" or "a@x.com" |
| `subject` | No | `string` | Defaults to "Re: ..." when replying |
| `bodyText` | No | `string` | Plain-text body |
| `bodyHtml` | No | `string` | HTML body |
| `replyToMessageId` | No | `string` | Message being replied to; threads correctly and computes recipients if "to" is omitted |
| `replyAll` | No | `boolean` | With replyToMessageId: reply to all original recipients |
| `attachments` | No | array of `object` | None |

<details>
<summary>JSON input schema</summary>

```json
{
  "type": "object",
  "properties": {
    "draftId": {
      "type": "string",
      "minLength": 1
    },
    "accountId": {
      "type": "string",
      "minLength": 1,
      "description": "Account to operate on. Optional when exactly one account is connected."
    },
    "to": {
      "type": "array",
      "items": {
        "type": "string",
        "minLength": 1
      },
      "description": "Recipients, each \"Name <a@x.com>\" or \"a@x.com\""
    },
    "cc": {
      "$ref": "#/properties/to",
      "description": "Recipients, each \"Name <a@x.com>\" or \"a@x.com\""
    },
    "bcc": {
      "$ref": "#/properties/to",
      "description": "Recipients, each \"Name <a@x.com>\" or \"a@x.com\""
    },
    "subject": {
      "type": "string",
      "description": "Defaults to \"Re: ...\" when replying"
    },
    "bodyText": {
      "type": "string",
      "description": "Plain-text body"
    },
    "bodyHtml": {
      "type": "string",
      "description": "HTML body"
    },
    "replyToMessageId": {
      "$ref": "#/properties/draftId",
      "description": "Message being replied to; threads correctly and computes recipients if \"to\" is omitted"
    },
    "replyAll": {
      "type": "boolean",
      "description": "With replyToMessageId: reply to all original recipients"
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
            "description": "base64"
          }
        },
        "required": [
          "filename",
          "mimeType",
          "content"
        ],
        "additionalProperties": false
      }
    }
  },
  "required": [
    "draftId"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

</details>
