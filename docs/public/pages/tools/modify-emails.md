---
title: 'Modify emails'
description: 'Batch-modify emails using the actions allowed for this connection. Moving requires folder; labels require labels.'
updated: '2026-07-15'
---

<!-- This page is generated from the MCP tool definitions. Run pnpm docs:generate to update it. -->

`modify_emails`

Batch-modify emails using the actions allowed for this connection. Moving requires folder; labels require labels.

## Permissions

Required capabilities: `mail.organize` or `mail.trash` or `mail.delete`.

## Inputs

| Name | Required | Type | Details |
| --- | --- | --- | --- |
| `accountId` | No | `string` | Account to operate on. Optional when exactly one account is connected. Minimum length: 1. |
| `messageIds` | Yes | array of `string` | None |
| `action` | Yes | `markRead` or `markUnread` or `star` or `unstar` or `archive` or `trash` or `untrash` or `delete` or `move` or `addLabels` or `removeLabels` | None |
| `folder` | No | `string` | Target folder for action=move Minimum length: 1. |
| `labels` | No | array of `string` | Labels for addLabels/removeLabels |

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
    "messageIds": {
      "type": "array",
      "items": {
        "type": "string",
        "minLength": 1
      },
      "minItems": 1
    },
    "action": {
      "type": "string",
      "enum": [
        "markRead",
        "markUnread",
        "star",
        "unstar",
        "archive",
        "trash",
        "untrash",
        "delete",
        "move",
        "addLabels",
        "removeLabels"
      ]
    },
    "folder": {
      "type": "string",
      "minLength": 1,
      "description": "Target folder for action=move"
    },
    "labels": {
      "type": "array",
      "items": {
        "type": "string",
        "minLength": 1
      },
      "maxItems": 100,
      "description": "Labels for addLabels/removeLabels"
    }
  },
  "required": [
    "messageIds",
    "action"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

</details>
