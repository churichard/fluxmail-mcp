---
name: publish-packages
description: Publish Fluxmail releases across npm, GitHub Container Registry, GitHub Releases, and the official MCP Registry. Use when preparing, validating, dry-running, publishing, resuming, or verifying a Fluxmail release; generating and approving Common Changelog release notes; bumping synchronized workspace versions; managing npm, Docker, or Git tags; or updating server.json registry metadata.
---

# Publish Fluxmail packages

Run release commands from the repository root. Treat `scripts/release.mjs`, `scripts/publish.mjs`, and `scripts/release-config.mjs` as the source of truth. Read `docs/releasing.md` when configuring trusted publishing or the GitHub release environment.

## Choose the scope

Determine whether the user wants preparation, a dry run, a live release, a retry, or verification.

- Preparation changes versions and `CHANGELOG.md`, validates the result, and stops before publishing.
- A dry run builds and packages the release without writing to a registry.
- A live release requires explicit publishing intent and approval of the exact release pull request contents.
- A retry uses the release CLI's resume path. Do not improvise destination-specific writes.
- Verification reads every destination and makes no changes.

Do not publish when the user asks only for analysis or preparation.

## Audit changes and choose a version

Complete a compatibility audit before editing manifests, even when the user proposes a version. Fetch `origin/main` and tags, identify the nearest eligible published release that is an ancestor of the candidate, then inspect the complete first-parent log and diff:

```bash
git fetch origin main:refs/remotes/origin/main --tags
base_tag="<nearest-eligible-published-release-tag>"
candidate_sha="$(git rev-parse HEAD)"
git merge-base --is-ancestor "$base_tag" "$candidate_sha"
git log --first-parent --reverse --format='- %s (%h)' "$base_tag..$candidate_sha"
git diff --stat "$base_tag..$candidate_sha"
git diff "$base_tag..$candidate_sha"
```

For stable releases, consider published, non-draft, non-prerelease releases. For prereleases, include published prereleases. Do not use the version stored in `package.json` as the release baseline because it may contain an unpublished bump.

Review public CLI behavior, environment variables, MCP tools and schemas, REST behavior, package exports and types, stored data, authentication, defaults, and runtime requirements. A change is breaking when an existing consumer must change code or configuration, or when existing input produces an incompatible result.

Choose the minimum stable version from the highest-impact change:

| Current release         | Highest-impact change                         | Required bump    |
| ----------------------- | --------------------------------------------- | ---------------- |
| `1.0.0` or later        | Breaking public contract                      | Major            |
| `0.y.z`, where `y >= 1` | Breaking public contract                      | Minor            |
| `0.0.z`                 | Breaking contract or new public functionality | Minor to `0.1.0` |
| Any version             | Backward-compatible functionality             | Minor            |
| Any version             | Backward-compatible fixes only                | Patch            |

Internal changes, tests, documentation, and release tooling do not increase the bump unless they change a public contract or correct instructions that users must follow. Stop when there is no release-worthy change. Before preparing the release, report the baseline, audited range, breaking changes, classification, and selected version.

## Inspect destination state

Check the proposed version before editing manifests and again before a live write:

```bash
pnpm release status --version <version>
```

The command discovers publishable packages from the workspace and checks npm, GHCR, the MCP Registry, the Git tag, and the GitHub Release in parallel. Treat network, authentication, DNS, and service failures as errors, not as missing artifacts.

Keep these partial-state rules:

- If npm is partly or fully published and Docker is missing, resume the release. The CLI skips existing npm versions.
- If npm and Docker exist but the Registry entry is missing, resume at the Registry.
- If Docker exists while any npm package is missing, stop and report the inconsistent release.
- If the Registry version exists, do not publish it again. Registry versions are immutable.
- If a published GitHub Release exists while npm, Docker, or Registry is missing, stop and report the inconsistent release.
- If a draft GitHub Release exists, require that it has no uploaded assets. Resume by updating and publishing that draft after the other destinations succeed.
- If a tag exists, require it to point to the approved release commit.

## Prepare the release pull request

Start from a clean tree that contains the latest `origin/main`, then run:

```bash
pnpm release prepare <version>
```

Pass `--previous-tag <tag>` only when the compatibility audit shows that the nearest ancestor tag chosen by the script is wrong. The command updates the root and publishable package versions, `pnpm-lock.yaml`, both versions in `server.json`, and `CHANGELOG.md`. It does not commit, tag, or publish anything.

Curate the generated changelog entry for end users. Follow [Common Changelog](https://common-changelog.org/):

- Use applicable groups in this order: `Changed`, `Added`, `Removed`, and `Fixed`.
- Use H3 group headings in `CHANGELOG.md`. The release CLI promotes them to H2 in the GitHub Release body.
- Write one imperative, single-line bullet per change and end it with the best pull request, issue, or commit link.
- Prefix breaking entries with `**Breaking:**` and include a short migration step or link.
- Sort breaking changes first, then by importance, then newest first.
- Merge related changes and omit empty groups, authors for a single-contributor project, and internal work.
- Use `_No user-facing changes._` only when the audited range has no user-facing changes.
- Do not use `Deprecated` or `Security` groups. Put those changes under the group that describes their effect.

Audit the entry against the full commit range. Do not invent changes. If the notes reveal a higher-impact change, stop, choose the required version, and prepare again.

Run the checks:

```bash
pnpm release validate --version <version>
pnpm format:check
pnpm lint
pnpm build
pnpm typecheck
pnpm test
pnpm publish:all --dry-run --tag <latest-or-next>
```

Build before typechecking because workspace declarations must exist. Fix failures before opening the release pull request.

Show the user the complete changelog entry, version, npm tag, intended Git tag, and release pull request diff. Ask for explicit approval before merging. Reviewing this committed entry also reviews the GitHub Release notes, so do not create a separate mutable notes file or approval digest.

## Publish with GitHub Actions

Use `.github/workflows/publish-release.yml` for normal live releases. The validation job runs once and uploads the package builds. The protected publish job uses npm trusted publishing, `GITHUB_TOKEN` for GHCR, and GitHub OIDC for the MCP Registry.

After the approved release pull request merges:

1. Fetch `main` and record the full merge commit SHA.
2. Confirm that the SHA is reachable from `origin/main` and contains the approved changelog.
3. Dispatch the workflow with the exact version, SHA, and npm tag:

```bash
gh workflow run publish-release.yml \
  --repo churichard/fluxmail-mcp \
  -f version=<version> \
  -f release_sha=<full-main-commit-sha> \
  -f npm_tag=<latest-or-next>
```

4. Surface the workflow URL. If the `release` environment requires approval, pause for the user to approve it.
5. Watch the run and report failures. Rerun only failed jobs when possible so the completed validation job and its artifact are reused.

The publish job writes destinations in this order: npm, GHCR, MCP Registry, Git tag, GitHub Release. It verifies every destination before succeeding.

## Resume or verify

The workflow and local release command are idempotent around existing immutable versions. For a failed workflow, prefer rerunning the failed publish job. For a new workflow run, use the same version, SHA, and npm tag.

Inspect or verify manually with:

```bash
pnpm release status --version <version>
pnpm release verify \
  --version <version> \
  --sha <full-release-commit-sha> \
  --npm-tag <latest-or-next>
```

Report the exact destinations that are published, skipped, missing, inconsistent, or unverified. Do not claim success until `release verify` succeeds.

## Local fallback

Use local publishing only when GitHub Actions is unavailable and the user explicitly approves the fallback. Confirm npm and GitHub authentication, require `write:packages` on the GitHub CLI token, and use a clean checkout of the approved commit:

```bash
npm whoami
gh auth refresh --hostname github.com --scopes write:packages
```

Then run:

```bash
pnpm release publish \
  --version <version> \
  --sha <full-release-commit-sha> \
  --npm-tag <latest-or-next> \
  --resume
```

The CLI logs Docker into GHCR with the checked GitHub CLI token. It authenticates the MCP publisher immediately before Registry publication so its short-lived credential does not expire during npm or Docker work. Do not authenticate the MCP publisher during initial preflight. Do not bypass the clean-tree, main ancestry, changelog, destination-state, or verification checks.
