import { describe, expect, it } from 'vitest';
import { openDb } from '../src/storage/db.js';
import { completeIdempotencyKey, reserveIdempotencyKey } from '../src/storage/restIdempotency.js';

describe('REST idempotency storage', () => {
  it('reserves, completes, and replays a request', () => {
    const db = openDb(':memory:');
    const request = { principalId: 'key_1', idempotencyKey: 'request-1', requestHash: 'hash-1', now: 1_000 };

    expect(reserveIdempotencyKey(db, request)).toEqual({ status: 'reserved' });
    expect(reserveIdempotencyKey(db, request)).toEqual({ status: 'in_progress' });
    expect(
      completeIdempotencyKey(db, {
        ...request,
        responseStatus: 200,
        responseBody: '{"data":{"id":"sent_1"}}',
      }),
    ).toBe(true);
    expect(reserveIdempotencyKey(db, request)).toEqual({
      status: 'replay',
      responseStatus: 200,
      responseBody: '{"data":{"id":"sent_1"}}',
    });
  });

  it('rejects a changed request and permits reuse after expiry', () => {
    const db = openDb(':memory:');
    const request = {
      principalId: 'key_1',
      idempotencyKey: 'request-1',
      requestHash: 'hash-1',
      now: 1_000,
      ttlMs: 100,
    };

    expect(reserveIdempotencyKey(db, request).status).toBe('reserved');
    expect(reserveIdempotencyKey(db, { ...request, requestHash: 'hash-2' }).status).toBe('conflict');
    expect(reserveIdempotencyKey(db, { ...request, requestHash: 'hash-2', now: 1_101 }).status).toBe('reserved');
  });

  it('scopes the same key to separate API-key principals', () => {
    const db = openDb(':memory:');
    expect(
      reserveIdempotencyKey(db, {
        principalId: 'key_1',
        idempotencyKey: 'shared-key',
        requestHash: 'hash',
      }).status,
    ).toBe('reserved');
    expect(
      reserveIdempotencyKey(db, {
        principalId: 'key_2',
        idempotencyKey: 'shared-key',
        requestHash: 'hash',
      }).status,
    ).toBe('reserved');
  });
});
