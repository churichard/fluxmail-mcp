import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { EmailError } from '@fluxmail/core';
import { decryptString, encryptString } from '../src/storage/crypto.js';
import { accounts, apiKeys, gmailConnectionGrants, openDb } from '../src/storage/db.js';
import {
  authenticateApiKey,
  createApiKey,
  listApiKeys,
  revokeApiKey,
  updateApiKeyPermissions,
  verifyApiKey,
} from '../src/storage/apiKeys.js';
import { customPermissionPolicy, permissionPolicyForProfile } from '../src/permissions.js';
import {
  claimGmailConnectionGrant,
  createGmailConnectionGrant,
  gmailConnectionTokenHash,
  GMAIL_CONNECTION_GRANT_TTL_MS,
  inspectGmailConnectionGrant,
} from '../src/storage/gmailConnectionGrants.js';
import { addMember, removeMember } from '../src/storage/members.js';
import {
  assertAccountLimit,
  assertMemberLimit,
  PERSONAL_TIER,
  type Entitlements,
} from '../src/licensing/entitlements.js';

const paidPlan: Entitlements = {
  plan: 'team',
  licensed: true,
  inGrace: false,
  maxMembers: 5,
  maxAccounts: 5,
};

describe('crypto', () => {
  const key = randomBytes(32);

  it('round-trips', () => {
    const packed = encryptString(key, 'secret token json');
    expect(packed).not.toContain('secret');
    expect(decryptString(key, packed)).toBe('secret token json');
  });

  it('rejects tampered ciphertext', () => {
    const packed = encryptString(key, 'data');
    const buf = Buffer.from(packed, 'base64');
    buf[buf.length - 1]! ^= 0xff;
    expect(() => decryptString(key, buf.toString('base64'))).toThrow();
  });

  it('rejects the wrong key', () => {
    const packed = encryptString(key, 'data');
    expect(() => decryptString(randomBytes(32), packed)).toThrow();
  });
});

describe('api keys', () => {
  it('creates, verifies, and revokes', () => {
    const db = openDb(':memory:');
    const { key, info } = createApiKey(db, 'test');
    expect(key).toMatch(/^fmk_/);
    expect(verifyApiKey(db, key)).toBe(true);
    expect(verifyApiKey(db, 'fmk_wrong')).toBe(false);
    expect(listApiKeys(db)[0]).toMatchObject({ permissionProfile: 'full' });
    expect(revokeApiKey(db, info.id)).toBe(true);
    expect(verifyApiKey(db, key)).toBe(false);
  });

  it('allows multiple keys', () => {
    const db = openDb(':memory:');
    createApiKey(db, 'first');
    createApiKey(db, 'second');
    expect(listApiKeys(db)).toHaveLength(2);
  });

  it('issues a key to a member and revokes it when the member is removed', () => {
    const db = openDb(':memory:');
    const member = addMember(db, { name: 'Alice' });
    const { key, info } = createApiKey(db, 'alice-key', member.id);
    expect(info.memberId).toBe(member.id);
    expect(listApiKeys(db)[0]?.memberId).toBe(member.id);

    removeMember(db, member.id);
    expect(listApiKeys(db)).toHaveLength(0);
    expect(verifyApiKey(db, key)).toBe(false);
  });

  it('rejects an unknown member', () => {
    const db = openDb(':memory:');
    expect(() => createApiKey(db, 'key', 'member_nope')).toThrow(/No member with id/);
  });

  it('stores named and custom permission policies', () => {
    const db = openDb(':memory:');
    const readOnly = createApiKey(db, 'reader', undefined, permissionPolicyForProfile('read-only'));
    const custom = createApiKey(db, 'organizer', undefined, customPermissionPolicy(['mail.read', 'mail.trash']));

    expect(authenticateApiKey(db, readOnly.key)?.permissions).toEqual(permissionPolicyForProfile('read-only'));
    expect(authenticateApiKey(db, custom.key)?.permissions).toEqual(
      customPermissionPolicy(['mail.read', 'mail.trash']),
    );
    expect(listApiKeys(db).map((key) => key.permissionProfile)).toEqual(['read-only', 'custom']);
  });

  it('updates permissions without rotating the key', () => {
    const db = openDb(':memory:');
    const { key, info } = createApiKey(db, 'test');

    expect(updateApiKeyPermissions(db, info.id, permissionPolicyForProfile('read-only'))).toBe(true);
    expect(authenticateApiKey(db, key)?.permissions).toEqual(permissionPolicyForProfile('read-only'));
    expect(updateApiKeyPermissions(db, 'key_missing', permissionPolicyForProfile('full'))).toBe(false);
  });

  it('fails authentication closed for malformed stored permissions', () => {
    const db = openDb(':memory:');
    const { key, info } = createApiKey(db, 'test');
    db.update(apiKeys)
      .set({ permissionProfile: 'custom', customCapabilities: '["mail.read","unknown"]' })
      .where(eq(apiKeys.id, info.id))
      .run();

    expect(authenticateApiKey(db, key)).toBeNull();
  });
});

describe('Gmail connection grants', () => {
  it('stores a digest of a 256-bit token and preserves its intent', () => {
    const db = openDb(':memory:');
    const created = createGmailConnectionGrant(db, {
      memberId: 'member_1',
      reauthorizeAccountId: 'acct_1',
    });

    expect(Buffer.from(created.token, 'base64url')).toHaveLength(32);
    const row = db.select().from(gmailConnectionGrants).get();
    expect(row?.tokenHash).toBe(gmailConnectionTokenHash(created.token));
    expect(JSON.stringify(row)).not.toContain(created.token);
    expect(inspectGmailConnectionGrant(db, created.token)).toBe('available');

    expect(claimGmailConnectionGrant(db, created.token)).toEqual({
      status: 'claimed',
      grant: {
        expiresAt: created.expiresAt,
        memberId: 'member_1',
        reauthorizeAccountId: 'acct_1',
      },
    });
    expect(inspectGmailConnectionGrant(db, created.token)).toBe('used');
  });

  it('rejects invalid, expired, and already-used grants', () => {
    const db = openDb(':memory:');
    expect(claimGmailConnectionGrant(db, 'missing')).toEqual({ status: 'invalid' });

    const expired = createGmailConnectionGrant(db, {}, 100);
    expect(inspectGmailConnectionGrant(db, expired.token, 100 + GMAIL_CONNECTION_GRANT_TTL_MS)).toBe('expired');
    expect(claimGmailConnectionGrant(db, expired.token, 100 + GMAIL_CONNECTION_GRANT_TTL_MS)).toEqual({
      status: 'expired',
    });

    const used = createGmailConnectionGrant(db);
    expect(claimGmailConnectionGrant(db, used.token).status).toBe('claimed');
    expect(claimGmailConnectionGrant(db, used.token)).toEqual({ status: 'used' });
  });

  it('allows only one claim when requests race', async () => {
    const db = openDb(':memory:');
    const { token } = createGmailConnectionGrant(db);
    const claims = await Promise.all([
      Promise.resolve().then(() => claimGmailConnectionGrant(db, token)),
      Promise.resolve().then(() => claimGmailConnectionGrant(db, token)),
    ]);

    expect(claims.filter((claim) => claim.status === 'claimed')).toHaveLength(1);
    expect(claims.filter((claim) => claim.status === 'used')).toHaveLength(1);
  });
});

describe('account storage', () => {
  it('prevents duplicate provider and email pairs', () => {
    const db = openDb(':memory:');
    db.insert(accounts)
      .values({
        id: 'acct_1',
        provider: 'gmail',
        email: 'me@example.com',
        status: 'active',
        createdAt: Date.now(),
      })
      .run();

    expect(() =>
      db
        .insert(accounts)
        .values({
          id: 'acct_2',
          provider: 'gmail',
          email: 'me@example.com',
          status: 'active',
          createdAt: Date.now(),
        })
        .run(),
    ).toThrow();
  });
});

describe('entitlements', () => {
  it('the Personal plan allows 3 mailboxes and 1 member', () => {
    expect(() => assertAccountLimit(2, PERSONAL_TIER)).not.toThrow();
    expect(() => assertAccountLimit(3, PERSONAL_TIER)).toThrow(/Personal plan allows 3 connected mailboxes/);
    expect(() => assertMemberLimit(0, PERSONAL_TIER)).not.toThrow();
    expect(() => assertMemberLimit(1, PERSONAL_TIER)).toThrow(/Personal plan allows 1 member/);
  });

  it('throws entitlement_exceeded', () => {
    try {
      assertAccountLimit(3, PERSONAL_TIER);
      expect.unreachable();
    } catch (err) {
      expect((err as EmailError).code).toBe('entitlement_exceeded');
    }
  });

  it('names the plan from the lease when a license is active', () => {
    expect(() => assertAccountLimit(5, paidPlan)).toThrow(/Your team plan allows 5 connected mailboxes/);
    expect(() => assertMemberLimit(5, paidPlan)).toThrow(/Your team plan allows 5 members/);
  });
});
