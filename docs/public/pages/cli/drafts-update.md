---
title: 'fluxmail drafts update'
description: 'Replace the content of a draft'
updated: '2026-07-15'
---

<!-- This page is generated from the CLI command definitions. Run pnpm docs:generate to update it. -->

`fluxmail drafts update`

Replace the content of a draft

## Usage

```bash
fluxmail drafts update <draft-id> [options]
```

## Arguments

| Name | Required | Details | Default |
| --- | --- | --- | --- |
| `draft-id` | Yes | Provider draft ID | None |

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
