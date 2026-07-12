import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { EmailError } from '@fluxmail/core';
import { AccountRegistry } from '../src/accounts/registry.js';
import { accountCredentials, oauthTokens, openDb } from '../src/storage/db.js';
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
    oauthPort: 8976,
    oauthHost: '127.0.0.1',
    authMode: 'apikey',
    licenseServerUrl: 'https://license.invalid',
    google: { clientId: 'id', clientSecret: 'secret' },
  };
}

const tokens = { refresh_token: 'rt_secret', access_token: 'at', expiry_date: 123 };
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
  it('adds an account and stores tokens encrypted', () => {
    const config = testConfig();
    const db = openDb(':memory:');
    const registry = new AccountRegistry(db, config);

    const account = registry.addGmailAccount('me@example.com', tokens);
    expect(account.provider).toBe('gmail');
    expect(account.status).toBe('active');

    const row = db.select().from(accountCredentials).get();
    expect(row?.encryptedCredentials).not.toContain('rt_secret');
    expect(JSON.parse(decryptString(config.encryptionKey, row!.encryptedCredentials)).refresh_token).toBe('rt_secret');
    expect(db.select().from(oauthTokens).get()?.encryptedTokens).toBe(row?.encryptedCredentials);
  });

  it('enforces the Personal-plan mailbox limit', () => {
    const registry = new AccountRegistry(openDb(':memory:'), testConfig());
    registry.addGmailAccount('one@example.com', tokens);
    registry.addGmailAccount('two@example.com', tokens);
    registry.addGmailAccount('three@example.com', tokens);
    try {
      registry.addGmailAccount('four@example.com', tokens);
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
    const account = registry.addImapAccount('me@example.com', imapCredentials);

    expect(account).toMatchObject({
      provider: 'imap',
      capabilities: { labels: false, serverThreads: false, serverSearch: 'basic', snippets: false },
    });
    const row = db.select().from(accountCredentials).get();
    expect(row?.encryptedCredentials).not.toContain('imap_secret');
    expect(JSON.parse(decryptString(config.encryptionKey, row!.encryptedCredentials))).toEqual(imapCredentials);
  });

  it('updates IMAP folder configuration and evicts the cached provider', () => {
    const config = testConfig();
    const registry = new AccountRegistry(openDb(':memory:'), config);
    const account = registry.addImapAccount('me@example.com', imapCredentials);
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
    const registry = new AccountRegistry(openDb(':memory:'), testConfig());
    const account = registry.addImapAccount('me@example.com', imapCredentials);
    expect(() =>
      registry.addImapAccount('other@example.com', imapCredentials, undefined, undefined, account.id),
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

  it('detects the mailbox limit before starting an OAuth flow', () => {
    const registry = new AccountRegistry(openDb(':memory:'), testConfig());
    registry.addGmailAccount('one@example.com', tokens);
    registry.addGmailAccount('two@example.com', tokens);
    registry.addGmailAccount('three@example.com', tokens);

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
    expect(registry.listAccounts()[0]?.memberId).toBe(member.id);
  });

  it('rejects an unknown member when adding a mailbox', () => {
    const registry = new AccountRegistry(openDb(':memory:'), testConfig());
    expect(() => registry.addGmailAccount('one@example.com', tokens, undefined, 'member_nope')).toThrow(
      /No member with id/,
    );
  });

  it('assignAccountMember moves a mailbox between a member and shared', () => {
    const db = openDb(':memory:');
    const registry = new AccountRegistry(db, testConfig());
    const member = addMember(db, { name: 'Alice' });
    const account = registry.addGmailAccount('one@example.com', tokens);
    expect(account.memberId).toBeUndefined();

    expect(registry.assignAccountMember(account.id, member.id).memberId).toBe(member.id);
    expect(registry.assignAccountMember(account.id, null).memberId).toBeUndefined();
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

    expect(() => registry.addGmailAccount('me@example.com', tokens)).toThrow(/token write failed/);
    expect(registry.listAccounts()).toEqual([]);
  });

  it('re-adding the same address re-authenticates instead of erroring', () => {
    const registry = new AccountRegistry(openDb(':memory:'), testConfig());
    const first = registry.addGmailAccount('me@example.com', tokens);
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
    const firstRegistry = new AccountRegistry(openDb(config.dbPath), config);
    const account = firstRegistry.addGmailAccount('me@example.com', tokens);
    const cachedProvider = firstRegistry.getProvider(account.id);

    const secondRegistry = new AccountRegistry(openDb(config.dbPath), config);
    secondRegistry.addGmailAccount('me@example.com', { ...tokens, refresh_token: 'rt_new' });

    expect(firstRegistry.getProvider(account.id)).not.toBe(cachedProvider);
  });

  it('resolveAccountId defaults to the sole account and errors when ambiguous or empty', () => {
    const registry = new AccountRegistry(openDb(':memory:'), testConfig());
    expect(() => registry.resolveAccountId()).toThrow(/No email accounts/);
    const account = registry.addGmailAccount('me@example.com', tokens);
    expect(registry.resolveAccountId()).toBe(account.id);
    expect(registry.resolveAccountId(account.id)).toBe(account.id);
    expect(() => registry.resolveAccountId('acct_nope')).toThrow(EmailError);
  });

  it('removeAccount deletes the account', () => {
    const registry = new AccountRegistry(openDb(':memory:'), testConfig());
    const account = registry.addGmailAccount('me@example.com', tokens);
    registry.removeAccount(account.id);
    expect(registry.listAccounts()).toHaveLength(0);
  });
});
