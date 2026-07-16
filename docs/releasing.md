# Releasing Fluxmail

Fluxmail releases publish five npm packages, a multi-platform container image, MCP Registry metadata, a Git tag, and a GitHub Release. The release scripts keep those destinations in a fixed order and can resume after a partial failure.

## One-time setup

Create a GitHub environment named `release` and add the required reviewers. The publish job uses this environment as its approval gate.

Configure npm trusted publishing for each package:

- `@fluxmail/core`
- `@fluxmail/provider-gmail`
- `@fluxmail/provider-imap`
- `@fluxmail/provider-outlook`
- `fluxmail`

Use these trusted publisher settings:

- Provider: GitHub Actions
- Repository: `churichard/fluxmail-mcp`
- Workflow: `publish-release.yml`
- Environment: `release`
- Allowed action: `npm publish`

Grant the repository write access to the `fluxmail-mcp` container under the package's GitHub Actions access settings. The workflow uses its short-lived `GITHUB_TOKEN` for GHCR and GitHub OIDC for npm and the MCP Registry.

## Prepare a release

Audit the changes since the nearest published release before choosing the version. Once the version is known, start from a clean working tree:

```bash
pnpm release prepare <version>
```

The command updates every publishable package, the root package, `server.json`, the lockfile, and `CHANGELOG.md`. It discovers publishable packages from the workspace instead of relying on a copied list.

Curate the new changelog entry before opening the release pull request. Keep the Common Changelog groups in this order: `Changed`, `Added`, `Removed`, and `Fixed`. Remove empty groups and internal changes. Each bullet must end with a linked pull request, issue, or commit. Prefix breaking changes with `**Breaking:**`.

Validate the release tree:

```bash
pnpm release validate --version <version>
pnpm publish:all --dry-run --tag <latest-or-next>
```

Commit the version and changelog together, then open the release pull request. Reviewing that pull request also reviews the GitHub Release notes because the workflow renders them directly from `CHANGELOG.md`.

## Publish from GitHub Actions

After the release pull request merges, copy its full merge commit SHA and run the `Publish release` workflow with:

- `version`: the version without the `v` prefix
- `release_sha`: the full commit SHA on `main`
- `npm_tag`: `latest` for a stable release or `next` for a prerelease

The validation job runs metadata checks, formatting, lint, builds, typechecking, documentation checks, and tests. It saves the package builds for the publish job. The protected publish job then publishes npm, GHCR, the MCP Registry, the Git tag, and the GitHub Release before verifying every destination.

If the publish job fails, rerun the failed job. The release CLI reads the current destination state and starts at the first missing destination. It does not republish immutable versions or rerun the validation job.

Inspect a release at any time:

```bash
pnpm release status --version <version>
pnpm release verify --version <version> --sha <release-sha> --npm-tag <latest-or-next>
```

## Local fallback

Use the local path only when GitHub Actions is unavailable. Authenticate to npm and GitHub first. The GitHub CLI token must include `write:packages`:

```bash
npm whoami
gh auth refresh --hostname github.com --scopes write:packages
```

Then run:

```bash
pnpm release publish \
  --version <version> \
  --sha <release-sha> \
  --npm-tag <latest-or-next> \
  --resume
```

The command logs Docker into GHCR with the checked GitHub CLI token. It opens the MCP Registry device login immediately before Registry publication so its short-lived credential does not expire during npm or Docker work.
