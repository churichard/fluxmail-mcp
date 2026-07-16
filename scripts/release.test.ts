import { describe, expect, it } from 'vitest';
import { loadReleasePackages } from './release-config.mjs';
import { parseArgs, planNpmAndDockerRelease, run } from './publish.mjs';
import { insertReleaseEntry, planRelease, renderReleaseNotes, validateChangelogEntry } from './release.mjs';

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
});

describe('resumable publishing', () => {
  it('routes a missing Docker image without republishing npm packages', () => {
    const plan = planNpmAndDockerRelease({
      npmStates: [{ name: 'fluxmail', version: '0.5.0', published: true }],
      dockerPublished: false,
    });

    expect(plan).toMatchObject({ complete: false, inconsistent: false, missingPackages: [] });
  });

  it('stops when Docker exists before every npm package', () => {
    const plan = planNpmAndDockerRelease({
      npmStates: [{ name: 'fluxmail', version: '0.5.0', published: false }],
      dockerPublished: true,
    });

    expect(plan.inconsistent).toBe(true);
  });

  it('continues at the first missing release destination', () => {
    const plan = planRelease({
      npm: [{ name: 'fluxmail', version: '0.5.0', published: true }],
      docker: { published: true },
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
      npm: [{ name: 'fluxmail', version: '0.5.0', published: true }],
      docker: { published: true },
      registry: { published: true },
      githubRelease: { state: 'published' },
      gitTag: { published: false },
    });

    expect(plan).toMatchObject({ inconsistent: true });
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
