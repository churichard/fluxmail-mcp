# Changelog

Fluxmail records user-facing changes in this file. The format follows [Common Changelog](https://common-changelog.org/).

## [Unreleased]

## [0.5.0] - 2026-07-18

### Changed

- **Breaking:** require member authentication for every instance, remove `FLUXMAIL_AUTH=none`, revoke legacy API keys during migration, and require a backup to return to an older version; [back up the data directory and claim the instance](https://fluxmail.ai/docs/upgrades/0.5.0/) before reconnecting clients ([#58](https://github.com/churichard/fluxmail/pull/58))
- **Breaking:** replace the `Account` fields `ownerId`, `sharingMode`, `sharedMemberIds`, and `memberId` with `ownerMemberId`, `sharedWithAll`, and `grantedMemberIds`; update API clients to use the new fields ([#58](https://github.com/churichard/fluxmail/pull/58))
- **Breaking:** make the CLI use named local or remote instances for administration, and require a logged-in local session before starting stdio MCP ([#58](https://github.com/churichard/fluxmail/pull/58))
- Record CLI, MCP, and REST operations with one anonymous telemetry schema that excludes arguments, request data, identifiers, and error messages ([#55](https://github.com/churichard/fluxmail/pull/55))

### Added

- Add password login, member sessions, enrollment and reset flows, member status controls, scoped API keys, mailbox access grants, and append-only security audits ([#58](https://github.com/churichard/fluxmail/pull/58))
- Add instance setup, login, logout, instance switching, session management, and member administration commands to the CLI ([#58](https://github.com/churichard/fluxmail/pull/58))
- Add member and session authentication, self-service mailbox and API key management, and administrative member and audit operations to the REST API ([#58](https://github.com/churichard/fluxmail/pull/58))
- Use Fluxmail's built-in Desktop Google OAuth app for local Gmail connections while keeping custom clients available for local and hosted setups ([#56](https://github.com/churichard/fluxmail/pull/56))

### Fixed

- Keep the Google OAuth client that issued each stored Gmail refresh token so existing accounts continue to refresh after an app configuration change ([#60](https://github.com/churichard/fluxmail/pull/60))
- Serialize shared database migrations, stored configuration writes, and encryption key creation to protect concurrent Fluxmail processes ([#59](https://github.com/churichard/fluxmail/pull/59))

## [0.4.1] - 2026-07-17

### Changed

- Point package and registry metadata at `churichard/fluxmail`, with container images at `ghcr.io/churichard/fluxmail` ([#53](https://github.com/churichard/fluxmail/pull/53))

## [0.4.0] - 2026-07-16

### Changed

- **Breaking:** require every new mailbox, API key, and stdio connection to name a member; existing memberless API keys become management-only credentials and can no longer read mail ([#34](https://github.com/churichard/fluxmail/pull/34))
- **Breaking:** identify a mailbox by its email address across providers; on first startup, keep the Gmail connection when duplicates exist, or otherwise keep the oldest connection, and remove the other duplicates ([#34](https://github.com/churichard/fluxmail/pull/34))
- **Breaking:** exclude Spam and Trash from queries that omit `folder` or use `folder: "all"`; query either folder directly to include those messages ([#49](https://github.com/churichard/fluxmail/pull/49))
- **Breaking:** add required `sharingMode` and `sharedMemberIds` fields to `Account`, replace its deprecated `memberId` field with `ownerId`, and add required `supplementalCapabilities` to `PermissionPolicy` ([#34](https://github.com/churichard/fluxmail/pull/34))
- **Breaking:** require an authenticated key with `admin.accounts` for `POST /auth/connections`, even when `FLUXMAIL_AUTH=none`, and require HTTPS for remote administrative requests ([#44](https://github.com/churichard/fluxmail/pull/44))
- Require mailbox owners to reassign or delete their mailboxes before removing the member ([#34](https://github.com/churichard/fluxmail/pull/34))
- Separate mail permissions from the `admin.accounts`, `admin.api_keys`, and `admin.license` capabilities ([#44](https://github.com/churichard/fluxmail/pull/44))

### Added

- Add Microsoft 365 and Outlook.com support through Microsoft Graph, including local PKCE and hosted OAuth flows ([#40](https://github.com/churichard/fluxmail/pull/40))
- Add a JSON REST API at `/api/v1` with an OpenAPI 3.1 schema, raw attachment downloads, and stored idempotency results for sends and forwards ([#41](https://github.com/churichard/fluxmail/pull/41))
- Add authenticated administrative REST endpoints for mailbox connections, API keys, and license activation, with explicit capabilities and audit records ([#44](https://github.com/churichard/fluxmail/pull/44))
- Add member roles, private and shared mailbox access, selected-member sharing, and mailbox allowlists for API keys and stdio connections ([#34](https://github.com/churichard/fluxmail/pull/34))

### Fixed

- Check Outlook attachment metadata before downloading content when a size limit is active, avoiding unnecessary buffering for oversized files ([#42](https://github.com/churichard/fluxmail/pull/42))
- Preserve the separate Trash and Archive permissions in Outlook move operations, including moves that use Microsoft folder aliases ([#43](https://github.com/churichard/fluxmail/pull/43))
- Prevent hosted Microsoft OAuth responses from forwarding connection credentials through the HTTP referrer ([#43](https://github.com/churichard/fluxmail/pull/43))
- Stop a pending IMAP connection immediately when its provider closes during setup ([#49](https://github.com/churichard/fluxmail/pull/49))

[Unreleased]: https://github.com/churichard/fluxmail/compare/v0.5.0...HEAD
[0.4.0]: https://github.com/churichard/fluxmail/compare/v0.3.0...v0.4.0
[0.4.1]: https://github.com/churichard/fluxmail/compare/v0.4.0...v0.4.1
[0.5.0]: https://github.com/churichard/fluxmail/compare/v0.4.1...v0.5.0
