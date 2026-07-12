import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { EmailError } from '@fluxmail/core';
import { accounts, apiKeys, members, type FluxmailDb } from './db.js';
import { assertMemberLimit, getEntitlements } from '../licensing/entitlements.js';

export interface MemberInfo {
  id: string;
  name: string;
  email: string | null;
  createdAt: number;
  /** Mailboxes owned by this member (shared mailboxes are not counted). */
  accountCount: number;
  apiKeyCount: number;
}

type MemberRow = typeof members.$inferSelect;

function toInfo(db: FluxmailDb, row: MemberRow): MemberInfo {
  return {
    ...row,
    accountCount: db.select().from(accounts).where(eq(accounts.memberId, row.id)).all().length,
    apiKeyCount: db.select().from(apiKeys).where(eq(apiKeys.memberId, row.id)).all().length,
  };
}

export function addMember(db: FluxmailDb, input: { name: string; email?: string }): MemberInfo {
  const name = input.name.trim();
  if (!name) throw new EmailError('invalid_request', 'Member name cannot be empty');
  const email = input.email?.trim().toLowerCase();
  const id = `member_${randomBytes(6).toString('hex')}`;
  db.transaction((tx) => {
    if (email && tx.select().from(members).where(eq(members.email, email)).get()) {
      throw new EmailError('invalid_request', `A member with email ${email} already exists`);
    }
    const memberCount = tx.select().from(members).all().length;
    assertMemberLimit(memberCount, getEntitlements(tx));
    tx.insert(members)
      .values({ id, name, email: email ?? null, createdAt: Date.now() })
      .run();
  });
  return getMember(db, id);
}

export function getMember(db: FluxmailDb, id: string): MemberInfo {
  const row = db.select().from(members).where(eq(members.id, id)).get();
  if (!row) throw new EmailError('not_found', `No member with id "${id}"`);
  return toInfo(db, row);
}

/** Resolve a member by id or email, for CLI --member flags. */
export function findMember(db: FluxmailDb, ref: string): MemberInfo {
  const byId = db.select().from(members).where(eq(members.id, ref)).get();
  if (byId) return toInfo(db, byId);
  const byEmail = db.select().from(members).where(eq(members.email, ref.trim().toLowerCase())).get();
  if (byEmail) return toInfo(db, byEmail);
  throw new EmailError('not_found', `No member with id or email "${ref}". Run "fluxmail members list" to see members.`);
}

export function listMembers(db: FluxmailDb): MemberInfo[] {
  return db
    .select()
    .from(members)
    .all()
    .map((row) => toInfo(db, row));
}

/**
 * Delete a member. Their mailboxes become shared (member_id is set to NULL by
 * the foreign key), and their API keys are revoked: a key must never outlive
 * the member scoping it, or it would fall back to unscoped admin access.
 */
export function removeMember(
  db: FluxmailDb,
  id: string,
): { name: string; freedAccounts: number; revokedApiKeys: number } {
  const info = getMember(db, id);
  db.transaction((tx) => {
    tx.delete(apiKeys).where(eq(apiKeys.memberId, id)).run();
    tx.delete(members).where(eq(members.id, id)).run();
  });
  return { name: info.name, freedAccounts: info.accountCount, revokedApiKeys: info.apiKeyCount };
}
