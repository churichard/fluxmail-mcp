---
title: 'fluxmail accounts configure'
description: 'Set special folder paths for an IMAP account'
updated: '2026-07-15'
---

<!-- This page is generated from the CLI command definitions. Run pnpm docs:generate to update it. -->

`fluxmail accounts configure`

Set special folder paths for an IMAP account

## Usage

```bash
fluxmail accounts configure <accountId> [options]
```

## Arguments

| Name | Required | Details | Default |
| --- | --- | --- | --- |
| `accountId` | Yes | None | None |

## Options

| Option | Required | Details | Default |
| --- | --- | --- | --- |
| `--sent-folder <path>` | No | Sent path, or auto to clear the override | None |
| `--drafts-folder <path>` | No | Drafts path, or auto to clear the override | None |
| `--trash-folder <path>` | No | Trash path, or auto to clear the override | None |
| `--archive-folder <path>` | No | Archive path, or auto to clear the override | None |
| `--spam-folder <path>` | No | Spam path, or auto to clear the override | None |
