import { randomBytes } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { EmailError } from '@fluxmail/core';
import { accounts, apiKeys, members, type FluxmailDb } from './db.js';
import { assertMemberLimit, getEntitlements } from '../licensing/entitlements.js';

export interface MemberInfo {
  id: string;
  name: string;
  email: string | null;
  role: MemberRole;
  createdAt: number;
  /** Mailboxes owned by this member (shared mailboxes are not counted). */
  accountCount: number;
  apiKeyCount: number;
}

export type MemberRole = 'admin' | 'member';

type MemberRow = typeof members.$inferSelect;

function toInfo(db: FluxmailDb, row: MemberRow): MemberInfo {
  return {
    ...row,
    role: row.role as MemberRole,
    accountCount: db.select().from(accounts).where(eq(accounts.memberId, row.id)).all().length,
    apiKeyCount: db.select().from(apiKeys).where(eq(apiKeys.memberId, row.id)).all().length,
  };
}

export function addMember(db: FluxmailDb, input: { name: string; email?: string; role?: MemberRole }): MemberInfo {
  const name = input.name.trim();
  if (!name) throw new EmailError('invalid_request', 'Member name cannot be empty');
  const email = input.email?.trim().toLowerCase();
  const id = `member_${randomBytes(6).toString('hex')}`;
  db.transaction((tx) => {
    if (
      email &&
      tx
        .select()
        .from(members)
        .where(sql`lower(${members.email}) = ${email}`)
        .get()
    ) {
      throw new EmailError('invalid_request', `A member with email ${email} already exists`);
    }
    const memberCount = tx.select().from(members).all().length;
    assertMemberLimit(memberCount, getEntitlements(tx));
    const role = input.role ?? (memberCount === 0 ? 'admin' : 'member');
    tx.insert(members)
      .values({ id, name, email: email ?? null, role, createdAt: Date.now() })
      .run();
    if (memberCount === 0) {
      tx.update(accounts)
        .set({ memberId: id })
        .where(sql`${accounts.memberId} IS NULL`)
        .run();
    }
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
  const email = ref.trim().toLowerCase();
  const byEmail = db
    .select()
    .from(members)
    .where(sql`lower(${members.email}) = ${email}`)
    .get();
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

export function setMemberRole(db: FluxmailDb, ref: string, role: MemberRole): MemberInfo {
  const member = findMember(db, ref);
  db.update(members).set({ role }).where(eq(members.id, member.id)).run();
  return getMember(db, member.id);
}

/**
 * Delete a member after every mailbox they own has been reassigned or removed.
 * Their API keys and selected sharing grants are deleted by the transaction and
 * foreign-key cascades.
 */
export function removeMember(db: FluxmailDb, id: string): { name: string; revokedApiKeys: number } {
  const info = getMember(db, id);
  if (info.accountCount > 0) {
    throw new EmailError(
      'invalid_request',
      `${info.name} still owns ${info.accountCount} mailbox${info.accountCount === 1 ? '' : 'es'}. Reassign or remove ${
        info.accountCount === 1 ? 'it' : 'them'
      } first.`,
    );
  }
  db.transaction((tx) => {
    tx.delete(apiKeys).where(eq(apiKeys.memberId, id)).run();
    tx.delete(members).where(eq(members.id, id)).run();
  });
  return { name: info.name, revokedApiKeys: info.apiKeyCount };
}
