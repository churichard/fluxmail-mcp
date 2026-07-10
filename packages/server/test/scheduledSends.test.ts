import { describe, expect, it } from 'vitest';
import { EmailError } from '@fluxmail/core';
import { accounts, openDb, type FluxmailDb } from '../src/storage/db.js';
import {
  cancelScheduledSend,
  countPending,
  createScheduledSend,
  findPendingByDraft,
  getScheduledSend,
  listPending,
  listScheduledSends,
  markFailed,
  markSent,
  recordAttempt,
} from '../src/storage/scheduledSends.js';
import { eq } from 'drizzle-orm';

function testDb(): FluxmailDb {
  const db = openDb(':memory:');
  db.insert(accounts)
    .values({ id: 'acct_1', provider: 'gmail', email: 'me@example.com', status: 'active', createdAt: Date.now() })
    .run();
  return db;
}

describe('scheduled sends storage', () => {
  it('creates and reads back a schedule', () => {
    const db = testDb();
    const row = createScheduledSend(db, {
      accountId: 'acct_1',
      draftId: 'draft_1',
      sendAt: 1234,
      subject: 'Hi',
      toRecipients: 'bob@example.com',
    });
    expect(row.id).toMatch(/^sch_/);
    expect(row.status).toBe('pending');
    expect(getScheduledSend(db, row.id)).toEqual(row);
    expect(findPendingByDraft(db, 'acct_1', 'draft_1')).toEqual(row);
    expect(findPendingByDraft(db, 'acct_1', 'draft_other')).toBeUndefined();
  });

  it('rejects a second pending schedule for the same draft', () => {
    const db = testDb();
    createScheduledSend(db, { accountId: 'acct_1', draftId: 'draft_1', sendAt: 1234 });
    expect(() => createScheduledSend(db, { accountId: 'acct_1', draftId: 'draft_1', sendAt: 5678 })).toThrow(
      EmailError
    );
  });

  it('allows rescheduling a draft after its schedule is canceled', () => {
    const db = testDb();
    const first = createScheduledSend(db, { accountId: 'acct_1', draftId: 'draft_1', sendAt: 1234 });
    expect(cancelScheduledSend(db, first.id)).toBe(true);
    expect(cancelScheduledSend(db, first.id)).toBe(false); // already canceled
    const second = createScheduledSend(db, { accountId: 'acct_1', draftId: 'draft_1', sendAt: 5678 });
    expect(second.id).not.toBe(first.id);
  });

  it('lists pending first by due time, then others newest-first', () => {
    const db = testDb();
    const late = createScheduledSend(db, { accountId: 'acct_1', draftId: 'd_late', sendAt: 9999 });
    const early = createScheduledSend(db, { accountId: 'acct_1', draftId: 'd_early', sendAt: 1111 });
    const done = createScheduledSend(db, { accountId: 'acct_1', draftId: 'd_done', sendAt: 2222 });
    markSent(db, done.id, { id: 'm1', threadId: 't1' });

    const listed = listScheduledSends(db);
    expect(listed.map((r) => r.id)).toEqual([early.id, late.id, done.id]);
    expect(listPending(db).map((r) => r.id).sort()).toEqual([early.id, late.id].sort());
    expect(listScheduledSends(db, 'acct_other')).toHaveLength(0);
  });

  it('tracks sent, failed, and retry attempts', () => {
    const db = testDb();
    const row = createScheduledSend(db, { accountId: 'acct_1', draftId: 'draft_1', sendAt: 1234 });

    recordAttempt(db, row.id, 'rate limited');
    recordAttempt(db, row.id, 'still rate limited');
    let current = getScheduledSend(db, row.id)!;
    expect(current).toMatchObject({ status: 'pending', attempts: 2, lastError: 'still rate limited' });

    markSent(db, row.id, { id: 'm1', threadId: 't1' });
    current = getScheduledSend(db, row.id)!;
    expect(current).toMatchObject({ status: 'sent', sentMessageId: 'm1', sentThreadId: 't1', lastError: null });
    expect(cancelScheduledSend(db, row.id)).toBe(false); // sent rows cannot be canceled

    const failing = createScheduledSend(db, { accountId: 'acct_1', draftId: 'draft_2', sendAt: 1234 });
    markFailed(db, failing.id, 'draft gone');
    expect(getScheduledSend(db, failing.id)).toMatchObject({ status: 'failed', lastError: 'draft gone' });
  });

  it('counts pending and reports the next due time', () => {
    const db = testDb();
    expect(countPending(db)).toEqual({ pending: 0 });
    createScheduledSend(db, { accountId: 'acct_1', draftId: 'd1', sendAt: 500 });
    createScheduledSend(db, { accountId: 'acct_1', draftId: 'd2', sendAt: 200 });
    expect(countPending(db)).toEqual({ pending: 2, nextSendAt: 200 });
  });

  it('cascades deletion with the account', () => {
    const db = testDb();
    createScheduledSend(db, { accountId: 'acct_1', draftId: 'draft_1', sendAt: 1234 });
    db.delete(accounts).where(eq(accounts.id, 'acct_1')).run();
    expect(listScheduledSends(db)).toHaveLength(0);
  });
});
