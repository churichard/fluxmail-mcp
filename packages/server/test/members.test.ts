import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EmailError } from '@fluxmail/core';
import { accounts, openDb } from '../src/storage/db.js';
import { addMember, findMember, getMember, listMembers, removeMember, setMemberRole } from '../src/storage/members.js';
import { authenticateApiKey, createApiKey, listApiKeys } from '../src/storage/apiKeys.js';
import {
  assertWithinQuota,
  checkLicenseState,
  GRACE_PERIOD_MS,
  saveLeaseToken,
} from '../src/licensing/entitlements.js';

function makeKeypair(): { privateKey: KeyObject; publicKeyB64: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    privateKey,
    publicKeyB64: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
  };
}

function signLease(privateKey: KeyObject, payload: Record<string, unknown>): string {
  const bytes = Buffer.from(JSON.stringify(payload));
  const signature = sign(null, bytes, privateKey);
  return `${bytes.toString('base64url')}.${signature.toString('base64url')}`;
}

const keys = makeKeypair();

function leaseToken(overrides: Record<string, unknown> = {}): string {
  return signLease(keys.privateKey, {
    v: 2,
    licenseId: 'd2f7c1e0-0000-4000-8000-000000000000',
    plan: 'team',
    maxMembers: 3,
    maxAccounts: 5,
    issuedAt: new Date(Date.now() - 1000).toISOString(),
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    ...overrides,
  });
}

function insertAccount(db: ReturnType<typeof openDb>, email: string): void {
  db.insert(accounts)
    .values({ id: `acct_${email}`, provider: 'gmail', email, status: 'active', createdAt: Date.now() })
    .run();
}

describe('members', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('adds, lists, and looks up members by id or email', () => {
    const db = openDb(':memory:');
    const member = addMember(db, { name: 'Alice', email: 'Alice@Example.com' });
    expect(member.id).toMatch(/^member_[0-9a-f]{12}$/);
    expect(member.email).toBe('alice@example.com');
    expect(member.role).toBe('admin');

    expect(getMember(db, member.id).name).toBe('Alice');
    expect(findMember(db, member.id).id).toBe(member.id);
    expect(findMember(db, 'alice@example.com').id).toBe(member.id);
    expect(listMembers(db)).toHaveLength(1);
    expect(() => findMember(db, 'nobody@example.com')).toThrow(/No member/);
  });

  it('uses explicit roles and reads role changes immediately', () => {
    const db = openDb(':memory:');
    const member = addMember(db, { name: 'Alice', role: 'member' });
    expect(member.role).toBe('member');
    expect(setMemberRole(db, member.id, 'admin').role).toBe('admin');
    expect(getMember(db, member.id).role).toBe('admin');
  });

  it('rejects a duplicate email', () => {
    const db = openDb(':memory:');
    addMember(db, { name: 'Alice', email: 'alice@example.com' });
    expect(() => addMember(db, { name: 'Alias', email: 'alice@example.com' })).toThrow(/already exists/);
  });

  it('enforces the Personal-plan seat limit', () => {
    const db = openDb(':memory:');
    addMember(db, { name: 'Alice' });
    try {
      addMember(db, { name: 'Bob' });
      expect.unreachable();
    } catch (err) {
      expect((err as EmailError).code).toBe('entitlement_exceeded');
      expect((err as EmailError).message).toMatch(/Personal plan allows 1 member/);
    }
  });

  it('allows seats up to the licensed cap', () => {
    vi.stubEnv('FLUXMAIL_LICENSE_PUBLIC_KEYS', keys.publicKeyB64);
    const db = openDb(':memory:');
    saveLeaseToken(db, leaseToken({ maxMembers: 3 }));

    addMember(db, { name: 'Alice' });
    addMember(db, { name: 'Bob' });
    addMember(db, { name: 'Carol' });
    expect(() => addMember(db, { name: 'Dave' })).toThrow(/team plan allows 3 members/);
  });

  it('blocks owner removal, then revokes keys after the mailbox is removed', () => {
    const db = openDb(':memory:');
    const member = addMember(db, { name: 'Alice' });
    db.insert(accounts)
      .values({
        id: 'acct_1',
        provider: 'gmail',
        email: 'me@example.com',
        status: 'active',
        createdAt: Date.now(),
        memberId: member.id,
      })
      .run();
    createApiKey(db, 'alice-key', member.id);

    expect(() => removeMember(db, member.id)).toThrow(/still owns 1 mailbox/);
    db.delete(accounts).run();
    const result = removeMember(db, member.id);
    expect(result).toEqual({ name: 'Alice', revokedApiKeys: 1 });
    expect(listMembers(db)).toHaveLength(0);
    // The member's key is gone, not promoted to an unscoped admin key.
    expect(listApiKeys(db)).toEqual([]);
  });
});

describe('plan quota', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('is within quota on a fresh Personal instance', () => {
    const db = openDb(':memory:');
    const state = assertWithinQuota(db);
    expect(state.overQuota).toBe(false);
    expect(state.warning).toBeUndefined();
  });

  it('warns while the license is in its grace period', () => {
    vi.stubEnv('FLUXMAIL_LICENSE_PUBLIC_KEYS', keys.publicKeyB64);
    const db = openDb(':memory:');
    saveLeaseToken(db, leaseToken({ expiresAt: new Date(Date.now() - 1000).toISOString() }));

    const state = assertWithinQuota(db);
    expect(state.entitlements.inGrace).toBe(true);
    expect(state.warning).toMatch(/expired .* paid limits continue until/i);
  });

  it('blocks once a lapsed license leaves the instance over quota, and clears after trimming', () => {
    vi.stubEnv('FLUXMAIL_LICENSE_PUBLIC_KEYS', keys.publicKeyB64);
    const db = openDb(':memory:');
    // 5 mailboxes were allowed under the team lease…
    saveLeaseToken(db, leaseToken({ maxAccounts: 5 }));
    for (const email of ['a@x.com', 'b@x.com', 'c@x.com', 'd@x.com', 'e@x.com']) insertAccount(db, email);
    expect(assertWithinQuota(db).overQuota).toBe(false);

    // …then the lease lapses past the grace period.
    const lapsed = new Date(Date.now() - GRACE_PERIOD_MS - 1000).toISOString();
    saveLeaseToken(db, leaseToken({ maxAccounts: 5, expiresAt: lapsed }));
    expect(() => assertWithinQuota(db)).toThrow(/Renew the license .* or remove mailboxes\/members/s);
    expect(checkLicenseState(db).warning).toMatch(/lapsed/);

    // Trimming usage back under the Personal caps unblocks immediately.
    const rows = db.select().from(accounts).all();
    for (const row of rows.slice(0, 2)) {
      db.delete(accounts).where(eq(accounts.id, row.id)).run();
    }
    expect(assertWithinQuota(db).overQuota).toBe(false);
  });
});

describe('API key migrations', () => {
  it('promotes only the earliest existing member during role migration', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'fluxmail-role-migrate-'));
    const dbPath = path.join(dir, 'fluxmail.db');
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE members (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT,
        created_at INTEGER NOT NULL
      );
      INSERT INTO members VALUES ('member_later', 'Later', NULL, 2);
      INSERT INTO members VALUES ('member_first', 'First', NULL, 1);
    `);
    raw.close();

    expect(listMembers(openDb(dbPath)).map(({ id, role }) => ({ id, role }))).toEqual([
      { id: 'member_later', role: 'member' },
      { id: 'member_first', role: 'admin' },
    ]);
  });

  it('adds member scope and full permissions to a pre-members database', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'fluxmail-migrate-'));
    const dbPath = path.join(dir, 'fluxmail.db');
    const raw = new Database(dbPath);
    const legacyKey = 'fmk_legacy_system';
    const legacyHash = createHash('sha256').update(legacyKey).digest('hex');
    raw.exec(`
      CREATE TABLE accounts (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        email TEXT NOT NULL,
        display_name TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        created_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX accounts_provider_email_unique ON accounts(provider, email);
      CREATE TABLE api_keys (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        key_hash TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER
      );
      INSERT INTO accounts (id, provider, email, created_at) VALUES ('acct_1', 'gmail', 'me@example.com', 1);
      INSERT INTO api_keys (id, name, key_hash, created_at) VALUES ('key_1', 'old', '${legacyHash}', 1);
    `);
    raw.close();

    const db = openDb(dbPath);
    const account = db.select().from(accounts).all()[0];
    expect(account?.id).toBe('acct_1');
    expect(account?.memberId).toBeNull();
    expect(account?.sharingMode).toBe('all');
    expect(listApiKeys(db)[0]).toMatchObject({ memberId: null, permissionProfile: 'full', accountIds: null });
    expect(authenticateApiKey(db, legacyKey)).toMatchObject({ memberId: null, role: null, accountIds: null });
    // The first member becomes the owner while migrated sharing stays global.
    const member = addMember(db, { name: 'Alice' });
    expect(db.select().from(accounts).all()[0]?.memberId).toBe(member.id);
    expect(db.select().from(accounts).all()[0]?.sharingMode).toBe('all');
  });
});
