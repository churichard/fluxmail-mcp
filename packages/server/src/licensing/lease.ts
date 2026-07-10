import { createPublicKey, verify as verifySignature, type KeyObject } from 'node:crypto';

/**
 * Entitlement lease issued by the hosted license server: a detached-signature
 * token of the form base64url(payloadJSON) + "." + base64url(ed25519 signature).
 * The signature covers the payload bytes exactly as transmitted, so we verify
 * before parsing and never re-serialize the JSON.
 */
export interface LeasePayload {
  /** Payload version; this client understands only 1. */
  v: 1;
  licenseId: string;
  maxAccounts: number;
  /** ISO 8601 */
  issuedAt: string;
  /** ISO 8601, issuedAt + ~7 days */
  expiresAt: string;
}

/**
 * License-server signing keys (base64 SPKI DER), pinned at build time.
 * Rotation: releases ship with both the old and new key pinned; the server
 * switches its private key once instances have upgraded, then the old pin
 * is removed.
 */
export const PINNED_LICENSE_PUBLIC_KEYS: readonly string[] = [
  'MCowBQYDK2VwAyEAoxmkS0uM1qUX6+Jzm3aoTPLFuZ8mcpyiEI3VE1qdM90=',
  'MCowBQYDK2VwAyEA3ZAEKMPlNE1Ne0bTra438WMvI2Tle+C2aDOOAA8ETWM=',
];

/**
 * Pinned keys plus any keys from FLUXMAIL_LICENSE_PUBLIC_KEYS (comma-separated
 * base64 SPKI DER), which exists for development and tests. Extra keys are
 * additive so an env typo can never unpin the production key, and the override
 * is ignored under NODE_ENV=production (as set by the Docker image) so a stock
 * production instance trusts only the pinned keys.
 */
export function licensePublicKeys(): string[] {
  const extra =
    process.env.NODE_ENV === 'production' ? undefined : process.env.FLUXMAIL_LICENSE_PUBLIC_KEYS;
  const fromEnv = extra
    ? extra
        .split(',')
        .map((key) => key.trim())
        .filter(Boolean)
    : [];
  return [...PINNED_LICENSE_PUBLIC_KEYS, ...fromEnv];
}

const BASE64URL = /^[A-Za-z0-9_-]+$/;

function decodePublicKey(base64Spki: string): KeyObject | undefined {
  try {
    return createPublicKey({ key: Buffer.from(base64Spki, 'base64'), format: 'der', type: 'spki' });
  } catch {
    return undefined;
  }
}

/**
 * Verify a lease token against the accepted public keys and return its payload.
 * Throws with a human-readable reason on any failure; callers on enforcement
 * paths catch and fall back to free-tier limits.
 */
export function verifyLease(token: string, publicKeys: readonly string[], now = new Date()): LeasePayload {
  const parts = token.split('.');
  if (parts.length !== 2 || !BASE64URL.test(parts[0]!) || !BASE64URL.test(parts[1]!)) {
    throw new Error('malformed lease token');
  }
  const payloadBytes = Buffer.from(parts[0]!, 'base64url');
  const signature = Buffer.from(parts[1]!, 'base64url');

  const signed = publicKeys.some((key) => {
    const publicKey = decodePublicKey(key);
    if (!publicKey) return false;
    try {
      return verifySignature(null, payloadBytes, publicKey, signature);
    } catch {
      return false;
    }
  });
  if (!signed) {
    throw new Error('lease signature does not match any accepted license key');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadBytes.toString('utf8'));
  } catch {
    throw new Error('lease payload is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('lease payload is not an object');
  }
  const payload = parsed as Record<string, unknown>;
  if (payload.v !== 1) {
    throw new Error(`unsupported lease version ${JSON.stringify(payload.v)}`);
  }
  if (typeof payload.licenseId !== 'string' || !payload.licenseId) {
    throw new Error('lease payload has no licenseId');
  }
  if (
    typeof payload.maxAccounts !== 'number' ||
    !Number.isInteger(payload.maxAccounts) ||
    payload.maxAccounts < 1
  ) {
    throw new Error('lease payload has an invalid maxAccounts');
  }
  for (const field of ['issuedAt', 'expiresAt'] as const) {
    const value = payload[field];
    if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
      throw new Error(`lease payload has an invalid ${field}`);
    }
  }
  if (Date.parse(payload.expiresAt as string) <= now.getTime()) {
    throw new Error(`lease expired at ${payload.expiresAt as string}`);
  }
  return payload as unknown as LeasePayload;
}
