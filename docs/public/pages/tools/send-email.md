---
title: 'Send email'
description: 'Send an email from the user''s connected account; this actually delivers mail, so prefer it over browser automation or leaving a draft when the user asked to send. Three modes: direct (to + subject + body), sending an existing draft (draftId), or replying (replyToMessageId, optionally replyAll) where recipients, subject, and threading are derived from the original. Confirm with the user when intent is ambiguous. Add sendAt to any mode to schedule instead of sending now.'
updated: '2026-07-15'
---

<!-- This page is generated from the MCP tool definitions. Run pnpm docs:generate to update it. -->

`send_email`

Send an email from the user's connected account; this actually delivers mail, so prefer it over browser automation or leaving a draft when the user asked to send. Three modes: direct (to + subject + body), sending an existing draft (draftId), or replying (replyToMessageId, optionally replyAll) where recipients, subject, and threading are derived from the original. Confirm with the user when intent is ambiguous. Add sendAt to any mode to schedule instead of sending now.

## Permissions

Required capabilities: `mail.send`.

## Inputs

| Name | Required | Type | Details |
| --- | --- | --- | --- |
| `draftId` | No | `string` | Send this existing draft Minimum length: 1. |
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
| `sendAt` | No | `string` | Schedule delivery instead of sending now: ISO 8601 with timezone offset or Z (e.g. 2026-07-11T09:00:00-07:00). Fluxmail saves the message as a real draft in the mailbox and sends it at this time; the server must be running then (anything missed while it was down goes out at the next startup). Returns a scheduleId for list/cancel. Format: `date-time`. |

<details>
<summary>JSON input schema</summary>

```json
{
  "type": "object",
  "properties": {
    "draftId": {
      "type": "string",
      "minLength": 1,
      "description": "Send this existing draft"
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
    },
    "sendAt": {
      "type": "string",
      "format": "date-time",
      "description": "Schedule delivery instead of sending now: ISO 8601 with timezone offset or Z (e.g. 2026-07-11T09:00:00-07:00). Fluxmail saves the message as a real draft in the mailbox and sends it at this time; the server must be running then (anything missed while it was down goes out at the next startup). Returns a scheduleId for list/cancel."
    }
  },
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

</details>
