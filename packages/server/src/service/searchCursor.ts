import { createHash, createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import { EmailError, type EmailQuery, type Provider } from '@fluxmail/core';

const CURSOR_VERSION = 1;
const CURSOR_LIFETIME_MS = 60 * 60 * 1_000;
const MAX_CURSOR_BYTES = 16 * 1_024;
const HKDF_CONTEXT = 'fluxmail/search-page-token/v1';

interface SearchCursorPayload {
  v: typeof CURSOR_VERSION;
  accountId: string;
  provider: Provider;
  queryHash: string;
  pageSize: number;
  providerToken: string;
  issuedAt: number;
  expiresAt: number;
}

function invalidCursor(): EmailError {
  return new EmailError('invalid_request', 'Invalid or expired search page token.');
}

function canonicalQuery(query: EmailQuery): string {
  const entries = Object.entries(query)
    .filter(([, value]) => value !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify(Object.fromEntries(entries));
}

export function emailQueryHash(query: EmailQuery): string {
  return createHash('sha256').update(canonicalQuery(query)).digest('base64url');
}

export class SearchCursorCodec {
  private readonly key: Buffer;

  constructor(instanceEncryptionKey: Buffer) {
    this.key = Buffer.from(hkdfSync('sha256', instanceEncryptionKey, Buffer.alloc(0), HKDF_CONTEXT, 32));
  }

  encode(
    binding: {
      accountId: string;
      provider: Provider;
      query: EmailQuery;
      pageSize: number;
      providerToken: string;
    },
    now = Date.now(),
  ): string {
    const payload: SearchCursorPayload = {
      v: CURSOR_VERSION,
      accountId: binding.accountId,
      provider: binding.provider,
      queryHash: emailQueryHash(binding.query),
      pageSize: binding.pageSize,
      providerToken: binding.providerToken,
      issuedAt: now,
      expiresAt: now + CURSOR_LIFETIME_MS,
    };
    const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = createHmac('sha256', this.key).update(encodedPayload).digest('base64url');
    const token = `${encodedPayload}.${signature}`;
    if (Buffer.byteLength(token) > MAX_CURSOR_BYTES) {
      throw new EmailError('invalid_request', 'The provider returned a search page token that is too large.');
    }
    return token;
  }

  decode(
    token: string,
    binding: { accountId: string; provider: Provider; query: EmailQuery; pageSize: number },
    now = Date.now(),
  ): string {
    if (Buffer.byteLength(token) > MAX_CURSOR_BYTES) throw invalidCursor();
    const parts = token.split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1]) throw invalidCursor();
    const [encodedPayload, encodedSignature] = parts;
    if (!/^[A-Za-z0-9_-]+$/.test(encodedPayload) || !/^[A-Za-z0-9_-]+$/.test(encodedSignature)) {
      throw invalidCursor();
    }

    let suppliedSignature: Buffer;
    try {
      suppliedSignature = Buffer.from(encodedSignature, 'base64url');
    } catch {
      throw invalidCursor();
    }
    if (suppliedSignature.toString('base64url') !== encodedSignature) throw invalidCursor();
    const expectedSignature = createHmac('sha256', this.key).update(encodedPayload).digest();
    if (suppliedSignature.length !== expectedSignature.length) throw invalidCursor();
    if (!timingSafeEqual(suppliedSignature, expectedSignature)) throw invalidCursor();

    let payload: SearchCursorPayload;
    try {
      const bytes = Buffer.from(encodedPayload, 'base64url');
      if (bytes.toString('base64url') !== encodedPayload) throw new Error();
      payload = JSON.parse(bytes.toString('utf8')) as SearchCursorPayload;
    } catch {
      throw invalidCursor();
    }
    if (
      !payload ||
      payload.v !== CURSOR_VERSION ||
      typeof payload.accountId !== 'string' ||
      !['gmail', 'outlook', 'imap'].includes(payload.provider) ||
      typeof payload.queryHash !== 'string' ||
      !Number.isInteger(payload.pageSize) ||
      typeof payload.providerToken !== 'string' ||
      !payload.providerToken ||
      !Number.isFinite(payload.issuedAt) ||
      !Number.isFinite(payload.expiresAt) ||
      payload.expiresAt !== payload.issuedAt + CURSOR_LIFETIME_MS ||
      payload.issuedAt > now ||
      payload.expiresAt <= now
    ) {
      throw invalidCursor();
    }
    if (
      payload.accountId !== binding.accountId ||
      payload.provider !== binding.provider ||
      payload.queryHash !== emailQueryHash(binding.query) ||
      payload.pageSize !== binding.pageSize
    ) {
      throw invalidCursor();
    }
    return payload.providerToken;
  }
}
