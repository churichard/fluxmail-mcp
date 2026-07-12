import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { ImapFlow, ListResponse } from 'imapflow';
import type { Transporter } from 'nodemailer';
import { ImapProvider, smtpTransportOptions } from '../src/imapProvider.js';
import type { ImapMessageLocation, ImapStateStore } from '../src/types.js';

function folder(path: string): ListResponse {
  return {
    path,
    pathAsListed: path,
    name: path,
    delimiter: '/',
    parent: [],
    parentPath: '',
    flags: new Set(),
    listed: true,
    subscribed: true,
  };
}

class MemoryStore implements ImapStateStore {
  rows = new Map<string, ImapMessageLocation>();
  async findById(id: string) {
    return this.rows.get(id);
  }
  async findByLocation(path: string, uidValidity: string, uid: number) {
    return [...this.rows.values()].find(
      (row) => row.mailboxPath === path && row.uidValidity === uidValidity && row.uid === uid,
    );
  }
  async findByDraftId(draftId: string) {
    return [...this.rows.values()].find((row) => row.draftId === draftId);
  }
  async listByThreadId(threadId: string) {
    return [...this.rows.values()].filter((row) => row.threadId === threadId);
  }
  async save(row: ImapMessageLocation) {
    this.rows.set(row.id, row);
  }
  async remove(id: string) {
    this.rows.delete(id);
  }
  async invalidateMailbox() {}
}

describe('ImapProvider safe folder fallbacks', () => {
  it('does not permanently delete when Trash is unresolved', async () => {
    const store = new MemoryStore();
    await store.save({
      id: 'm1',
      accountId: 'a1',
      mailboxPath: 'INBOX',
      uidValidity: '1',
      uid: 7,
      threadId: 't1',
    });
    const messageDelete = vi.fn();
    const fake = {
      usable: true,
      mailbox: false,
      capabilities: new Map(),
      on: vi.fn(),
      connect: vi.fn(),
      close: vi.fn(),
      list: vi.fn().mockResolvedValue([folder('INBOX')]),
      getMailboxLock: vi.fn(async () => {
        fake.mailbox = { uidValidity: 1n } as never;
        return { release: vi.fn() };
      }),
      messageDelete,
    };
    const provider = new ImapProvider({
      accountId: 'a1',
      email: 'me@example.com',
      credentials: {
        imap: { host: 'imap.example.com', port: 993, security: 'tls', user: 'me', password: 'secret' },
        smtp: { host: 'smtp.example.com', port: 587, security: 'starttls', user: 'me', password: 'secret' },
        saveSent: true,
      },
      store,
      imapFactory: () => fake as unknown as ImapFlow,
    });

    await expect(provider.modify(['m1'], 'trash')).rejects.toMatchObject({ code: 'unsupported_capability' });
    expect(messageDelete).not.toHaveBeenCalled();
  });

  it('delivers without failing when Sent is unresolved', async () => {
    const fake = {
      usable: true,
      capabilities: new Map(),
      on: vi.fn(),
      connect: vi.fn(),
      close: vi.fn(),
      list: vi.fn().mockResolvedValue([folder('INBOX')]),
    };
    const sendMail = vi.fn().mockResolvedValue({ messageId: '<sent@example.com>' });
    const provider = new ImapProvider({
      accountId: 'a1',
      email: 'me@example.com',
      credentials: {
        imap: { host: 'imap.example.com', port: 993, security: 'tls', user: 'me', password: 'secret' },
        smtp: { host: 'smtp.example.com', port: 587, security: 'starttls', user: 'me', password: 'secret' },
        saveSent: true,
      },
      store: new MemoryStore(),
      imapFactory: () => fake as unknown as ImapFlow,
      smtpFactory: () => ({ sendMail }) as unknown as Transporter,
    });

    await expect(
      provider.send({
        to: [{ email: 'you@example.com' }],
        cc: [{ email: 'copy@example.com' }],
        bcc: [{ email: 'hidden@example.com' }],
        subject: 'Hello',
        body: { text: 'Body' },
      }),
    ).resolves.toMatchObject({
      id: '<sent@example.com>',
      warnings: [expect.stringMatching(/no Sent folder/)],
    });
    expect(sendMail).toHaveBeenCalledOnce();
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        envelope: {
          from: 'me@example.com',
          to: ['you@example.com', 'copy@example.com', 'hidden@example.com'],
        },
      }),
    );
    expect((sendMail.mock.calls[0]![0] as { raw: Buffer }).raw.toString()).not.toMatch(/^Bcc:/im);
  });

  it('disables draft creation when Drafts is unresolved', async () => {
    const append = vi.fn();
    const fake = {
      usable: true,
      capabilities: new Map(),
      on: vi.fn(),
      connect: vi.fn(),
      close: vi.fn(),
      list: vi.fn().mockResolvedValue([folder('INBOX')]),
      append,
    };
    const provider = new ImapProvider({
      accountId: 'a1',
      email: 'me@example.com',
      credentials: {
        imap: { host: 'imap.example.com', port: 993, security: 'tls', user: 'me', password: 'secret' },
        smtp: { host: 'smtp.example.com', port: 587, security: 'starttls', user: 'me', password: 'secret' },
        saveSent: true,
      },
      store: new MemoryStore(),
      imapFactory: () => fake as unknown as ImapFlow,
    });

    await expect(provider.createDraft({ subject: 'Draft', body: { text: 'Body' } })).rejects.toMatchObject({
      code: 'unsupported_capability',
      message: expect.stringMatching(/--drafts-folder/),
    });
    expect(append).not.toHaveBeenCalled();
  });

  it.each(['archive', 'trash', 'untrash'] as const)(
    'does not move or delete for %s when its required folder is unresolved',
    async (action) => {
      const store = new MemoryStore();
      await store.save({
        id: 'm1',
        accountId: 'a1',
        mailboxPath: 'INBOX',
        uidValidity: '1',
        uid: 7,
        threadId: 't1',
      });
      const messageMove = vi.fn();
      const messageDelete = vi.fn();
      const fake = {
        usable: true,
        mailbox: false,
        capabilities: new Map(),
        on: vi.fn(),
        connect: vi.fn(),
        close: vi.fn(),
        list: vi.fn().mockResolvedValue([folder('INBOX')]),
        getMailboxLock: vi.fn(async () => {
          fake.mailbox = { uidValidity: 1n } as never;
          return { release: vi.fn() };
        }),
        messageMove,
        messageDelete,
      };
      const provider = new ImapProvider({
        accountId: 'a1',
        email: 'me@example.com',
        credentials: {
          imap: { host: 'imap.example.com', port: 993, security: 'tls', user: 'me', password: 'secret' },
          smtp: { host: 'smtp.example.com', port: 587, security: 'starttls', user: 'me', password: 'secret' },
          saveSent: true,
        },
        store,
        imapFactory: () => fake as unknown as ImapFlow,
      });

      await expect(provider.modify(['m1'], action)).rejects.toMatchObject({ code: 'unsupported_capability' });
      expect(messageMove).not.toHaveBeenCalled();
      expect(messageDelete).not.toHaveBeenCalled();
    },
  );

  it('does not append a Sent copy when saveSent is false', async () => {
    const append = vi.fn();
    const fake = {
      usable: true,
      capabilities: new Map(),
      on: vi.fn(),
      connect: vi.fn(),
      close: vi.fn(),
      list: vi.fn().mockResolvedValue([folder('INBOX'), folder('Sent')]),
      append,
    };
    const sendMail = vi.fn().mockResolvedValue({ messageId: '<sent@example.com>' });
    const provider = new ImapProvider({
      accountId: 'a1',
      email: 'me@example.com',
      credentials: {
        imap: { host: 'imap.example.com', port: 993, security: 'tls', user: 'me', password: 'secret' },
        smtp: { host: 'smtp.example.com', port: 587, security: 'starttls', user: 'me', password: 'secret' },
        saveSent: false,
      },
      store: new MemoryStore(),
      imapFactory: () => fake as unknown as ImapFlow,
      smtpFactory: () => ({ sendMail }) as unknown as Transporter,
    });

    await expect(
      provider.send({ to: [{ email: 'you@example.com' }], subject: 'Hello', body: { text: 'Body' } }),
    ).resolves.not.toHaveProperty('warnings');
    expect(sendMail).toHaveBeenCalledOnce();
    expect(append).not.toHaveBeenCalled();
  });

  it('returns a warning without retrying SMTP when the Sent append fails', async () => {
    const sentFolder = folder('Sent');
    sentFolder.specialUse = '\\Sent';
    const fake = {
      usable: true,
      capabilities: new Map(),
      on: vi.fn(),
      connect: vi.fn(),
      close: vi.fn(),
      list: vi.fn().mockResolvedValue([folder('INBOX'), sentFolder]),
      append: vi.fn().mockRejectedValue(new Error('append refused')),
    };
    const sendMail = vi.fn().mockResolvedValue({ messageId: '<delivered@example.com>' });
    const provider = new ImapProvider({
      accountId: 'a1',
      email: 'me@example.com',
      credentials: {
        imap: { host: 'imap.example.com', port: 993, security: 'tls', user: 'me', password: 'secret' },
        smtp: { host: 'smtp.example.com', port: 587, security: 'starttls', user: 'me', password: 'secret' },
        saveSent: true,
      },
      store: new MemoryStore(),
      imapFactory: () => fake as unknown as ImapFlow,
      smtpFactory: () => ({ sendMail }) as unknown as Transporter,
    });

    await expect(
      provider.send({ to: [{ email: 'you@example.com' }], subject: 'Hello', body: { text: 'Body' } }),
    ).resolves.toMatchObject({
      id: '<delivered@example.com>',
      warnings: [expect.stringMatching(/could not save the Sent copy.*append refused/)],
    });
    expect(sendMail).toHaveBeenCalledOnce();
    expect(fake.append).toHaveBeenCalledOnce();
  });

  it('builds required STARTTLS and implicit TLS SMTP options', () => {
    const base = { host: 'smtp.example.com', port: 587, user: 'me', password: 'secret' };
    expect(smtpTransportOptions({ ...base, security: 'starttls' })).toMatchObject({
      secure: false,
      requireTLS: true,
    });
    expect(smtpTransportOptions({ ...base, port: 465, security: 'tls' })).toMatchObject({
      secure: true,
      requireTLS: false,
    });
  });

  it('creates a new IMAP client after the current connection becomes unusable', async () => {
    const clients = [0, 1].map(() => ({
      usable: true,
      capabilities: new Map(),
      on: vi.fn(),
      connect: vi.fn(),
      close: vi.fn(),
      list: vi.fn().mockResolvedValue([folder('INBOX')]),
    }));
    const factory = vi.fn(() => clients[factory.mock.calls.length - 1] as unknown as ImapFlow);
    const provider = new ImapProvider({
      accountId: 'a1',
      email: 'me@example.com',
      credentials: {
        imap: { host: 'imap.example.com', port: 993, security: 'tls', user: 'me', password: 'secret' },
        smtp: { host: 'smtp.example.com', port: 587, security: 'starttls', user: 'me', password: 'secret' },
        saveSent: true,
      },
      store: new MemoryStore(),
      imapFactory: factory,
    });

    await provider.listFolders();
    clients[0]!.usable = false;
    await provider.listFolders();
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('falls back to PostalMime when BODYSTRUCTURE is unavailable', async () => {
    const store = new MemoryStore();
    await store.save({
      id: 'm1',
      accountId: 'a1',
      mailboxPath: 'INBOX',
      uidValidity: '1',
      uid: 7,
      threadId: 't1',
    });
    const source = Buffer.from(
      'From: sender@example.com\r\nTo: me@example.com\r\nSubject: Fallback\r\nMessage-ID: <fallback@example.com>\r\nContent-Type: text/plain\r\n\r\nfallback body',
    );
    const fetchOne = vi
      .fn()
      .mockResolvedValueOnce({
        uid: 7,
        envelope: {
          subject: 'Fallback',
          from: [{ address: 'sender@example.com' }],
          to: [{ address: 'me@example.com' }],
        },
        flags: new Set(),
      })
      .mockResolvedValueOnce({ uid: 7, source });
    const fake = {
      usable: true,
      mailbox: false,
      capabilities: new Map(),
      on: vi.fn(),
      connect: vi.fn(),
      close: vi.fn(),
      getMailboxLock: vi.fn(async () => {
        fake.mailbox = { uidValidity: 1n } as never;
        return { release: vi.fn() };
      }),
      fetchOne,
    };
    const provider = new ImapProvider({
      accountId: 'a1',
      email: 'me@example.com',
      credentials: {
        imap: { host: 'imap.example.com', port: 993, security: 'tls', user: 'me', password: 'secret' },
        smtp: { host: 'smtp.example.com', port: 587, security: 'starttls', user: 'me', password: 'secret' },
        saveSent: true,
      },
      store,
      imapFactory: () => fake as unknown as ImapFlow,
    });

    await expect(provider.getMessage('m1')).resolves.toMatchObject({
      subject: 'Fallback',
      body: { text: expect.stringContaining('fallback body') },
    });
    expect(fetchOne).toHaveBeenCalledTimes(2);
  });
});

function testCredentials(saveSent = true) {
  return {
    imap: { host: 'imap.example.com', port: 993, security: 'tls' as const, user: 'me', password: 'secret' },
    smtp: {
      host: 'smtp.example.com',
      port: 587,
      security: 'starttls' as const,
      user: 'me',
      password: 'secret',
    },
    saveSent,
  };
}

describe('ImapProvider connection and pagination state', () => {
  it('shares an in-flight IMAP connection between concurrent requests', async () => {
    let finishConnect!: () => void;
    const connected = new Promise<void>((resolve) => {
      finishConnect = resolve;
    });
    const fake = {
      usable: false,
      capabilities: new Map(),
      on: vi.fn(),
      connect: vi.fn(async () => {
        await connected;
        fake.usable = true;
      }),
      close: vi.fn(),
      list: vi.fn().mockResolvedValue([folder('INBOX')]),
    };
    const factory = vi.fn(() => fake as unknown as ImapFlow);
    const provider = new ImapProvider({
      accountId: 'a1',
      email: 'me@example.com',
      credentials: testCredentials(),
      store: new MemoryStore(),
      imapFactory: factory,
    });

    const first = provider.listFolders();
    const second = provider.listFolders();
    await vi.waitFor(() => expect(factory).toHaveBeenCalledOnce());
    finishConnect();
    await Promise.all([first, second]);

    expect(fake.connect).toHaveBeenCalledOnce();
    expect(factory).toHaveBeenCalledOnce();
  });

  function paginationProvider(initialUids: number[]) {
    const store = new MemoryStore();
    let selected = 'INBOX';
    let uids = initialUids;
    const fake = {
      usable: true,
      mailbox: false,
      capabilities: new Map(),
      on: vi.fn(),
      connect: vi.fn(),
      close: vi.fn(),
      list: vi.fn().mockResolvedValue([folder('INBOX'), folder('Sent')]),
      getMailboxLock: vi.fn(async (path: string) => {
        selected = path;
        fake.mailbox = { uidValidity: 1n } as never;
        return { release: vi.fn() };
      }),
      search: vi.fn(async () => uids),
      fetchOne: vi.fn(async (uid: number) => ({
        uid,
        envelope: { subject: `${selected}-${uid}`, messageId: `<${selected}-${uid}@example.com>` },
        headers: Buffer.from(`Message-ID: <${selected}-${uid}@example.com>\r\n`),
        flags: new Set<string>(),
        internalDate: new Date('2026-01-01T00:00:00Z'),
      })),
    };
    return {
      provider: new ImapProvider({
        accountId: 'a1',
        email: 'me@example.com',
        credentials: testCredentials(),
        store,
        imapFactory: () => fake as unknown as ImapFlow,
      }),
      setUids(next: number[]) {
        uids = next;
      },
    };
  }

  it('rejects a page token when the folder changes', async () => {
    const { provider } = paginationProvider([3, 2]);
    const first = await provider.listMessages({ folder: 'INBOX' }, { pageSize: 1 });

    await expect(
      provider.listMessages({ folder: 'Sent' }, { pageSize: 1, pageToken: first.nextPageToken }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('keeps pagination stable when a newer UID arrives', async () => {
    const { provider, setUids } = paginationProvider([3, 2, 1]);
    const first = await provider.listMessages({ folder: 'INBOX' }, { pageSize: 2 });
    setUids([4, 3, 2, 1]);
    const second = await provider.listMessages({ folder: 'INBOX' }, { pageSize: 2, pageToken: first.nextPageToken });

    expect(first.items.map((message) => message.subject)).toEqual(['INBOX-3', 'INBOX-2']);
    expect(second.items.map((message) => message.subject)).toEqual(['INBOX-1']);
  });

  it('does not return a page token when the page consumes every match', async () => {
    const { provider } = paginationProvider([2, 1]);
    const page = await provider.listMessages({ folder: 'INBOX' }, { pageSize: 2 });
    expect(page.nextPageToken).toBeUndefined();
  });

  it('lists all selectable folders when the server has no All mailbox', async () => {
    const { provider } = paginationProvider([1]);
    const page = await provider.listMessages({ folder: 'all' });
    expect(page.items.map((message) => message.subject)).toEqual(['INBOX-1', 'Sent-1']);
  });
});

describe('ImapProvider reply threading', () => {
  it('reads threading headers without depending on their capitalization', async () => {
    const store = new MemoryStore();
    await store.save({
      id: 'm1',
      accountId: 'a1',
      mailboxPath: 'INBOX',
      uidValidity: '1',
      uid: 7,
      threadId: 't1',
    });
    const source = Buffer.from(
      'message-id: <root@example.com>\r\nreferences: <older@example.com>\r\nSubject: Original\r\nContent-Type: text/plain\r\n\r\nBody',
    );
    const fake = {
      usable: true,
      mailbox: false,
      capabilities: new Map(),
      on: vi.fn(),
      connect: vi.fn(),
      close: vi.fn(),
      getMailboxLock: vi.fn(async () => {
        fake.mailbox = { uidValidity: 1n } as never;
        return { release: vi.fn() };
      }),
      fetchOne: vi.fn(async (_uid: number, query: { source?: boolean }) =>
        query.source
          ? { uid: 7, source }
          : {
              uid: 7,
              envelope: { subject: 'Original' },
              headers: Buffer.from('message-id: <root@example.com>\r\nreferences: <older@example.com>\r\n'),
              flags: new Set<string>(),
            },
      ),
    };
    const sendMail = vi.fn().mockResolvedValue({ messageId: '<reply@example.com>' });
    const provider = new ImapProvider({
      accountId: 'a1',
      email: 'me@example.com',
      credentials: testCredentials(false),
      store,
      imapFactory: () => fake as unknown as ImapFlow,
      smtpFactory: () => ({ sendMail }) as unknown as Transporter,
    });

    await provider.send({
      to: [{ email: 'you@example.com' }],
      replyToMessageId: 'm1',
      body: { text: 'Reply' },
    });

    const raw = (sendMail.mock.calls[0]![0] as { raw: Buffer }).raw.toString();
    expect(raw).toMatch(/^In-Reply-To: <root@example.com>$/im);
    expect(raw).toMatch(/^References: <older@example.com> <root@example.com>$/im);
  });

  it('expands a thread through replies that omit References', async () => {
    const store = new MemoryStore();
    const threadId = 'thread-root';
    for (let uid = 1; uid <= 5; uid++) {
      await store.save({
        id: `m${uid}`,
        accountId: 'a1',
        mailboxPath: 'INBOX',
        uidValidity: '1',
        uid,
        messageId: `<m${uid}@example.com>`,
        ...(uid > 1 ? { inReplyTo: `<m${uid - 1}@example.com>` } : {}),
        threadId: uid === 1 ? threadId : `thread-parent-${uid}`,
      });
    }
    const fake = {
      usable: true,
      mailbox: false,
      capabilities: new Map(),
      on: vi.fn(),
      connect: vi.fn(),
      close: vi.fn(),
      list: vi.fn().mockResolvedValue([folder('INBOX')]),
      getMailboxLock: vi.fn(async () => {
        fake.mailbox = { uidValidity: 1n } as never;
        return { release: vi.fn() };
      }),
      search: vi.fn(async (query: unknown) => {
        const serialized = JSON.stringify(query);
        for (let parent = 1; parent < 5; parent++) {
          if (serialized.includes(`<m${parent}@example.com>`)) return [parent + 1];
        }
        return [];
      }),
      fetchOne: vi.fn(async (uid: number, query: { source?: boolean }) => {
        const headers = `Message-ID: <m${uid}@example.com>\r\n${uid > 1 ? `In-Reply-To: <m${uid - 1}@example.com>\r\n` : ''}`;
        if (query.source) {
          return {
            uid,
            source: Buffer.from(`${headers}Subject: Message ${uid}\r\nContent-Type: text/plain\r\n\r\nBody ${uid}`),
          };
        }
        return {
          uid,
          envelope: { subject: `Message ${uid}`, messageId: `<m${uid}@example.com>` },
          headers: Buffer.from(headers),
          flags: new Set<string>(),
        };
      }),
    };
    const provider = new ImapProvider({
      accountId: 'a1',
      email: 'me@example.com',
      credentials: testCredentials(),
      store,
      imapFactory: () => fake as unknown as ImapFlow,
    });

    const thread = await provider.getThread(threadId);

    expect(thread.messages).toHaveLength(5);
    expect(thread.messages.every((message) => message.threadId === threadId)).toBe(true);
  });

  it('keeps reply headers when updating a draft without APPENDUID', async () => {
    const store = new MemoryStore();
    const threadId = `ith_${createHash('sha256').update('<older@example.com>').digest('hex').slice(0, 24)}`;
    await store.save({
      id: 'm1',
      accountId: 'a1',
      mailboxPath: 'Drafts',
      uidValidity: '1',
      uid: 7,
      messageId: '<old-draft@example.com>',
      inReplyTo: '<root@example.com>',
      references: ['<older@example.com>', '<root@example.com>'],
      threadId,
      draftId: 'draft-1',
    });
    const drafts = folder('Drafts');
    drafts.specialUse = '\\Drafts';
    let appended = Buffer.alloc(0);
    const fake = {
      usable: true,
      mailbox: false,
      capabilities: new Map(),
      on: vi.fn(),
      connect: vi.fn(),
      close: vi.fn(),
      list: vi.fn().mockResolvedValue([folder('INBOX'), drafts]),
      append: vi.fn(async (_path: string, raw: Buffer) => {
        appended = raw;
        return false as const;
      }),
      getMailboxLock: vi.fn(async () => {
        fake.mailbox = { uidValidity: 1n } as never;
        return { release: vi.fn() };
      }),
      search: vi.fn().mockResolvedValue([8]),
      fetchOne: vi.fn(async (uid: number, query: { source?: boolean }) => {
        if (query.source) return { uid, source: appended };
        return {
          uid,
          envelope: { subject: 'Updated draft', messageId: '<new-draft@example.com>' },
          headers: appended.subarray(0, appended.indexOf('\r\n\r\n')),
          flags: new Set(['\\Draft']),
        };
      }),
      messageDelete: vi.fn(),
    };
    const provider = new ImapProvider({
      accountId: 'a1',
      email: 'me@example.com',
      credentials: testCredentials(),
      store,
      imapFactory: () => fake as unknown as ImapFlow,
    });

    const updated = await provider.updateDraft('draft-1', {
      to: [{ email: 'you@example.com' }],
      subject: 'Updated draft',
      body: { text: 'Updated body' },
    });

    expect(fake.search).toHaveBeenCalled();
    expect(fake.messageDelete).toHaveBeenCalledWith(7, { uid: true });
    expect(appended.toString()).toMatch(/^In-Reply-To: <root@example.com>$/im);
    expect(appended.toString()).toMatch(/^References: <older@example.com> <root@example.com>$/im);
    expect(updated).toMatchObject({ id: 'm1', draftId: 'draft-1', threadId });
  });
});
