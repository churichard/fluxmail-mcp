---
title: 'fluxmail emails forward'
description: 'Forward a message'
updated: '2026-07-15'
---

<!-- This page is generated from the CLI command definitions. Run pnpm docs:generate to update it. -->

`fluxmail emails forward`

Forward a message

## Usage

```bash
fluxmail emails forward <message-id> [options]
```

## Arguments

| Name | Required | Details | Default |
| --- | --- | --- | --- |
| `message-id` | Yes | Provider message ID | None |

## Options

| Option | Required | Details | Default |
| --- | --- | --- | --- |
| `--to <address>` | No | Add a To recipient; repeat as needed | None |
| `--cc <address>` | No | Add a Cc recipient; repeat as needed | None |
| `--comment <text>` | No | Add a comment above the forwarded message | None |
| `--no-attachments` | No | Do not include attachments from the original message | None |
| `--idempotency-key <key>` | No | Reuse a delivery request safely | None |
| `--input <file>` | No | Read an exact REST JSON body from a file, or pass - for stdin | None |
