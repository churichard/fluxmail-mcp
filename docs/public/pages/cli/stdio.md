---
title: 'fluxmail stdio'
description: 'Run as a stdio MCP server (for Claude Desktop / Claude Code local config)'
updated: '2026-07-15'
---

<!-- This page is generated from the CLI command definitions. Run pnpm docs:generate to update it. -->

`fluxmail stdio`

Run as a stdio MCP server (for Claude Desktop / Claude Code local config)

## Usage

```bash
fluxmail stdio [options]
```

## Options

| Option | Required | Details | Default |
| --- | --- | --- | --- |
| `--member <member>` | Yes | Member (id or email) using this MCP process | None |
| `--account <account>` | No | Limit access to one mailbox; repeat as needed | None |
| `--profile <profile>` | No | Tool profile: read-only, read-write, full | None |
| `--allow <capability>` | No | Allow one MCP capability; repeat as needed | None |
