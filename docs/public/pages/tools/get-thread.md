---
title: 'Get thread'
description: 'Fetch a full conversation thread with all message bodies.'
updated: '2026-07-15'
---

<!-- This page is generated from the MCP tool definitions. Run pnpm docs:generate to update it. -->

`get_thread`

Fetch a full conversation thread with all message bodies.

## Permissions

Required capabilities: `mail.read`.

## Inputs

| Name | Required | Type | Details |
| --- | --- | --- | --- |
| `accountId` | No | `string` | Account to operate on. Optional when exactly one account is connected. Minimum length: 1. |
| `threadId` | Yes | `string` | Minimum length: 1. |

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
    "threadId": {
      "type": "string",
      "minLength": 1
    }
  },
  "required": [
    "threadId"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

</details>
