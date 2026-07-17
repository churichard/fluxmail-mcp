import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, isNull, lt } from 'drizzle-orm';
import { gmailConnectionGrants, type FluxmailDb } from './db.js';

export const GMAIL_CONNECTION_GRANT_TTL_MS = 10 * 60 * 1000;
const GMAIL_CONNECTION_SCOPE = 'gmail_connect';
const OUTLOOK_CONNECTION_SCOPE = 'outlook_connect';
const RETENTION_MS = 24 * 60 * 60 * 1000;

export interface GmailConnectionIntent {
  ownerMemberId?: string;
  reauthorizeAccountId?: string;
  sharedWithAll?: boolean;
  grantedMemberIds?: string[];
}

export interface GmailConnectionGrant extends GmailConnectionIntent {
  expiresAt: number;
}

export type GmailConnectionClaim =
  | { status: 'claimed'; grant: GmailConnectionGrant }
  | { status: 'invalid' }
  | { status: 'expired' }
  | { status: 'used' };

export type GmailConnectionGrantStatus = 'available' | 'invalid' | 'expired' | 'used';

type ConnectionScope = typeof GMAIL_CONNECTION_SCOPE | typeof OUTLOOK_CONNECTION_SCOPE;

export function gmailConnectionTokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function inspectConnectionGrant(
  db: FluxmailDb,
  token: string,
  scope: ConnectionScope,
  now = Date.now(),
): GmailConnectionGrantStatus {
  const existing = db
    .select()
    .from(gmailConnectionGrants)
    .where(
      and(eq(gmailConnectionGrants.tokenHash, gmailConnectionTokenHash(token)), eq(gmailConnectionGrants.scope, scope)),
    )
    .get();
  if (!existing) return 'invalid';
  if (existing.consumedAt !== null) return 'used';
  return existing.expiresAt > now ? 'available' : 'expired';
}

export function inspectGmailConnectionGrant(
  db: FluxmailDb,
  token: string,
  now = Date.now(),
): GmailConnectionGrantStatus {
  return inspectConnectionGrant(db, token, GMAIL_CONNECTION_SCOPE, now);
}

export function inspectOutlookConnectionGrant(
  db: FluxmailDb,
  token: string,
  now = Date.now(),
): GmailConnectionGrantStatus {
  return inspectConnectionGrant(db, token, OUTLOOK_CONNECTION_SCOPE, now);
}

function createConnectionGrant(
  db: FluxmailDb,
  scope: ConnectionScope,
  intent: GmailConnectionIntent = {},
  now = Date.now(),
): { token: string; expiresAt: number } {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = now + GMAIL_CONNECTION_GRANT_TTL_MS;

  db.delete(gmailConnectionGrants)
    .where(lt(gmailConnectionGrants.expiresAt, now - RETENTION_MS))
    .run();
  db.insert(gmailConnectionGrants)
    .values({
      tokenHash: gmailConnectionTokenHash(token),
      scope,
      ownerMemberId: intent.ownerMemberId ?? null,
      reauthorizeAccountId: intent.reauthorizeAccountId ?? null,
      sharedWithAll: intent.sharedWithAll ?? null,
      grantedMemberIds: intent.grantedMemberIds ? JSON.stringify(intent.grantedMemberIds) : null,
      createdAt: now,
      expiresAt,
      consumedAt: null,
    })
    .run();

  return { token, expiresAt };
}

export function createGmailConnectionGrant(
  db: FluxmailDb,
  intent: GmailConnectionIntent = {},
  now = Date.now(),
): { token: string; expiresAt: number } {
  return createConnectionGrant(db, GMAIL_CONNECTION_SCOPE, intent, now);
}

export function createOutlookConnectionGrant(
  db: FluxmailDb,
  intent: GmailConnectionIntent = {},
  now = Date.now(),
): { token: string; expiresAt: number } {
  return createConnectionGrant(db, OUTLOOK_CONNECTION_SCOPE, intent, now);
}

function claimConnectionGrant(
  db: FluxmailDb,
  token: string,
  scope: ConnectionScope,
  now = Date.now(),
): GmailConnectionClaim {
  const tokenHash = gmailConnectionTokenHash(token);
  const claimed = db
    .update(gmailConnectionGrants)
    .set({ consumedAt: now })
    .where(
      and(
        eq(gmailConnectionGrants.tokenHash, tokenHash),
        eq(gmailConnectionGrants.scope, scope),
        isNull(gmailConnectionGrants.consumedAt),
        gt(gmailConnectionGrants.expiresAt, now),
      ),
    )
    .returning()
    .get();

  if (claimed) {
    return {
      status: 'claimed',
      grant: {
        expiresAt: claimed.expiresAt,
        ...(claimed.ownerMemberId ? { ownerMemberId: claimed.ownerMemberId } : {}),
        ...(claimed.reauthorizeAccountId ? { reauthorizeAccountId: claimed.reauthorizeAccountId } : {}),
        ...(claimed.sharedWithAll !== null ? { sharedWithAll: claimed.sharedWithAll } : {}),
        ...(claimed.grantedMemberIds ? { grantedMemberIds: JSON.parse(claimed.grantedMemberIds) as string[] } : {}),
      },
    };
  }

  const existing = db
    .select()
    .from(gmailConnectionGrants)
    .where(and(eq(gmailConnectionGrants.tokenHash, tokenHash), eq(gmailConnectionGrants.scope, scope)))
    .get();
  if (!existing) return { status: 'invalid' };
  if (existing.consumedAt !== null) return { status: 'used' };
  return { status: 'expired' };
}

export function claimGmailConnectionGrant(db: FluxmailDb, token: string, now = Date.now()): GmailConnectionClaim {
  return claimConnectionGrant(db, token, GMAIL_CONNECTION_SCOPE, now);
}

export function claimOutlookConnectionGrant(db: FluxmailDb, token: string, now = Date.now()): GmailConnectionClaim {
  return claimConnectionGrant(db, token, OUTLOOK_CONNECTION_SCOPE, now);
}
