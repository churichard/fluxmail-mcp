# Changelog

Fluxmail records user-facing changes in this file. The format follows [Common Changelog](https://common-changelog.org/).

## [Unreleased]

## [0.4.0] - 2026-07-16

### Changed

- **Breaking:** require every new mailbox, API key, and stdio connection to name a member; existing memberless API keys become management-only credentials and can no longer read mail ([#34](https://github.com/churichard/fluxmail-mcp/pull/34))
- **Breaking:** identify a mailbox by its email address across providers; on first startup, keep the Gmail connection when duplicates exist, or otherwise keep the oldest connection, and remove the other duplicates ([#34](https://github.com/churichard/fluxmail-mcp/pull/34))
- **Breaking:** exclude Spam and Trash from queries that omit `folder` or use `folder: "all"`; query either folder directly to include those messages ([#49](https://github.com/churichard/fluxmail-mcp/pull/49))
- **Breaking:** add required `sharingMode` and `sharedMemberIds` fields to `Account`, replace its deprecated `memberId` field with `ownerId`, and add required `supplementalCapabilities` to `PermissionPolicy` ([#34](https://github.com/churichard/fluxmail-mcp/pull/34))
- **Breaking:** require an authenticated key with `admin.accounts` for `POST /auth/connections`, even when `FLUXMAIL_AUTH=none`, and require HTTPS for remote administrative requests ([#44](https://github.com/churichard/fluxmail-mcp/pull/44))
- Require mailbox owners to reassign or delete their mailboxes before removing the member ([#34](https://github.com/churichard/fluxmail-mcp/pull/34))
- Separate mail permissions from the `admin.accounts`, `admin.api_keys`, and `admin.license` capabilities ([#44](https://github.com/churichard/fluxmail-mcp/pull/44))

### Added

- Add Microsoft 365 and Outlook.com support through Microsoft Graph, including local PKCE and hosted OAuth flows ([#40](https://github.com/churichard/fluxmail-mcp/pull/40))
- Add a JSON REST API at `/api/v1` with an OpenAPI 3.1 schema, raw attachment downloads, and stored idempotency results for sends and forwards ([#41](https://github.com/churichard/fluxmail-mcp/pull/41))
- Add authenticated administrative REST endpoints for mailbox connections, API keys, and license activation, with explicit capabilities and audit records ([#44](https://github.com/churichard/fluxmail-mcp/pull/44))
- Add member roles, private and shared mailbox access, selected-member sharing, and mailbox allowlists for API keys and stdio connections ([#34](https://github.com/churichard/fluxmail-mcp/pull/34))

### Fixed

- Check Outlook attachment metadata before downloading content when a size limit is active, avoiding unnecessary buffering for oversized files ([#42](https://github.com/churichard/fluxmail-mcp/pull/42))
- Preserve the separate Trash and Archive permissions in Outlook move operations, including moves that use Microsoft folder aliases ([#43](https://github.com/churichard/fluxmail-mcp/pull/43))
- Prevent hosted Microsoft OAuth responses from forwarding connection credentials through the HTTP referrer ([#43](https://github.com/churichard/fluxmail-mcp/pull/43))
- Stop a pending IMAP connection immediately when its provider closes during setup ([#49](https://github.com/churichard/fluxmail-mcp/pull/49))

[Unreleased]: https://github.com/churichard/fluxmail-mcp/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/churichard/fluxmail-mcp/compare/v0.3.0...v0.4.0
