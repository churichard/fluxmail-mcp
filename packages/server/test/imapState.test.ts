import { beforeEach, describe, expect, it } from 'vitest';
import { accounts, openDb, type FluxmailDb } from '../src/storage/db.js';
import { SqliteImapStateStore } from '../src/storage/imapState.js';

describe('SqliteImapStateStore', () => {
  let db: FluxmailDb;
  let store: SqliteImapStateStore;

  beforeEach(() => {
    db = openDb(':memory:');
    db.insert(accounts)
      .values({ id: 'acct_1', provider: 'imap', email: 'me@example.com', status: 'active', createdAt: 1 })
      .run();
    store = new SqliteImapStateStore(db, 'acct_1');
  });

  it('keeps stable IDs while a message moves', async () => {
    await store.save({
      id: 'im_1',
      accountId: 'acct_1',
      mailboxPath: 'INBOX',
      uidValidity: '10',
      uid: 2,
      messageId: '<one@example.com>',
      references: ['<root@example.com>'],
      threadId: 'ith_1',
    });
    await store.save({
      ...(await store.findById('im_1'))!,
      mailboxPath: 'Archive',
      uidValidity: '20',
      uid: 9,
    });

    expect(await store.findById('im_1')).toMatchObject({ mailboxPath: 'Archive', uidValidity: '20', uid: 9 });
    expect(await store.findByLocation('Archive', '20', 9)).toMatchObject({ id: 'im_1' });
  });

  it('invalidates locations from an old UIDVALIDITY generation', async () => {
    await store.save({
      id: 'im_old',
      accountId: 'acct_1',
      mailboxPath: 'INBOX',
      uidValidity: '10',
      uid: 2,
      threadId: 'ith_1',
    });
    await store.invalidateMailbox('INBOX', '11');
    expect(await store.findById('im_old')).toBeUndefined();
  });

  it('resolves stable draft and thread records', async () => {
    await store.save({
      id: 'im_draft',
      accountId: 'acct_1',
      mailboxPath: 'Drafts',
      uidValidity: '10',
      uid: 3,
      threadId: 'ith_1',
      draftId: 'draft_1',
    });
    expect(await store.findByDraftId('draft_1')).toMatchObject({ id: 'im_draft' });
    expect(await store.listByThreadId('ith_1')).toHaveLength(1);
  });
});
