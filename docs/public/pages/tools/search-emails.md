---
title: 'Search emails'
description: 'Search one account with typed portable syntax. The query supports text, from:, to:, subject:, in:, read and starred states, attachments, and date filters.'
updated: '2026-07-15'
---

<!-- This page is generated from the MCP tool definitions. Run pnpm docs:generate to update it. -->

`search_emails`

Search one account with typed portable syntax. The query supports text, from:, to:, subject:, in:, read and starred states, attachments, and date filters.

## Permissions

Required capabilities: `mail.read`.

## Inputs

| Name | Required | Type | Details |
| --- | --- | --- | --- |
| `accountId` | No | `string` | Account to operate on. Optional when exactly one account is connected. Minimum length: 1. |
| `query` | Yes | `string` | Typed portable search syntax Minimum length: 1. |
| `folder` | No | `string` | Folder role (inbox, sent, drafts, trash, spam, starred, archive, all) or a label/folder name. Use all or omit this field to search all mail except Spam and Trash. An IMAP server's \All mailbox may use different rules. Minimum length: 1. |
| `from` | No | `string` | None |
| `to` | No | `string` | None |
| `subject` | No | `string` | None |
| `read` | No | `boolean` | None |
| `starred` | No | `boolean` | None |
| `hasAttachment` | No | `boolean` | None |
| `after` | No | `string` | YYYY-MM-DD received date, inclusive in UTC Minimum length: 1. |
| `before` | No | `string` | YYYY-MM-DD received date, exclusive in UTC Minimum length: 1. |
| `rawProviderQuery` | No | `string` | Provider-native Gmail syntax or Outlook KQL for one compatible account |
| `pageSize` | No | `integer` | Defaults to 25 Minimum: 1. Maximum: 100. |
| `pageToken` | No | `string` | nextPageToken from a previous call Minimum length: 1. |

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
    "query": {
      "type": "string",
      "minLength": 1,
      "description": "Typed portable search syntax"
    },
    "folder": {
      "type": "string",
      "minLength": 1,
      "description": "Folder role (inbox, sent, drafts, trash, spam, starred, archive, all) or a label/folder name. Use all or omit this field to search all mail except Spam and Trash. An IMAP server's \\All mailbox may use different rules."
    },
    "from": {
      "type": "string"
    },
    "to": {
      "type": "string"
    },
    "subject": {
      "type": "string"
    },
    "read": {
      "type": "boolean"
    },
    "starred": {
      "type": "boolean"
    },
    "hasAttachment": {
      "type": "boolean"
    },
    "after": {
      "type": "string",
      "minLength": 1,
      "description": "YYYY-MM-DD received date, inclusive in UTC"
    },
    "before": {
      "type": "string",
      "minLength": 1,
      "description": "YYYY-MM-DD received date, exclusive in UTC"
    },
    "rawProviderQuery": {
      "type": "string",
      "description": "Provider-native Gmail syntax or Outlook KQL for one compatible account"
    },
    "pageSize": {
      "type": "integer",
      "minimum": 1,
      "maximum": 100,
      "description": "Defaults to 25"
    },
    "pageToken": {
      "type": "string",
      "minLength": 1,
      "description": "nextPageToken from a previous call"
    }
  },
  "required": [
    "query"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

</details>
