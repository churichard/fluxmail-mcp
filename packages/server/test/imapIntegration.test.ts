import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ImapFlow } from 'imapflow';
import { describe, expect, it } from 'vitest';
import type { ImapCredentials } from '@fluxmail/provider-imap';
import { AccountRegistry } from '../src/accounts/registry.js';
import type { FluxmailConfig } from '../src/config.js';
import { SendScheduler } from '../src/scheduler/sendScheduler.js';
import { EmailService } from '../src/service/emailService.js';
import { openDb, type FluxmailDb } from '../src/storage/db.js';
import { createScheduledSend, getScheduledSend } from '../src/storage/scheduledSends.js';
import { addMember } from '../src/storage/members.js';

const host = process.env.GREENMAIL_HOST;

function closeDb(db: FluxmailDb): void {
  (db as unknown as { $client: { close(): void } }).$client.close();
}

function config(dbPath: string): FluxmailConfig {
  return {
    dataDir: path.dirname(dbPath),
    dbPath,
    encryptionKey: randomBytes(32),
    port: 8977,
    publicUrl: 'http://localhost:8977',
    publicUrlConfigured: false,
    oauthPort: 8976,
    oauthHost: '127.0.0.1',
    maxAttachmentBytes: 10 * 1024 * 1024,
    licenseServerUrl: 'https://license.invalid',
  };
}

const credentials: ImapCredentials = {
  imap: { host: host!, port: 3993, security: 'tls', user: 'server', password: 'pwd2' },
  smtp: { host: host!, port: 3465, security: 'tls', user: 'server', password: 'pwd2' },
  saveSent: true,
  folderOverrides: { sent: 'Sent', drafts: 'Drafts', trash: 'Trash', archive: 'Archive', spam: 'Spam' },
};

describe.skipIf(!host).sequential('IMAP account persistence integration', () => {
  it('validates credentials and restores drafts and stable IDs after a database restart', async () => {
    const admin = new ImapFlow({
      host: host!,
      port: 3993,
      secure: true,
      auth: { user: 'server', pass: 'pwd2' },
      logger: false,
    });
    await admin.connect();
    try {
      const existing = new Set((await admin.list()).map((folder) => folder.path));
      for (const folder of ['Sent', 'Drafts', 'Trash', 'Archive', 'Spam']) {
        if (!existing.has(folder)) await admin.mailboxCreate(folder);
      }
    } finally {
      await admin.logout();
    }

    const dbPath = path.join(mkdtempSync(path.join(tmpdir(), 'fluxmail-imap-integration-')), 'fluxmail.db');
    const appConfig = config(dbPath);
    let db = openDb(dbPath);
    let registry = new AccountRegistry(db, appConfig);
    expect(await registry.testImapCredentials('server@localhost', credentials)).toEqual([]);
    const owner = addMember(db, { name: 'Owner' });
    const account = registry.addImapAccount('server@localhost', credentials, undefined, owner.id);
    const firstProvider = registry.getProvider(account.id);
    const draft = await firstProvider.createDraft({
      to: [{ email: 'server@localhost' }],
      subject: 'Persistent IMAP draft',
      body: { text: 'survives restart' },
    });
    const schedule = createScheduledSend(db, {
      accountId: account.id,
      draftId: draft.draftId!,
      sendAt: Date.now() - 1_000,
      subject: draft.subject,
      toRecipients: 'server@localhost',
    });
    await (firstProvider as typeof firstProvider & { close(): Promise<void> }).close();
    closeDb(db);

    db = openDb(dbPath);
    registry = new AccountRegistry(db, appConfig);
    const restored = registry.getProvider(account.id);
    const scheduler = new SendScheduler(db, new EmailService(registry, db));
    try {
      await expect(restored.getDraft(draft.draftId!)).resolves.toMatchObject({
        id: draft.id,
        draftId: draft.draftId,
        body: { text: 'survives restart' },
      });
      scheduler.start();
      for (let attempt = 0; attempt < 50 && getScheduledSend(db, schedule.id)?.status !== 'sent'; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(getScheduledSend(db, schedule.id)).toMatchObject({
        status: 'sent',
        sentMessageId: draft.id,
        sentThreadId: draft.threadId,
      });
      await expect(restored.getMessage(draft.id)).resolves.toMatchObject({
        folder: { role: 'sent' },
        flags: { draft: false, read: true },
      });
    } finally {
      scheduler.stop();
      await (restored as typeof restored & { close(): Promise<void> }).close();
      closeDb(db);
    }
  }, 20_000);
});
