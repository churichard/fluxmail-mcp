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
- For a full live release, require explicit publishing intent. A full release changes npm, GHCR, and the MCP Registry.

`pnpm publish:all` always handles npm and Docker together. The Registry uses separate commands. Do not run `publish:all` when the user asks for only npm or only Docker. Explain that the repository has no single-destination mode and stop before publishing unless the user explicitly authorizes a manual destination-specific procedure.

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

## Inspect existing release state

Before changing manifests or running a live command, check whether the intended version already exists at each requested destination:

```bash
npm view fluxmail@<version> version mcpName --json
npm view @fluxmail/core@<version> version --json
npm view @fluxmail/provider-gmail@<version> version --json
npm view @fluxmail/provider-imap@<version> version --json
docker manifest inspect ghcr.io/churichard/fluxmail-mcp:<version>
curl -fsS 'https://registry.modelcontextprotocol.io/v0/servers?search=io.github.churichard%2Ffluxmail'
```

Treat a missing npm version, Docker manifest, or Registry entry as unpublished. Route partial releases by destination state:

- If npm is partly or fully published and the versioned Docker tag is missing, rerun `pnpm publish:all`. It skips npm packages that already exist.
- If all npm packages and the versioned Docker tag exist but the Registry entry is missing, skip `publish:all` and publish only the Registry metadata.
- If the versioned Docker tag exists while any npm package is missing, stop and report the inconsistent release. Do not improvise a repair without explicit approval.
- If the Registry version exists, do not publish it again. Complete any missing npm or Docker destination using the rules above, then verify the Registry entry. Use a new version when its metadata must change.

## Validate before publishing

Run the focused metadata checks first:

```bash
pnpm registry:check
node scripts/check-package-licenses.mjs packages/core packages/provider-gmail packages/provider-imap packages/server
```

If the release includes Registry metadata, install the official publisher if needed and run its read-only validation. This checks the Registry schema and semantic rules without publishing or requiring login.

```bash
command -v mcp-publisher >/dev/null || brew install mcp-publisher
mcp-publisher validate server.json
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

For the MCP Registry, authenticate the official publisher if needed:

```bash
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
anonymous_docker_config="$(mktemp -d)"
DOCKER_CONFIG="$anonymous_docker_config" docker pull ghcr.io/churichard/fluxmail-mcp:<version>
```

Remove the temporary directory afterward. Do not use `docker logout`, which would remove the user's saved GHCR credentials.

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
npm view fluxmail@<version> version mcpName --json
npm view fluxmail dist-tags --json
npm view @fluxmail/core@<version> version --json
npm view @fluxmail/provider-gmail@<version> version --json
npm view @fluxmail/provider-imap@<version> version --json
docker manifest inspect ghcr.io/churichard/fluxmail-mcp:<version>
curl -fsS 'https://registry.modelcontextprotocol.io/v0/servers?search=io.github.churichard%2Ffluxmail'
```

Confirm that the Registry response contains `io.github.churichard/fluxmail` at the intended version. Report the exact versions published, skipped, or blocked. Include any remaining manual step and do not claim success for a destination that was not verified.
