---
title: 'fluxmail emails send'
description: 'Send or schedule a message'
updated: '2026-07-15'
---

<!-- This page is generated from the CLI command definitions. Run pnpm docs:generate to update it. -->

`fluxmail emails send`

Send or schedule a message

## Usage

```bash
fluxmail emails send [options]
```

## Options

| Option | Required | Details | Default |
| --- | --- | --- | --- |
| `--to <address>` | No | Add a To recipient; repeat as needed | None |
| `--cc <address>` | No | Add a Cc recipient; repeat as needed | None |
| `--bcc <address>` | No | Add a Bcc recipient; repeat as needed | None |
| `--subject <subject>` | No | Set the subject | None |
| `--body <text>` | No | Set the plain-text body | None |
| `--body-file <path>` | No | Read the plain-text body from a file | None |
| `--html <html>` | No | Set the HTML body | None |
| `--html-file <path>` | No | Read the HTML body from a file | None |
| `--attach <path>` | No | Attach a local file; repeat as needed | None |
| `--reply-to <message-id>` | No | Reply to a message | None |
| `--reply-all` | No | Include the original recipients in the reply | None |
| `--input <file>` | No | Read an exact REST JSON body from a file, or pass - for stdin | None |
| `--draft <draft-id>` | No | Send an existing draft | None |
| `--send-at <timestamp>` | No | Schedule delivery at an ISO timestamp | None |
| `--idempotency-key <key>` | No | Reuse a delivery request safely | None |
