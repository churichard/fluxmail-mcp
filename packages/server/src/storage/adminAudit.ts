import { sql } from 'drizzle-orm';
import { adminAuditEvents, type FluxmailDb } from './db.js';

export interface AdminAuditInput {
  operation: string;
  outcome: 'success' | 'error';
  actorKeyId?: string;
  actorSessionId?: string;
  actorMemberId: string | null;
  resourceType?: string;
  resourceId?: string;
  errorCode?: string;
}

export interface AdminAuditEvent {
  id: number;
  timestamp: number;
  operation: string;
  outcome: string;
  actorKeyId: string | null;
  actorSessionId: string | null;
  actorMemberId: string | null;
  resourceType: string | null;
  resourceId: string | null;
  errorCode: string | null;
}

export function listAdminAuditEvents(db: FluxmailDb, limit = 100): AdminAuditEvent[] {
  return db
    .select()
    .from(adminAuditEvents)
    .orderBy(sql`${adminAuditEvents.id} DESC`)
    .limit(Math.min(Math.max(limit, 1), 500))
    .all();
}

/** Store identifiers and stable codes only. Callers must not pass request data or error text. */
export function recordAdminAuditEvent(db: FluxmailDb, input: AdminAuditInput): void {
  db.insert(adminAuditEvents)
    .values({
      timestamp: Date.now(),
      operation: input.operation,
      outcome: input.outcome,
      actorKeyId: input.actorKeyId ?? null,
      actorSessionId: input.actorSessionId ?? null,
      actorMemberId: input.actorMemberId,
      resourceType: input.resourceType ?? null,
      resourceId: input.resourceId ?? null,
      errorCode: input.errorCode ?? null,
    })
    .run();
}
