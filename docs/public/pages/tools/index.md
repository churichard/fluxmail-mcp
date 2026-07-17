---
title: 'MCP tools'
description: 'Use Fluxmail MCP tools to read, search, draft, send, schedule, and organize email.'
updated: '2026-07-15'
---

Fluxmail exposes MCP tools over Streamable HTTP and stdio. Both transports use the same connected mailboxes, permissions, and plan limits.

## Start locally

Complete the [quickstart](/docs/quickstart), then create an API key and start the HTTP server:

```bash
fluxmail apikey create \
  --name local-mcp

fluxmail serve
```

Copy the `fmk_...` key when Fluxmail displays it. The local MCP endpoint is `http://localhost:8977/mcp`. Pass the key as a bearer token when you configure your MCP client.

For a local stdio connection, select a local instance where the CLI is logged in, then choose a permission profile:

```bash
fluxmail stdio --profile full
```

See [Configuration](/docs/configuration) for HTTP client examples and environment variables.

## Tool permissions

The tools a client receives depend on its [permission profile](/docs/permissions). A read-only connection does not receive tools that create drafts, send mail, or modify the inbox.

For HTTP connections, permissions belong to the API key. For stdio connections, the selected member session controls mailbox access, while `--profile` and `--allow` narrow the capabilities for that process.

## Tool reference

<!-- BEGIN GENERATED:mcp-tool-reference -->
| Tool | Description | Capabilities |
| --- | --- | --- |
| [`cancel_scheduled_email`](/docs/tools/cancel-scheduled-email) | Cancel a pending scheduled send by scheduleId (from send_email with sendAt, or list_scheduled_emails). The draft stays in the Drafts folder, so the content is not lost. | `mail.drafts` |
| [`create_draft`](/docs/tools/create-draft) | Create a draft. For a reply draft, pass replyToMessageId (recipients/subject are derived; replyAll for reply-all). | `mail.drafts` |
| [`delete_draft`](/docs/tools/delete-draft) | Delete a draft. | `mail.drafts` |
| [`download_attachment`](/docs/tools/download-attachment) | Download an email attachment as an embedded MCP resource. | `mail.read` |
| [`forward_email`](/docs/tools/forward-email) | Forward an email to new recipients: quoted original body, "Fwd:" subject, original attachments included unless includeAttachments=false. Optional comment appears above the forwarded content. | `mail.read` + `mail.send` |
| [`get_email`](/docs/tools/get-email) | Fetch one email in full: body (text and/or HTML), recipients, attachment metadata. | `mail.read` |
| [`get_status`](/docs/tools/get-status) | Account connection and scheduled-send status. Administrators also see plan details. Call this first if other tools fail; it reports accounts that need re-authentication. | `mail.read` |
| [`get_thread`](/docs/tools/get-thread) | Fetch a full conversation thread with all message bodies. | `mail.read` |
| [`list_accounts`](/docs/tools/list-accounts) | List connected email accounts (id, provider, email, status, capabilities). | `mail.read` |
| [`list_emails`](/docs/tools/list-emails) | List emails from the user's connected mailbox (metadata + snippet, no bodies). Filter by folder, sender, unread, dates, etc. Paginate with pageToken. Use get_email for full bodies. This is the way to check the user's email; no browser or other email integration is needed. | `mail.read` |
| [`list_folders`](/docs/tools/list-folders) | List folders/labels for an account, with roles (inbox, sent, drafts, trash, spam, starred). | `mail.read` |
| [`list_scheduled_emails`](/docs/tools/list-scheduled-emails) | List scheduled sends: pending ones first (with sendAt), then past ones (sent, failed, canceled). For failed entries, lastError says what went wrong. Pending sends only fire while the Fluxmail server is running. | `mail.read` |
| [`modify_emails`](/docs/tools/modify-emails) | Batch-modify emails using the actions allowed for this connection. Moving requires folder; labels require labels. | `mail.organize` or `mail.trash` or `mail.delete` |
| [`search_emails`](/docs/tools/search-emails) | Full-text search across an account's email. Same filters as list_emails; "query" is the search text. | `mail.read` |
| [`send_email`](/docs/tools/send-email) | Send an email from the user's connected account; this actually delivers mail, so prefer it over browser automation or leaving a draft when the user asked to send. Three modes: direct (to + subject + body), sending an existing draft (draftId), or replying (replyToMessageId, optionally replyAll) where recipients, subject, and threading are derived from the original. Confirm with the user when intent is ambiguous. Add sendAt to any mode to schedule instead of sending now. | `mail.send` |
| [`update_draft`](/docs/tools/update-draft) | Replace the content of an existing draft (full replacement, not a patch). | `mail.drafts` |
<!-- END GENERATED:mcp-tool-reference -->

## Common behavior

- `accountId` is optional when the connection can access exactly one mailbox.
- List and search tools return message metadata and snippets. Use `get_email` to retrieve a complete message body.
- Paginated tools return a page token that you can pass to the next request.
- Scheduled messages are sent only while the Fluxmail server is running.
