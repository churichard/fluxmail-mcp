---
title: 'fluxmail emails search'
description: 'Search messages'
updated: '2026-07-15'
---

<!-- This page is generated from the CLI command definitions. Run pnpm docs:generate to update it. -->

`fluxmail emails search`

Search messages

## Usage

```bash
fluxmail emails search <query> [options]
```

## Arguments

| Name | Required | Details | Default |
| --- | --- | --- | --- |
| `query` | Yes | Full-text search query | None |

## Options

| Option | Required | Details | Default |
| --- | --- | --- | --- |
| `--folder <folder>` | No | Filter by folder ID, role, or name | None |
| `--from <address>` | No | Filter by sender | None |
| `--to <address>` | No | Filter by recipient | None |
| `--subject <text>` | No | Filter by subject | None |
| `--unread-only` | No | Return unread messages only | None |
| `--starred-only` | No | Return starred messages only | None |
| `--has-attachment` | No | Return messages with attachments only | None |
| `--after <date>` | No | Return messages on or after this ISO date | None |
| `--before <date>` | No | Return messages before this ISO date | None |
| `--raw-provider-query <query>` | No | Pass a provider-native query | None |
| `--page-size <number>` | No | Return 1 to 100 messages | None |
| `--page-token <token>` | No | Continue from a previous response | None |
