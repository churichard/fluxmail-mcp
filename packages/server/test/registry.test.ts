import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EmailError } from '@fluxmail/core';
import { AccountRegistry } from '../src/accounts/registry.js';
import { accountCredentials, accounts, members, oauthTokens, openDb } from '../src/storage/db.js';
import { addMember } from '../src/storage/members.js';
import { decryptString } from '../src/storage/crypto.js';
import type { FluxmailConfig } from '../src/config.js';

function testConfig(): FluxmailConfig {
  return {
    dataDir: '/tmp',
    dbPath: ':memory:',
    encryptionKey: randomBytes(32),
    port: 8977,
    publicUrl: 'http://localhost:8977',
    publicUrlConfigured: false,
    oauthPort: 8976,
    oauthHost: '127.0.0.1',
    authMode: 'apikey',
    maxAttachmentBytes: 10 * 1024 * 1024,
    licenseServerUrl: 'https://license.invalid',
    google: { clientId: 'id', clientSecret: 'secret' },
    microsoft: { clientId: 'microsoft-id', tenantId: 'common' },
  };
}

const tokens = { refresh_token: 'rt_secret', access_token: 'at', expiry_date: 123 };
const microsoftCredentials = {
  accessToken: 'ms_access_secret',
  refreshToken: 'ms_refresh_secret',
  expiresAt: Date.now() + 3_600_000,
};
const imapCredentials = {
  imap: { host: 'imap.example.com', port: 993, security: 'tls' as const, user: 'me', password: 'imap_secret' },
  smtp: {
    host: 'smtp.example.com',
    port: 587,
    security: 'starttls' as const,
    user: 'me',
    password: 'smtp_secret',
  },
  saveSent: true,
};

describe('AccountRegistry', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('adds an account and stores tokens encrypted', () => {
    const config = testConfig();
    const db = openDb(':memory:');
    const registry = new AccountRegistry(db, config);
    const owner = addMember(db, { name: 'Owner' });

    const account = registry.addGmailAccount('me@example.com', tokens, undefined, owner.id);
    expect(account.provider).toBe('gmail');
    expect(account.status).toBe('active');

    const row = db.select().from(accountCredentials).get();
    expect(row?.encryptedCredentials).not.toContain('rt_secret');
    expect(JSON.parse(decryptString(config.encryptionKey, row!.encryptedCredentials)).refresh_token).toBe('rt_secret');
    expect(db.select().from(oauthTokens).get()?.encryptedTokens).toBe(row?.encryptedCredentials);
  });

  it('enforces the Personal-plan mailbox limit', () => {
    const db = openDb(':memory:');
    const registry = new AccountRegistry(db, testConfig());
    const owner = addMember(db, { name: 'Owner' });
    registry.addGmailAccount('one@example.com', tokens, undefined, owner.id);
    registry.addGmailAccount('two@example.com', tokens, undefined, owner.id);
    registry.addGmailAccount('three@example.com', tokens, undefined, owner.id);
    try {
      registry.addGmailAccount('four@example.com', tokens, undefined, owner.id);
      expect.unreachable();
    } catch (err) {
      expect((err as EmailError).code).toBe('entitlement_exceeded');
      expect((err as EmailError).message).toMatch(/Personal plan allows 3 connected mailboxes/);
    }
  });

  it('adds an IMAP account with encrypted credentials and IMAP capabilities', () => {
    const config = testConfig();
    const db = openDb(':memory:');
    const registry = new AccountRegistry(db, config);
    const owner = addMember(db, { name: 'Owner' });
    const account = registry.addImapAccount('me@example.com', imapCredentials, undefined, owner.id);

    expect(account).toMatchObject({
      provider: 'imap',
      capabilities: { labels: false, serverThreads: false, serverSearch: 'basic', snippets: false },
    });
    const row = db.select().from(accountCredentials).get();
    expect(row?.encryptedCredentials).not.toContain('imap_secret');
    expect(JSON.parse(decryptString(config.encryptionKey, row!.encryptedCredentials))).toEqual(imapCredentials);
  });

  it('adds an Outlook account with encrypted Graph credentials and Outlook capabilities', () => {
    const config = testConfig();
    const db = openDb(':memory:');
    const registry = new AccountRegistry(db, config);
    const owner = addMember(db, { name: 'Owner' });

    const account = registry.addOutlookAccount('me@example.com', microsoftCredentials, 'Example User', owner.id);

    expect(account).toMatchObject({
      provider: 'outlook',
      displayName: 'Example User',
      capabilities: { labels: false, serverThreads: true, serverSearch: 'rich', snippets: true },
    });
    const row = db.select().from(accountCredentials).get();
    expect(row?.encryptedCredentials).not.toContain('ms_refresh_secret');
    expect(JSON.parse(decryptString(config.encryptionKey, row!.encryptedCredentials))).toEqual(microsoftCredentials);
    expect(db.select().from(oauthTokens).get()?.encryptedTokens).toBe(row?.encryptedCredentials);
  });

  it('reauthorizes an Outlook account without changing its id or owner', () => {
    const db = openDb(':memory:');
    const registry = new AccountRegistry(db, testConfig());
    const owner = addMember(db, { name: 'Owner' });
    const first = registry.addOutlookAccount('me@example.com', microsoftCredentials, undefined, owner.id);

    const second = registry.addOutlookAccount(
      'ME@example.com',
      { ...microsoftCredentials, refreshToken: 'rotated-refresh' },
      'Updated Name',
      undefined,
      first.id,
    );

    expect(second).toMatchObject({ id: first.id, ownerId: owner.id, displayName: 'Updated Name' });
    expect(registry.listAccounts()).toHaveLength(1);
  });

  it('refreshes and persists expired Outlook credentials', async () => {
    const config = testConfig();
    const db = openDb(':memory:');
    const registry = new AccountRegistry(db, config);
    const owner = addMember(db, { name: 'Owner' });
    const account = registry.addOutlookAccount(
      'me@example.com',
      { ...microsoftCredentials, expiresAt: 0 },
      undefined,
      owner.id,
    );
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('login.microsoftonline.com')) {
        return new Response(
          JSON.stringify({ access_token: 'fresh-access', refresh_token: 'fresh-refresh', expires_in: 3600 }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ id: 'user-id' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    await registry.getProvider(account.id).testConnection();

    const stored = JSON.parse(
      decryptString(config.encryptionKey, db.select().from(accountCredentials).get()!.encryptedCredentials),
    );
    expect(stored).toMatchObject({ accessToken: 'fresh-access', refreshToken: 'fresh-refresh' });
  });

  it('updates IMAP folder configuration and evicts the cached provider', () => {
    const config = testConfig();
    const db = openDb(':memory:');
    const registry = new AccountRegistry(db, config);
    const owner = addMember(db, { name: 'Owner' });
    const account = registry.addImapAccount('me@example.com', imapCredentials, undefined, owner.id);
    const firstProvider = registry.getProvider(account.id);
    const updated = { ...imapCredentials, folderOverrides: { sent: 'Sent Items', drafts: 'Drafts' } };

    registry.saveImapCredentials(account.id, updated);

    expect(registry.loadImapCredentials(account.id)).toEqual(updated);
    expect(registry.getProvider(account.id)).not.toBe(firstProvider);
  });

  it('reauthorizes an IMAP account without changing its id or owner', () => {
    const db = openDb(':memory:');
    const registry = new AccountRegistry(db, testConfig());
    const member = addMember(db, { name: 'Alice' });
    const first = registry.addImapAccount('me@example.com', imapCredentials, 'Old Name', member.id);
    const updated = {
      ...imapCredentials,
      imap: { ...imapCredentials.imap, password: 'new_imap_secret' },
    };

    const second = registry.addImapAccount('me@example.com', updated, 'New Name', undefined, first.id);

    expect(second).toMatchObject({ id: first.id, memberId: member.id, displayName: 'New Name' });
    expect(registry.loadImapCredentials(first.id)).toEqual(updated);
  });

  it('rejects reauthorization for a different IMAP mailbox', () => {
    const db = openDb(':memory:');
    const registry = new AccountRegistry(db, testConfig());
    const owner = addMember(db, { name: 'Owner' });
    const account = registry.addImapAccount('me@example.com', imapCredentials, undefined, owner.id);
    expect(() =>
      registry.addImapAccount('other@example.com', imapCredentials, undefined, owner.id, account.id),
    ).toThrow(/does not match IMAP mailbox/);
  });

  it('migrates legacy Gmail OAuth rows into generic credentials', () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'fluxmail-credentials-'));
    const dbPath = path.join(dataDir, 'fluxmail.db');
    const sqlite = new Database(dbPath);
    sqlite.exec(`
      CREATE TABLE accounts (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        email TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created_at INTEGER NOT NULL
      );
      CREATE TABLE oauth_tokens (
        account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
        encrypted_tokens TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO accounts VALUES ('acct_legacy', 'gmail', 'legacy@example.com', 'active', 1);
      INSERT INTO oauth_tokens VALUES ('acct_legacy', 'encrypted-value', 2);
    `);
    sqlite.close();

    const db = openDb(dbPath);
    expect(db.select().from(accountCredentials).get()).toMatchObject({
      accountId: 'acct_legacy',
      encryptedCredentials: 'encrypted-value',
      updatedAt: 2,
    });
  });

  it('keeps Gmail and cascades cleanup for legacy cross-provider duplicates', () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'fluxmail-deduplicate-'));
    const dbPath = path.join(dataDir, 'fluxmail.db');
    const sqlite = new Database(dbPath);
    sqlite.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE accounts (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        email TEXT NOT NULL,
        display_name TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        created_at INTEGER NOT NULL
      );
      CREATE TABLE account_credentials (
        account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
        encrypted_credentials TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO accounts VALUES ('acct_imap', 'imap', 'Me@example.com', NULL, 'active', 1);
      INSERT INTO accounts VALUES ('acct_gmail', 'gmail', 'me@example.com', NULL, 'active', 2);
      INSERT INTO account_credentials VALUES ('acct_imap', 'imap-secret', 1);
      INSERT INTO account_credentials VALUES ('acct_gmail', 'gmail-secret', 2);
    `);
    sqlite.close();

    const db = openDb(dbPath);
    expect(new AccountRegistry(db, testConfig()).listAccounts().map((account) => account.id)).toEqual(['acct_gmail']);
    expect(
      db
        .select()
        .from(accountCredentials)
        .all()
        .map((row) => row.accountId),
    ).toEqual(['acct_gmail']);
    expect(() =>
      db
        .insert(accounts)
        .values({
          id: 'acct_duplicate',
          provider: 'imap',
          email: 'ME@EXAMPLE.COM',
          status: 'active',
          createdAt: 3,
          sharingMode: 'all',
        })
        .run(),
    ).toThrow(/UNIQUE/);
  });

  it('detects the mailbox limit before starting an OAuth flow', () => {
    const db = openDb(':memory:');
    const registry = new AccountRegistry(db, testConfig());
    const owner = addMember(db, { name: 'Owner' });
    registry.addGmailAccount('one@example.com', tokens, undefined, owner.id);
    registry.addGmailAccount('two@example.com', tokens, undefined, owner.id);
    registry.addGmailAccount('three@example.com', tokens, undefined, owner.id);

    expect(() => registry.assertCanAddAccount()).toThrow(
      /Personal plan allows 3 connected mailboxes.*--reauthorize <account-id>/,
    );
  });

  it('stores and reports the owning member of a mailbox', () => {
    const db = openDb(':memory:');
    const registry = new AccountRegistry(db, testConfig());
    const member = addMember(db, { name: 'Alice', email: 'alice@example.com' });

    const account = registry.addGmailAccount('one@example.com', tokens, undefined, member.id);
    expect(account.memberId).toBe(member.id);
    expect(account.ownerId).toBe(member.id);
    expect(account.sharingMode).toBe('private');
    expect(registry.listAccounts()[0]?.memberId).toBe(member.id);
  });

  it('replaces private, global, and selected mailbox access', () => {
    const db = openDb(':memory:');
    const registry = new AccountRegistry(db, testConfig());
    const owner = addMember(db, { name: 'Owner' });
    db.insert(members)
      .values({ id: 'member_guest', name: 'Guest', email: null, role: 'member', createdAt: Date.now() + 1 })
      .run();
    const account = registry.addGmailAccount('one@example.com', tokens, undefined, owner.id);

    expect(registry.setAccountAccess(account.id, { sharingMode: 'all' }).sharingMode).toBe('all');
    expect(
      registry.setAccountAccess(account.id, { sharingMode: 'selected', sharedMemberIds: ['member_guest'] }),
    ).toMatchObject({ sharingMode: 'selected', sharedMemberIds: ['member_guest'] });
    expect(registry.setAccountAccess(account.id, { sharingMode: 'private' })).toMatchObject({
      sharingMode: 'private',
      sharedMemberIds: [],
    });
  });

  it('treats mailbox addresses as case-insensitive across providers', () => {
    const db = openDb(':memory:');
    const registry = new AccountRegistry(db, testConfig());
    const owner = addMember(db, { name: 'Owner' });
    const first = registry.addGmailAccount('Me@Example.com', tokens, undefined, owner.id);
    expect(registry.addGmailAccount('me@example.com', tokens, undefined, owner.id).id).toBe(first.id);
    expect(() => registry.addImapAccount('ME@example.com', imapCredentials, undefined, owner.id)).toThrow(
      /already connected through gmail/,
    );
    expect(registry.findAccount('mE@EXAMPLE.com').id).toBe(first.id);
  });

  it('rejects an unknown member when adding a mailbox', () => {
    const registry = new AccountRegistry(openDb(':memory:'), testConfig());
    expect(() => registry.addGmailAccount('one@example.com', tokens, undefined, 'member_nope')).toThrow(
      /No member with id/,
    );
  });

  it('requires an owner during creation and reassignment', () => {
    const db = openDb(':memory:');
    const registry = new AccountRegistry(db, testConfig());
    const member = addMember(db, { name: 'Alice' });
    expect(() => registry.addGmailAccount('one@example.com', tokens)).toThrow(/owner is required/i);
    const account = registry.addGmailAccount('one@example.com', tokens, undefined, member.id);

    expect(registry.assignAccountMember(account.id, member.id).memberId).toBe(member.id);
    expect(() => registry.assignAccountMember(account.id, null)).toThrow(/must have an owner/i);
  });

  it('re-authenticating keeps the existing owner', () => {
    const db = openDb(':memory:');
    const registry = new AccountRegistry(db, testConfig());
    const member = addMember(db, { name: 'Alice' });
    const first = registry.addGmailAccount('me@example.com', tokens, undefined, member.id);

    const second = registry.addGmailAccount('me@example.com', { ...tokens, refresh_token: 'rt_new' });
    expect(second.id).toBe(first.id);
    expect(second.memberId).toBe(member.id);
  });

  it('rolls back the account when storing its tokens fails', () => {
    const db = openDb(':memory:');
    const sqlite = (db as unknown as { $client: { exec(sql: string): void } }).$client;
    sqlite.exec(`
      CREATE TRIGGER reject_account_credentials
      BEFORE INSERT ON account_credentials
      BEGIN
        SELECT RAISE(ABORT, 'token write failed');
      END;
    `);
    const registry = new AccountRegistry(db, testConfig());
    const owner = addMember(db, { name: 'Owner' });

    expect(() => registry.addGmailAccount('me@example.com', tokens, undefined, owner.id)).toThrow(/token write failed/);
    expect(registry.listAccounts()).toEqual([]);
  });

  it('re-adding the same address re-authenticates instead of erroring', () => {
    const db = openDb(':memory:');
    const registry = new AccountRegistry(db, testConfig());
    const owner = addMember(db, { name: 'Owner' });
    const first = registry.addGmailAccount('me@example.com', tokens, undefined, owner.id);
    const second = registry.addGmailAccount('me@example.com', { ...tokens, refresh_token: 'rt_new' });
    expect(second.id).toBe(first.id);
    expect(registry.listAccounts()).toHaveLength(1);
  });

  it('reloads a cached provider when another process updates its tokens', () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'fluxmail-registry-'));
    const config = {
      ...testConfig(),
      dataDir,
      dbPath: path.join(dataDir, 'fluxmail.db'),
    };
    const firstDb = openDb(config.dbPath);
    const firstRegistry = new AccountRegistry(firstDb, config);
    const owner = addMember(firstDb, { name: 'Owner' });
    const account = firstRegistry.addGmailAccount('me@example.com', tokens, undefined, owner.id);
    const cachedProvider = firstRegistry.getProvider(account.id);

    const secondRegistry = new AccountRegistry(openDb(config.dbPath), config);
    secondRegistry.addGmailAccount('me@example.com', { ...tokens, refresh_token: 'rt_new' });

    expect(firstRegistry.getProvider(account.id)).not.toBe(cachedProvider);
  });

  it('resolveAccountId defaults to the sole account and errors when ambiguous or empty', () => {
    const db = openDb(':memory:');
    const registry = new AccountRegistry(db, testConfig());
    expect(() => registry.resolveAccountId()).toThrow(/No email accounts/);
    const owner = addMember(db, { name: 'Owner' });
    const account = registry.addGmailAccount('me@example.com', tokens, undefined, owner.id);
    expect(registry.resolveAccountId()).toBe(account.id);
    expect(registry.resolveAccountId(account.id)).toBe(account.id);
    expect(() => registry.resolveAccountId('acct_nope')).toThrow(EmailError);
  });

  it('removeAccount deletes the account', () => {
    const db = openDb(':memory:');
    const registry = new AccountRegistry(db, testConfig());
    const owner = addMember(db, { name: 'Owner' });
    const account = registry.addGmailAccount('me@example.com', tokens, undefined, owner.id);
    registry.removeAccount(account.id);
    expect(registry.listAccounts()).toHaveLength(0);
  });
});
