---
name: publish-packages
description: Publish Fluxmail releases across npm, GitHub Container Registry, and the official MCP Registry. Use when preparing, validating, dry-running, publishing, retrying, or verifying a Fluxmail release; bumping synchronized workspace versions; managing npm and Docker tags; or updating server.json registry metadata.
---

# Publish Fluxmail packages

Run release commands from the repository root. Treat `scripts/publish.mjs`, `scripts/check-package-licenses.mjs`, and `scripts/check-registry-metadata.mjs` as the source of truth.

## Choose the scope

Determine whether the user wants preparation, a dry run, or a live release.

- For preparation, make the version and metadata changes, validate them, and stop before publishing.
- For a dry run, run the checks and package builds without pushing artifacts.
- For a live release, require explicit publishing intent. Publishing changes npm, GHCR, and the MCP Registry.

Do not add Docker publishing or Registry publishing when the user asks for only one destination.

## Prepare the release

1. Inspect `git status`, the current branch, and the latest `origin/main`.
2. Preserve unrelated work. Start version changes only from a clean tree.
3. Confirm the intended version and npm tag. Use `latest` for stable releases and `next` for prereleases unless the user specifies another tag.
4. Keep these versions identical:
   - The private root `package.json`
   - Every `packages/*/package.json`
   - The top-level `version` in `server.json`
   - The npm package version inside `server.json`
5. Keep `packages/server/package.json#mcpName` identical to `server.json#name`.

Use the repository command to bump package manifests:

```bash
pnpm version:bump patch
```

Replace `patch` with a specific version or another pnpm-supported increment when appropriate. The command does not create a commit or tag, and it does not update `server.json`. Update both version fields in `server.json` before continuing.

The MCP Registry does not allow changing a published version or its metadata. Use a new package version for a new stable listing. If the user does not want a new release, update the source metadata only and state that the live listing will change with the next release.

## Validate before publishing

Run the focused metadata checks first:

```bash
pnpm registry:check
node scripts/check-package-licenses.mjs packages/core packages/provider-gmail packages/provider-imap packages/server
```

Then run the repository checks in build order:

```bash
pnpm format:check
pnpm lint
pnpm build
pnpm typecheck
pnpm test
```

Build before typechecking because workspace package declarations must exist. Fix failures before publishing.

Review and commit the release changes. `pnpm publish:all` requires a clean working tree.

## Authenticate

Confirm npm access:

```bash
npm whoami
```

If it fails, run `npm login`. npm may require a browser confirmation when publishing even after login. Surface the authorization link and keep the terminal session open.

For noninteractive CI, use an existing `NODE_AUTH_TOKEN`. Do not create, print, or commit an npm token.

Authenticate to GHCR before a live Docker release:

```bash
docker login ghcr.io
```

For the MCP Registry, install and authenticate the official publisher if needed:

```bash
brew install mcp-publisher
mcp-publisher login github
```

GitHub authentication proves ownership of the `io.github.churichard` Registry namespace. Surface the device URL and code when the publisher requests approval.

## Run a dry run

Use the repository release command:

```bash
pnpm publish:all --dry-run
```

The dry run builds and tests the npm packages and Docker image without publishing them. It still requires a working Docker daemon and multi-platform builder. Docker Desktop provides one by default. On plain Docker Engine, create one if needed:

```bash
docker buildx create --use
```

The default platforms are `linux/amd64,linux/arm64`. Override them only when requested:

```bash
DOCKER_PLATFORMS=linux/amd64 pnpm publish:all --dry-run
```

## Publish npm and Docker

For a stable release, run:

```bash
pnpm publish:all
```

For a prerelease, keep npm and Docker on the same tag:

```bash
pnpm publish:all --tag next
```

The default image is `ghcr.io/churichard/fluxmail-mcp`. Override it only when the user requests another repository:

```bash
pnpm publish:all --docker-image docker.io/your-name/fluxmail
```

The command publishes all four npm packages before pushing Docker tags. It skips npm packages already published at that version, which makes an npm retry safe. It refuses to overwrite an existing versioned Docker tag.

After the first GHCR release, confirm the package is public. If it is private, direct the user to `https://github.com/churichard/fluxmail-mcp/pkgs/container/fluxmail-mcp`, open Package settings, and change its visibility to Public. GitHub does not provide an API for this setting. Verify anonymous access with:

```bash
docker logout ghcr.io
docker pull ghcr.io/churichard/fluxmail-mcp:latest
```

## Publish Registry metadata

Publish the npm package before the Registry entry. The published `fluxmail` manifest must contain the matching `mcpName` and version.

Run:

```bash
pnpm registry:check
mcp-publisher publish
```

Do not retry with the same Registry version after a successful publication. Registry versions and metadata are immutable.

## Verify the release

Verify every destination used by the release:

```bash
npm view fluxmail version mcpName dist-tags --json
npm view @fluxmail/core version --json
npm view @fluxmail/provider-gmail version --json
npm view @fluxmail/provider-imap version --json
docker manifest inspect ghcr.io/churichard/fluxmail-mcp:<version>
```

Search the MCP Registry for `io.github.churichard/fluxmail` after publishing its metadata. Report the exact versions published, skipped, or blocked. Include any remaining manual step and do not claim success for a destination that was not verified.
