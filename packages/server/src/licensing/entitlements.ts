import { EmailError } from '@fluxmail/core';
import { eq } from 'drizzle-orm';
import { accounts, licenseLease, members, type FluxmailDb } from '../storage/db.js';
import { licensePublicKeys, verifyLease } from './lease.js';

/** After a lease expires, paid limits are honored this much longer before the plan lapses. */
export const GRACE_PERIOD_MS = 21 * 24 * 60 * 60 * 1000;

export interface Entitlements {
  /** 'personal' when unlicensed, otherwise the plan name from the signed lease. */
  plan: string;
  /** True while a lease grants paid limits (including the grace period). */
  licensed: boolean;
  /** True when the lease has expired but the grace period is still running. */
  inGrace: boolean;
  maxMembers: number;
  maxAccounts: number;
  /** Licensed only: when the lease expires (or expired) and the grace period starts. */
  leaseExpiresAt?: string;
  /** In grace only: when paid limits lapse to the Personal plan unless renewed. */
  graceUntil?: string;
}

export const PERSONAL_TIER: Entitlements = {
  plan: 'personal',
  licensed: false,
  inGrace: false,
  maxMembers: 1,
  maxAccounts: 3,
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
 * Effective entitlements: the plan and caps from the cached lease while it
 * verifies against a pinned license-server key, Personal-plan limits otherwise.
 * An expired lease keeps its paid limits through the grace period, so a
 * renewal hiccup never interrupts a running server. Reads only local state;
 * enforcement never waits on the network.
 */
export function getEntitlements(db: DbReader, now = new Date()): Entitlements {
  const row = readLeaseRow(db);
  if (!row) return PERSONAL_TIER;
  try {
    const lease = verifyLease(row.token, licensePublicKeys(), now, { allowExpired: true });
    const expiresAt = Date.parse(lease.expiresAt);
    const graceUntil = expiresAt + GRACE_PERIOD_MS;
    if (now.getTime() >= graceUntil) return PERSONAL_TIER;
    const inGrace = now.getTime() >= expiresAt;
    return {
      plan: lease.plan,
      licensed: true,
      inGrace,
      maxMembers: lease.maxMembers,
      maxAccounts: lease.maxAccounts,
      leaseExpiresAt: lease.expiresAt,
      ...(inGrace ? { graceUntil: new Date(graceUntil).toISOString() } : {}),
    };
  } catch {
    // Unverifiable lease: degrade to Personal-plan limits, never block.
    return PERSONAL_TIER;
  }
}

function assertLimit(kind: 'mailbox' | 'member', current: number, max: number, ent: Entitlements): void {
  if (current < max) return;
  const noun = `${kind === 'mailbox' ? 'connected mailbox' : 'member'}${max === 1 ? '' : kind === 'mailbox' ? 'es' : 's'}`;
  throw new EmailError(
    'entitlement_exceeded',
    ent.licensed
      ? `Your ${ent.plan} plan allows ${max} ${noun} (currently ${current}). Upgrade your plan to add more.`
      : `The Personal plan allows ${max} ${noun} (currently ${current}). ` +
          'A Fluxmail subscription unlocks more; see the README for details.',
  );
}

export function assertAccountLimit(current: number, entitlements: Entitlements): void {
  assertLimit('mailbox', current, entitlements.maxAccounts, entitlements);
}

export function assertMemberLimit(current: number, entitlements: Entitlements): void {
  assertLimit('member', current, entitlements.maxMembers, entitlements);
}

export interface LicenseState {
  entitlements: Entitlements;
  accountCount: number;
  memberCount: number;
  /** Usage exceeds the entitled caps; only possible after a paid license lapsed. */
  overQuota: boolean;
  /** Renewal warning while in grace or after a lapse; undefined when all is well. */
  warning?: string;
}

/** Entitlements plus current usage, for quota enforcement and renewal warnings. */
export function checkLicenseState(db: DbReader, now = new Date()): LicenseState {
  const entitlements = getEntitlements(db, now);
  const accountCount = db.select().from(accounts).all().length;
  const memberCount = db.select().from(members).all().length;
  const overQuota = accountCount > entitlements.maxAccounts || memberCount > entitlements.maxMembers;

  let warning: string | undefined;
  if (entitlements.inGrace) {
    warning =
      `The Fluxmail license expired ${entitlements.leaseExpiresAt}; paid limits continue until ` +
      `${entitlements.graceUntil}. Renew before then or this instance drops to the Personal plan.`;
  } else if (!entitlements.licensed && readLeaseRow(db)) {
    warning =
      `The Fluxmail license has lapsed; this instance is on the Personal plan ` +
      `(${entitlements.maxAccounts} mailboxes, ${entitlements.maxMembers} member).` +
      (overQuota
        ? ` Current usage (${accountCount} mailboxes, ${memberCount} members) exceeds that, so email tools are ` +
          'blocked until you renew the license or remove mailboxes/members to fit.'
        : '');
  }
  return { entitlements, accountCount, memberCount, overQuota, ...(warning ? { warning } : {}) };
}

/**
 * Gate for MCP tool calls: throws once a lapsed license leaves the instance
 * over the entitled caps. Returns the current state so callers can surface
 * grace warnings without a second read.
 */
export function assertWithinQuota(db: DbReader, now = new Date()): LicenseState {
  const state = checkLicenseState(db, now);
  if (state.overQuota) {
    const { entitlements: ent } = state;
    throw new EmailError(
      'entitlement_exceeded',
      `This instance has ${state.accountCount} connected mailboxes and ${state.memberCount} members, but the ` +
        `${ent.plan} plan allows ${ent.maxAccounts} and ${ent.maxMembers}. Renew the license ` +
        '("fluxmail license activate") or remove mailboxes/members ' +
        '("fluxmail accounts remove", "fluxmail members remove") to fit the plan.',
    );
  }
  return state;
}
