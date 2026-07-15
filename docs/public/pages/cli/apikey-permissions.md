---
title: 'fluxmail apikey permissions'
description: 'Change the permissions for an API key'
updated: '2026-07-15'
---

<!-- This page is generated from the CLI command definitions. Run pnpm docs:generate to update it. -->

`fluxmail apikey permissions`

Change the permissions for an API key

## Usage

```bash
fluxmail apikey permissions <keyId> [options]
```

## Arguments

| Name | Required | Details | Default |
| --- | --- | --- | --- |
| `keyId` | Yes | None | None |

## Options

| Option | Required | Details | Default |
| --- | --- | --- | --- |
| `--profile <profile>` | No | Tool profile: read-only, read-write, full | None |
| `--allow <capability>` | No | Allow one capability in a custom policy; repeat as needed | None |
| `--admin <capability>` | No | Add one admin capability to a named profile; repeat as needed | None |
