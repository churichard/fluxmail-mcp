import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { EmailError } from '@fluxmail/core';
import { decryptString, encryptString } from '../src/storage/crypto.js';
import { accounts, openDb } from '../src/storage/db.js';
import { createApiKey, listApiKeys, revokeApiKey, verifyApiKey } from '../src/storage/apiKeys.js';
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
    expect(listApiKeys(db)).toHaveLength(1);
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
      db.insert(accounts)
        .values({
          id: 'acct_2',
          provider: 'gmail',
          email: 'me@example.com',
          status: 'active',
          createdAt: Date.now(),
        })
        .run()
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
