---
name: publish-packages
description: Publish Fluxmail releases across npm, GitHub Container Registry, GitHub Releases, and the official MCP Registry. Use when preparing, validating, dry-running, publishing, retrying, or verifying a Fluxmail release; generating and approving release notes; bumping synchronized workspace versions; managing npm, Docker, or Git tags; or updating server.json registry metadata.
---

# Publish Fluxmail packages

Run release commands from the repository root. Treat `scripts/publish.mjs`, `scripts/check-package-licenses.mjs`, and `scripts/check-registry-metadata.mjs` as the source of truth.

## Choose the scope

Determine whether the user wants preparation, a dry run, or a live release.

- For preparation, make the version and metadata changes, validate them, and stop before publishing.
- For a dry run, run the checks and package builds without pushing artifacts. Do not generate or request approval for a changelog.
- For a full live release, require explicit publishing intent, generate and approve the changelog, then publish npm, GHCR, the MCP Registry, and GitHub Releases.

`pnpm publish:all` always handles npm and Docker together. The Registry uses separate commands. Do not run `publish:all` when the user asks for only npm or only Docker. Explain that the repository has no single-destination mode and stop before publishing unless the user explicitly authorizes a manual destination-specific procedure.

## Audit changes and choose a version

Complete a compatibility audit before editing any manifest. Do this even when the user supplies a version. Treat that version as a proposal until the audit confirms it.

Decide whether the intended release is stable or a prerelease before selecting the baseline. For a stable release, consider only published, non-draft full releases. For a prerelease, consider all published, non-draft releases. From the eligible releases, use the nearest tag that is an ancestor of the release candidate. Do not use the version currently stored in `package.json` as the baseline because the repository may contain an unpublished version bump. Use the same filtering and ancestry checks described in `Generate and approve the changelog for a live release`.

Inspect the complete first-parent range and the relevant diffs, not only commit or pull request titles:

```bash
git fetch origin main --tags
base_tag="<nearest-eligible-published-release-tag-that-is-an-ancestor-of-origin/main>"
git log --first-parent --reverse --format='- %s (%h)' "$base_tag..origin/main"
git diff --stat "$base_tag..origin/main"
git diff "$base_tag..origin/main"
```

Review every public contract that changed, including CLI arguments and output, environment variables, MCP tool names and schemas, HTTP behavior, package exports and types, stored data, authentication, defaults, and runtime requirements. A change is breaking when an existing consumer must change code or configuration, or when existing input produces an incompatible result.

Choose the next stable version from the highest-impact change in the range:

| Current published version        | Highest-impact change                                | Required bump         |
| -------------------------------- | ---------------------------------------------------- | --------------------- |
| `1.0.0` or later                 | Breaking public contract                             | Major                 |
| `0.y.z`, where `y` is at least 1 | Breaking public contract                             | Minor, to `0.(y+1).0` |
| `0.0.z`                          | Breaking public contract or new public functionality | Minor, to `0.1.0`     |
| Any version                      | Backward-compatible public functionality             | Minor                 |
| Any version                      | Backward-compatible fixes only                       | Patch                 |

Internal work, tests, documentation, and release tooling do not increase the required bump unless they change the public contract or correct instructions that users must follow. If a release contains several kinds of changes, use the largest required bump. A prerelease suffix does not reduce the required core version bump.

Before changing manifests, report the baseline tag, audited commit range, breaking changes, highest-impact classification, and selected version. If a requested version is lower than the audit requires, stop and propose the minimum compliant version. If the audit finds no release-worthy change, stop instead of creating a version only to advance the number.

## Prepare the release

1. Inspect `git status`, the current branch, and the latest `origin/main`.
2. Preserve unrelated work. Start version changes only from a clean tree.
3. Complete the compatibility audit and confirm that the intended version satisfies its required SemVer bump.
4. Inspect the intended version at every release destination before changing manifests.
5. Confirm the npm tag and Git tag. Use `latest` for stable releases and `next` for prereleases unless the user specifies another npm tag. Use `v<version>` for the Git tag and the GitHub Release title.
6. Keep these versions identical:
   - The private root `package.json`
   - Every `packages/*/package.json`
   - The top-level `version` in `server.json`
   - The npm package version inside `server.json`
7. Keep `packages/server/package.json#mcpName` identical to `server.json#name`.

Use the repository command to bump package manifests:

```bash
pnpm version:bump <version>
```

Pass the audited version explicitly. Do not default to `patch` before reviewing the changes. The command does not create a commit or tag, and it does not update `server.json`. Update both version fields in `server.json` before continuing.

The MCP Registry does not allow changing a published version or its metadata. Use a new package version for a new stable listing. If the user does not want a new release, update the source metadata only and state that the live listing will change with the next release.

For a live release, require the release commit to be reachable from `origin/main`. Record its full commit SHA and use that exact SHA for changelog generation and the GitHub Release. Do not target a moving branch name when creating the release.

## Inspect existing release state

Before changing manifests or running a live command, check whether the intended version already exists at each requested destination:

```bash
npm view fluxmail@<version> version mcpName --json
npm view @fluxmail/core@<version> version --json
npm view @fluxmail/provider-gmail@<version> version --json
npm view @fluxmail/provider-imap@<version> version --json
docker manifest inspect ghcr.io/churichard/fluxmail-mcp:<version>
curl -fsS 'https://registry.modelcontextprotocol.io/v0.1/servers/io.github.churichard%2Ffluxmail/versions/<version>' | jq -e --arg version '<version>' '.server.name == "io.github.churichard/fluxmail" and .server.version == $version'
gh release view v<version> --repo churichard/fluxmail-mcp --json tagName,name,body,targetCommitish,isDraft,isPrerelease,assets,url
git ls-remote --tags origin 'refs/tags/v<version>' 'refs/tags/v<version>^{}'
```

Treat a confirmed missing npm version, Docker manifest, Registry version, Git tag, or GitHub Release as unpublished. Do not interpret authentication, network, DNS, or service failures as missing artifacts. Record the GitHub Release state as `missing`, `draft`, or `published`, then route partial releases by destination state:

- If npm is partly or fully published and the versioned Docker tag is missing, rerun `pnpm publish:all` with the exact `--tag` and any `--docker-image` from the original attempt. It skips npm packages that already exist.
- If all npm packages and the versioned Docker tag exist but the Registry entry is missing, skip `publish:all` and publish only the Registry metadata.
- If the versioned Docker tag exists while any npm package is missing, stop and report the inconsistent release. Do not improvise a repair without explicit approval.
- If the Registry version exists, do not publish it again. Complete any missing npm or Docker destination using the rules above, then verify the Registry entry. Use a new version when its metadata must change.
- If the GitHub Release is published, do not create it again. Verify its tag, target commit, title, and notes.
- If the GitHub Release is a draft, do not create another release for the same tag. Verify its tag and target commit, and require its uploaded asset list to be empty. This workflow does not publish release assets. Generate and approve the changelog before updating and publishing the draft.
- If the Git tag exists without a GitHub Release, verify that it points to the intended release commit. Generate and approve the changelog before creating a release for that existing tag.
- If a published GitHub Release exists while another requested destination is missing, stop and report the inconsistent release. Do not present the release as complete or improvise a repair without explicit approval. A draft is not a completed destination; after changelog approval, publish the other missing destinations before publishing the draft.

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

Review and commit the release changes. `pnpm publish:all` requires a clean working tree. For a live release, push or merge the changes to `origin/main`, then record the full SHA of the commit on `origin/main` as `release_sha`. Do not assume the current `HEAD` is that commit. A squash merge creates a new SHA; obtain it from the merged pull request:

```bash
git fetch origin main --tags
release_sha="$(gh pr view <number> --repo churichard/fluxmail-mcp --json mergeCommit --jq '.mergeCommit.oid')"
git merge-base --is-ancestor "$release_sha" origin/main
test "$(git rev-parse HEAD^{tree})" = "$(git rev-parse "${release_sha}^{tree}")"
```

For a direct push or a merge that preserves the release commit, use `git rev-parse HEAD` after confirming that `HEAD` is reachable from `origin/main`. Stop if the ancestry check fails. If the tree check fails, continue from a clean checkout of `release_sha`; do not publish artifacts from a different tree.

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

Confirm GitHub CLI authentication before generating or publishing release notes:

```bash
gh auth status
```

## Generate and approve the changelog for a live release

Skip this section for preparation and dry runs. For a live release, generate the release title and notes without creating a tag, draft release, or published release. GitHub's release-notes endpoint does not change GitHub state. The block writes ignored local files under `.context/releases`.

```bash
(
set -e
version="$(jq -er '.version' package.json)"
npm_tag="<npm-tag>"
tag="v${version}"
release_sha="<full-release-commit-sha>"
github_release_state="<missing-or-draft>"
prerelease_state="<true-or-false>"
release_state_dir=".context/releases/${tag}"
release_json="${release_state_dir}/generated.json"
notes_file="${release_state_dir}/notes.md"
state_file="${release_state_dir}/state.json"
mkdir -p "$release_state_dir"
previous_tag=""
previous_distance=""
historical_backfill=false
if [[ -z "$npm_tag" ]]; then
  printf 'The npm tag must not be empty.\n' >&2
  false
fi
if [[ "$prerelease_state" != "true" && "$prerelease_state" != "false" ]]; then
  printf 'The prerelease state must be true or false.\n' >&2
  false
fi
for manifest in \
  package.json \
  packages/core/package.json \
  packages/provider-gmail/package.json \
  packages/provider-imap/package.json \
  packages/server/package.json; do
  manifest_version="$(jq -er '.version' "$manifest")"
  if [[ "$manifest_version" != "$version" ]]; then
    printf '%s has version %s, expected %s.\n' "$manifest" "$manifest_version" "$version" >&2
    false
  fi
done
server_version="$(jq -er '.version' server.json)"
registry_version="$(
  jq -er '.packages[] | select(.registryType == "npm" and .identifier == "fluxmail") | .version' server.json
)"
if [[ "$server_version" != "$version" || "$registry_version" != "$version" ]]; then
  printf 'server.json does not match package version %s.\n' "$version" >&2
  false
fi
git fetch origin --tags
release_filter='.[] | select(.draft == false)'
if [[ "$prerelease_state" == "false" ]]; then
  release_filter='.[] | select(.draft == false and .prerelease == false)'
fi
published_tags="$(
  gh api --paginate 'repos/churichard/fluxmail-mcp/releases?per_page=100' \
    --jq "$release_filter | .tag_name"
)"
while IFS= read -r candidate; do
  [[ -z "$candidate" ]] && continue
  if ! candidate_commit="$(git rev-parse -q --verify "refs/tags/${candidate}^{commit}")"; then
    printf 'Published GitHub Release tag %s is unavailable after fetching tags.\n' "$candidate" >&2
    false
  fi
  if [[ "$candidate_commit" != "$release_sha" ]] && git merge-base --is-ancestor "$release_sha" "$candidate_commit"; then
    historical_backfill=true
  fi
  git merge-base --is-ancestor "$candidate_commit" "$release_sha" || continue
  distance="$(git rev-list --count "$candidate_commit..$release_sha")"
  if [[ -z "$previous_distance" || "$distance" -lt "$previous_distance" ]]; then
    previous_tag="$candidate"
    previous_distance="$distance"
  fi
done <<< "$published_tags"
computed_previous_tag="$previous_tag"
computed_historical_backfill="$historical_backfill"
# Apply any user-confirmed previous_tag or historical_backfill override below this line.

generate_args=(
  --method POST
  "repos/churichard/fluxmail-mcp/releases/generate-notes"
  -f "tag_name=$tag"
  -f "target_commitish=$release_sha"
)
if [[ -n "$previous_tag" ]]; then
  generate_args+=(-f "previous_tag_name=$previous_tag")
fi

gh api "${generate_args[@]}" > "$release_json"
jq -r '.body' "$release_json" > "$notes_file"
title="$tag"
jq -n \
  --arg version "$version" \
  --arg npm_tag "$npm_tag" \
  --arg tag "$tag" \
  --arg release_sha "$release_sha" \
  --arg github_release_state "$github_release_state" \
  --argjson prerelease "$prerelease_state" \
  --arg previous_tag "$previous_tag" \
  --argjson historical_backfill "$historical_backfill" \
  --arg computed_previous_tag "$computed_previous_tag" \
  --argjson computed_historical_backfill "$computed_historical_backfill" \
  --arg title "$title" \
  --arg release_json "$release_json" \
  --arg notes_file "$notes_file" \
  '{
    version: $version,
    npm_tag: $npm_tag,
    tag: $tag,
    release_sha: $release_sha,
    github_release_state: $github_release_state,
    prerelease: $prerelease,
    previous_tag: $previous_tag,
    historical_backfill: $historical_backfill,
    computed_previous_tag: $computed_previous_tag,
    computed_historical_backfill: $computed_historical_backfill,
    title: $title,
    release_json: $release_json,
    notes_file: $notes_file
  }' > "$state_file"
jq -r '"Computed previous tag: \(.computed_previous_tag)\nComputed historical backfill: \(.computed_historical_backfill)\nPrevious tag: \(.previous_tag)\nHistorical backfill: \(.historical_backfill)"' "$state_file"
printf '%s\n' "$title"
sed -n '1,$p' "$notes_file"
)
```

For the first GitHub Release, leave `previous_tag` empty so GitHub generates notes from the repository history. Otherwise, use the nearest published release tag that is an ancestor of `release_sha`. This also produces the correct range when creating a missing GitHub Release for an older existing tag. `historical_backfill` becomes `true` when an existing published release descends from `release_sha`. The block records the computed values before the override comment. If unusual branching makes either value questionable, discard the generated local files and show both computed values to the user. If the user changes either value, rerun the block with the confirmed assignments immediately after the override comment, then audit the new notes before requesting approval. Later checks compare the current computation with the recorded computation while preserving the approved override.

Curate the generated notes for end users. Follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and use only the sections that apply: `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, and `Security`. Render each section as an H2 heading, such as `## Added`, never H1 or H3. Omit empty sections and keep the full changelog link that GitHub generates.

Do not add a version or release-date heading to the GitHub Release body, such as `## 0.3.0 - 2026-07-14`. GitHub already displays the `v<version>` release title and publication date. Start the body with the breaking-change or migration notice when one exists; otherwise, start with the first applicable changelog section.

Keep the GitHub Release title identical to the Git tag in `v<version>` format. Do not replace it with a product name or another title.

Include a change only when it affects how people install, configure, use, secure, or upgrade Fluxmail, or when it changes observable behavior, compatibility, performance, or reliability. Describe the effect in terms users can understand. Combine related commits when one entry explains the user impact better than separate implementation details. Call out breaking changes and required migration steps before the categorized entries.

Exclude changes that have no end-user impact, including refactors, code cleanup, tests, CI, build or release tooling, publishing mechanics, agent skills or prompts, repository administration, and dependency or toolchain updates with no observable effect. Include documentation changes only when they alter a required user action or correct instructions that would otherwise cause a user problem. Do not include a commit only to make the notes look complete. If the release has no user-facing changes, write `No user-facing changes.` instead of listing internal work.

Audit the generated notes against the complete first-parent commit range:

```bash
state_file=".context/releases/v<version>/state.json"
previous_tag="$(jq -r '.previous_tag' "$state_file")"
release_sha="$(jq -r '.release_sha' "$state_file")"
if [[ -n "$previous_tag" ]]; then
  git log --first-parent --reverse --format='- %s (%h)' "$previous_tag..$release_sha"
else
  git log --first-parent --reverse --format='- %s (%h)' "$release_sha"
fi
```

Use the complete range to find every change that may affect users. Verify that each release-note entry maps to a commit in the range and that no user-facing change is missing. A commit does not need a release-note entry when it has no end-user impact. Remove internal, duplicate, speculative, or misleading entries. Never invent a change.

Compare the finished changelog with the pre-bump compatibility audit. If the changelog audit uncovers a higher-impact change, the selected version is invalid. Stop before requesting approval, choose the minimum compliant version, update and validate every manifest again, merge the corrected release tree into `origin/main`, and regenerate the changelog.

After auditing and editing the notes, save the final title and notes digest in the release state:

```bash
(
set -e
state_file=".context/releases/v<version>/state.json"
notes_file="$(jq -r '.notes_file' "$state_file")"
version="$(jq -er '.version' "$state_file")"
title="$(jq -er '.tag' "$state_file")"
first_content_line="$(awk 'NF { print; exit }' "$notes_file")"
heading_text="$(printf '%s\n' "$first_content_line" | sed -E 's/^#{1,6}[[:space:]]+//')"
if [[ "$heading_text" == "$version" ||
      "$heading_text" == "v${version}" ||
      "$heading_text" == "${version} - "* ||
      "$heading_text" == "v${version} - "* ]]; then
  printf 'Remove the redundant version or release-date heading from the release notes.\n' >&2
  false
fi
invalid_section_heading="$(
  awk '
    /^#+[[:space:]]+(Added|Changed|Deprecated|Removed|Fixed|Security)[[:space:]]*$/ &&
    $0 !~ /^##[[:space:]]/ { print; exit }
  ' "$notes_file"
)"
if [[ -n "$invalid_section_heading" ]]; then
  printf 'Use H2 headings for changelog sections, for example ## Added. Found: %s\n' "$invalid_section_heading" >&2
  false
fi
notes_sha256="$(shasum -a 256 "$notes_file" | awk '{print $1}')"
state_tmp="${state_file}.tmp"
jq \
  --arg title "$title" \
  --arg notes_sha256 "$notes_sha256" \
  '.title = $title | .notes_sha256 = $notes_sha256' \
  "$state_file" > "$state_tmp"
mv "$state_tmp" "$state_file"
approval_payload="$(
  jq -ceS \
    '{version, npm_tag, tag, release_sha, github_release_state, prerelease, previous_tag, historical_backfill, computed_previous_tag, computed_historical_backfill, title, notes_sha256}' \
    "$state_file"
)"
approval_sha256="$(printf '%s\n' "$approval_payload" | shasum -a 256 | awk '{print $1}')"
state_tmp="${state_file}.tmp"
jq --arg approval_sha256 "$approval_sha256" '.approval_sha256 = $approval_sha256' \
  "$state_file" > "$state_tmp"
mv "$state_tmp" "$state_file"
jq -r '"Version: \(.version)\nnpm tag: \(.npm_tag)\nGit tag: \(.tag)\nTarget: \(.release_sha)\nGitHub Release state: \(.github_release_state)\nPrerelease: \(.prerelease)\nComputed previous tag: \(.computed_previous_tag)\nComputed historical backfill: \(.computed_historical_backfill)\nPrevious tag: \(.previous_tag)\nHistorical backfill: \(.historical_backfill)\nTitle: \(.title)\nNotes SHA-256: \(.notes_sha256)\nApproval SHA-256: \(.approval_sha256)"' "$state_file"
sed -n '1,$p' "$notes_file"
)
```

Show the user this exact version, npm tag, Git tag, target commit, GitHub Release state, prerelease state, computed and approved release range, title, both digests, and complete release notes. Ask the user to approve them or request edits, then stop. Do not create a Git tag, draft release, or published release until the user explicitly approves the displayed version. Earlier authorization to run a full release does not count as changelog approval.

After the user approves the changelog, run this check before publishing npm, Docker, Registry metadata, a Git tag, or a GitHub Release. Set `approved_release_sha256` to the exact approval digest shown to the user. Do not trust a digest read only from the mutable state file.

```bash
(
set -e
state_file=".context/releases/v<version>/state.json"
approved_release_sha256="<exact-approved-release-sha256>"
notes_file="$(jq -er '.notes_file' "$state_file")"
version="$(jq -er '.version' "$state_file")"
npm_tag="$(jq -er '.npm_tag' "$state_file")"
tag="$(jq -er '.tag' "$state_file")"
release_sha="$(jq -er '.release_sha' "$state_file")"
title="$(jq -er '.title' "$state_file")"
approved_notes_sha256="$(jq -er '.notes_sha256' "$state_file")"
saved_release_sha256="$(jq -er '.approval_sha256' "$state_file")"
current_notes_sha256="$(shasum -a 256 "$notes_file" | awk '{print $1}')"
approved_tree="$(git rev-parse "${release_sha}^{tree}")"
current_tree="$(git rev-parse 'HEAD^{tree}')"
working_tree_status="$(git status --porcelain)"
if [[ -z "$npm_tag" || "$tag" != "v${version}" || "$title" != "$tag" ]]; then
  printf 'The approved version, npm tag, Git tag, or release title is invalid.\n' >&2
  false
fi
for manifest in \
  package.json \
  packages/core/package.json \
  packages/provider-gmail/package.json \
  packages/provider-imap/package.json \
  packages/server/package.json; do
  manifest_version="$(jq -er '.version' "$manifest")"
  if [[ "$manifest_version" != "$version" ]]; then
    printf '%s has version %s, expected approved version %s.\n' "$manifest" "$manifest_version" "$version" >&2
    false
  fi
done
server_version="$(jq -er '.version' server.json)"
registry_version="$(
  jq -er '.packages[] | select(.registryType == "npm" and .identifier == "fluxmail") | .version' server.json
)"
if [[ "$server_version" != "$version" || "$registry_version" != "$version" ]]; then
  printf 'server.json does not match approved version %s.\n' "$version" >&2
  false
fi
approval_payload="$(
  jq -ceS \
    '{version, npm_tag, tag, release_sha, github_release_state, prerelease, previous_tag, historical_backfill, computed_previous_tag, computed_historical_backfill, title, notes_sha256}' \
    "$state_file"
)"
current_release_sha256="$(printf '%s\n' "$approval_payload" | shasum -a 256 | awk '{print $1}')"
if [[ "$current_notes_sha256" != "$approved_notes_sha256" ||
      "$current_release_sha256" != "$approved_release_sha256" ||
      "$saved_release_sha256" != "$approved_release_sha256" ]]; then
  printf 'The approved release state changed. Generate it again and request fresh approval.\n' >&2
  false
fi
if [[ -n "$working_tree_status" || "$current_tree" != "$approved_tree" ]]; then
  printf 'The checkout no longer matches the approved release commit. Restore a clean checkout of the approved tree before publishing.\n' >&2
  false
fi
)
```

If the version, npm tag, Git tag, target commit, release state, prerelease state, computed or approved release range, title, notes, or either digest changes after approval, invalidate the approval. Regenerate or update the notes, save the new state, show the complete result again, and wait for fresh approval. Run this approval and checkout gate immediately before `pnpm publish:all` and again before `mcp-publisher publish`. Repeat every destination check in `Inspect existing release state` before the first live write and after each completed destination. Continue only when the changes match the steps that have already succeeded.

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

For a live release, read the npm tag from the approved state and pass it to the repository command:

```bash
state_file=".context/releases/v<version>/state.json"
npm_tag="$(jq -er '.npm_tag' "$state_file")"
pnpm publish:all --tag "$npm_tag"
```

The approved npm tag is normally `latest` for a stable release and `next` for a prerelease. Passing it explicitly keeps npm and Docker on the approved tag.

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

## Publish the GitHub Release

After npm, Docker, and Registry publishing succeeds, run this complete block in one shell invocation. Set `approved_release_sha256` to the exact approval digest that the user approved. The function verifies the saved state and notes, creates or checks the remote tag, and then creates or publishes the GitHub Release. Historical backfills cannot replace the repository's Latest release:

```bash
state_file=".context/releases/v<version>/state.json"
approved_release_sha256="<exact-approved-release-sha256>"
publish_github_release() {
  local version npm_tag tag release_sha title notes_file historical_backfill github_release_state prerelease_state
  local approved_notes_sha256 current_notes_sha256 current_release_sha256 saved_release_sha256 approval_payload
  local approved_tree current_tree working_tree_status
  local manifest manifest_version server_version registry_version
  local saved_computed_previous_tag saved_computed_historical_backfill
  local current_previous_tag current_previous_distance current_historical_backfill
  local published_tags release_filter candidate candidate_commit distance
  local remote_tag_sha tag_refs draft_json draft_state draft_asset_count
  local -a latest_args prerelease_args
  version="$(jq -er '.version' "$state_file")" || return 1
  npm_tag="$(jq -er '.npm_tag' "$state_file")" || return 1
  tag="$(jq -er '.tag' "$state_file")" || return 1
  release_sha="$(jq -er '.release_sha' "$state_file")" || return 1
  title="$(jq -er '.title' "$state_file")" || return 1
  notes_file="$(jq -er '.notes_file' "$state_file")" || return 1
  historical_backfill="$(jq -r '.historical_backfill' "$state_file")" || return 1
  github_release_state="$(jq -er '.github_release_state' "$state_file")" || return 1
  prerelease_state="$(jq -r '.prerelease' "$state_file")" || return 1
  approved_notes_sha256="$(jq -er '.notes_sha256' "$state_file")" || return 1
  saved_release_sha256="$(jq -er '.approval_sha256' "$state_file")" || return 1
  if [[ "$historical_backfill" != "true" && "$historical_backfill" != "false" ]] ||
     [[ "$prerelease_state" != "true" && "$prerelease_state" != "false" ]]; then
    printf 'The saved prerelease or historical-backfill state is invalid.\n' >&2
    return 1
  fi
  if [[ "$github_release_state" != "missing" && "$github_release_state" != "draft" ]]; then
    printf 'Unexpected saved GitHub Release state: %s.\n' "$github_release_state" >&2
    return 1
  fi
  if [[ -z "$npm_tag" || "$tag" != "v${version}" || "$title" != "$tag" ]]; then
    printf 'The approved version, npm tag, Git tag, or release title is invalid.\n' >&2
    return 1
  fi
  for manifest in \
    package.json \
    packages/core/package.json \
    packages/provider-gmail/package.json \
    packages/provider-imap/package.json \
    packages/server/package.json; do
    manifest_version="$(jq -er '.version' "$manifest")" || return 1
    if [[ "$manifest_version" != "$version" ]]; then
      printf '%s has version %s, expected approved version %s.\n' "$manifest" "$manifest_version" "$version" >&2
      return 1
    fi
  done
  server_version="$(jq -er '.version' server.json)" || return 1
  registry_version="$(
    jq -er '.packages[] | select(.registryType == "npm" and .identifier == "fluxmail") | .version' server.json
  )" || return 1
  if [[ "$server_version" != "$version" || "$registry_version" != "$version" ]]; then
    printf 'server.json does not match approved version %s.\n' "$version" >&2
    return 1
  fi
  current_notes_sha256="$(shasum -a 256 "$notes_file" | awk '{print $1}')" || return 1
  approval_payload="$(
    jq -ceS \
      '{version, npm_tag, tag, release_sha, github_release_state, prerelease, previous_tag, historical_backfill, computed_previous_tag, computed_historical_backfill, title, notes_sha256}' \
      "$state_file"
  )" || return 1
  current_release_sha256="$(printf '%s\n' "$approval_payload" | shasum -a 256 | awk '{print $1}')" || return 1
  if [[ "$current_notes_sha256" != "$approved_notes_sha256" ||
        "$current_release_sha256" != "$approved_release_sha256" ||
        "$saved_release_sha256" != "$approved_release_sha256" ]]; then
    printf 'The approved release state changed. Generate it again and request fresh approval.\n' >&2
    return 1
  fi
  approved_tree="$(git rev-parse "${release_sha}^{tree}")" || return 1
  current_tree="$(git rev-parse 'HEAD^{tree}')" || return 1
  working_tree_status="$(git status --porcelain)" || return 1
  if [[ -n "$working_tree_status" || "$current_tree" != "$approved_tree" ]]; then
    printf 'The checkout no longer matches the approved release commit. Restore a clean checkout of the approved tree before publishing.\n' >&2
    return 1
  fi

  saved_computed_previous_tag="$(jq -r '.computed_previous_tag' "$state_file")" || return 1
  saved_computed_historical_backfill="$(jq -r '.computed_historical_backfill' "$state_file")" || return 1
  if [[ "$saved_computed_historical_backfill" != "true" &&
        "$saved_computed_historical_backfill" != "false" ]]; then
    printf 'The saved computed historical-backfill state is invalid.\n' >&2
    return 1
  fi
  current_previous_tag=""
  current_previous_distance=""
  current_historical_backfill=false
  git fetch origin --tags || return 1
  release_filter='.[] | select(.draft == false)'
  if [[ "$prerelease_state" == "false" ]]; then
    release_filter='.[] | select(.draft == false and .prerelease == false)'
  fi
  published_tags="$(
    gh api --paginate 'repos/churichard/fluxmail-mcp/releases?per_page=100' \
      --jq "$release_filter | .tag_name"
  )" || return 1
  while IFS= read -r candidate; do
    [[ -z "$candidate" ]] && continue
    if ! candidate_commit="$(git rev-parse -q --verify "refs/tags/${candidate}^{commit}")"; then
      printf 'Published GitHub Release tag %s is unavailable after fetching tags.\n' "$candidate" >&2
      return 1
    fi
    if [[ "$candidate_commit" != "$release_sha" ]] && git merge-base --is-ancestor "$release_sha" "$candidate_commit"; then
      current_historical_backfill=true
    fi
    git merge-base --is-ancestor "$candidate_commit" "$release_sha" || continue
    distance="$(git rev-list --count "$candidate_commit..$release_sha")" || return 1
    if [[ -z "$current_previous_distance" || "$distance" -lt "$current_previous_distance" ]]; then
      current_previous_tag="$candidate"
      current_previous_distance="$distance"
    fi
  done <<< "$published_tags"
  if [[ "$current_previous_tag" != "$saved_computed_previous_tag" ||
        "$current_historical_backfill" != "$saved_computed_historical_backfill" ]]; then
    printf 'Published GitHub Releases changed after approval. Generate the notes again and request fresh approval.\n' >&2
    return 1
  fi

  latest_args=()
  prerelease_args=()
  if [[ "$historical_backfill" == "true" ]]; then
    latest_args+=(--latest=false)
  fi
  if [[ "$prerelease_state" == "true" ]]; then
    prerelease_args+=(--prerelease)
  fi

  tag_refs="$(git ls-remote --tags origin "refs/tags/${tag}" "refs/tags/${tag}^{}")" || return 1
  remote_tag_sha="$(
    printf '%s\n' "$tag_refs" |
      awk -v base="refs/tags/${tag}" -v peeled="refs/tags/${tag}^{}" '
        $2 == base { base_sha = $1 }
        $2 == peeled { peeled_sha = $1 }
        END { print (peeled_sha != "" ? peeled_sha : base_sha) }
      '
  )" || return 1
  if [[ -z "$remote_tag_sha" ]]; then
    git push origin "${release_sha}:refs/tags/${tag}" || return 1
    tag_refs="$(git ls-remote --tags origin "refs/tags/${tag}" "refs/tags/${tag}^{}")" || return 1
    remote_tag_sha="$(
      printf '%s\n' "$tag_refs" |
        awk -v base="refs/tags/${tag}" -v peeled="refs/tags/${tag}^{}" '
          $2 == base { base_sha = $1 }
          $2 == peeled { peeled_sha = $1 }
          END { print (peeled_sha != "" ? peeled_sha : base_sha) }
        '
    )" || return 1
  fi
  if [[ "$remote_tag_sha" != "$release_sha" ]]; then
    printf 'Tag %s points to %s, expected %s.\n' "$tag" "${remote_tag_sha:-<missing>}" "$release_sha" >&2
    return 1
  fi

  case "$github_release_state" in
    missing)
      gh release create "$tag" \
        --repo churichard/fluxmail-mcp \
        --verify-tag \
        --title "$title" \
        --notes-file "$notes_file" \
        "${prerelease_args[@]}" \
        "${latest_args[@]}"
      ;;
    draft)
      draft_json="$(
        gh release view "$tag" --repo churichard/fluxmail-mcp --json isDraft,assets
      )" || return 1
      draft_state="$(jq -r '.isDraft' <<< "$draft_json")" || return 1
      draft_asset_count="$(jq -er '.assets | length' <<< "$draft_json")" || return 1
      if [[ "$draft_state" != "true" ]]; then
        printf 'Release %s is no longer a draft. Inspect it before continuing.\n' "$tag" >&2
        return 1
      fi
      if [[ "$draft_asset_count" != "0" ]]; then
        printf 'Draft release %s contains %s uploaded asset(s). Inspect and remove them before continuing.\n' "$tag" "$draft_asset_count" >&2
        return 1
      fi
      gh release edit "$tag" \
        --repo churichard/fluxmail-mcp \
        --verify-tag \
        --target "$release_sha" \
        --title "$title" \
        --notes-file "$notes_file" \
        --prerelease="$prerelease_state" \
        --draft=false \
        "${latest_args[@]}"
      ;;
  esac
}

publish_github_release
```

Do not use `--generate-notes` because it could produce text that differs from the approved changelog. Do not add `--fail-on-no-commits`; it rejects valid historical release backfills, and the existing-release check already prevents duplicate releases.

## Verify the release

Verify every destination used by the release:

```bash
(
set -e
npm view fluxmail@<version> version mcpName --json
npm view fluxmail dist-tags --json
npm view @fluxmail/core@<version> version --json
npm view @fluxmail/provider-gmail@<version> version --json
npm view @fluxmail/provider-imap@<version> version --json
docker manifest inspect ghcr.io/churichard/fluxmail-mcp:<version>
curl -fsS 'https://registry.modelcontextprotocol.io/v0.1/servers/io.github.churichard%2Ffluxmail/versions/<version>' | jq -e --arg version '<version>' '.server.name == "io.github.churichard/fluxmail" and .server.version == $version'
version="<version>"
release_tag="v${version}"
release_json="$(
  gh release view "$release_tag" \
    --repo churichard/fluxmail-mcp \
    --json tagName,name,body,isDraft,isPrerelease,assets,url
)"
test "$(jq -r '.tagName' <<< "$release_json")" = "$release_tag"
test "$(jq -r '.name' <<< "$release_json")" = "$release_tag"
test "$(jq -r '.isDraft' <<< "$release_json")" = "false"
test "$(jq -r '.assets | length' <<< "$release_json")" = "0"
tag_refs="$(git ls-remote --tags origin "refs/tags/${release_tag}" "refs/tags/${release_tag}^{}")"
remote_tag_sha="$(
  printf '%s\n' "$tag_refs" |
    awk -v base="refs/tags/${release_tag}" -v peeled="refs/tags/${release_tag}^{}" '
      $2 == base { base_sha = $1 }
      $2 == peeled { peeled_sha = $1 }
      END { print (peeled_sha != "" ? peeled_sha : base_sha) }
    '
)"
test -n "$remote_tag_sha"
state_file=".context/releases/${release_tag}/state.json"
if [[ -f "$state_file" ]]; then
  notes_file="$(jq -er '.notes_file' "$state_file")"
  test -f "$notes_file"
  test "$(jq -er '.version' "$state_file")" = "$version"
  test "$(jq -er '.tag' "$state_file")" = "$release_tag"
  test "$(jq -er '.release_sha' "$state_file")" = "$remote_tag_sha"
  test "$(jq -er '.title' "$state_file")" = "$(jq -r '.name' <<< "$release_json")"
  test "$(jq -r '.prerelease' "$state_file")" = "$(jq -r '.isPrerelease' <<< "$release_json")"
  test "$(cat "$notes_file")" = "$(jq -r '.body' <<< "$release_json")"
fi
printf '%s\n' "$release_json"
printf 'Remote tag commit: %s\n' "$remote_tag_sha"
)
```

Confirm that the Registry response contains `io.github.churichard/fluxmail` at the intended version. The block always verifies that the GitHub Release is published, has no uploaded assets, and uses an existing remote Git tag, then reports the release metadata and peeled tag commit. When saved release state exists, it also checks the approved version, tag, commit, title, notes, and prerelease state. Keep that state for retries until every destination is verified, then remove its directory from `.context/releases`. A later verify-only run can verify artifact existence and remote consistency without local state, but it cannot reconstruct the original approval. Report the exact versions published, skipped, or blocked. Include any remaining manual step and do not claim success for a destination that was not verified.
