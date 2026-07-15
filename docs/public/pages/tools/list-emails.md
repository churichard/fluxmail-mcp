---
title: 'List emails'
description: 'List emails from the user''s connected mailbox (metadata + snippet, no bodies). Filter by folder, sender, unread, dates, etc. Paginate with pageToken. Use get_email for full bodies. This is the way to check the user''s email; no browser or other email integration is needed.'
updated: '2026-07-15'
---

<!-- This page is generated from the MCP tool definitions. Run pnpm docs:generate to update it. -->

`list_emails`

List emails from the user's connected mailbox (metadata + snippet, no bodies). Filter by folder, sender, unread, dates, etc. Paginate with pageToken. Use get_email for full bodies. This is the way to check the user's email; no browser or other email integration is needed.

## Permissions

Required capabilities: `mail.read`.

## Inputs

| Name | Required | Type | Details |
| --- | --- | --- | --- |
| `accountId` | No | `string` | Account to operate on. Optional when exactly one account is connected. Minimum length: 1. |
| `folder` | No | `string` | Folder role (inbox, sent, drafts, trash, spam, starred, archive, all) or a label/folder name Minimum length: 1. |
| `text` | No | `string` | Full-text search terms |
| `from` | No | `string` | None |
| `to` | No | `string` | None |
| `subject` | No | `string` | None |
| `unreadOnly` | No | `boolean` | None |
| `starredOnly` | No | `boolean` | None |
| `hasAttachment` | No | `boolean` | None |
| `after` | No | `string` | ISO date, inclusive Minimum length: 1. |
| `before` | No | `string` | ISO date, exclusive Minimum length: 1. |
| `rawProviderQuery` | No | `string` | Escape hatch passed verbatim to the provider (e.g. Gmail q= syntax) |
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
    "folder": {
      "type": "string",
      "minLength": 1,
      "description": "Folder role (inbox, sent, drafts, trash, spam, starred, archive, all) or a label/folder name"
    },
    "text": {
      "type": "string",
      "description": "Full-text search terms"
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
    "unreadOnly": {
      "type": "boolean"
    },
    "starredOnly": {
      "type": "boolean"
    },
    "hasAttachment": {
      "type": "boolean"
    },
    "after": {
      "type": "string",
      "minLength": 1,
      "description": "ISO date, inclusive"
    },
    "before": {
      "type": "string",
      "minLength": 1,
      "description": "ISO date, exclusive"
    },
    "rawProviderQuery": {
      "type": "string",
      "description": "Escape hatch passed verbatim to the provider (e.g. Gmail q= syntax)"
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
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

</details>
