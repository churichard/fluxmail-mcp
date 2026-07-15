---
title: 'fluxmail accounts assign'
description: 'Change mailbox ownership'
updated: '2026-07-15'
---

<!-- This page is generated from the CLI command definitions. Run pnpm docs:generate to update it. -->

`fluxmail accounts assign`

Change mailbox ownership

## Usage

```bash
fluxmail accounts assign <accountId> [options]
```

## Arguments

| Name | Required | Details | Default |
| --- | --- | --- | --- |
| `accountId` | Yes | None | None |

## Options

| Option | Required | Details | Default |
| --- | --- | --- | --- |
| `--owner <member>` | No | Member (id or email) to own the mailbox | None |
| `--member <member>` | No | Deprecated alias for --owner | None |
| `--shared` | No | Deprecated alias for sharing with all members | None |
