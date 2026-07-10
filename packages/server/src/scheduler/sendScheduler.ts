import { isEmailError, type SendResult } from '@fluxmail/core';
import type { FluxmailDb } from '../storage/db.js';
import {
  claimScheduledSend,
  completeClaim,
  failClaim,
  listActive,
  listClaimable,
  retryClaim,
  type ScheduledSendRow,
} from '../storage/scheduledSends.js';

/** The slice of EmailService the scheduler needs. */
export interface ScheduledSender {
  send(accountId: string | undefined, input: { draftId: string }): Promise<SendResult>;
}

/** Re-check at least this often while anything is pending (heals clock jumps and laptop sleep). */
const MAX_ARM_MS = 15 * 60_000;
const BASE_BACKOFF_MS = 30_000;
const CLAIM_LEASE_MS = 5 * 60_000;

/** Errors that no amount of retrying will fix (e.g. the draft is gone). */
const PERMANENT_CODES = new Set(['not_found', 'invalid_request', 'unsupported_capability']);

/**
 * Fires scheduled sends when their time comes. Owned by the long-lived
 * processes (serve/stdio); one-shot CLI commands construct it but never
 * start() it. Assumes a single long-lived process per database; there is
 * no cross-process locking.
 */
export class SendScheduler {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private processing = false;
  private rerun = false;
  /** Retry gates for transient failures; in-memory only (a restart just retries immediately). */
  private backoff = new Map<string, { attempt: number; notBefore: number }>();

  constructor(
    private readonly db: FluxmailDb,
    private readonly service: ScheduledSender
  ) {}

  /** Starts the loop; immediately fires anything past due (catch-up after downtime). */
  start(): void {
    this.running = true;
    void this.tick();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** Poke after any schedule change (new, canceled, or sent early). */
  wake(): void {
    if (this.running) void this.tick();
  }

  private async tick(): Promise<void> {
    if (!this.running) return;
    if (this.processing) {
      this.rerun = true;
      return;
    }
    this.processing = true;
    try {
      const now = Date.now();
      const due = listClaimable(this.db, now)
        .filter((r) => r.sendAt <= now && (this.backoff.get(r.id)?.notBefore ?? 0) <= now)
        .sort((a, b) => a.sendAt - b.sendAt);
      for (const row of due) await this.fire(row);
    } finally {
      this.processing = false;
    }
    if (this.rerun) {
      this.rerun = false;
      return void this.tick();
    }
    this.arm();
  }

  private async fire(row: ScheduledSendRow): Promise<void> {
    const claim = claimScheduledSend(this.db, row.id, Date.now(), CLAIM_LEASE_MS);
    if (!claim) {
      this.backoff.delete(row.id);
      return;
    }
    try {
      const result = await this.service.send(row.accountId, { draftId: row.draftId });
      completeClaim(this.db, row.id, claim.token, result);
      this.backoff.delete(row.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isEmailError(err) && PERMANENT_CODES.has(err.code)) {
        failClaim(
          this.db,
          row.id,
          claim.token,
          err.code === 'not_found'
            ? 'Draft no longer exists: it was sent or deleted outside Fluxmail'
            : message
        );
        this.backoff.delete(row.id);
      } else {
        // Transient (auth_expired, rate_limited, network): retry forever, late but sent.
        retryClaim(this.db, row.id, claim.token, message);
        const attempt = (this.backoff.get(row.id)?.attempt ?? 0) + 1;
        this.backoff.set(row.id, {
          attempt,
          notBefore: Date.now() + Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1), MAX_ARM_MS),
        });
      }
    }
  }

  private arm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const pending = listActive(this.db);
    if (!pending.length) return;
    const next = Math.min(
      ...pending.map((r) =>
        Math.max(r.sendAt, r.claimUntil ?? 0, this.backoff.get(r.id)?.notBefore ?? 0)
      )
    );
    const delay = Math.min(Math.max(next - Date.now(), 0), MAX_ARM_MS);
    this.timer = setTimeout(() => void this.tick(), delay);
    this.timer.unref();
  }
}
