import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function fluxmailWorktreeCandidates(worktreeList: string): string[] {
  return worktreeList
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => path.join(path.dirname(line.slice('worktree '.length)), 'fluxmail-web'));
}

export function isFluxmailCheckout(directory: string): boolean {
  try {
    const packageJson = JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8')) as { name?: unknown };
    return packageJson.name === 'fluxmail';
  } catch {
    return false;
  }
}

export function supportsMcpDocsPreview(directory: string): boolean {
  try {
    const packageJson = JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8')) as {
      scripts?: Record<string, unknown>;
    };
    return typeof packageJson.scripts?.['docs:preview:mcp'] === 'string';
  } catch {
    return false;
  }
}

function fluxmailWorktrees(directory: string): string[] {
  const worktrees = execFileSync('git', ['-C', directory, 'worktree', 'list', '--porcelain'], {
    encoding: 'utf8',
  });
  return worktrees
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length));
}

export function findFluxmailRoot(override = process.env.FLUXMAIL_WEB_ROOT): string {
  if (override) {
    const directory = path.resolve(override);
    if (isFluxmailCheckout(directory) && supportsMcpDocsPreview(directory)) return directory;
    if (isFluxmailCheckout(directory)) {
      throw new Error(
        `Fluxmail does not include the docs:preview:mcp script yet: ${directory}. Check out the companion Fluxmail docs-preview changes or point FLUXMAIL_WEB_ROOT at that worktree.`,
      );
    }
    throw new Error(`FLUXMAIL_WEB_ROOT is not a Fluxmail checkout: ${directory}`);
  }

  const worktrees = execFileSync('git', ['worktree', 'list', '--porcelain'], {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
  });
  const checkouts = fluxmailWorktreeCandidates(worktrees).filter(isFluxmailCheckout);
  const directory = checkouts
    .flatMap((checkout) => fluxmailWorktrees(checkout))
    .find((checkout) => isFluxmailCheckout(checkout) && supportsMcpDocsPreview(checkout));
  if (directory) return directory;
  if (checkouts.length > 0) {
    throw new Error(
      'The sibling Fluxmail checkout does not include the docs:preview:mcp script yet. Check out the companion Fluxmail docs-preview changes, then try again.',
    );
  }
  throw new Error('Set FLUXMAIL_WEB_ROOT to the path of a Fluxmail checkout with the docs-preview changes.');
}

export function normalizePreviewArgs(args: string[]): string[] {
  const normalized = [...args];
  while (normalized[0] === '--') normalized.shift();
  return normalized;
}

function run(command: string, args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv }): void {
  const result = spawnSync(command, args, { ...options, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function main(): void {
  const fluxmailRoot = findFluxmailRoot();
  const previewArgs = normalizePreviewArgs(process.argv.slice(2));
  if (!previewArgs.includes('--port')) {
    previewArgs.push('--port', process.env.CONDUCTOR_PORT || '3001');
  }

  run('pnpm', ['docs:generate'], { cwd: REPOSITORY_ROOT });
  console.log(`Previewing this worktree with the Fluxmail site at ${fluxmailRoot}`);
  run('pnpm', ['docs:preview:mcp', ...previewArgs], {
    cwd: fluxmailRoot,
    env: { ...process.env, FLUXMAIL_MCP_SOURCE: REPOSITORY_ROOT },
  });
}

const invokedFile = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : undefined;
if (invokedFile === import.meta.url) main();
