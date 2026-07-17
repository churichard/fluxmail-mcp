---
title: 'fluxmail apikey create'
description: 'Create an API key (shown once)'
updated: '2026-07-15'
---

<!-- This page is generated from the CLI command definitions. Run pnpm docs:generate to update it. -->

`fluxmail apikey create`

Create an API key (shown once)

## Usage

```bash
fluxmail apikey create [options]
```

## Options

| Option | Required | Details | Default |
| --- | --- | --- | --- |
| `--name <name>` | Yes | Human-readable key name | None |
| `--member <member>` | No | Admin only: issue the key to another member | None |
| `--account <account>` | No | Limit the key to one mailbox; repeat as needed | None |
| `--profile <profile>` | No | Tool profile: read-only, read-write, full | None |
| `--allow <capability>` | No | Allow one capability in a custom policy; repeat as needed | None |
| `--admin <capability>` | No | Add one admin capability to a named profile; repeat as needed | None |
