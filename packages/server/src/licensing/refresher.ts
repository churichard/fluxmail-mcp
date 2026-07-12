import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { FluxmailConfig } from '../config.js';
import type { FluxmailDb } from '../storage/db.js';
import { validateLicense } from './client.js';
import { licensePublicKeys, verifyLease, type LeasePayload } from './lease.js';
import { getEntitlements, readLeaseRow, saveLeaseToken } from './entitlements.js';

/** Instances revalidate roughly daily; the lease itself is valid for ~7 days. */
export const VALIDATE_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** After an outage, retry sooner than the daily cadence. */
const OUTAGE_RETRY_MS = 60 * 60 * 1000;

export type RefreshResult =
  | { outcome: 'refreshed'; lease: LeasePayload }
  | {
      outcome: 'invalid_key' | 'not_found' | 'inactive' | 'in_use' | 'bad_lease' | 'outage';
      message: string;
      /** True while a previously cached lease still grants paid limits. */
      cachedLeaseActive: boolean;
    };

/**
 * Stable random id per install, persisted next to the database. Not a secret;
 * it lets the license server spot one key shared across many instances.
 */
export function loadInstanceId(dataDir: string): string {
  const file = path.join(dataDir, 'instance.id');
  if (existsSync(file)) {
    const id = readFileSync(file, 'utf8').trim();
    if (id) return id;
  }
  const id = randomBytes(16).toString('hex');
  writeFileSync(file, id + '\n');
  return id;
}

export interface RefreshOptions {
  licenseKey: string;
  serverUrl: string;
  dataDir: string;
  fetchImpl?: typeof fetch;
}

/**
 * Validate the license with the server and cache the returned lease. Every
 * failure keeps the existing cached lease, per the contract: an outage or a
 * lapsed subscription degrades to free-tier limits only once the cached lease
 * expires, and never interrupts a running server.
 */
export async function refreshLicense(db: FluxmailDb, opts: RefreshOptions): Promise<RefreshResult> {
  const result = await validateLicense({
    serverUrl: opts.serverUrl,
    licenseKey: opts.licenseKey,
    instanceId: loadInstanceId(opts.dataDir),
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
  const cachedLeaseActive = () => getEntitlements(db).licensed;

  switch (result.kind) {
    case 'valid': {
      let lease: LeasePayload;
      try {
        lease = verifyLease(result.lease, licensePublicKeys());
      } catch (err) {
        return {
          outcome: 'bad_lease',
          message:
            `The license server returned a lease this build cannot verify ` +
            `(${err instanceof Error ? err.message : String(err)}). ` +
            'Update Fluxmail if a signing-key rotation was announced.',
          cachedLeaseActive: cachedLeaseActive(),
        };
      }
      saveLeaseToken(db, result.lease);
      return { outcome: 'refreshed', lease };
    }
    case 'invalid_request':
      return {
        outcome: 'invalid_key',
        message: 'The license server rejected the key as malformed; check FLUXMAIL_LICENSE_KEY.',
        cachedLeaseActive: cachedLeaseActive(),
      };
    case 'license_not_found':
      return {
        outcome: 'not_found',
        message: 'The license key is invalid; check it for typos.',
        cachedLeaseActive: cachedLeaseActive(),
      };
    case 'license_inactive':
      return {
        outcome: 'inactive',
        message: `The license is no longer active (${result.status}).`,
        cachedLeaseActive: cachedLeaseActive(),
      };
    case 'license_in_use':
      return {
        outcome: 'in_use',
        message:
          'This license is already active on another Fluxmail instance. ' +
          'Run "fluxmail license deactivate" there first, or manage instances from your Fluxmail account.',
        cachedLeaseActive: cachedLeaseActive(),
      };
    case 'outage':
      return {
        outcome: 'outage',
        message: `Could not reach the license server (${result.detail}); will retry.`,
        cachedLeaseActive: cachedLeaseActive(),
      };
  }
}

/**
 * Background revalidation for long-running server modes: refresh immediately
 * if the last validation is over a day old, then keep a daily cadence. Timers
 * are unref'd and every failure path is caught, so licensing can never keep
 * the process alive or take it down. Returns a stop function.
 */
export function startLicenseRefresher(deps: {
  db: FluxmailDb;
  config: FluxmailConfig;
  log?: (line: string) => void;
  /** Notify long-lived services that renewed entitlements are available. */
  onRefreshed?: () => void;
}): () => void {
  const { db, config } = deps;
  const log = deps.log ?? (() => {});
  const licenseKey = config.licenseKey;
  if (!licenseKey) return () => {};

  let timer: NodeJS.Timeout | undefined;
  let stopped = false;

  const schedule = (delayMs: number): void => {
    if (stopped) return;
    timer = setTimeout(() => void run(), delayMs);
    timer.unref();
  };

  const run = async (): Promise<void> => {
    let result: RefreshResult;
    try {
      result = await refreshLicense(db, {
        licenseKey,
        serverUrl: config.licenseServerUrl,
        dataDir: config.dataDir,
      });
    } catch (err) {
      log(`License refresh failed: ${err instanceof Error ? err.message : String(err)}`);
      schedule(OUTAGE_RETRY_MS);
      return;
    }
    if (result.outcome === 'refreshed') {
      log(`License validated; lease renewed until ${result.lease.expiresAt}`);
      deps.onRefreshed?.();
      schedule(VALIDATE_INTERVAL_MS);
    } else {
      log(
        `License validation: ${result.message}` +
          (result.cachedLeaseActive
            ? ' The cached lease keeps paid limits for now.'
            : ' Running with Personal-plan limits.'),
      );
      schedule(result.outcome === 'outage' ? OUTAGE_RETRY_MS : VALIDATE_INTERVAL_MS);
    }
  };

  const row = readLeaseRow(db);
  const sinceLastValidation = row ? Date.now() - row.updatedAt : Number.POSITIVE_INFINITY;
  if (sinceLastValidation >= VALIDATE_INTERVAL_MS) void run();
  else schedule(VALIDATE_INTERVAL_MS - sinceLastValidation);

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
