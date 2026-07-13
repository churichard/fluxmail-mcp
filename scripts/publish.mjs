#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';

const packages = ['packages/core', 'packages/provider-gmail', 'packages/provider-imap', 'packages/server'];

const options = parseArgs(process.argv.slice(2));
const manifests = await Promise.all(packages.map(readManifest));
const version = manifests[0].version;

if (!version || manifests.some((manifest) => manifest.version !== version)) {
  fail(
    `All packages must have the same version. Found: ${manifests
      .map((manifest) => `${manifest.name}@${manifest.version ?? '<missing>'}`)
      .join(', ')}`,
  );
}

const dockerImage = options.dockerImage ?? process.env.DOCKER_IMAGE ?? 'ghcr.io/churichard/fluxmail-mcp';
const npmTag = options.tag ?? process.env.NPM_TAG ?? 'latest';
const dockerTags = [...new Set([version, npmTag])];
const dockerPlatforms = process.env.DOCKER_PLATFORMS ?? 'linux/amd64,linux/arm64';
const dockerBuildArgs = [
  'buildx',
  'build',
  '--pull',
  '--platform',
  dockerPlatforms,
  ...dockerTags.flatMap((tag) => ['--tag', `${dockerImage}:${tag}`]),
];

console.log(`Publishing Fluxmail ${version}`);
console.log(`npm tag: ${npmTag}`);
console.log(`Docker image: ${dockerImage}`);
console.log(`Docker platforms: ${dockerPlatforms}`);

await run('node', ['scripts/check-package-licenses.mjs', ...packages]);
await run('node', ['scripts/check-registry-metadata.mjs']);
await ensureCleanWorkingTree();
if (!options.dryRun) {
  await ensureNpmAuthentication();
}
await run('pnpm', ['build']);
await run('pnpm', ['typecheck']);
await run('pnpm', ['test']);
await run('docker', ['info'], { output: 'ignore' });
if (!options.dryRun) {
  await ensureDockerVersionIsUnpublished();
}
await run('docker', [...dockerBuildArgs, '.']);

for (const manifest of manifests) {
  await run('pnpm', [
    '--filter',
    manifest.name,
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
  process.exit(0);
}

for (const manifest of manifests) {
  if (await isPublished(manifest)) {
    console.log(`Skipping ${manifest.name}@${manifest.version}: already published.`);
    continue;
  }

  await run('pnpm', ['--filter', manifest.name, 'publish', '--access', 'public', '--tag', npmTag, '--no-git-checks']);
}

await run('docker', [...dockerBuildArgs, '--push', '.']);

console.log(`\nPublished Fluxmail ${version} to npm and ${dockerImage}.`);

async function readManifest(directory) {
  return JSON.parse(await readFile(new URL(`../${directory}/package.json`, import.meta.url)));
}

async function ensureCleanWorkingTree() {
  const result = await run('git', ['status', '--porcelain'], {
    output: 'capture',
    allowFailure: true,
  });

  if (result.code !== 0) {
    fail('Could not inspect the Git working tree.');
  }

  if (result.stdout.trim()) {
    fail('The Git working tree must be clean before publishing.');
  }
}

async function isPublished(manifest) {
  const result = await run('npm', ['view', `${manifest.name}@${manifest.version}`, 'version', '--json'], {
    output: 'capture',
    allowFailure: true,
  });

  if (result.code === 0) {
    return JSON.parse(result.stdout) === manifest.version;
  }

  return false;
}

async function ensureDockerVersionIsUnpublished() {
  const image = `${dockerImage}:${version}`;
  const result = await run('docker', ['manifest', 'inspect', image], {
    output: 'capture',
    allowFailure: true,
  });

  if (result.code === 0) {
    fail(`Docker image ${image} is already published and will not be overwritten.`);
  }

  if (!/manifest unknown|no such manifest|not found/i.test(result.stderr)) {
    fail(`Could not verify whether Docker image ${image} is already published.`);
  }
}

async function ensureNpmAuthentication() {
  const result = await run('npm', ['whoami'], {
    output: 'capture',
    allowFailure: true,
  });

  if (result.code !== 0) {
    fail('npm authentication failed. Run `npm login`, then confirm it with `npm whoami` before publishing.');
  }
}

function parseArgs(args) {
  const parsed = { dryRun: false, dockerImage: undefined, tag: undefined };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === '--dry-run') {
      parsed.dryRun = true;
    } else if (arg === '--docker-image') {
      parsed.dockerImage = requiredValue(args, ++index, arg);
    } else if (arg === '--tag') {
      parsed.tag = requiredValue(args, ++index, arg);
    } else {
      fail(`Unknown option: ${arg}`);
    }
  }

  return parsed;
}

function requiredValue(args, index, option) {
  const value = args[index];
  if (!value || value.startsWith('--')) {
    fail(`${option} requires a value.`);
  }
  return value;
}

function run(command, args, { output = 'inherit', allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: output === 'capture' ? ['ignore', 'pipe', 'pipe'] : output,
    });
    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
    });
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

function fail(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}
