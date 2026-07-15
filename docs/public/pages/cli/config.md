---
title: 'fluxmail config'
description: 'Persistent settings stored in the data dir, usable from any directory'
updated: '2026-07-15'
---

<!-- This page is generated from the CLI command definitions. Run pnpm docs:generate to update it. -->

`fluxmail config`

Persistent settings stored in the data dir, usable from any directory

## Usage

```bash
fluxmail config [command]
```

## Options

This command has no command-specific options.

## Subcommands

| Command | Description |
| --- | --- |
| [`fluxmail config set`](/docs/cli/config-set) | Store a setting (shell env vars and local .env files still take precedence) |
| [`fluxmail config unset`](/docs/cli/config-unset) | Remove a stored setting |
| [`fluxmail config list`](/docs/cli/config-list) | Show stored settings (secret values are masked) |
