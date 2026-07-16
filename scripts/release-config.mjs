import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const releaseConfig = Object.freeze({
  githubRepository: 'churichard/fluxmail-mcp',
  githubRepositoryUrl: 'git+https://github.com/churichard/fluxmail-mcp.git',
  githubWorkflow: 'publish-release.yml',
  githubEnvironment: 'release',
  dockerImage: 'ghcr.io/churichard/fluxmail-mcp',
  registryName: 'io.github.churichard/fluxmail',
  registryUrl: 'https://registry.modelcontextprotocol.io',
});

export async function loadReleasePackages(root = repositoryRoot) {
  const packagesRoot = path.join(root, 'packages');
  const entries = await readdir(packagesRoot, { withFileTypes: true });
  const packages = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const directory = path.posix.join('packages', entry.name);
    const manifestPath = path.join(root, directory, 'package.json');
    let manifest;

    try {
      manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }

    if (manifest.private === true) continue;
    if (!manifest.name || !manifest.version) {
      throw new Error(`${directory}/package.json must define a name and version.`);
    }
    if (
      manifest.repository?.url !== releaseConfig.githubRepositoryUrl ||
      manifest.repository?.directory !== directory
    ) {
      throw new Error(
        `${directory}/package.json must set repository.url to ${releaseConfig.githubRepositoryUrl} and repository.directory to ${directory}.`,
      );
    }

    packages.push({ directory, manifest, manifestPath });
  }

  return packages.sort((left, right) => {
    if (left.manifest.name === 'fluxmail') return 1;
    if (right.manifest.name === 'fluxmail') return -1;
    return left.manifest.name.localeCompare(right.manifest.name);
  });
}

export async function loadReleaseVersion(root = repositoryRoot) {
  const packages = await loadReleasePackages(root);
  if (packages.length === 0) throw new Error('No publishable workspace packages were found.');

  const version = packages[0].manifest.version;
  const mismatches = packages.filter(({ manifest }) => manifest.version !== version);
  if (mismatches.length > 0) {
    const found = packages.map(({ manifest }) => `${manifest.name}@${manifest.version}`).join(', ');
    throw new Error(`All publishable packages must use one version. Found: ${found}`);
  }

  return { packages, version };
}
