---
title: 'Authentication migration'
description: 'Upgrade an existing Fluxmail instance to member login, sessions, owned mailboxes, and scoped API keys.'
updated: '2026-07-17'
---

The member authentication release performs one breaking SQLite migration. Back up the Fluxmail data directory before installing it. The default directory is `~/.fluxmail` for a local installation and `/data` in the Docker image.

## What the migration keeps

Fluxmail preserves member IDs and roles, mailbox messages and provider state, encrypted provider credentials, existing mailbox owners, selected member grants, and share-with-all behavior.

The old sharing modes map to the current fields as follows:

| Previous setting | Current setting |
| --- | --- |
| Private | `sharedWithAll = false`, with no explicit grants |
| Selected members | `sharedWithAll = false`, with the selected grants preserved |
| All members | `sharedWithAll = true` |

Mailboxes without a real owner remain unavailable to authenticated clients until the local administrator claim. The claim assigns those mailboxes to the chosen administrator. Mailboxes already owned by another member keep that owner.

## What the migration changes

All existing members become pending because old member records do not have password credentials. Every legacy API key is revoked. Fluxmail does not convert memberless or implicitly trusted credentials.

Authenticated MCP and REST access remains blocked until one existing administrator claims the instance. Health checks and the server process remain available during this step. `FLUXMAIL_AUTH=none` is no longer supported.

## Claim the instance

Run setup on the instance host:

```bash
fluxmail setup --existing-admin <id-or-email> --email admin@example.com
```

Use an existing administrator ID or email. Supply `--email` when the legacy record has no login email. Fluxmail asks for a new password, activates that administrator, assigns ownerless mailboxes, creates the `local` CLI profile, and logs it in.

If you do not know the administrator ID, run `fluxmail setup` once. The error lists the existing administrators that can be claimed. It does not modify the database.

## Enroll the remaining members

The claimed administrator issues new enrollment codes:

```bash
fluxmail members list
fluxmail members invite <member>
```

Each member enrolls from their own CLI:

```bash
fluxmail --instance work login --server https://mail.example.com --enroll
```

Enrollment codes last seven days and work once. Members use their email and password for later logins.

## Replace API keys

Create new keys after the owner has enrolled:

```bash
fluxmail apikey create --name agent --profile read-only
```

Each key now has an explicit member owner and capability policy. An optional mailbox allowlist can only narrow the owner's current mailbox access. Recreate administrative keys with the specific `admin.*` capabilities they need.

## Recovery and rollback

Use `fluxmail auth recover-admin <id-or-email>` on the instance host if the claimed administrator loses access. The command resets that administrator's password and revokes their sessions.

To return to an older Fluxmail version, stop Fluxmail and restore the complete data-directory backup. An older binary cannot use the migrated schema. Keep the migrated directory until you have confirmed that member login, mailbox ownership, grants, and new API keys work as expected.
