---
title: 'fluxmail emails modify'
description: 'Apply one action to one or more messages'
updated: '2026-07-15'
---

<!-- This page is generated from the CLI command definitions. Run pnpm docs:generate to update it. -->

`fluxmail emails modify`

Apply one action to one or more messages

## Usage

```bash
fluxmail emails modify [action] [message-ids...] [options]
```

## Arguments

| Name | Required | Details | Default |
| --- | --- | --- | --- |
| `action` | No | Message action, such as mark-read, archive, move, or add-labels | None |
| `message-ids...` | No | Provider message IDs | None |

## Options

| Option | Required | Details | Default |
| --- | --- | --- | --- |
| `--folder <folder>` | No | Destination folder for move | None |
| `--label <label>` | No | Label or Outlook category; repeat as needed | None |
| `--input <file>` | No | Read an exact REST JSON body from a file, or pass - for stdin | None |
