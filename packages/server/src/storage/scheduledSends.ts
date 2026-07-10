import { randomBytes } from 'node:crypto';
import { and, eq, lte, or } from 'drizzle-orm';
import { EmailError } from '@fluxmail/core';
import { scheduledSends, type FluxmailDb } from './db.js';

export type ScheduledSendStatus = 'pending' | 'sending' | 'sent' | 'failed' | 'canceled';

export interface ScheduledSendRow {
  id: string;
  accountId: string;
  draftId: string;
  /** Epoch milliseconds. */
  sendAt: number;
  createdAt: number;
  status: ScheduledSendStatus;
  attempts: number;
  lastError: string | null;
  sentMessageId: string | null;
  sentThreadId: string | null;
  subject: string | null;
  toRecipients: string | null;
  claimToken: string | null;
  claimUntil: number | null;
}

type Row = typeof scheduledSends.$inferSelect;

function toRow(r: Row): ScheduledSendRow {
  return { ...r, status: r.status as ScheduledSendStatus };
}

export function createScheduledSend(
  db: FluxmailDb,
  input: { accountId: string; draftId: string; sendAt: number; subject?: string; toRecipients?: string }
): ScheduledSendRow {
  const id = `sch_${randomBytes(6).toString('hex')}`;
  const createdAt = Date.now();
  return db.transaction((tx) => {
    const existing = tx
      .select()
      .from(scheduledSends)
      .where(
        and(
          eq(scheduledSends.accountId, input.accountId),
          eq(scheduledSends.draftId, input.draftId),
          eq(scheduledSends.status, 'pending')
        )
      )
      .get();
    if (existing) {
      throw new EmailError(
        'invalid_request',
        `Draft ${input.draftId} is already scheduled to send at ${new Date(existing.sendAt).toISOString()}; cancel it first to reschedule`
      );
    }
    const row = {
      id,
      accountId: input.accountId,
      draftId: input.draftId,
      sendAt: input.sendAt,
      createdAt,
      status: 'pending',
      attempts: 0,
      lastError: null,
      sentMessageId: null,
      sentThreadId: null,
      subject: input.subject ?? null,
      toRecipients: input.toRecipients ?? null,
      claimToken: null,
      claimUntil: null,
    };
    tx.insert(scheduledSends).values(row).run();
    return toRow(row);
  });
}

export function getScheduledSend(db: FluxmailDb, id: string): ScheduledSendRow | undefined {
  const row = db.select().from(scheduledSends).where(eq(scheduledSends.id, id)).get();
  return row ? toRow(row) : undefined;
}

/** All schedules, pending first by due time, then the rest newest-first. */
export function listScheduledSends(db: FluxmailDb, accountId?: string): ScheduledSendRow[] {
  const rows = accountId
    ? db.select().from(scheduledSends).where(eq(scheduledSends.accountId, accountId)).all()
    : db.select().from(scheduledSends).all();
  return rows.map(toRow).sort((a, b) => {
    if ((a.status === 'pending') !== (b.status === 'pending')) return a.status === 'pending' ? -1 : 1;
    return a.status === 'pending' ? a.sendAt - b.sendAt : b.createdAt - a.createdAt;
  });
}

export function listPending(db: FluxmailDb): ScheduledSendRow[] {
  return db.select().from(scheduledSends).where(eq(scheduledSends.status, 'pending')).all().map(toRow);
}

export function listActive(db: FluxmailDb): ScheduledSendRow[] {
  return db
    .select()
    .from(scheduledSends)
    .where(or(eq(scheduledSends.status, 'pending'), eq(scheduledSends.status, 'sending')))
    .all()
    .map(toRow);
}

export function findPendingByDraft(
  db: FluxmailDb,
  accountId: string,
  draftId: string
): ScheduledSendRow | undefined {
  const row = db
    .select()
    .from(scheduledSends)
    .where(
      and(
        eq(scheduledSends.accountId, accountId),
        eq(scheduledSends.draftId, draftId),
        eq(scheduledSends.status, 'pending')
      )
    )
    .get();
  return row ? toRow(row) : undefined;
}

export function markSent(db: FluxmailDb, id: string, result: { id: string; threadId: string }): void {
  db.update(scheduledSends)
    .set({ status: 'sent', sentMessageId: result.id, sentThreadId: result.threadId, lastError: null })
    .where(eq(scheduledSends.id, id))
    .run();
}

/** Atomically claim a due row so only one scheduler process can dispatch it. */
export function claimScheduledSend(
  db: FluxmailDb,
  id: string,
  now: number,
  leaseMs: number
): { row: ScheduledSendRow; token: string } | undefined {
  const token = randomBytes(12).toString('hex');
  const result = db
    .update(scheduledSends)
    .set({ status: 'sending', claimToken: token, claimUntil: now + leaseMs })
    .where(
      and(
        eq(scheduledSends.id, id),
        or(
          eq(scheduledSends.status, 'pending'),
          and(eq(scheduledSends.status, 'sending'), lte(scheduledSends.claimUntil, now))
        )
      )
    )
    .run();
  if (result.changes === 0) return undefined;
  return { row: getScheduledSend(db, id)!, token };
}

export function completeClaim(
  db: FluxmailDb,
  id: string,
  token: string,
  result: { id: string; threadId: string }
): void {
  db.update(scheduledSends)
    .set({
      status: 'sent',
      sentMessageId: result.id,
      sentThreadId: result.threadId,
      lastError: null,
      claimToken: null,
      claimUntil: null,
    })
    .where(and(eq(scheduledSends.id, id), eq(scheduledSends.claimToken, token)))
    .run();
}

export function failClaim(db: FluxmailDb, id: string, token: string, error: string): void {
  db.update(scheduledSends)
    .set({ status: 'failed', lastError: error, claimToken: null, claimUntil: null })
    .where(and(eq(scheduledSends.id, id), eq(scheduledSends.claimToken, token)))
    .run();
}

export function retryClaim(db: FluxmailDb, id: string, token: string, error: string): void {
  const row = getScheduledSend(db, id);
  if (!row || row.claimToken !== token) return;
  db.update(scheduledSends)
    .set({
      status: 'pending',
      attempts: row.attempts + 1,
      lastError: error,
      claimToken: null,
      claimUntil: null,
    })
    .where(and(eq(scheduledSends.id, id), eq(scheduledSends.claimToken, token)))
    .run();
}

export function listClaimable(db: FluxmailDb, now: number): ScheduledSendRow[] {
  return db
    .select()
    .from(scheduledSends)
    .where(
      or(
        eq(scheduledSends.status, 'pending'),
        and(eq(scheduledSends.status, 'sending'), lte(scheduledSends.claimUntil, now))
      )
    )
    .all()
    .map(toRow);
}

export function markFailed(db: FluxmailDb, id: string, error: string): void {
  db.update(scheduledSends).set({ status: 'failed', lastError: error }).where(eq(scheduledSends.id, id)).run();
}

/** Record a retryable failure: bump attempts, keep the row pending. */
export function recordAttempt(db: FluxmailDb, id: string, error: string): void {
  const row = db.select().from(scheduledSends).where(eq(scheduledSends.id, id)).get();
  if (!row) return;
  db.update(scheduledSends)
    .set({ attempts: row.attempts + 1, lastError: error })
    .where(eq(scheduledSends.id, id))
    .run();
}

/** Only pending schedules can be canceled; returns false otherwise. */
export function cancelScheduledSend(db: FluxmailDb, id: string): boolean {
  const result = db
    .update(scheduledSends)
    .set({ status: 'canceled' })
    .where(and(eq(scheduledSends.id, id), eq(scheduledSends.status, 'pending')))
    .run();
  return result.changes > 0;
}

export function countPending(db: FluxmailDb): { pending: number; nextSendAt?: number } {
  const rows = listActive(db);
  if (!rows.length) return { pending: 0 };
  return { pending: rows.length, nextSendAt: Math.min(...rows.map((r) => r.sendAt)) };
}
