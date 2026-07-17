---
title: 'Authentication and instances'
description: 'Log in to local and remote Fluxmail instances, enroll members, manage sessions, and create API keys.'
updated: '2026-07-17'
---

Fluxmail uses member sessions for people and API keys for MCP clients, scripts, and other automation. A member session follows the member's current role and mailbox access. An API key is narrower: Fluxmail also checks its capabilities and optional mailbox allowlist on every request.

## Set up a local instance

Run this once on a fresh instance:

```bash
fluxmail setup --name "Your name" --email you@example.com
```

Fluxmail asks for a password without displaying it. The command creates the first administrator, adds a CLI profile named `local`, and saves a 90-day device session.

Passwords must contain 15 to 256 Unicode characters. Fluxmail rejects common passwords and passwords based on the member's name or email address. It does not require a mix of uppercase letters, numbers, and symbols.

## Log in to a remote instance

Name the profile when you add a server:

```bash
fluxmail --instance work login --server https://mail.example.com
```

Fluxmail asks for the member email and password. After the profile exists, the server URL is no longer needed:

```bash
fluxmail --instance work login
```

Remote profiles require HTTPS. Plain HTTP is accepted only for loopback addresses such as `http://127.0.0.1:8977`. The CLI refuses redirects for authenticated remote requests so it cannot forward a session to another origin.

If a reverse proxy terminates TLS and connects to Fluxmail from a non-loopback address, set `FLUXMAIL_TRUST_PROXY=1`. Fluxmail will then use the forwarded protocol and client address for HTTPS checks and login throttling. Enable this only when the proxy overwrites forwarded headers and blocks direct access to Fluxmail.

List, select, or remove profiles with:

```bash
fluxmail instances list
fluxmail instances use work
fluxmail instances remove work
```

`--instance <name>` overrides the selected profile for one command. Removing a profile deletes its local session secret but does not change the server or its data.

## Invite and enroll a member

An administrator creates a pending member:

```bash
fluxmail members add --name "Grace Hopper" --email grace@example.com
```

The command prints a one-time enrollment code. It expires after seven days. Send it to the member through a private channel. The member enrolls with:

```bash
fluxmail --instance work login --server https://mail.example.com --enroll
```

Fluxmail asks for the code and a new password without putting either secret in shell history. If the profile already exists, omit `--server`. Administrators can replace an unused or expired code with `fluxmail members invite <member>`.

Enrollment is only needed for the first password. Members use normal login afterward.

## Manage sessions

Member sessions have a server-enforced 90-day lifetime. Logout, suspension, removal, password reset, and explicit revocation take effect immediately.

```bash
fluxmail auth sessions
fluxmail auth revoke-session <session-id>
fluxmail logout
```

Administrators can inspect or revoke another member's sessions:

```bash
fluxmail members sessions <member>
fluxmail members revoke-session <member> <session-id>
```

Password reset codes last for one hour:

```bash
fluxmail members password-reset <member>
```

The member redeems the code with `fluxmail --instance <name> login --reset`. Email delivery is not built in, so the administrator must send the code privately.

## Use API keys for automation

Create a key while logged in:

```bash
fluxmail apikey create --name research-agent --profile read-only
```

The key belongs to the current member and is shown once. It can only reach mailboxes available to that member. Use repeated `--account` options to narrow it to specific mailboxes.

Administrators can issue a key for another member with `--member <id-or-email>`. Administrative capabilities require an administrator owner and an explicit `admin.*` capability. Demoting or suspending the owner removes that authority immediately.

HTTP MCP accepts API keys, not member sessions:

```http
Authorization: Bearer fmk_...
```

REST accepts either an API key or the `fms_...` session used by the CLI. A future web dashboard can use the same REST operations through a browser cookie adapter.

## Local stdio

`fluxmail stdio` uses the authenticated member session from the selected local profile. It does not accept a member override:

```bash
fluxmail stdio --profile read-only
```

Stdio is local only. Use the HTTP MCP endpoint and a scoped API key for remote MCP clients.

## Stored CLI files

Fluxmail keeps profile metadata and session secrets in separate files under `<data dir>/cli`. Both files are readable only by their owner, and the directory uses owner-only permissions. The session file contains the bearer secret. Copying the profile file alone does not copy a login.

## Recover a local administrator

If every administrator session is unavailable, someone with filesystem access to the instance can reset an existing administrator:

```bash
fluxmail auth recover-admin <id-or-email>
```

The command is local only. It sets a new password, reactivates that administrator if needed, revokes their sessions, and writes a security audit event. It cannot create a member or bypass plan limits.

Finish `fluxmail setup` before using administrator recovery. Migrated instances must claim an existing administrator during setup first.
