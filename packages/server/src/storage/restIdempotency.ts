import { and, eq, lt } from 'drizzle-orm';
import { restIdempotency, type FluxmailDb } from './db.js';

export const REST_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

export type IdempotencyReservation =
  | { status: 'reserved' }
  | { status: 'conflict' }
  | { status: 'in_progress' }
  | { status: 'replay'; responseStatus: number; responseBody: string };

export function reserveIdempotencyKey(
  db: FluxmailDb,
  input: {
    principalId: string;
    idempotencyKey: string;
    requestHash: string;
    now?: number;
    ttlMs?: number;
  },
): IdempotencyReservation {
  const now = input.now ?? Date.now();
  db.delete(restIdempotency).where(lt(restIdempotency.expiresAt, now)).run();

  const result = db
    .insert(restIdempotency)
    .values({
      principalId: input.principalId,
      idempotencyKey: input.idempotencyKey,
      requestHash: input.requestHash,
      state: 'in_progress',
      createdAt: now,
      expiresAt: now + (input.ttlMs ?? REST_IDEMPOTENCY_TTL_MS),
    })
    .onConflictDoNothing()
    .run();
  if (result.changes === 1) return { status: 'reserved' };

  const existing = db
    .select()
    .from(restIdempotency)
    .where(
      and(eq(restIdempotency.principalId, input.principalId), eq(restIdempotency.idempotencyKey, input.idempotencyKey)),
    )
    .get();
  if (!existing) return { status: 'in_progress' };
  if (existing.requestHash !== input.requestHash) return { status: 'conflict' };
  if (existing.state !== 'completed' || existing.responseStatus === null || existing.responseBody === null) {
    return { status: 'in_progress' };
  }
  return {
    status: 'replay',
    responseStatus: existing.responseStatus,
    responseBody: existing.responseBody,
  };
}

export function completeIdempotencyKey(
  db: FluxmailDb,
  input: {
    principalId: string;
    idempotencyKey: string;
    requestHash: string;
    responseStatus: number;
    responseBody: string;
  },
): boolean {
  const result = db
    .update(restIdempotency)
    .set({ state: 'completed', responseStatus: input.responseStatus, responseBody: input.responseBody })
    .where(
      and(
        eq(restIdempotency.principalId, input.principalId),
        eq(restIdempotency.idempotencyKey, input.idempotencyKey),
        eq(restIdempotency.requestHash, input.requestHash),
        eq(restIdempotency.state, 'in_progress'),
      ),
    )
    .run();
  return result.changes === 1;
}
