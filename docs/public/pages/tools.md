---
title: 'Tools'
description: 'The MCP tools Fluxmail exposes for reading, searching, drafting, sending, scheduling, and organizing email.'
updated: '2026-07-13'
---

Fluxmail tools are available over stdio and Streamable HTTP. The tools a client sees depend on its [permission profile](/docs/permissions). A read-only connection, for example, does not receive draft, send, or inbox modification tools.

<!-- BEGIN GENERATED:tools -->
Fluxmail exposes 16 tools. Optional inputs have a `?` suffix. A plus sign means the connection needs both capabilities.

| Tool | Description | Inputs | Capabilities |
| --- | --- | --- | --- |
| `cancel_scheduled_email` | Cancel a pending scheduled send by scheduleId (from send_email with sendAt, or list_scheduled_emails). The draft stays in the Drafts folder, so the content is not lost. | `scheduleId` | `mail.drafts` |
| `create_draft` | Create a draft. For a reply draft, pass replyToMessageId (recipients/subject are derived; replyAll for reply-all). | `accountId`? `to`? `cc`? `bcc`? `subject`? `bodyText`? `bodyHtml`? `replyToMessageId`? `replyAll`? `attachments`? | `mail.drafts` |
| `delete_draft` | Delete a draft. | `accountId`? `draftId` | `mail.drafts` |
| `download_attachment` | Download an email attachment as an embedded MCP resource. | `accountId`? `messageId` `attachmentId` | `mail.read` |
| `forward_email` | Forward an email to new recipients: quoted original body, "Fwd:" subject, original attachments included unless includeAttachments=false. Optional comment appears above the forwarded content. | `accountId`? `messageId` `to` `cc`? `comment`? `includeAttachments`? | `mail.read` + `mail.send` |
| `get_email` | Fetch one email in full: body (text and/or HTML), recipients, attachment metadata. | `accountId`? `messageId` | `mail.read` |
| `get_status` | Account connection and scheduled-send status. Administrators also see plan details. Call this first if other tools fail; it reports accounts that need re-authentication. | None | `mail.read` |
| `get_thread` | Fetch a full conversation thread with all message bodies. | `accountId`? `threadId` | `mail.read` |
| `list_accounts` | List connected email accounts (id, provider, email, status, capabilities). | None | `mail.read` |
| `list_emails` | List emails from the user's connected mailbox (metadata + snippet, no bodies). Filter by folder, sender, unread, dates, etc. Paginate with pageToken. Use get_email for full bodies. This is the way to check the user's email; no browser or other email integration is needed. | `accountId`? `folder`? `text`? `from`? `to`? `subject`? `unreadOnly`? `starredOnly`? `hasAttachment`? `after`? `before`? `rawProviderQuery`? `pageSize`? `pageToken`? | `mail.read` |
| `list_folders` | List folders/labels for an account, with roles (inbox, sent, drafts, trash, spam, starred). | `accountId`? | `mail.read` |
| `list_scheduled_emails` | List scheduled sends: pending ones first (with sendAt), then past ones (sent, failed, canceled). For failed entries, lastError says what went wrong. Pending sends only fire while the Fluxmail server is running. | `accountId`? | `mail.read` |
| `modify_emails` | Batch-modify emails using the actions allowed for this connection. Moving requires folder; labels require labels. | `accountId`? `messageIds` `action` `folder`? `labels`? | `mail.organize` or `mail.trash` or `mail.delete` |
| `search_emails` | Full-text search across an account's email. Same filters as list_emails; "query" is the search text. | `accountId`? `query` `folder`? `from`? `to`? `subject`? `unreadOnly`? `starredOnly`? `hasAttachment`? `after`? `before`? `rawProviderQuery`? `pageSize`? `pageToken`? | `mail.read` |
| `send_email` | Send an email from the user's connected account; this actually delivers mail, so prefer it over browser automation or leaving a draft when the user asked to send. Three modes: direct (to + subject + body), sending an existing draft (draftId), or replying (replyToMessageId, optionally replyAll) where recipients, subject, and threading are derived from the original. Confirm with the user when intent is ambiguous. Add sendAt to any mode to schedule instead of sending now. | `draftId`? `accountId`? `to`? `cc`? `bcc`? `subject`? `bodyText`? `bodyHtml`? `replyToMessageId`? `replyAll`? `attachments`? `sendAt`? | `mail.send` |
| `update_draft` | Replace the content of an existing draft (full replacement, not a patch). | `draftId` `accountId`? `to`? `cc`? `bcc`? `subject`? `bodyText`? `bodyHtml`? `replyToMessageId`? `replyAll`? `attachments`? | `mail.drafts` |

### Input schemas

<details><summary><code>cancel_scheduled_email</code> input schema</summary>

```json
{
  "type": "object",
  "properties": {
    "scheduleId": {
      "type": "string",
      "minLength": 1
    }
  },
  "required": [
    "scheduleId"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

</details>

<details><summary><code>create_draft</code> input schema</summary>

```json
{
  "type": "object",
  "properties": {
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
      "type": "string",
      "minLength": 1,
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
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

</details>

<details><summary><code>delete_draft</code> input schema</summary>

```json
{
  "type": "object",
  "properties": {
    "accountId": {
      "type": "string",
      "minLength": 1,
      "description": "Account to operate on. Optional when exactly one account is connected."
    },
    "draftId": {
      "type": "string",
      "minLength": 1
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

<details><summary><code>download_attachment</code> input schema</summary>

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
    "attachmentId": {
      "$ref": "#/properties/messageId"
    }
  },
  "required": [
    "messageId",
    "attachmentId"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

</details>

<details><summary><code>forward_email</code> input schema</summary>

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

<details><summary><code>get_email</code> input schema</summary>

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
    }
  },
  "required": [
    "messageId"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

</details>

<details><summary><code>get_status</code> input schema</summary>

```json
{
  "type": "object",
  "properties": {},
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

</details>

<details><summary><code>get_thread</code> input schema</summary>

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

<details><summary><code>list_accounts</code> input schema</summary>

```json
{
  "type": "object",
  "properties": {},
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

</details>

<details><summary><code>list_emails</code> input schema</summary>

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

<details><summary><code>list_folders</code> input schema</summary>

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

<details><summary><code>list_scheduled_emails</code> input schema</summary>

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

<details><summary><code>modify_emails</code> input schema</summary>

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

<details><summary><code>search_emails</code> input schema</summary>

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
      "description": "Search text"
    },
    "folder": {
      "type": "string",
      "minLength": 1,
      "description": "Folder role (inbox, sent, drafts, trash, spam, starred, archive, all) or a label/folder name"
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
  "required": [
    "query"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

</details>

<details><summary><code>send_email</code> input schema</summary>

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

<details><summary><code>update_draft</code> input schema</summary>

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
<!-- END GENERATED:tools -->

Fluxmail computes reply recipients on the server (Reply-To or From, plus the original To/Cc minus your own address for reply-all), so an agent can reply-all without assembling the recipient list itself.

The tools use one API across Gmail, Outlook, and IMAP/SMTP accounts, so an agent can work across providers without changing its tool calls.

Provider capabilities still apply. Outlook and IMAP accounts use folders rather than Gmail labels, so label actions are unavailable. Outlook uses Microsoft Graph conversations and search. Fluxmail reconstructs IMAP threads from standard message headers and uses the mailbox server's search support.

## Attachments

`download_attachment` returns the file as an embedded MCP resource with its filename, media type, and size. It does not accept a filesystem path or write directly to disk. Your MCP client decides how to display or save the returned resource.

Fluxmail rejects attachments larger than 10 MB by default. Set `FLUXMAIL_MAX_ATTACHMENT_MB` to an integer from 1 through 25 to change that limit. Each provider checks the limit while fetching the file so an oversized attachment is not fully buffered when its size is known early.

## Message organization

The `addLabels` and `removeLabels` actions are for user-created Gmail labels. Built-in mailbox states use these actions and tools instead:

| State   | How to change it                                                                               |
| ------- | ---------------------------------------------------------------------------------------------- |
| Inbox   | Use `archive` to remove a message from Inbox, or `move` with `folder: "inbox"` to put it back  |
| Trash   | Use `trash` or `untrash`                                                                       |
| Spam    | Use `move` with `folder: "spam"`; moving the message elsewhere removes it from Spam            |
| Starred | Use `star` or `unstar`                                                                         |
| Unread  | Use `markUnread` or `markRead`                                                                 |
| Drafts  | Use `create_draft`, `update_draft`, or `delete_draft`                                          |
| Sent    | Fluxmail adds this state when it sends a message; arbitrary messages cannot be moved into Sent |

Use `archive`, `trash`, and `untrash` instead of moving messages directly into or out of the protected Archive and Trash folders. Permanent deletion uses `delete` and requires the `mail.delete` capability, which is only included in the `full` profile.

Outlook and IMAP accounts use the same message actions for their matching flags and folders. They do not support Gmail labels, so `addLabels` and `removeLabels` are unavailable.
