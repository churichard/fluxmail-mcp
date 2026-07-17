import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { AccountRegistry } from '../src/accounts/registry.js';
import { isBootstrapComplete, recoverAdminPassword, setupInitialAdmin } from '../src/auth.js';
import type { FluxmailConfig } from '../src/config.js';
import { accountCredentials, accounts, members, openDb } from '../src/storage/db.js';
import { listApiKeys } from '../src/storage/apiKeys.js';

function config(dbPath: string): FluxmailConfig {
  return {
    dataDir: path.dirname(dbPath),
    dbPath,
    encryptionKey: Buffer.alloc(32, 4),
    port: 8977,
    publicUrl: 'http://localhost:8977',
    publicUrlConfigured: false,
    oauthPort: 8976,
    oauthHost: '127.0.0.1',
    maxAttachmentBytes: 1024,
    licenseServerUrl: 'https://license.invalid',
  };
}

describe('breaking authentication migration', () => {
  it('preserves mailbox ownership, grants, sharing, and credentials while revoking old keys', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'fluxmail-auth-migration-'));
    const dbPath = path.join(directory, 'fluxmail.db');
    const sqlite = new Database(dbPath);
    sqlite.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE members (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT,
        role TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      INSERT INTO members VALUES ('member_admin', 'Existing Admin', NULL, 'admin', 1);
      INSERT INTO members VALUES ('member_other_admin', 'Other Admin', 'other-admin@example.com', 'admin', 2);
      INSERT INTO members VALUES ('member_user', 'Existing User', 'user@example.com', 'member', 3);

      CREATE TABLE accounts (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        email TEXT NOT NULL,
        display_name TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        created_at INTEGER NOT NULL,
        member_id TEXT REFERENCES members(id) ON DELETE SET NULL,
        sharing_mode TEXT
      );
      INSERT INTO accounts VALUES ('acct_private', 'gmail', 'private@example.com', NULL, 'active', 10, 'member_admin', 'private');
      INSERT INTO accounts VALUES ('acct_selected', 'gmail', 'selected@example.com', NULL, 'active', 11, 'member_admin', 'selected');
      INSERT INTO accounts VALUES ('acct_all', 'gmail', 'all@example.com', NULL, 'active', 12, NULL, 'all');
      INSERT INTO accounts VALUES ('acct_member', 'gmail', 'member@example.com', NULL, 'active', 13, 'member_user', 'private');

      CREATE TABLE account_member_shares (
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        PRIMARY KEY (account_id, member_id)
      );
      INSERT INTO account_member_shares VALUES ('acct_selected', 'member_user');

      CREATE TABLE oauth_tokens (
        account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
        encrypted_tokens TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO oauth_tokens VALUES ('acct_private', 'encrypted-provider-secret', 20);

      CREATE TABLE api_keys (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        key_hash TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER,
        member_id TEXT REFERENCES members(id) ON DELETE SET NULL,
        permission_profile TEXT NOT NULL DEFAULT 'full',
        custom_capabilities TEXT,
        account_ids TEXT
      );
      INSERT INTO api_keys VALUES ('key_legacy', 'Legacy', 'legacy-hash', 30, NULL, 'member_admin', 'full', NULL, NULL);
    `);
    sqlite.close();

    const db = openDb(dbPath);
    expect(isBootstrapComplete(db)).toBe(false);
    expect(db.select().from(members).all()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'member_admin', role: 'admin', status: 'pending' }),
        expect.objectContaining({ id: 'member_other_admin', role: 'admin', status: 'pending' }),
        expect.objectContaining({ id: 'member_user', role: 'member', status: 'pending' }),
      ]),
    );
    expect(listApiKeys(db)).toEqual([]);
    expect(db.select().from(accountCredentials).all()).toContainEqual(
      expect.objectContaining({ accountId: 'acct_private', encryptedCredentials: 'encrypted-provider-secret' }),
    );
    expect(db.select().from(accounts).all()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'acct_private', ownerMemberId: 'member_admin', sharedWithAll: false }),
        expect.objectContaining({ id: 'acct_selected', ownerMemberId: 'member_admin', sharedWithAll: false }),
        expect.objectContaining({ id: 'acct_all', ownerMemberId: null, sharedWithAll: true }),
        expect.objectContaining({ id: 'acct_member', ownerMemberId: 'member_user', sharedWithAll: false }),
      ]),
    );

    await expect(recoverAdminPassword(db, 'member_other_admin', 'Granite harbor recovery 2026!')).rejects.toMatchObject(
      { code: 'invalid_request' },
    );
    expect(isBootstrapComplete(db)).toBe(false);

    const claimed = await setupInitialAdmin(db, {
      existingAdmin: 'member_admin',
      email: 'claimed-admin@example.com',
      password: 'Granite harbor compass 2026!',
    });
    expect(claimed.member).toMatchObject({
      id: 'member_admin',
      email: 'claimed-admin@example.com',
      role: 'admin',
      status: 'active',
    });
    expect(isBootstrapComplete(db)).toBe(true);
    const migrated = new AccountRegistry(db, config(dbPath)).listAccounts();
    expect(migrated.find((account) => account.id === 'acct_selected')).toMatchObject({
      ownerMemberId: 'member_admin',
      sharedWithAll: false,
      grantedMemberIds: ['member_user'],
    });
    expect(migrated.find((account) => account.id === 'acct_all')).toMatchObject({
      ownerMemberId: 'member_admin',
      sharedWithAll: true,
    });
    expect(migrated.find((account) => account.id === 'acct_member')).toMatchObject({
      ownerMemberId: 'member_user',
    });
  });
});
