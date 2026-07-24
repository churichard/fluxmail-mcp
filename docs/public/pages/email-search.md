---
title: 'Email search'
description: 'Use the same portable search syntax with Fluxmail CLI, MCP, and REST clients.'
updated: '2026-07-23'
---

Fluxmail has one portable search syntax for Gmail, Outlook, and IMAP mailboxes. You can use it with `fluxmail emails search`, the `search_emails` MCP tool, or the REST `query` parameter.

```text
from:ann@example.com in:archive is:unread after:2026-07-01 quarterly report
```

Search terms use implicit AND. Fluxmail does not interpret `AND`, `OR`, or parentheses as boolean expressions.

## Filters

| Syntax | Meaning |
| --- | --- |
| `from:value` | Sender |
| `to:value` | Recipient |
| `subject:value` | Subject |
| `in:role` | Portable folder role |
| `is:read` or `is:unread` | Read state |
| `is:starred` or `is:unstarred` | Starred state |
| `has:attachment` or `-has:attachment` | Non-inline attachment state |
| `after:YYYY-MM-DD` | Received on or after this UTC date |
| `before:YYYY-MM-DD` | Received before this UTC date |

Portable folder roles are `inbox`, `sent`, `drafts`, `archive`, `spam`, `trash`, and `all`. Custom folders are account specific. Use the structured `folder` filter after looking up the folder with `list_folders` or the REST folders endpoint.

Dates use the message's received or provider internal time. `after` is inclusive and `before` is exclusive. Both values must be calendar dates, and `after` must be earlier than `before`.

## Quotes and literal text

Double quotes group spaces inside a value:

```text
subject:"quarterly forecast" from:"Ann Example <ann@example.com>"
```

Inside quotes, escape `"` as `\"` and `\` as `\\`.

Free text is always literal. A search for `"from:ann@example.com"` looks for that text instead of activating a sender filter. URLs, times, unrelated values containing a colon, `AND`, `OR`, and parentheses also remain text.

Fluxmail may return a warning when a term looks like a mistyped operator. For example, `form:ann@example.com` remains literal text and produces a suggestion for `from:`. Quote the term when you intended it as text and do not want the warning.

## Provider-native search

Use `rawProviderQuery` when you need Gmail search syntax or Outlook KQL. Native queries are not portable and must target one compatible account. They are not part of the typed search string.

Structured `text` is literal and cannot be combined with `rawProviderQuery`. Other structured filters combine with a native query using AND.

IMAP supports Gmail native syntax only when the server advertises `X-GM-EXT-1`. Account capabilities report whether native syntax and portable folder roles are available, unavailable, or still unknown.

## Attachments

Fluxmail treats a message as having an attachment when its hydrated metadata contains at least one part whose disposition is not `inline`. This definition is the same across providers.

Gmail's `has:attachment` operator has different behavior, so Fluxmail does not use it for portable attachment searches. Gmail may need to inspect several provider pages before it fills a result page, especially when searching for messages without attachments.

## Pagination

Pass `nextPageToken` back with the same account, query, and page size. Search page tokens expire after one hour. They are signed to prevent changes, but their contents are not encrypted. Replacing the Fluxmail instance encryption key also invalidates existing tokens.

Some filters require local checks after Fluxmail receives provider candidates. A response can include:

```json
{
  "meta": {
    "nextPageToken": "...",
    "incomplete": true,
    "incompleteReason": "scan_limit",
    "inspectedCandidates": 1000
  }
}
```

An empty incomplete page does not mean that no matches exist. A client can follow up to three empty incomplete pages automatically, then offer a "Continue searching" action.
