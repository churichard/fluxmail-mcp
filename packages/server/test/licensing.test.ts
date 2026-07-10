import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { verifyLease, licensePublicKeys, type LeasePayload } from '../src/licensing/lease.js';
import { validateLicense } from '../src/licensing/client.js';
import {
  clearLease,
  FREE_TIER,
  getEntitlements,
  readLeaseRow,
  saveLeaseToken,
} from '../src/licensing/entitlements.js';
import { loadInstanceId, refreshLicense } from '../src/licensing/refresher.js';
import { activateLicense } from '../src/licensing/activation.js';
import { readStoredConfig, setStoredConfig } from '../src/config.js';
import { openDb } from '../src/storage/db.js';

function makeKeypair(): { privateKey: KeyObject; publicKeyB64: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    privateKey,
    publicKeyB64: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
  };
}

function leasePayload(overrides: Partial<Record<keyof LeasePayload, unknown>> = {}): Record<string, unknown> {
  return {
    v: 1,
    licenseId: 'd2f7c1e0-0000-4000-8000-000000000000',
    maxAccounts: 5,
    issuedAt: new Date(Date.now() - 1000).toISOString(),
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

function signLease(privateKey: KeyObject, payload: Record<string, unknown>): string {
  const bytes = Buffer.from(JSON.stringify(payload));
  const signature = sign(null, bytes, privateKey);
  return `${bytes.toString('base64url')}.${signature.toString('base64url')}`;
}

const keys = makeKeypair();

describe('verifyLease', () => {
  it('accepts a validly signed lease and returns its payload', () => {
    const payload = leasePayload();
    const lease = verifyLease(signLease(keys.privateKey, payload), [keys.publicKeyB64]);
    expect(lease).toEqual(payload);
  });

  it('accepts a lease signed by any key in the pin list (rotation)', () => {
    const newKeys = makeKeypair();
    const token = signLease(newKeys.privateKey, leasePayload());
    expect(() => verifyLease(token, [keys.publicKeyB64, newKeys.publicKeyB64])).not.toThrow();
  });

  it('rejects a lease signed by an unpinned key', () => {
    const rogue = makeKeypair();
    const token = signLease(rogue.privateKey, leasePayload());
    expect(() => verifyLease(token, [keys.publicKeyB64])).toThrow(/signature/);
  });

  it('rejects a tampered payload', () => {
    const token = signLease(keys.privateKey, leasePayload());
    const [, signature] = token.split('.');
    const forged = Buffer.from(JSON.stringify(leasePayload({ maxAccounts: 500 }))).toString('base64url');
    expect(() => verifyLease(`${forged}.${signature}`, [keys.publicKeyB64])).toThrow(/signature/);
  });

  it('rejects tokens that are not exactly two base64url parts', () => {
    const token = signLease(keys.privateKey, leasePayload());
    expect(() => verifyLease('justonepart', [keys.publicKeyB64])).toThrow(/malformed/);
    expect(() => verifyLease(`${token}.extra`, [keys.publicKeyB64])).toThrow(/malformed/);
    expect(() => verifyLease('not+base64url!.abc', [keys.publicKeyB64])).toThrow(/malformed/);
  });

  it('rejects a signed payload that is not JSON', () => {
    const bytes = Buffer.from('not json');
    const signature = sign(null, bytes, keys.privateKey);
    const token = `${bytes.toString('base64url')}.${signature.toString('base64url')}`;
    expect(() => verifyLease(token, [keys.publicKeyB64])).toThrow(/JSON/);
  });

  it('rejects unknown payload versions', () => {
    const token = signLease(keys.privateKey, leasePayload({ v: 2 }));
    expect(() => verifyLease(token, [keys.publicKeyB64])).toThrow(/version/);
  });

  it('rejects an expired lease', () => {
    const token = signLease(
      keys.privateKey,
      leasePayload({ expiresAt: new Date(Date.now() - 1000).toISOString() })
    );
    expect(() => verifyLease(token, [keys.publicKeyB64])).toThrow(/expired/);
  });

  it('rejects invalid limit fields', () => {
    for (const bad of [{ maxAccounts: 0 }, { maxAccounts: '5' }]) {
      const token = signLease(keys.privateKey, leasePayload(bad));
      expect(() => verifyLease(token, [keys.publicKeyB64])).toThrow(/invalid max/);
    }
  });

  it('rejects everything when no keys are pinned', () => {
    const token = signLease(keys.privateKey, leasePayload());
    expect(() => verifyLease(token, [])).toThrow(/signature/);
  });
});

describe('licensePublicKeys', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('adds keys from FLUXMAIL_LICENSE_PUBLIC_KEYS to the pinned list', () => {
    vi.stubEnv('FLUXMAIL_LICENSE_PUBLIC_KEYS', ` ${keys.publicKeyB64} , second-key `);
    expect(licensePublicKeys()).toEqual(expect.arrayContaining([keys.publicKeyB64, 'second-key']));
  });

  it('ignores FLUXMAIL_LICENSE_PUBLIC_KEYS under NODE_ENV=production', () => {
    vi.stubEnv('FLUXMAIL_LICENSE_PUBLIC_KEYS', keys.publicKeyB64);
    vi.stubEnv('NODE_ENV', 'production');
    expect(licensePublicKeys()).not.toContain(keys.publicKeyB64);
  });
});

function fakeFetch(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>
): { fetchImpl: typeof fetch; calls: Array<{ url: string; body: unknown }> } {
  const calls: Array<{ url: string; body: unknown }> = [];
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return handler(String(url), init!);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe('validateLicense', () => {
  const licenseKey = `fluxmail_lic_${'ab'.repeat(20)}`;

  it('posts the key and instance id to the validate endpoint', async () => {
    const { fetchImpl, calls } = fakeFetch(() => Response.json({ lease: 'a.b' }));
    const outcome = await validateLicense({
      serverUrl: 'https://license.invalid/',
      licenseKey,
      instanceId: 'inst-1',
      fetchImpl,
    });
    expect(outcome).toEqual({ kind: 'valid', lease: 'a.b' });
    expect(calls[0]?.url).toBe('https://license.invalid/api/v1/licenses/validate');
    expect(calls[0]?.body).toEqual({ licenseKey, instanceId: 'inst-1' });
  });

  it('maps the contract error statuses', async () => {
    const cases: Array<[number, Record<string, unknown>, Record<string, unknown>]> = [
      [400, { error: 'invalid_request' }, { kind: 'invalid_request' }],
      [404, { error: 'license_not_found' }, { kind: 'license_not_found' }],
      [403, { error: 'license_inactive', status: 'revoked' }, { kind: 'license_inactive', status: 'revoked' }],
    ];
    for (const [status, body, expected] of cases) {
      const { fetchImpl } = fakeFetch(() => Response.json(body, { status }));
      await expect(
        validateLicense({ serverUrl: 'https://license.invalid', licenseKey, fetchImpl })
      ).resolves.toEqual(expected);
    }
  });

  it('treats 500s, network failures, and bad payloads as outages', async () => {
    const server500 = fakeFetch(() => Response.json({ error: 'internal_error' }, { status: 500 }));
    await expect(
      validateLicense({ serverUrl: 'https://license.invalid', licenseKey, fetchImpl: server500.fetchImpl })
    ).resolves.toMatchObject({ kind: 'outage' });

    const network = (async () => {
      throw new Error('getaddrinfo ENOTFOUND');
    }) as unknown as typeof fetch;
    await expect(
      validateLicense({ serverUrl: 'https://license.invalid', licenseKey, fetchImpl: network })
    ).resolves.toMatchObject({ kind: 'outage', detail: expect.stringContaining('ENOTFOUND') });

    const missingLease = fakeFetch(() => Response.json({ entitlements: {} }));
    await expect(
      validateLicense({ serverUrl: 'https://license.invalid', licenseKey, fetchImpl: missingLease.fetchImpl })
    ).resolves.toMatchObject({ kind: 'outage', detail: expect.stringContaining('lease') });
  });
});

describe('getEntitlements', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('returns free-tier limits with no cached lease', () => {
    expect(getEntitlements(openDb(':memory:'))).toEqual(FREE_TIER);
  });

  it('returns paid limits from a valid cached lease', () => {
    vi.stubEnv('FLUXMAIL_LICENSE_PUBLIC_KEYS', keys.publicKeyB64);
    const db = openDb(':memory:');
    const payload = leasePayload({ maxAccounts: 7 });
    saveLeaseToken(db, signLease(keys.privateKey, payload));
    expect(getEntitlements(db)).toEqual({
      maxAccounts: 7,
      tier: 'paid',
      leaseExpiresAt: payload.expiresAt,
    });
  });

  it('degrades to free-tier limits when the cached lease has expired', () => {
    vi.stubEnv('FLUXMAIL_LICENSE_PUBLIC_KEYS', keys.publicKeyB64);
    const db = openDb(':memory:');
    saveLeaseToken(
      db,
      signLease(keys.privateKey, leasePayload({ expiresAt: new Date(Date.now() - 1000).toISOString() }))
    );
    expect(getEntitlements(db)).toEqual(FREE_TIER);
  });

  it('ignores a cached lease tampered with in the database', () => {
    vi.stubEnv('FLUXMAIL_LICENSE_PUBLIC_KEYS', keys.publicKeyB64);
    const db = openDb(':memory:');
    const [, signature] = signLease(keys.privateKey, leasePayload()).split('.');
    const forged = Buffer.from(JSON.stringify(leasePayload({ maxAccounts: 999 }))).toString('base64url');
    saveLeaseToken(db, `${forged}.${signature}`);
    expect(getEntitlements(db)).toEqual(FREE_TIER);
  });

  it('clearLease removes the cached lease', () => {
    vi.stubEnv('FLUXMAIL_LICENSE_PUBLIC_KEYS', keys.publicKeyB64);
    const db = openDb(':memory:');
    saveLeaseToken(db, signLease(keys.privateKey, leasePayload()));
    clearLease(db);
    expect(readLeaseRow(db)).toBeUndefined();
    expect(getEntitlements(db)).toEqual(FREE_TIER);
  });
});

describe('refreshLicense', () => {
  afterEach(() => vi.unstubAllEnvs());

  const licenseKey = `fluxmail_lic_${'cd'.repeat(20)}`;
  const dataDir = () => mkdtempSync(path.join(tmpdir(), 'fluxmail-license-'));

  it('stores the lease returned by the server', async () => {
    vi.stubEnv('FLUXMAIL_LICENSE_PUBLIC_KEYS', keys.publicKeyB64);
    const db = openDb(':memory:');
    const token = signLease(keys.privateKey, leasePayload({ maxAccounts: 5 }));
    const { fetchImpl } = fakeFetch(() => Response.json({ lease: token }));

    const result = await refreshLicense(db, {
      licenseKey,
      serverUrl: 'https://license.invalid',
      dataDir: dataDir(),
      fetchImpl,
    });
    expect(result.outcome).toBe('refreshed');
    expect(readLeaseRow(db)?.token).toBe(token);
    expect(getEntitlements(db).maxAccounts).toBe(5);
  });

  it('keeps the cached lease when the license has gone inactive', async () => {
    vi.stubEnv('FLUXMAIL_LICENSE_PUBLIC_KEYS', keys.publicKeyB64);
    const db = openDb(':memory:');
    const cached = signLease(keys.privateKey, leasePayload());
    saveLeaseToken(db, cached);
    const { fetchImpl } = fakeFetch(() =>
      Response.json({ error: 'license_inactive', status: 'canceled' }, { status: 403 })
    );

    const result = await refreshLicense(db, {
      licenseKey,
      serverUrl: 'https://license.invalid',
      dataDir: dataDir(),
      fetchImpl,
    });
    expect(result).toMatchObject({ outcome: 'inactive', cachedLeaseActive: true });
    expect(readLeaseRow(db)?.token).toBe(cached);
  });

  it('keeps the cached lease across an outage', async () => {
    vi.stubEnv('FLUXMAIL_LICENSE_PUBLIC_KEYS', keys.publicKeyB64);
    const db = openDb(':memory:');
    const cached = signLease(keys.privateKey, leasePayload());
    saveLeaseToken(db, cached);
    const network = (async () => {
      throw new Error('connect ECONNREFUSED');
    }) as unknown as typeof fetch;

    const result = await refreshLicense(db, {
      licenseKey,
      serverUrl: 'https://license.invalid',
      dataDir: dataDir(),
      fetchImpl: network,
    });
    expect(result).toMatchObject({ outcome: 'outage', cachedLeaseActive: true });
    expect(readLeaseRow(db)?.token).toBe(cached);
  });

  it('does not overwrite the cache with a lease it cannot verify', async () => {
    vi.stubEnv('FLUXMAIL_LICENSE_PUBLIC_KEYS', keys.publicKeyB64);
    const db = openDb(':memory:');
    const cached = signLease(keys.privateKey, leasePayload());
    saveLeaseToken(db, cached);
    const rogue = makeKeypair();
    const { fetchImpl } = fakeFetch(() =>
      Response.json({ lease: signLease(rogue.privateKey, leasePayload({ maxAccounts: 999 })) })
    );

    const result = await refreshLicense(db, {
      licenseKey,
      serverUrl: 'https://license.invalid',
      dataDir: dataDir(),
      fetchImpl,
    });
    expect(result).toMatchObject({ outcome: 'bad_lease', cachedLeaseActive: true });
    expect(readLeaseRow(db)?.token).toBe(cached);
  });
});

describe('activateLicense', () => {
  const oldKey = `fluxmail_lic_${'ab'.repeat(20)}`;
  const newKey = `fluxmail_lic_${'cd'.repeat(20)}`;

  it('preserves the stored key when the replacement is rejected', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'fluxmail-activation-'));
    setStoredConfig(dir, 'FLUXMAIL_LICENSE_KEY', oldKey);
    const db = openDb(':memory:');
    const { fetchImpl } = fakeFetch(() =>
      Response.json({ error: 'license_not_found' }, { status: 404 })
    );

    const result = await activateLicense(db, {
      licenseKey: newKey,
      serverUrl: 'https://license.invalid',
      dataDir: dir,
      fetchImpl,
    });

    expect(result.outcome).toBe('not_found');
    expect(readStoredConfig(dir).FLUXMAIL_LICENSE_KEY).toBe(oldKey);
  });
});

describe('loadInstanceId', () => {
  it('generates once and stays stable across calls', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'fluxmail-instance-'));
    const first = loadInstanceId(dir);
    expect(first).toMatch(/^[0-9a-f]{32}$/);
    expect(loadInstanceId(dir)).toBe(first);
    expect(readFileSync(path.join(dir, 'instance.id'), 'utf8').trim()).toBe(first);
  });
});
