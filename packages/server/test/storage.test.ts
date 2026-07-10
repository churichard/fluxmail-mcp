import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { EmailError } from '@fluxmail/core';
import { decryptString, encryptString } from '../src/storage/crypto.js';
import { accounts, openDb } from '../src/storage/db.js';
import { createApiKey, listApiKeys, revokeApiKey, verifyApiKey } from '../src/storage/apiKeys.js';
import { assertAccountLimit, FREE_TIER } from '../src/licensing/entitlements.js';

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
  it('free tier allows 1 account', () => {
    expect(() => assertAccountLimit(0, FREE_TIER)).not.toThrow();
    expect(() => assertAccountLimit(1, FREE_TIER)).toThrow(/free tier/);
  });

  it('throws entitlement_exceeded', () => {
    try {
      assertAccountLimit(1, FREE_TIER);
      expect.unreachable();
    } catch (err) {
      expect((err as EmailError).code).toBe('entitlement_exceeded');
    }
  });

  it('names the paid tier limit when a license is active', () => {
    expect(() => assertAccountLimit(5, { maxAccounts: 5, tier: 'paid' })).toThrow(
      /Your license allows 5 accounts/
    );
  });
});
