import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EmailError } from '@fluxmail/core';
import { accounts, openDb, type FluxmailDb } from '../src/storage/db.js';
import {
  cancelScheduledSend,
  createScheduledSend,
  getScheduledSend,
  listPending,
} from '../src/storage/scheduledSends.js';
import { SendScheduler } from '../src/scheduler/sendScheduler.js';

function testDb(): FluxmailDb {
  const db = openDb(':memory:');
  db.insert(accounts)
    .values({ id: 'acct_1', provider: 'gmail', email: 'me@example.com', status: 'active', createdAt: Date.now() })
    .run();
  return db;
}

/** Let the scheduler's fire-and-forget tick() promises settle. */
async function settle() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe('SendScheduler', () => {
  let db: FluxmailDb;
  let send: ReturnType<typeof vi.fn>;
  let enforceQuota: ReturnType<typeof vi.fn>;
  let scheduler: SendScheduler;

  beforeEach(() => {
    vi.useFakeTimers();
    db = testDb();
    send = vi.fn().mockResolvedValue({ id: 'sent_1', threadId: 'thread_1' });
    enforceQuota = vi.fn().mockReturnValue(undefined);
    scheduler = new SendScheduler(db, { send, enforceQuota });
  });

  afterEach(() => {
    scheduler.stop();
    vi.useRealTimers();
  });

  it('fires past-due schedules immediately on start (catch-up)', async () => {
    const row = createScheduledSend(db, { accountId: 'acct_1', draftId: 'draft_1', sendAt: Date.now() - 60_000 });
    scheduler.start();
    await settle();

    expect(send).toHaveBeenCalledWith('acct_1', { draftId: 'draft_1' });
    expect(getScheduledSend(db, row.id)).toMatchObject({ status: 'sent', sentMessageId: 'sent_1' });
  });

  it('restores and sends a pending row after the database is reopened', async () => {
    scheduler.stop();
    const dbPath = path.join(mkdtempSync(path.join(tmpdir(), 'fluxmail-scheduler-restart-')), 'fluxmail.db');
    const first = openDb(dbPath);
    first
      .insert(accounts)
      .values({
        id: 'acct_restart',
        provider: 'imap',
        email: 'me@example.com',
        status: 'active',
        createdAt: Date.now(),
      })
      .run();
    const row = createScheduledSend(first, {
      accountId: 'acct_restart',
      draftId: 'draft_restart',
      sendAt: Date.now() - 1_000,
    });
    (first as unknown as { $client: { close(): void } }).$client.close();

    const reopened = openDb(dbPath);
    scheduler = new SendScheduler(reopened, { send, enforceQuota });
    scheduler.start();
    await settle();

    expect(send).toHaveBeenCalledWith('acct_restart', { draftId: 'draft_restart' });
    expect(getScheduledSend(reopened, row.id)).toMatchObject({ status: 'sent', sentMessageId: 'sent_1' });
    scheduler.stop();
    (reopened as unknown as { $client: { close(): void } }).$client.close();
  });

  it('fires a future schedule only when its time comes', async () => {
    createScheduledSend(db, { accountId: 'acct_1', draftId: 'draft_1', sendAt: Date.now() + 60_000 });
    scheduler.start();
    await settle();
    expect(send).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(61_000);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('fires multiple due schedules in send_at order', async () => {
    const now = Date.now();
    createScheduledSend(db, { accountId: 'acct_1', draftId: 'draft_b', sendAt: now - 1_000 });
    createScheduledSend(db, { accountId: 'acct_1', draftId: 'draft_a', sendAt: now - 5_000 });
    scheduler.start();
    await settle();

    expect(send.mock.calls.map((c) => c[1].draftId)).toEqual(['draft_a', 'draft_b']);
  });

  it('wakes up for a newly scheduled earlier send', async () => {
    createScheduledSend(db, { accountId: 'acct_1', draftId: 'draft_far', sendAt: Date.now() + 3_600_000 });
    scheduler.start();
    await settle();

    createScheduledSend(db, { accountId: 'acct_1', draftId: 'draft_soon', sendAt: Date.now() + 10_000 });
    scheduler.wake();
    await settle();
    await vi.advanceTimersByTimeAsync(11_000);

    expect(send.mock.calls.map((c) => c[1].draftId)).toEqual(['draft_soon']);
  });

  it('does not fire a schedule canceled before its time', async () => {
    const row = createScheduledSend(db, { accountId: 'acct_1', draftId: 'draft_1', sendAt: Date.now() + 60_000 });
    scheduler.start();
    await settle();

    cancelScheduledSend(db, row.id);
    scheduler.wake();
    await vi.advanceTimersByTimeAsync(120_000);

    expect(send).not.toHaveBeenCalled();
  });

  it('does not fire a schedule canceled while an earlier send in the same tick is in flight', async () => {
    const now = Date.now();
    let releaseFirst!: (result: { id: string; threadId: string }) => void;
    send.mockImplementationOnce(() => new Promise((resolve) => (releaseFirst = resolve)));
    createScheduledSend(db, { accountId: 'acct_1', draftId: 'draft_a', sendAt: now - 5_000 });
    const rowB = createScheduledSend(db, { accountId: 'acct_1', draftId: 'draft_b', sendAt: now - 1_000 });
    scheduler.start();
    await settle();

    // draft_a's send is still awaiting the provider; cancel draft_b's schedule.
    cancelScheduledSend(db, rowB.id);
    releaseFirst({ id: 'sent_1', threadId: 'thread_1' });
    await settle();

    expect(send.mock.calls.map((c) => c[1].draftId)).toEqual(['draft_a']);
    expect(getScheduledSend(db, rowB.id)).toMatchObject({ status: 'canceled' });
  });

  it('rejects cancellation after a send has been claimed', async () => {
    let release!: (result: { id: string; threadId: string }) => void;
    send.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
    const row = createScheduledSend(db, {
      accountId: 'acct_1',
      draftId: 'draft_1',
      sendAt: Date.now() - 1_000,
    });
    scheduler.start();
    await settle();

    expect(cancelScheduledSend(db, row.id)).toBe(false);
    expect(getScheduledSend(db, row.id)).toMatchObject({ status: 'sending' });

    release({ id: 'sent_1', threadId: 'thread_1' });
    await settle();
    expect(getScheduledSend(db, row.id)).toMatchObject({ status: 'sent' });
  });

  it('allows only one scheduler to claim a due send', async () => {
    let release!: (result: { id: string; threadId: string }) => void;
    send.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
    createScheduledSend(db, { accountId: 'acct_1', draftId: 'draft_1', sendAt: Date.now() - 1_000 });
    const competingScheduler = new SendScheduler(db, { send, enforceQuota });

    scheduler.start();
    competingScheduler.start();
    await settle();
    expect(send).toHaveBeenCalledTimes(1);

    release({ id: 'sent_1', threadId: 'thread_1' });
    await settle();
    competingScheduler.stop();
  });

  it('marks permanent failures failed with a human-readable reason and stops retrying', async () => {
    send.mockRejectedValue(new EmailError('not_found', 'Requested entity was not found'));
    const row = createScheduledSend(db, { accountId: 'acct_1', draftId: 'draft_1', sendAt: Date.now() - 1_000 });
    scheduler.start();
    await settle();

    expect(getScheduledSend(db, row.id)).toMatchObject({
      status: 'failed',
      lastError: 'Draft no longer exists: it was sent or deleted outside Fluxmail',
    });
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('retries transient failures with backoff until they succeed', async () => {
    send.mockRejectedValueOnce(new EmailError('auth_expired', 'token expired'));
    const row = createScheduledSend(db, { accountId: 'acct_1', draftId: 'draft_1', sendAt: Date.now() - 1_000 });
    scheduler.start();
    await settle();

    expect(getScheduledSend(db, row.id)).toMatchObject({ status: 'pending', attempts: 1, lastError: 'token expired' });

    await vi.advanceTimersByTimeAsync(31_000); // past the 30s first backoff
    expect(send).toHaveBeenCalledTimes(2);
    expect(getScheduledSend(db, row.id)).toMatchObject({ status: 'sent' });
  });

  it('does not retry a delivered message that returns a Sent-copy warning', async () => {
    send.mockResolvedValue({
      id: 'smtp_delivery',
      threadId: 'thread_delivery',
      warnings: ['Message delivered, but Fluxmail could not save the Sent copy.'],
    });
    const row = createScheduledSend(db, {
      accountId: 'acct_1',
      draftId: 'draft_1',
      sendAt: Date.now() - 1_000,
    });
    scheduler.start();
    await settle();

    expect(getScheduledSend(db, row.id)).toMatchObject({ status: 'sent', sentMessageId: 'smtp_delivery' });
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('arms no timer when nothing is pending', async () => {
    scheduler.start();
    await settle();
    expect(vi.getTimerCount()).toBe(0);
    expect(listPending(db)).toHaveLength(0);
  });

  it('holds due sends while over the plan quota and resumes once it clears', async () => {
    enforceQuota.mockImplementation(() => {
      throw new EmailError('entitlement_exceeded', 'over the plan quota');
    });
    const row = createScheduledSend(db, { accountId: 'acct_1', draftId: 'draft_1', sendAt: Date.now() - 1_000 });
    scheduler.start();
    await settle();

    // Held: still pending, no attempt consumed, the reason recorded.
    expect(send).not.toHaveBeenCalled();
    expect(getScheduledSend(db, row.id)).toMatchObject({
      status: 'pending',
      attempts: 0,
      lastError: 'over the plan quota',
    });

    // License renewed (or usage trimmed): the next re-check sends it.
    enforceQuota.mockReturnValue(undefined);
    await vi.advanceTimersByTimeAsync(15 * 60_000 + 1_000);
    expect(send).toHaveBeenCalledTimes(1);
    expect(getScheduledSend(db, row.id)).toMatchObject({ status: 'sent' });
  });

  it('rechecks held sends immediately when woken after a license refresh', async () => {
    enforceQuota.mockImplementation(() => {
      throw new EmailError('entitlement_exceeded', 'over the plan quota');
    });
    createScheduledSend(db, { accountId: 'acct_1', draftId: 'draft_1', sendAt: Date.now() - 1_000 });
    scheduler.start();
    await settle();
    expect(send).not.toHaveBeenCalled();

    enforceQuota.mockReturnValue(undefined);
    scheduler.wake();
    await settle();

    expect(send).toHaveBeenCalledTimes(1);
  });
});
