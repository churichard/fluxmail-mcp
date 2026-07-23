---
title: 'fluxmail oauth configure outlook'
description: 'Configure a custom Microsoft OAuth application'
updated: '2026-07-15'
---

<!-- This page is generated from the CLI command definitions. Run pnpm docs:generate to update it. -->

`fluxmail oauth configure outlook`

Configure a custom Microsoft OAuth application

## Usage

```bash
fluxmail oauth configure outlook [options]
```

## Options

| Option | Required | Details | Default |
| --- | --- | --- | --- |
| `--client-id <id>` | Yes | Microsoft OAuth client ID | None |
| `--tenant-id <tenant>` | No | Microsoft tenant ID | `common` |
| `--public-client` | No | Configure a public client without a secret | None |
| `--client-secret-file <path>` | No | Read the client secret from a file, or use - for stdin | None |
