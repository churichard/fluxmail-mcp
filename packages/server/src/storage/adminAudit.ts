import { asc, eq } from 'drizzle-orm';
import { adminAuditEvents, type FluxmailDb } from './db.js';

export const ADMIN_AUDIT_RETENTION = 10_000;

export interface AdminAuditInput {
  operation: string;
  outcome: 'success' | 'error';
  actorKeyId: string;
  actorMemberId: string | null;
  resourceType?: string;
  resourceId?: string;
  errorCode?: string;
}

/** Store identifiers and stable codes only. Callers must not pass request data or error text. */
export function recordAdminAuditEvent(db: FluxmailDb, input: AdminAuditInput): void {
  db.transaction((tx) => {
    tx.insert(adminAuditEvents)
      .values({
        timestamp: Date.now(),
        operation: input.operation,
        outcome: input.outcome,
        actorKeyId: input.actorKeyId,
        actorMemberId: input.actorMemberId,
        resourceType: input.resourceType ?? null,
        resourceId: input.resourceId ?? null,
        errorCode: input.errorCode ?? null,
      })
      .run();
    const excess = tx.select({ id: adminAuditEvents.id }).from(adminAuditEvents).all().length - ADMIN_AUDIT_RETENTION;
    if (excess <= 0) return;
    const oldest = tx
      .select({ id: adminAuditEvents.id })
      .from(adminAuditEvents)
      .orderBy(asc(adminAuditEvents.id))
      .limit(excess)
      .all();
    for (const event of oldest) tx.delete(adminAuditEvents).where(eq(adminAuditEvents.id, event.id)).run();
  });
}
