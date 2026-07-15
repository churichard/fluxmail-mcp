---
title: 'Forward email'
description: 'Forward an email to new recipients: quoted original body, "Fwd:" subject, original attachments included unless includeAttachments=false. Optional comment appears above the forwarded content.'
updated: '2026-07-15'
---

<!-- This page is generated from the MCP tool definitions. Run pnpm docs:generate to update it. -->

`forward_email`

Forward an email to new recipients: quoted original body, "Fwd:" subject, original attachments included unless includeAttachments=false. Optional comment appears above the forwarded content.

## Permissions

Required capabilities: `mail.read` + `mail.send`.

## Inputs

| Name | Required | Type | Details |
| --- | --- | --- | --- |
| `accountId` | No | `string` | Account to operate on. Optional when exactly one account is connected. Minimum length: 1. |
| `messageId` | Yes | `string` | Minimum length: 1. |
| `to` | Yes | array of `string` | Recipients, each "Name <a@x.com>" or "a@x.com" |
| `cc` | No | array of `string` | Recipients, each "Name <a@x.com>" or "a@x.com" |
| `comment` | No | `string` | None |
| `includeAttachments` | No | `boolean` | Default true |

<details>
<summary>JSON input schema</summary>

```json
{
  "type": "object",
  "properties": {
    "accountId": {
      "type": "string",
      "minLength": 1,
      "description": "Account to operate on. Optional when exactly one account is connected."
    },
    "messageId": {
      "type": "string",
      "minLength": 1
    },
    "to": {
      "type": "array",
      "items": {
        "type": "string",
        "minLength": 1
      },
      "minItems": 1,
      "description": "Recipients, each \"Name <a@x.com>\" or \"a@x.com\""
    },
    "cc": {
      "type": "array",
      "items": {
        "$ref": "#/properties/to/items"
      },
      "description": "Recipients, each \"Name <a@x.com>\" or \"a@x.com\""
    },
    "comment": {
      "type": "string"
    },
    "includeAttachments": {
      "type": "boolean",
      "description": "Default true"
    }
  },
  "required": [
    "messageId",
    "to"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

</details>
