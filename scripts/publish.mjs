#!/usr/bin/env node

import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { loadReleaseVersion, releaseConfig, repositoryRoot } from './release-config.mjs';

export async function main(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  const { packages, version } = await loadReleaseVersion();
  const dockerImage = options.dockerImage ?? process.env.DOCKER_IMAGE ?? releaseConfig.dockerImage;
  const npmTag = options.tag ?? process.env.NPM_TAG ?? 'latest';
  const dockerTags = [...new Set([version, npmTag])];
  const dockerPlatforms = process.env.DOCKER_PLATFORMS ?? 'linux/amd64,linux/arm64';
  const dockerBuildArgs = [
    'buildx',
    'build',
    '--progress',
    'plain',
    '--platform',
    dockerPlatforms,
    ...dockerTags.flatMap((tag) => ['--tag', `${dockerImage}:${tag}`]),
  ];

  console.log(`Publishing Fluxmail ${version}`);
  console.log(`npm tag: ${npmTag}`);
  console.log(`Docker image: ${dockerImage}`);
  console.log(`Docker platforms: ${dockerPlatforms}`);

  if (options.skipChecks && process.env.GITHUB_ACTIONS !== 'true') {
    fail('--skip-checks is reserved for the validated GitHub Actions publish job.');
  }

  await run('node', ['scripts/check-package-licenses.mjs', ...packages.map(({ directory }) => directory)]);
  await run('node', ['scripts/check-registry-metadata.mjs']);
  await ensureCleanWorkingTree();

  if (!options.dryRun) await ensureNpmAuthentication(options.npmOidc);

  if (!options.skipChecks) {
    await run('pnpm', ['build']);
    await run('pnpm', ['typecheck']);
    await run('pnpm', ['test']);
  }

  await run('docker', ['info'], { output: 'ignore' });

  const npmStates = await inspectNpmPackages(packages, { attempts: options.resume ? 3 : 1 });
  const dockerState = await inspectDockerImage(`${dockerImage}:${version}`);
  const plan = planNpmAndDockerRelease({ npmStates, dockerPublished: dockerState.published });

  if (plan.inconsistent) fail(plan.message);
  if (plan.complete) {
    if (!options.resume) fail(`Docker image ${dockerImage}:${version} is already published.`);
    console.log(`Fluxmail ${version} is already published to npm and ${dockerImage}.`);
    return;
  }

  await run('docker', [...dockerBuildArgs, '--pull', '.']);

  for (const packageState of plan.missingPackages) {
    await run('pnpm', [
      '--filter',
      packageState.name,
      'publish',
      '--access',
      'public',
      '--tag',
      npmTag,
      '--no-git-checks',
      '--dry-run',
    ]);
  }

  if (options.dryRun) {
    console.log('\nDry run complete. Nothing was pushed or published.');
    return;
  }

  for (const packageState of plan.missingPackages) {
    const releasePackage = packages.find(({ manifest }) => manifest.name === packageState.name);
    await publishPackage(releasePackage, npmTag, { npmOidc: options.npmOidc });
  }

  const publishedNpmStates = await inspectNpmPackages(packages, { attempts: 6, initialDelayMs: 1_000 });
  const missingAfterPublish = publishedNpmStates.filter(({ published }) => !published);
  if (missingAfterPublish.length > 0) {
    fail(
      `npm did not confirm these packages after publishing: ${missingAfterPublish.map(({ name }) => name).join(', ')}`,
    );
  }

  await run('docker', [...dockerBuildArgs, '--push', '.']);
  console.log(`\nPublished Fluxmail ${version} to npm and ${dockerImage}.`);
}

export function parseArgs(args) {
  const parsed = {
    dryRun: false,
    dockerImage: undefined,
    npmOidc: false,
    resume: false,
    skipChecks: false,
    tag: undefined,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === '--dry-run') parsed.dryRun = true;
    else if (arg === '--resume') parsed.resume = true;
    else if (arg === '--skip-checks') parsed.skipChecks = true;
    else if (arg === '--npm-oidc') parsed.npmOidc = true;
    else if (arg === '--docker-image') parsed.dockerImage = requiredValue(args, ++index, arg);
    else if (arg === '--tag') parsed.tag = requiredValue(args, ++index, arg);
    else fail(`Unknown option: ${arg}`);
  }

  if (parsed.dryRun && parsed.skipChecks) fail('--dry-run cannot be combined with --skip-checks.');
  if (parsed.dryRun && parsed.npmOidc) fail('--dry-run does not use npm OIDC authentication.');

  return parsed;
}

export function planNpmAndDockerRelease({ npmStates, dockerPublished }) {
  const missingPackages = npmStates.filter(({ published }) => !published);

  if (dockerPublished && missingPackages.length > 0) {
    return {
      complete: false,
      inconsistent: true,
      message: `The Docker image exists while npm packages are missing: ${missingPackages.map(({ name }) => name).join(', ')}`,
      missingPackages,
    };
  }

  return {
    complete: dockerPublished && missingPackages.length === 0,
    inconsistent: false,
    missingPackages,
  };
}

async function publishPackage(releasePackage, npmTag, { npmOidc }) {
  const { directory, manifest } = releasePackage;
  if (!npmOidc) {
    await run('pnpm', ['--filter', manifest.name, 'publish', '--access', 'public', '--tag', npmTag, '--no-git-checks']);
    return;
  }

  const packDirectory = await mkdtemp(path.join(tmpdir(), 'fluxmail-release-'));
  try {
    await run('pnpm', ['--dir', directory, 'pack', '--pack-destination', packDirectory]);
    const tarballs = (await readdir(packDirectory)).filter((file) => file.endsWith('.tgz'));
    if (tarballs.length !== 1) {
      fail(`Expected one tarball for ${manifest.name}, found ${tarballs.length}.`);
    }
    await run('npm', ['publish', path.join(packDirectory, tarballs[0]), '--access', 'public', '--tag', npmTag]);
  } finally {
    await rm(packDirectory, { recursive: true, force: true });
  }
}

async function ensureCleanWorkingTree() {
  const result = await run('git', ['status', '--porcelain'], { output: 'capture', allowFailure: true });
  if (result.code !== 0) fail('Could not inspect the Git working tree.');
  if (result.stdout.trim()) fail('The Git working tree must be clean before publishing.');
}

async function ensureNpmAuthentication(npmOidc) {
  if (npmOidc) {
    if (
      process.env.GITHUB_ACTIONS !== 'true' ||
      !process.env.ACTIONS_ID_TOKEN_REQUEST_URL ||
      !process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN
    ) {
      fail('npm OIDC publishing requires GitHub Actions with `id-token: write`.');
    }
    return;
  }

  const result = await run('npm', ['whoami'], { output: 'capture', allowFailure: true });
  if (result.code !== 0) {
    fail('npm authentication failed. Run `npm login`, then confirm it with `npm whoami` before publishing.');
  }
}

export async function inspectNpmPackages(packages, retryOptions = {}) {
  return Promise.all(
    packages.map(async ({ manifest }) => ({
      name: manifest.name,
      version: manifest.version,
      published: await isPublished(manifest, retryOptions),
    })),
  );
}

async function isPublished(manifest, { attempts = 1, initialDelayMs = 500 } = {}) {
  let delayMs = initialDelayMs;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = await run('npm', ['view', `${manifest.name}@${manifest.version}`, 'version', '--json'], {
      output: 'capture',
      allowFailure: true,
    });

    if (result.code === 0) return JSON.parse(result.stdout) === manifest.version;
    if (!isMissingNpmResult(result)) {
      throw new Error(`Could not inspect ${manifest.name}@${manifest.version}: ${result.stderr.trim()}`);
    }
    if (attempt < attempts) await wait(delayMs);
    delayMs = Math.min(delayMs * 2, 4_000);
  }

  return false;
}

function isMissingNpmResult(result) {
  return /E404|404 Not Found|is not in this registry|No match found/i.test(`${result.stdout}\n${result.stderr}`);
}

async function inspectDockerImage(image) {
  const result = await run('docker', ['manifest', 'inspect', image], { output: 'capture', allowFailure: true });
  if (result.code === 0) return { published: true };
  if (/manifest unknown|no such manifest|not found/i.test(result.stderr)) return { published: false };
  fail(`Could not verify whether Docker image ${image} is already published.`);
}

function requiredValue(args, index, option) {
  const value = args[index];
  if (!value || value.startsWith('--')) fail(`${option} requires a value.`);
  return value;
}

export function run(command, args, { output = 'inherit', allowFailure = false, cwd = repositoryRoot, input } = {}) {
  return new Promise((resolve, reject) => {
    const stdio =
      output === 'capture'
        ? [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe']
        : input === undefined
          ? output
          : ['pipe', output, output];
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio,
    });
    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
    });
    if (input !== undefined) child.stdin.end(input);
    child.on('error', reject);
    child.on('close', (code) => {
      const result = { code: code ?? 1, stdout, stderr };
      if (result.code !== 0 && !allowFailure) {
        reject(new Error(`${command} ${args.join(' ')} failed with exit code ${result.code}`));
      } else {
        resolve(result);
      }
    });
  });
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function fail(message) {
  throw new Error(message);
}

if (pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  });
}
