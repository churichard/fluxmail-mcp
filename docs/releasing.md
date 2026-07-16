# Releasing Fluxmail

The `/release` skill is the normal release interface. It audits compatibility, selects a version, prepares the Common Changelog entry, opens the release pull request, waits for CI, asks for publication approval, merges, publishes, resumes failures, and verifies every destination.

The scripts in `scripts/release.mjs` and `scripts/publish.mjs` enforce release invariants. The GitHub workflow performs live publication. This document covers one-time service setup and manual recovery.

## One-time setup

Run the automated checks first:

```bash
pnpm release doctor --json
pnpm release doctor --json --npm-trust
```

The strict npm check requires an npm login. If it returns an authentication URL, open it and complete the proof-of-presence check. Select npm's option to skip additional two-factor prompts for five minutes, then rerun the command. That window is long enough to inspect or configure all five packages.

### GitHub release environment

Create a GitHub environment named `release`. Restrict deployment branches to `main`.

The agent asks for explicit publication approval before it merges and dispatches a release, so the environment does not need required reviewers. Add a reviewer only if the project needs a second approval in the GitHub interface.

The workflow uses the environment name as part of its npm trusted-publisher identity. Do not rename it without updating the workflow and every npm package configuration.

### npm trusted publishers

Configure GitHub Actions as the trusted publisher for these packages:

- `@fluxmail/core`
- `@fluxmail/provider-gmail`
- `@fluxmail/provider-imap`
- `@fluxmail/provider-outlook`
- `fluxmail`

Use the same settings for each package:

- Repository: `churichard/fluxmail-mcp`
- Workflow file: `publish-release.yml`
- Environment: `release`
- Permission: `npm publish`

The agent can configure them after setup approval. The equivalent bulk command is:

```bash
for package in \
  @fluxmail/core \
  @fluxmail/provider-gmail \
  @fluxmail/provider-imap \
  @fluxmail/provider-outlook \
  fluxmail
do
  npx --yes npm@11 trust github "$package" \
    --repo churichard/fluxmail-mcp \
    --file publish-release.yml \
    --env release \
    --allow-publish \
    --yes
  sleep 2
done
```

### GHCR Actions access

Connect the `fluxmail-mcp` container package to `churichard/fluxmail-mcp`. A linked package inherits GitHub Actions access from that repository. The Dockerfile's `org.opencontainers.image.source` label keeps future images linked to the repository.

If preflight reports a mismatch, open the package settings and add `churichard/fluxmail-mcp` under Manage Actions access with write permission.

## Agent-driven release flow

Invoke `/release` and let the agent continue until it presents the publication approval packet. The packet includes the selected version, compatibility reasoning, complete changelog entry, pull request, release commit, npm tag, and destinations.

Approval authorizes the agent to merge the reviewed release pull request and dispatch the protected workflow. The workflow publishes five npm packages, a multi-platform GHCR image, MCP Registry metadata, a Git tag, and a GitHub Release. It verifies all destinations before it succeeds.

The release state lives in GitHub and the registries. Running `/release` again resumes an open pull request, a failed workflow, or a partial publication without relying on a local progress file.

## Manual inspection and recovery

Inspect destination state without writing anything:

```bash
pnpm release status --version <version> --json
```

Verify a completed release:

```bash
pnpm release verify \
  --version <version> \
  --sha <release-sha> \
  --npm-tag <latest-or-next>
```

When a workflow publish job fails after validation, rerun only the failed job. The release command skips existing immutable versions and starts at the first missing destination.

For the active release, a retry repairs a missing or stale Docker `latest` or `next` tag without rebuilding the image. A historical retry leaves newer npm and Docker channel tags unchanged.

Stop instead of retrying when Docker exists before every npm package, an existing npm version has the wrong channel tag without a consistent newer release, a published GitHub Release has a missing destination, a Git tag points to the wrong commit, or a draft GitHub Release has uploaded assets.

## Local fallback

Use local publishing only when GitHub Actions is unavailable. It requires separate approval because it replaces the normal OIDC and workflow controls.

Authenticate to npm and GitHub first. The GitHub CLI token needs `write:packages`:

```bash
npm whoami
gh auth refresh --hostname github.com --scopes write:packages
```

Then publish from a clean checkout of the approved commit:

```bash
pnpm release publish \
  --version <version> \
  --sha <release-sha> \
  --npm-tag <latest-or-next> \
  --resume
```
