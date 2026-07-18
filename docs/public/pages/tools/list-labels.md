---
title: 'List labels'
description: 'List Gmail user labels or Outlook categories for an account.'
updated: '2026-07-15'
---

<!-- This page is generated from the MCP tool definitions. Run pnpm docs:generate to update it. -->

`list_labels`

List Gmail user labels or Outlook categories for an account.

## Permissions

Required capabilities: `mail.read`.

## Inputs

| Name | Required | Type | Details |
| --- | --- | --- | --- |
| `accountId` | No | `string` | Account to operate on. Optional when exactly one account is connected. Minimum length: 1. |

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
    }
  },
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

</details>
