import updateNotifier, { type Settings, type UpdateNotifier } from 'update-notifier';
import { VERSION } from './version.js';

export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1_000;
export const UPDATE_GUIDE_URL = 'https://fluxmail.ai/docs/use-the-cli#update-fluxmail';

const UPDATE_MESSAGE = `Fluxmail update available: {currentVersion} -> {latestVersion}\nUpdate instructions: ${UPDATE_GUIDE_URL}`;
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

interface ParsedVersion {
  major: bigint;
  minor: bigint;
  patch: bigint;
  prerelease: string[];
}

export interface CliUpdateNotifier {
  notify(): void;
}

export type CliUpdateNotifierFactory = () => CliUpdateNotifier | undefined;

interface UpdateNotifierEnvironment {
  env?: NodeJS.ProcessEnv;
  stdoutIsTTY?: boolean;
  notifierFactory?: (settings: Settings) => UpdateNotifier;
}

function parseVersion(version: string): ParsedVersion | undefined {
  const match = SEMVER_PATTERN.exec(version);
  if (!match?.[1] || !match[2] || !match[3]) return undefined;
  return {
    major: BigInt(match[1]),
    minor: BigInt(match[2]),
    patch: BigInt(match[3]),
    prerelease: match[4]?.split('.') ?? [],
  };
}

function compareIdentifier(left: string, right: string): number {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);
  if (leftNumeric && rightNumeric) {
    const leftNumber = BigInt(left);
    const rightNumber = BigInt(right);
    return leftNumber < rightNumber ? -1 : leftNumber > rightNumber ? 1 : 0;
  }
  if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareVersions(left: ParsedVersion, right: ParsedVersion): number {
  for (const field of ['major', 'minor', 'patch'] as const) {
    if (left[field] !== right[field]) return left[field] < right[field] ? -1 : 1;
  }
  if (!left.prerelease.length || !right.prerelease.length) {
    if (left.prerelease.length === right.prerelease.length) return 0;
    return left.prerelease.length ? -1 : 1;
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = left.prerelease[index];
    const rightIdentifier = right.prerelease[index];
    if (leftIdentifier === undefined || rightIdentifier === undefined) {
      return leftIdentifier === rightIdentifier ? 0 : leftIdentifier === undefined ? -1 : 1;
    }
    const compared = compareIdentifier(leftIdentifier, rightIdentifier);
    if (compared !== 0) return compared;
  }
  return 0;
}

export function isNewerVersion(current: string, latest: string): boolean {
  const parsedCurrent = parseVersion(current);
  const parsedLatest = parseVersion(latest);
  return Boolean(parsedCurrent && parsedLatest && compareVersions(parsedLatest, parsedCurrent) > 0);
}

function environmentValueIsEnabled(value: string | undefined): boolean {
  return value !== undefined && value !== '' && value !== '0' && value.toLowerCase() !== 'false';
}

export function updateChecksAllowed(
  env: NodeJS.ProcessEnv = process.env,
  stdoutIsTTY = process.stdout.isTTY === true,
): boolean {
  if (!stdoutIsTTY || 'NO_UPDATE_NOTIFIER' in env || env.NODE_ENV === 'test') return false;
  if (environmentValueIsEnabled(env.CI)) return false;
  if (env.npm_config_user_agent || env.npm_execpath || env.npm_lifecycle_event || env.npm_command === 'exec') {
    return false;
  }
  return true;
}

function removeNewExitListeners(existing: ReadonlySet<(...args: never[]) => unknown>): void {
  for (const listener of process.listeners('exit')) {
    if (!existing.has(listener)) process.off('exit', listener);
  }
}

function markDueCheckAttempt(config: NonNullable<UpdateNotifier['config']>): void {
  try {
    const lastUpdateCheck = config.get('lastUpdateCheck');
    const now = Date.now();
    if (typeof lastUpdateCheck !== 'number' || now - lastUpdateCheck >= UPDATE_CHECK_INTERVAL_MS) {
      config.set('lastUpdateCheck', now);
    }
  } catch {
    // A cache error must not affect the command.
  }
}

/** Create an npm update notifier without letting cache or registry failures affect the CLI. */
export function createCliUpdateNotifier(options: UpdateNotifierEnvironment = {}): CliUpdateNotifier | undefined {
  const env = options.env ?? process.env;
  const stdoutIsTTY = options.stdoutIsTTY ?? process.stdout.isTTY === true;
  if (!updateChecksAllowed(env, stdoutIsTTY)) return undefined;

  const existingExitListeners = new Set(process.listeners('exit'));
  try {
    const notifier = (options.notifierFactory ?? updateNotifier)({
      pkg: { name: 'fluxmail', version: VERSION },
      distTag: 'latest',
      updateCheckInterval: UPDATE_CHECK_INTERVAL_MS,
    });
    if (!notifier.config) {
      removeNewExitListeners(existingExitListeners);
      return undefined;
    }
    // update-notifier records only successful checks. Record the attempt too so
    // registry failures cannot trigger another detached check on every command.
    markDueCheckAttempt(notifier.config);
    return {
      notify(): void {
        try {
          const update = notifier.update;
          if (!update || !isNewerVersion(update.current, update.latest)) return;
          notifier.notify({ defer: false, message: UPDATE_MESSAGE });
        } catch {
          // A corrupt cache or terminal error must not affect the command.
        }
      },
    };
  } catch {
    removeNewExitListeners(existingExitListeners);
    return undefined;
  }
}
