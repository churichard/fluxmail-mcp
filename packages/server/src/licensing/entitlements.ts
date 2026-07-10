import { EmailError } from '@fluxmail/core';
import { eq } from 'drizzle-orm';
import { licenseLease, type FluxmailDb } from '../storage/db.js';
import { licensePublicKeys, verifyLease } from './lease.js';

export interface Entitlements {
  maxAccounts: number;
  tier: 'free' | 'paid';
  /** Paid tier only: when the cached lease lapses back to free-tier limits unless renewed. */
  leaseExpiresAt?: string;
}

export const FREE_TIER: Entitlements = {
  maxAccounts: 1,
  tier: 'free',
};

const LEASE_ROW_ID = 'current';

/** Accepts a transaction as well as the root db, like the other storage helpers. */
type DbReader = Pick<FluxmailDb, 'select'>;

export function readLeaseRow(db: DbReader): { token: string; updatedAt: number } | undefined {
  const row = db.select().from(licenseLease).where(eq(licenseLease.id, LEASE_ROW_ID)).get();
  return row ? { token: row.token, updatedAt: row.updatedAt } : undefined;
}

export function saveLeaseToken(db: Pick<FluxmailDb, 'insert'>, token: string): void {
  const updatedAt = Date.now();
  db.insert(licenseLease)
    .values({ id: LEASE_ROW_ID, token, updatedAt })
    .onConflictDoUpdate({ target: licenseLease.id, set: { token, updatedAt } })
    .run();
}

export function clearLease(db: Pick<FluxmailDb, 'delete'>): void {
  db.delete(licenseLease).where(eq(licenseLease.id, LEASE_ROW_ID)).run();
}

/**
 * Effective entitlements: paid limits while the cached lease verifies against
 * a pinned license-server key and has not expired, free-tier limits otherwise.
 * Reads only local state; enforcement never waits on the network.
 */
export function getEntitlements(db: DbReader): Entitlements {
  const row = readLeaseRow(db);
  if (!row) return FREE_TIER;
  try {
    const lease = verifyLease(row.token, licensePublicKeys());
    return {
      maxAccounts: lease.maxAccounts,
      tier: 'paid',
      leaseExpiresAt: lease.expiresAt,
    };
  } catch {
    // Expired or unverifiable lease: degrade to free-tier limits, never block.
    return FREE_TIER;
  }
}

export function assertAccountLimit(current: number, entitlements: Entitlements): void {
  const max = entitlements.maxAccounts;
  if (current < max) return;
  const noun = `account${max === 1 ? '' : 's'}`;
  throw new EmailError(
    'entitlement_exceeded',
    entitlements.tier === 'free'
      ? `The free tier allows ${max} ${noun} (currently ${current}). ` +
        'A paid Fluxmail subscription unlocks more; see the README for details.'
      : `Your license allows ${max} ${noun} (currently ${current}). Upgrade your plan to add more.`
  );
}
