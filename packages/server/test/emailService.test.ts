import { describe, expect, it, vi } from 'vitest';
import { EmailError, type Message } from '@fluxmail/core';
import { buildForwardBody, EmailService, resolveSendAt } from '../src/service/emailService.js';
import { accounts, openDb, type FluxmailDb } from '../src/storage/db.js';

function testDb(): FluxmailDb {
  const db = openDb(':memory:');
  db.insert(accounts)
    .values({ id: 'acct_1', provider: 'gmail', email: 'me@example.com', status: 'active', createdAt: Date.now() })
    .run();
  return db;
}

const original: Message = {
  id: 'm1',
  threadId: 't1',
  accountId: 'acct_1',
  from: { name: 'Ann', email: 'ann@example.com' },
  to: [{ email: 'me@example.com' }],
  cc: [{ email: 'carol@example.com' }],
  subject: 'Report',
  date: '2026-07-01T12:00:00.000Z',
  body: { text: 'original text', html: '<p>original <b>html</b></p>' },
  attachments: [],
  flags: { read: true, starred: false, draft: false },
};

describe('buildForwardBody', () => {
  it('includes the forwarded-message header block and original text', () => {
    const body = buildForwardBody(original, 'FYI');
    expect(body.text).toContain('FYI');
    expect(body.text).toContain('---------- Forwarded message ----------');
    expect(body.text).toContain('From: Ann <ann@example.com>');
    expect(body.text).toContain('Cc: carol@example.com');
    expect(body.text).toContain('original text');
  });

  it('builds an html version quoting the original html', () => {
    const body = buildForwardBody(original);
    expect(body.html).toContain('<blockquote');
    expect(body.html).toContain('<p>original <b>html</b></p>');
  });

  it('escapes html in the comment', () => {
    const body = buildForwardBody(original, '<script>alert(1)</script>');
    expect(body.html).not.toContain('<script>');
    expect(body.html).toContain('&lt;script&gt;');
  });

  it('handles text-only originals', () => {
    const body = buildForwardBody({ ...original, body: { text: 'only text' } });
    expect(body.text).toContain('only text');
    expect(body.html).toBeUndefined();
  });
});

describe('EmailService.forward', () => {
  it('preserves inline attachment metadata', async () => {
    const message: Message = {
      ...original,
      body: { html: '<img src="cid:chart@example.com">' },
      attachments: [
        {
          id: 'attachment_1',
          filename: 'chart.png',
          mimeType: 'image/png',
          sizeBytes: 10,
          contentId: 'chart@example.com',
          disposition: 'inline',
        },
      ],
    };
    const send = vi.fn().mockResolvedValue({ id: 'sent_1', threadId: 'thread_1' });
    const provider = {
      getMessage: vi.fn().mockResolvedValue(message),
      getAttachment: vi.fn().mockResolvedValue({
        meta: message.attachments![0],
        content: Buffer.from('image data'),
      }),
      send,
    };
    const registry = {
      resolveAccountId: () => 'acct_1',
      getAccount: () => ({
        id: 'acct_1',
        provider: 'gmail',
        email: 'me@example.com',
        status: 'active',
        capabilities: {},
      }),
      getProvider: () => provider,
      markStatus: vi.fn(),
    };
    const service = new EmailService(registry as never, testDb());

    await service.forward(undefined, {
      messageId: message.id,
      to: [{ email: 'bob@example.com' }],
    });

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        attachments: [
          expect.objectContaining({
            filename: 'chart.png',
            contentId: 'chart@example.com',
            disposition: 'inline',
          }),
        ],
      })
    );
  });
});

describe('EmailService account state', () => {
  it('does not call a provider for a disabled account', async () => {
    const getProvider = vi.fn();
    const registry = {
      resolveAccountId: () => 'acct_1',
      getAccount: () => ({
        id: 'acct_1',
        provider: 'gmail',
        email: 'me@example.com',
        status: 'disabled',
        capabilities: {},
      }),
      getProvider,
    };
    const service = new EmailService(registry as never, testDb());

    await expect(service.listFolders()).rejects.toMatchObject({ code: 'invalid_request' });
    expect(getProvider).not.toHaveBeenCalled();
  });
});

describe('EmailService.status', () => {
  function statusService(
    initialStatus: 'active' | 'auth_error',
    testConnection: () => Promise<void>
  ) {
    const account = {
      id: 'acct_1',
      provider: 'gmail' as const,
      email: 'me@example.com',
      status: initialStatus,
      capabilities: {
        labels: true,
        serverThreads: true,
        serverSearch: 'rich' as const,
        snippets: true,
      },
    };
    const markStatus = vi.fn((_id: string, status: 'active' | 'auth_error' | 'disabled') => {
      account.status = status as typeof initialStatus;
    });
    const registry = {
      listAccounts: () => [account],
      getProvider: () => ({ testConnection }),
      markStatus,
    };
    return { service: new EmailService(registry as never, testDb()), markStatus };
  }

  it('marks an account when a live connection check finds expired authorization', async () => {
    const { service, markStatus } = statusService('active', async () => {
      throw new EmailError('auth_expired', 'expired');
    });

    await expect(service.status()).resolves.toMatchObject({
      accounts: [{ id: 'acct_1', status: 'auth_error' }],
    });
    expect(markStatus).toHaveBeenCalledWith('acct_1', 'auth_error');
  });

  it('restores an account after a successful live connection check', async () => {
    const { service, markStatus } = statusService('auth_error', async () => {});

    await expect(service.status()).resolves.toMatchObject({
      accounts: [{ id: 'acct_1', status: 'active' }],
    });
    expect(markStatus).toHaveBeenCalledWith('acct_1', 'active');
  });

  it('keeps the stored state when a provider check fails for another reason', async () => {
    const { service, markStatus } = statusService('active', async () => {
      throw new EmailError('provider_unavailable', 'temporary failure');
    });

    await expect(service.status()).resolves.toMatchObject({
      accounts: [
        {
          id: 'acct_1',
          status: 'active',
          error: { code: 'provider_unavailable', message: 'temporary failure' },
        },
      ],
    });
    expect(markStatus).not.toHaveBeenCalled();
  });
});

describe('resolveSendAt', () => {
  const now = Date.parse('2026-07-10T12:00:00.000Z');

  it('accepts a future ISO timestamp with offset', () => {
    expect(resolveSendAt('2026-07-11T09:00:00-07:00', now)).toBe(Date.parse('2026-07-11T16:00:00Z'));
  });

  it('accepts a timestamp within the past-grace window', () => {
    expect(resolveSendAt('2026-07-10T11:59:30.000Z', now)).toBe(now - 30_000);
  });

  it('rejects a past timestamp', () => {
    expect(() => resolveSendAt('2026-07-10T11:00:00.000Z', now)).toThrow(/in the past/);
  });

  it('rejects a timestamp more than a year away', () => {
    expect(() => resolveSendAt('2027-08-01T00:00:00.000Z', now)).toThrow(/more than a year/);
  });

  it('rejects garbage', () => {
    expect(() => resolveSendAt('tomorrow at 9', now)).toThrow(/Could not parse/);
  });
});

describe('EmailService scheduling', () => {
  const soon = new Date(Date.now() + 3_600_000).toISOString();

  function schedulingService(provider: Record<string, unknown>) {
    const db = testDb();
    const account = {
      id: 'acct_1',
      provider: 'gmail',
      email: 'me@example.com',
      status: 'active',
      capabilities: {},
    };
    const registry = {
      resolveAccountId: () => 'acct_1',
      getAccount: () => account,
      listAccounts: () => [account],
      getProvider: () => provider,
      markStatus: vi.fn(),
    };
    const service = new EmailService(registry as never, db);
    const onScheduleChanged = vi.fn();
    service.onScheduleChanged = onScheduleChanged;
    return { service, db, onScheduleChanged };
  }

  const draftMessage: Message = {
    ...original,
    draftId: 'draft_1',
    to: [{ email: 'bob@example.com' }],
    subject: 'Later',
    flags: { read: true, starred: false, draft: true },
  };

  it('schedules new content by creating a draft and storing a schedule row', async () => {
    const createDraft = vi.fn().mockResolvedValue(draftMessage);
    const { service, onScheduleChanged } = schedulingService({ createDraft });

    const info = await service.scheduleSend(
      undefined,
      { to: [{ email: 'bob@example.com' }], subject: 'Later', body: { text: 'hi' } },
      soon
    );

    expect(createDraft).toHaveBeenCalled();
    expect(info).toMatchObject({
      draftId: 'draft_1',
      accountId: 'acct_1',
      status: 'pending',
      subject: 'Later',
      to: 'bob@example.com',
      sendAt: new Date(soon).toISOString(),
    });
    expect(info.scheduleId).toMatch(/^sch_/);
    expect(onScheduleChanged).toHaveBeenCalled();
    expect(service.listScheduled()).toHaveLength(1);
  });

  it('rejects recipientless content before creating a draft', async () => {
    const createDraft = vi.fn();
    const { service } = schedulingService({ createDraft });

    await expect(
      service.scheduleSend(undefined, { subject: 'Nobody', body: { text: 'hi' } }, soon)
    ).rejects.toMatchObject({ code: 'invalid_request' });

    expect(createDraft).not.toHaveBeenCalled();
    expect(service.listScheduled()).toHaveLength(0);
  });

  it('accepts a reply after deriving its recipient', async () => {
    const getMessage = vi.fn().mockResolvedValue(original);
    const createDraft = vi.fn().mockResolvedValue(draftMessage);
    const { service } = schedulingService({ getMessage, createDraft });

    await service.scheduleSend(
      undefined,
      { replyToMessageId: original.id, subject: 'Re: Hello', body: { text: 'hi' } },
      soon
    );

    expect(createDraft).toHaveBeenCalledWith(
      expect.objectContaining({ to: [{ email: 'ann@example.com', name: 'Ann' }] })
    );
  });

  it('schedules an existing draft after verifying it exists', async () => {
    const getDraft = vi.fn().mockResolvedValue(draftMessage);
    const { service } = schedulingService({ getDraft });

    const info = await service.scheduleSend(undefined, { draftId: 'draft_1' }, soon);

    expect(getDraft).toHaveBeenCalledWith('draft_1');
    expect(info.draftId).toBe('draft_1');
  });

  it('rejects scheduling a missing draft', async () => {
    const getDraft = vi.fn().mockRejectedValue(new EmailError('not_found', 'no such draft'));
    const { service } = schedulingService({ getDraft });

    await expect(service.scheduleSend(undefined, { draftId: 'nope' }, soon)).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(service.listScheduled()).toHaveLength(0);
  });

  it('rejects a second pending schedule for the same draft', async () => {
    const getDraft = vi.fn().mockResolvedValue(draftMessage);
    const { service } = schedulingService({ getDraft });

    await service.scheduleSend(undefined, { draftId: 'draft_1' }, soon);
    await expect(service.scheduleSend(undefined, { draftId: 'draft_1' }, soon)).rejects.toMatchObject({
      code: 'invalid_request',
    });
  });

  it('marks the schedule sent when the draft is sent manually', async () => {
    const getDraft = vi.fn().mockResolvedValue(draftMessage);
    const send = vi.fn().mockResolvedValue({ id: 'sent_1', threadId: 'thread_1' });
    const { service, onScheduleChanged } = schedulingService({ getDraft, send });

    const info = await service.scheduleSend(undefined, { draftId: 'draft_1' }, soon);
    onScheduleChanged.mockClear();
    await service.send(undefined, { draftId: 'draft_1' });

    const [row] = service.listScheduled();
    expect(row).toMatchObject({ scheduleId: info.scheduleId, status: 'sent', sentMessageId: 'sent_1' });
    expect(onScheduleChanged).toHaveBeenCalled();
  });

  it('cancels a pending schedule and keeps the draft', async () => {
    const getDraft = vi.fn().mockResolvedValue(draftMessage);
    const deleteDraft = vi.fn();
    const { service } = schedulingService({ getDraft, deleteDraft });

    const info = await service.scheduleSend(undefined, { draftId: 'draft_1' }, soon);
    const result = service.cancelScheduled(info.scheduleId);

    expect(result).toEqual({ scheduleId: info.scheduleId, draftId: 'draft_1', draftKept: true });
    expect(deleteDraft).not.toHaveBeenCalled();
    expect(service.listScheduled()[0]).toMatchObject({ status: 'canceled' });
    expect(() => service.cancelScheduled(info.scheduleId)).toThrow(/already canceled/);
    expect(() => service.cancelScheduled('sch_missing')).toThrow(/No scheduled send/);
  });

  it('reports pending schedules in status()', async () => {
    const getDraft = vi.fn().mockResolvedValue(draftMessage);
    const { service } = schedulingService({ getDraft, testConnection: vi.fn() });

    await service.scheduleSend(undefined, { draftId: 'draft_1' }, soon);

    await expect(service.status()).resolves.toMatchObject({
      scheduled: { pending: 1, nextSendAt: new Date(soon).toISOString() },
    });
  });
});
