import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { loadReleasePackages, repositoryRoot } from './release-config.mjs';
import { classifyNpmChannel, inspectNpmTag, parseArgs, planNpmAndDockerRelease, run } from './publish.mjs';
import {
  assertNpmTagMatchesVersion,
  buildDoctorReport,
  buildNpmTrustFailureCheck,
  insertReleaseEntry,
  isExpectedNpmTrustedPublisher,
  isMainOnlyEnvironmentPolicy,
  planRelease,
  renderReleaseNotes,
  validateChangelogEntry,
} from './release.mjs';

const changelog = `# Changelog

## [Unreleased]

## [0.5.0] - 2026-07-15

### Changed

- Require Node.js 22 for the CLI ([#51](https://github.com/churichard/fluxmail-mcp/pull/51))

### Added

- Add shared Outlook mailboxes ([#52](https://github.com/churichard/fluxmail-mcp/pull/52))

[Unreleased]: https://github.com/churichard/fluxmail-mcp/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/churichard/fluxmail-mcp/compare/v0.4.0...v0.5.0
`;

describe('release inventory', () => {
  it('discovers every publishable package from the workspace', async () => {
    const packages = await loadReleasePackages();

    expect(packages.map(({ manifest }) => manifest.name)).toEqual([
      '@fluxmail/core',
      '@fluxmail/provider-gmail',
      '@fluxmail/provider-imap',
      '@fluxmail/provider-outlook',
      'fluxmail',
    ]);
  });

  it('includes GitHub repository metadata in every publishable package', async () => {
    const packages = await loadReleasePackages();

    for (const { directory, manifest } of packages) {
      expect(manifest.repository).toMatchObject({
        type: 'git',
        url: 'git+https://github.com/churichard/fluxmail-mcp.git',
        directory,
      });
    }
  });
});

describe('release preflight', () => {
  it('serializes all release workflow runs', async () => {
    const workflow = await readFile(path.join(repositoryRoot, '.github/workflows/publish-release.yml'), 'utf8');

    expect(workflow).toContain('group: publish-release\n');
    expect(workflow).not.toContain('group: publish-release-${{ inputs.version }}');
  });

  it('accepts the expected npm trusted publisher', () => {
    expect(
      isExpectedNpmTrustedPublisher({
        type: 'github',
        file: 'publish-release.yml',
        repository: 'churichard/fluxmail-mcp',
        environment: 'release',
        permissions: ['createPackage'],
      }),
    ).toBe(true);
  });

  it('accepts npm registry trust list output', () => {
    expect(
      isExpectedNpmTrustedPublisher([
        {
          type: 'gitlab',
          claims: { project_id: '12345' },
          permissions: ['createPackage'],
        },
        {
          type: 'github',
          claims: {
            workflow_ref: { file: 'publish-release.yml' },
            repository: 'churichard/fluxmail-mcp',
            environment: 'release',
          },
          permissions: ['createPackage'],
        },
      ]),
    ).toBe(true);
  });

  it('rejects registry output for a different workflow', () => {
    expect(
      isExpectedNpmTrustedPublisher([
        {
          type: 'github',
          claims: {
            workflow_ref: { file: 'other.yml' },
            repository: 'churichard/fluxmail-mcp',
            environment: 'release',
          },
          permissions: ['createPackage'],
        },
      ]),
    ).toBe(false);
  });

  it('fails when preflight requires an external action', () => {
    expect(
      buildDoctorReport([
        { id: 'tool:git', status: 'pass', message: 'git is available.' },
        { id: 'npm-trusted-publisher:fluxmail', status: 'action_required', message: 'Authenticate npm.' },
      ]),
    ).toMatchObject({ ok: false });
  });

  it('reports a missing npm login as an authentication action', () => {
    expect(
      buildNpmTrustFailureCheck('@fluxmail/core', {
        stdout: JSON.stringify({ error: { code: 'E401', summary: 'You must be logged in.' } }),
        stderr: '',
      }),
    ).toEqual({
      id: 'npm-trusted-publisher:@fluxmail/core',
      status: 'action_required',
      message: 'Log in to npm, then rerun the preflight.',
    });
  });

  it('accepts only a custom main branch policy for the release environment', () => {
    expect(
      isMainOnlyEnvironmentPolicy({ custom_branch_policies: true, protected_branches: false }, [{ name: 'main' }]),
    ).toBe(true);
    expect(
      isMainOnlyEnvironmentPolicy({ custom_branch_policies: true, protected_branches: false }, [
        { name: 'main', type: 'branch' },
      ]),
    ).toBe(true);
    expect(
      isMainOnlyEnvironmentPolicy({ custom_branch_policies: false, protected_branches: true }, [
        { name: 'main', type: 'branch' },
      ]),
    ).toBe(false);
    expect(
      isMainOnlyEnvironmentPolicy({ custom_branch_policies: true, protected_branches: false }, [
        { name: 'main', type: 'branch' },
        { name: 'release/*', type: 'branch' },
      ]),
    ).toBe(false);
  });
});

describe('Common Changelog releases', () => {
  it('moves Unreleased changes into a versioned entry and updates comparison links', () => {
    const prepared = insertReleaseEntry(
      `# Changelog

## [Unreleased]

[Unreleased]: https://github.com/churichard/fluxmail-mcp/compare/v0.4.0...HEAD
`,
      {
        version: '0.5.0',
        date: '2026-07-15',
        previousTag: 'v0.4.0',
        body: '### Added\n\n- Add shared mailboxes ([#52](https://github.com/churichard/fluxmail-mcp/pull/52))',
      },
    );

    expect(prepared).toContain('## [0.5.0] - 2026-07-15');
    expect(prepared).toContain('[Unreleased]: https://github.com/churichard/fluxmail-mcp/compare/v0.5.0...HEAD');
    expect(prepared).toContain('[0.5.0]: https://github.com/churichard/fluxmail-mcp/compare/v0.4.0...v0.5.0');
  });

  it('renders the committed entry as a GitHub Release body', () => {
    expect(renderReleaseNotes(changelog, '0.5.0')).toBe(`## Changed

- Require Node.js 22 for the CLI ([#51](https://github.com/churichard/fluxmail-mcp/pull/51))

## Added

- Add shared Outlook mailboxes ([#52](https://github.com/churichard/fluxmail-mcp/pull/52))

**Full Changelog**: https://github.com/churichard/fluxmail-mcp/compare/v0.4.0...v0.5.0
`);
  });

  it('rejects unsupported or out-of-order groups', () => {
    const invalid = changelog.replace('### Changed', '### Fixed');
    expect(() => validateChangelogEntry(invalid, '0.5.0')).toThrow(
      'Use changelog groups in this order: Changed, Added, Removed, Fixed.',
    );
  });

  it('requires the release comparison link', () => {
    const invalid = changelog.replace(
      '[0.5.0]: https://github.com/churichard/fluxmail-mcp/compare/v0.4.0...v0.5.0\n',
      '',
    );

    expect(() => validateChangelogEntry(invalid, '0.5.0')).toThrow('Add the [0.5.0] release link to CHANGELOG.md.');
  });

  it('rejects a release comparison link for another version', () => {
    const invalid = changelog.replace('compare/v0.4.0...v0.5.0', 'compare/v0.4.0...v0.6.0');

    expect(() => validateChangelogEntry(invalid, '0.5.0')).toThrow(
      'The [0.5.0] release link must target v0.5.0 in the Fluxmail repository.',
    );
  });

  it('accepts the release link used when there is no previous tag', () => {
    const firstRelease = changelog.replace(
      'https://github.com/churichard/fluxmail-mcp/compare/v0.4.0...v0.5.0',
      'https://github.com/churichard/fluxmail-mcp/releases/tag/v0.5.0',
    );

    expect(() => validateChangelogEntry(firstRelease, '0.5.0')).not.toThrow();
  });
});

describe('resumable publishing', () => {
  it('requires stable releases to use latest', () => {
    expect(() => assertNpmTagMatchesVersion('0.5.0', 'latest')).not.toThrow();
    expect(() => assertNpmTagMatchesVersion('0.5.0', 'next')).toThrow('Fluxmail 0.5.0 must use the latest npm tag.');
  });

  it('requires prereleases to use next', () => {
    expect(() => assertNpmTagMatchesVersion('0.5.0-beta.1', 'next')).not.toThrow();
    expect(() => assertNpmTagMatchesVersion('0.5.0-beta.1', 'latest')).toThrow(
      'Fluxmail 0.5.0-beta.1 must use the next npm tag.',
    );
  });

  it('routes a missing Docker image without republishing npm packages', () => {
    const plan = planNpmAndDockerRelease({
      npmStates: [{ name: 'fluxmail', version: '0.5.0', published: true, tagVersion: '0.5.0' }],
      dockerVersion: { published: false },
      dockerChannel: { published: false },
    });

    expect(plan).toMatchObject({
      complete: false,
      inconsistent: false,
      missingPackages: [],
      publishDocker: true,
      repairDockerChannel: false,
    });
  });

  it('stops when Docker exists before every npm package', () => {
    const plan = planNpmAndDockerRelease({
      npmStates: [{ name: 'fluxmail', version: '0.5.0', published: false, tagVersion: '0.4.0' }],
      dockerVersion: { published: true, digest: 'sha256:version' },
      dockerChannel: { published: true, digest: 'sha256:version' },
    });

    expect(plan.inconsistent).toBe(true);
  });

  it('repairs a missing Docker channel without rebuilding the version', () => {
    const plan = planNpmAndDockerRelease({
      npmStates: [{ name: 'fluxmail', version: '0.5.0', published: true, tagVersion: '0.5.0' }],
      dockerVersion: { published: true, digest: 'sha256:version' },
      dockerChannel: { published: false },
    });

    expect(plan).toMatchObject({
      complete: false,
      inconsistent: false,
      publishDocker: false,
      repairDockerChannel: true,
    });
  });

  it('repairs a Docker channel that points to another version', () => {
    const plan = planNpmAndDockerRelease({
      npmStates: [{ name: 'fluxmail', version: '0.5.0', published: true, tagVersion: '0.5.0' }],
      dockerVersion: { published: true, digest: 'sha256:version' },
      dockerChannel: { published: true, digest: 'sha256:previous' },
    });

    expect(plan).toMatchObject({
      complete: false,
      inconsistent: false,
      publishDocker: false,
      repairDockerChannel: true,
    });
  });

  it('completes when Docker version and channel tags match', () => {
    const plan = planNpmAndDockerRelease({
      npmStates: [{ name: 'fluxmail', version: '0.5.0', published: true, tagVersion: '0.5.0' }],
      dockerVersion: { published: true, digest: 'sha256:version' },
      dockerChannel: { published: true, digest: 'sha256:version' },
    });

    expect(plan).toMatchObject({
      complete: true,
      inconsistent: false,
      publishDocker: false,
      repairDockerChannel: false,
    });
  });

  it('preserves newer npm and Docker channels during a historical resume', () => {
    const plan = planNpmAndDockerRelease({
      npmStates: [{ name: 'fluxmail', version: '0.5.0', published: true, tagVersion: '0.6.0' }],
      dockerVersion: { published: true, digest: 'sha256:version' },
      dockerChannelVersion: { published: true, digest: 'sha256:newer' },
      dockerChannel: { published: true, digest: 'sha256:newer' },
    });

    expect(plan).toMatchObject({
      channelVersion: '0.6.0',
      complete: true,
      historical: true,
      inconsistent: false,
      publishDocker: false,
      repairDockerChannel: false,
      updateChannel: false,
    });
  });

  it('stops a historical resume when Docker does not match the newer npm channel', () => {
    const plan = planNpmAndDockerRelease({
      npmStates: [{ name: 'fluxmail', version: '0.5.0', published: true, tagVersion: '0.6.0' }],
      dockerVersion: { published: true, digest: 'sha256:version' },
      dockerChannelVersion: { published: true, digest: 'sha256:newer' },
      dockerChannel: { published: true, digest: 'sha256:older' },
    });

    expect(plan).toMatchObject({
      complete: false,
      historical: true,
      inconsistent: true,
    });
  });

  it('stops when an already-published npm version has a stale channel tag', () => {
    expect(
      classifyNpmChannel(
        [{ name: 'fluxmail', version: '0.5.0', published: true, tagVersion: '0.4.0' }],
        '0.5.0',
        'latest',
      ),
    ).toMatchObject({
      historical: false,
      inconsistent: true,
    });
  });

  it('stops before a historical package publish can move the npm channel backward', () => {
    expect(
      classifyNpmChannel(
        [{ name: 'fluxmail', version: '0.5.0', published: false, tagVersion: '0.6.0' }],
        '0.5.0',
        'latest',
      ),
    ).toMatchObject({
      historical: false,
      inconsistent: true,
    });
  });

  it('continues at the first missing release destination', () => {
    const plan = planRelease({
      version: '0.5.0',
      npmTag: 'latest',
      npm: [{ name: 'fluxmail', version: '0.5.0', published: true, tagVersion: '0.5.0' }],
      docker: { published: true, channelMatches: true },
      registry: { published: false },
      githubRelease: { state: 'missing' },
      gitTag: { published: false },
    });

    expect(plan).toMatchObject({
      inconsistent: false,
      publishNpmOrDocker: false,
      publishRegistry: true,
      publishGitHubRelease: true,
    });
  });

  it('stops when a published GitHub Release has lost a destination', () => {
    const plan = planRelease({
      version: '0.5.0',
      npmTag: 'latest',
      npm: [{ name: 'fluxmail', version: '0.5.0', published: true, tagVersion: '0.5.0' }],
      docker: { published: true, channelMatches: true },
      registry: { published: true },
      githubRelease: { state: 'published' },
      gitTag: { published: false },
    });

    expect(plan).toMatchObject({ inconsistent: true });
  });

  it('routes a stale Docker channel through publishing', () => {
    const plan = planRelease({
      version: '0.5.0',
      npmTag: 'latest',
      npm: [{ name: 'fluxmail', version: '0.5.0', published: true, tagVersion: '0.5.0' }],
      docker: { published: true, channelMatches: false },
      registry: { published: true },
      githubRelease: { state: 'missing' },
      gitTag: { published: false },
    });

    expect(plan).toMatchObject({
      inconsistent: false,
      publishNpmOrDocker: true,
    });
  });

  it('completes a historical release without changing newer channels', () => {
    const plan = planRelease({
      version: '0.5.0',
      npmTag: 'latest',
      npm: [{ name: 'fluxmail', version: '0.5.0', published: true, tagVersion: '0.6.0' }],
      docker: { published: true, channelMatches: true },
      registry: { published: true },
      githubRelease: { state: 'published' },
      gitTag: { published: true },
    });

    expect(plan).toMatchObject({
      channelVersion: '0.6.0',
      complete: true,
      historical: true,
      inconsistent: false,
      publishNpmOrDocker: false,
      updateChannel: false,
    });
  });

  it('stops a historical release when Docker does not match the newer npm channel', () => {
    const plan = planRelease({
      version: '0.5.0',
      npmTag: 'latest',
      npm: [{ name: 'fluxmail', version: '0.5.0', published: true, tagVersion: '0.6.0' }],
      docker: { published: true, channelMatches: false },
      registry: { published: true },
      githubRelease: { state: 'published' },
      gitTag: { published: true },
    });

    expect(plan).toMatchObject({
      complete: false,
      historical: true,
      inconsistent: true,
    });
  });

  it('retries a successful npm tag read until the expected version appears', async () => {
    const responses = ['0.4.0', '0.5.0'];
    const waits = [];
    const tagVersion = await inspectNpmTag({ name: 'fluxmail' }, 'latest', {
      attempts: 3,
      expectedTagVersion: '0.5.0',
      initialDelayMs: 10,
      runCommand: async () => ({
        code: 0,
        stdout: JSON.stringify({ latest: responses.shift() }),
        stderr: '',
      }),
      waitFor: async (milliseconds) => waits.push(milliseconds),
    });

    expect(tagVersion).toBe('0.5.0');
    expect(waits).toEqual([10]);
  });

  it('requires resume mode for release retries', () => {
    expect(parseArgs(['--resume', '--skip-checks', '--tag', 'latest'])).toMatchObject({
      resume: true,
      skipChecks: true,
      tag: 'latest',
    });
  });

  it('passes credentials over stdin without adding them to command arguments', async () => {
    const result = await run(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], {
      input: 'credential',
      output: 'capture',
    });

    expect(result.stdout).toBe('credential');
  });
});
