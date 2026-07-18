import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ImapFlow } from 'imapflow';
import { ImapProvider } from '../src/imapProvider.js';
import type { ImapCredentials, ImapMessageLocation, ImapStateStore } from '../src/types.js';

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

  async invalidateMailbox(path: string, uidValidity: string) {
    for (const [id, row] of this.rows) {
      if (row.mailboxPath === path && row.uidValidity !== uidValidity) this.rows.delete(id);
    }
  }
}

const host = process.env.GREENMAIL_HOST;
const folders = ['Sent', 'Drafts', 'Trash', 'Archive', 'Spam', 'Vanishing'];
const overrides = { sent: 'Sent', drafts: 'Drafts', trash: 'Trash', archive: 'Archive', spam: 'Spam' } as const;

function credentials(options: { saveSent?: boolean; smtpSecurity?: 'tls' | 'starttls' } = {}): ImapCredentials {
  const smtpSecurity = options.smtpSecurity ?? 'tls';
  return {
    imap: { host: host!, port: 3993, security: 'tls', user: 'test1', password: 'pwd1' },
    smtp: {
      host: host!,
      port: smtpSecurity === 'tls' ? 3465 : 3025,
      security: smtpSecurity,
      user: 'test1',
      password: 'pwd1',
    },
    saveSent: options.saveSent ?? true,
    folderOverrides: overrides,
  };
}

function makeProvider(store = new MemoryStore(), custom = credentials()): ImapProvider {
  return new ImapProvider({
    accountId: 'acct_greenmail',
    email: 'test1@localhost',
    displayName: 'Green Mail',
    credentials: custom,
    store,
  });
}

async function adminClient(): Promise<ImapFlow> {
  const client = new ImapFlow({
    host: host!,
    port: 3993,
    secure: true,
    auth: { user: 'test1', pass: 'pwd1' },
    logger: false,
  });
  await client.connect();
  return client;
}

async function waitForMessage(provider: ImapProvider, folder: string, subject: string) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const message = (await provider.listMessages({ folder, subject })).items[0];
    if (message) return message;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${subject} in ${folder}`);
}

it('reports labels as unsupported without connecting to the server', async () => {
  await expect(makeProvider().listLabels()).rejects.toMatchObject({ code: 'unsupported_capability' });
});

describe.skipIf(!host).sequential('GreenMail integration', () => {
  const store = new MemoryStore();
  const provider = makeProvider(store);

  beforeAll(async () => {
    let connected = false;
    for (let attempt = 0; attempt < 20 && !connected; attempt++) {
      try {
        await provider.testConnection();
        connected = true;
      } catch (error) {
        if (attempt === 19) throw error;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    const client = await adminClient();
    try {
      const existing = new Set((await client.list()).map((folder) => folder.path));
      for (const folder of folders) {
        if (!existing.has(folder)) await client.mailboxCreate(folder);
      }
    } finally {
      await client.logout();
    }
  }, 15_000);

  afterAll(async () => {
    await provider.close();
  });

  it('resolves configured folders and reports their provenance', async () => {
    const listed = await provider.listFolders();
    for (const [role, path] of Object.entries(overrides)) {
      expect(listed.find((folder) => folder.id === path)).toMatchObject({ role, roleSource: 'user' });
    }
  });

  it('delivers through SMTP, saves Sent, and keeps Bcc out of the delivered copy', async () => {
    const subject = 'GreenMail delivery and Bcc';
    const sent = await provider.send({
      to: [{ email: 'test1@localhost' }],
      bcc: [{ email: 'hidden@localhost' }],
      subject,
      body: { text: 'message body' },
    });
    expect(sent.warnings).toBeUndefined();

    const inbox = await waitForMessage(provider, 'inbox', subject);
    const sentCopy = await waitForMessage(provider, 'sent', subject);
    const delivered = await provider.getMessage(inbox.id);
    expect(delivered).toMatchObject({ body: { text: 'message body' } });
    expect(delivered).not.toHaveProperty('bcc');
    await expect(provider.getMessage(sentCopy.id)).resolves.toMatchObject({
      body: { text: 'message body' },
      bcc: [{ email: 'hidden@localhost' }],
    });
  }, 15_000);

  it('reads multipart bodies and downloads attachment parts', async () => {
    const subject = 'GreenMail multipart attachment';
    await provider.send({
      to: [{ email: 'test1@localhost' }],
      subject,
      body: { text: 'plain version', html: '<p>html version</p>' },
      attachments: [
        {
          filename: 'hello.txt',
          mimeType: 'text/plain',
          content: Buffer.from('attachment bytes').toString('base64'),
        },
      ],
    });
    const listed = await waitForMessage(provider, 'inbox', subject);
    await expect(provider.listMessages({ folder: 'inbox', subject, hasAttachment: true })).resolves.toMatchObject({
      items: [expect.objectContaining({ id: listed.id })],
    });
    const message = await provider.getMessage(listed.id);
    expect(message.body).toMatchObject({ text: 'plain version', html: '<p>html version</p>' });
    expect(message.attachments).toHaveLength(1);
    const downloaded = await provider.getAttachment(message.id, message.attachments![0]!.id);
    expect(downloaded.meta).toMatchObject({ filename: 'hello.txt', mimeType: 'text/plain' });
    expect(downloaded.content.toString()).toBe('attachment bytes');
  });

  it('paginates deterministically and rejects a token for a different query', async () => {
    for (const suffix of ['one', 'two', 'three']) {
      await provider.send({
        to: [{ email: 'test1@localhost' }],
        subject: `GreenMail pagination ${suffix}`,
        body: { text: suffix },
      });
    }
    const first = await provider.listMessages({ folder: 'inbox', subject: 'GreenMail pagination' }, { pageSize: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.nextPageToken).toBeTruthy();
    const second = await provider.listMessages(
      { folder: 'inbox', subject: 'GreenMail pagination' },
      { pageSize: 2, pageToken: first.nextPageToken },
    );
    expect(second.items).toHaveLength(1);
    expect(new Set([...first.items, ...second.items].map((item) => item.id)).size).toBe(3);
    await expect(
      provider.listMessages({ folder: 'inbox', subject: 'another query' }, { pageToken: first.nextPageToken }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('continues pagination deterministically across folders', async () => {
    const subject = 'GreenMail cross-folder pagination';
    for (const body of ['first', 'second']) {
      await provider.send({ to: [{ email: 'test1@localhost' }], subject, body: { text: body } });
    }
    const inbox = await provider.listMessages({ folder: 'inbox', subject });
    await provider.modify([inbox.items[0]!.id], 'archive');

    const found = [];
    let pageToken: string | undefined;
    do {
      const page = await provider.listMessages({ subject }, { pageSize: 1, ...(pageToken ? { pageToken } : {}) });
      found.push(...page.items);
      pageToken = page.nextPageToken;
    } while (pageToken);

    expect(found).toHaveLength(4);
    expect(new Set(found.map((message) => `${message.folder.id}:${message.id}`)).size).toBe(4);
    expect(new Set(found.map((message) => message.folder.role))).toEqual(new Set(['inbox', 'sent', 'archive']));
  }, 15_000);

  it('changes flags, moves through special folders, and only deletes explicitly', async () => {
    const subject = 'GreenMail modify lifecycle';
    await provider.send({
      to: [{ email: 'test1@localhost' }],
      subject,
      body: { text: 'move me' },
    });
    const message = await waitForMessage(provider, 'inbox', subject);

    await provider.modify([message.id], 'markRead');
    expect((await provider.getMessage(message.id)).flags.read).toBe(true);
    await provider.modify([message.id], 'markUnread');
    expect((await provider.getMessage(message.id)).flags.read).toBe(false);
    await provider.modify([message.id], 'star');
    expect((await provider.getMessage(message.id)).flags.starred).toBe(true);
    await expect(
      provider.listMessages({ folder: 'inbox', subject, unreadOnly: true, starredOnly: true }),
    ).resolves.toMatchObject({ items: [expect.objectContaining({ id: message.id })] });
    await provider.modify([message.id], 'unstar');
    expect((await provider.getMessage(message.id)).flags.starred).toBe(false);

    await provider.modify([message.id], 'archive');
    expect(await provider.getMessage(message.id)).toMatchObject({ id: message.id, folder: { role: 'archive' } });
    await provider.modify([message.id], 'trash');
    expect(await provider.getMessage(message.id)).toMatchObject({ id: message.id, folder: { role: 'trash' } });
    await provider.modify([message.id], 'untrash');
    expect(await provider.getMessage(message.id)).toMatchObject({ id: message.id, folder: { role: 'inbox' } });
    await provider.modify([message.id], { move: 'Spam' });
    expect(await provider.getMessage(message.id)).toMatchObject({ id: message.id, folder: { role: 'spam' } });
    await provider.modify([message.id], 'delete');
    await expect(provider.getMessage(message.id)).rejects.toMatchObject({ code: 'not_found' });
  }, 15_000);

  it('creates, updates, reads, deletes, and sends drafts', async () => {
    const draft = await provider.createDraft({
      to: [{ email: 'test1@localhost' }],
      subject: 'GreenMail original draft',
      body: { text: 'first body' },
    });
    expect(draft).toMatchObject({ folder: { role: 'drafts' }, flags: { draft: true } });
    const updated = await provider.updateDraft(draft.draftId!, {
      to: [{ email: 'test1@localhost' }],
      subject: 'GreenMail updated draft',
      body: { text: 'second body' },
    });
    expect(updated).toMatchObject({ id: draft.id, draftId: draft.draftId, body: { text: 'second body' } });
    await expect(provider.getDraft(draft.draftId!)).resolves.toMatchObject({ subject: 'GreenMail updated draft' });
    const sent = await provider.send({ draftId: draft.draftId! });
    expect(sent.warnings).toBeUndefined();
    await expect(provider.getDraft(draft.draftId!)).rejects.toMatchObject({ code: 'not_found' });
    await expect(provider.getMessage(draft.id)).resolves.toMatchObject({
      folder: { role: 'sent' },
      flags: { draft: false, read: true },
    });

    const disposable = await provider.createDraft({ subject: 'GreenMail deleted draft', body: { text: 'delete' } });
    await provider.deleteDraft(disposable.draftId!);
    await expect(provider.getDraft(disposable.draftId!)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('builds a synthetic thread from Message-ID, References, and In-Reply-To', async () => {
    const subject = 'GreenMail thread root';
    await provider.send({
      to: [{ email: 'test1@localhost' }],
      subject,
      body: { text: 'root body' },
    });
    const root = await waitForMessage(provider, 'inbox', subject);
    await provider.send({
      to: [{ email: 'test1@localhost' }],
      replyToMessageId: root.id,
      body: { text: 'reply body' },
    });
    await waitForMessage(provider, 'sent', `Re: ${subject}`);
    const thread = await provider.getThread(root.threadId);
    expect(thread.messages.map((message) => message.body?.text)).toEqual(
      expect.arrayContaining(['root body', 'reply body']),
    );
    expect(thread.messages.every((message) => message.threadId === root.threadId)).toBe(true);
  });

  it('reconnects after close and keeps stable IDs through the state store', async () => {
    const subject = 'GreenMail reconnect';
    await provider.send({ to: [{ email: 'test1@localhost' }], subject, body: { text: 'persist me' } });
    const before = await waitForMessage(provider, 'inbox', subject);
    await provider.close();
    const restarted = makeProvider(store);
    try {
      const after = await waitForMessage(restarted, 'inbox', subject);
      expect(after.id).toBe(before.id);
      await expect(restarted.getMessage(before.id)).resolves.toMatchObject({ body: { text: 'persist me' } });
    } finally {
      await restarted.close();
    }
  });

  it('reports a configured folder that disappears after setup', async () => {
    const staleCredentials = credentials();
    staleCredentials.folderOverrides = { ...staleCredentials.folderOverrides, archive: 'Vanishing' };
    const stale = makeProvider(new MemoryStore(), staleCredentials);
    try {
      expect(await stale.listFolders()).toContainEqual(expect.objectContaining({ id: 'Vanishing', role: 'archive' }));
      await stale.close();
      const client = await adminClient();
      try {
        await client.mailboxDelete('Vanishing');
      } finally {
        await client.logout();
      }
      await expect(stale.getFolderWarnings()).resolves.toContainEqual(
        expect.objectContaining({ role: 'archive', reason: 'stale_override' }),
      );
    } finally {
      await stale.close();
    }
  });
});
