import { isEmailError } from '@fluxmail/core';
import { randomBytes } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';
import { VERSION } from './version.js';

export type LogLevel = 'info' | 'warn' | 'error' | 'off';
export type LogDestination = 'both' | 'file' | 'console';
export type ProcessMode = 'cli' | 'serve' | 'stdio' | 'library';
export type LogValue = boolean | number | string;

export interface LogContext {
  productSurface?: 'cli' | 'mcp' | 'rest';
  operation?: string;
  durationMs?: number;
  details?: Record<string, LogValue | undefined>;
  /** CLI errors are already printed in their user-facing form. */
  skipConsole?: boolean;
}

export interface Logger {
  info(event: string, message: string, context?: LogContext): void;
  warn(event: string, message: string, error?: unknown, context?: LogContext): void;
  error(event: string, message: string, error?: unknown, context?: LogContext): void;
  flush(): Promise<void>;
  close(): Promise<void>;
}

export interface LogError {
  name: string;
  code?: string;
  message: string;
  stack?: string;
  cause?: LogError;
}

export interface LogRecord {
  timestamp: string;
  level: Exclude<LogLevel, 'off'>;
  event: string;
  message: string;
  version: string;
  pid: number;
  run_id: string;
  process_mode: ProcessMode;
  product_surface?: 'cli' | 'mcp' | 'rest';
  operation?: string;
  duration_ms?: number;
  details?: Record<string, LogValue>;
  error?: LogError;
}

interface LoggerLimits {
  segmentBytes: number;
  segmentCount: number;
  maxRecordBytes: number;
  maxQueueBytes: number;
  maxBatchBytes: number;
  flushIntervalMs: number;
  rateBurstBytes: number;
  rateBytesPerHour: number;
  duplicateWindowMs: number;
  duplicateLimit: number;
}

const DEFAULT_LIMITS: LoggerLimits = {
  segmentBytes: 5 * 1024 * 1024,
  segmentCount: 4,
  maxRecordBytes: 16 * 1024,
  maxQueueBytes: 256 * 1024,
  maxBatchBytes: 64 * 1024,
  flushIntervalMs: 1_000,
  rateBurstBytes: 64 * 1024,
  rateBytesPerHour: 1024 * 1024,
  duplicateWindowMs: 60_000,
  duplicateLimit: 3,
};

const LEVEL_VALUE: Record<Exclude<LogLevel, 'off'>, number> = { info: 10, warn: 20, error: 30 };
const SECRET_VALUE = '[REDACTED]';
const LOCK_STALE_MS = 30_000;
const LOCK_READ_TIMEOUT_MS = 1_000;
const FILE_FAILURE_WARNING_INTERVAL_MS = 60 * 60_000;
const LOCK_WAIT_ARRAY = new Int32Array(new SharedArrayBuffer(4));

interface PendingRecord {
  json: string;
  console: string;
  bytes: number;
  filePending: boolean;
  consolePending: boolean;
}

interface DuplicateState {
  windowStartedAt: number;
  emitted: number;
  suppressed: number;
}

interface LockOwner {
  token: string;
  pid: number;
  hostname: string;
  createdAt: number;
}

interface AcquiredLock {
  descriptor: number;
  token: string;
}

export interface CreateLoggerOptions {
  dataDir: string;
  mode: ProcessMode;
  level?: LogLevel;
  destination?: LogDestination;
  now?: () => number;
  consoleWrite?: (value: string) => void;
  limits?: Partial<LoggerLimits>;
}

function redact(value: string): string {
  return value
    .replace(/\bBearer\s+[^\s,;]+/gi, `Bearer ${SECRET_VALUE}`)
    .replace(/\bfluxmail_(?:api|lic)_[A-Za-z0-9_-]+\b/g, SECRET_VALUE)
    .replace(/\b(?:fmk|fms)_[a-f0-9]{16,}\b/gi, SECRET_VALUE)
    .replace(
      /([?&](?:access_token|refresh_token|client_secret|password|api_key|key|code)=)[^&#\s]*/gi,
      `$1${SECRET_VALUE}`,
    )
    .replace(
      /((?:access_token|refresh_token|client_secret|password|api_key|license_key|authorization)["']?\s*[:=]\s*["']?)[^"'\s,;}]+/gi,
      `$1${SECRET_VALUE}`,
    )
    .replace(/\b(?:GOOGLE|MICROSOFT|FLUXMAIL)_[A-Z0-9_]*(?:SECRET|KEY|TOKEN|PASSWORD)=\S+/g, (match) => {
      const separator = match.indexOf('=');
      return `${match.slice(0, separator + 1)}${SECRET_VALUE}`;
    });
}

function truncateText(value: string, maxBytes: number): string {
  const suffix = '...[truncated]';
  const inputLimit = Math.max(maxBytes, maxBytes * 4);
  const safe = redact(value.length > inputLimit ? value.slice(0, inputLimit) + suffix : value);
  if (Buffer.byteLength(safe) <= maxBytes) return safe;
  const suffixBytes = Buffer.byteLength(suffix);
  let end = Math.max(0, Math.min(safe.length, maxBytes - suffixBytes));
  while (end > 0 && Buffer.byteLength(safe.slice(0, end)) + suffixBytes > maxBytes) end -= 1;
  return safe.slice(0, end) + suffix;
}

function errorCode(error: unknown): string | undefined {
  if (isEmailError(error)) return error.code;
  if (!error || typeof error !== 'object') return undefined;
  const value = (error as { code?: unknown }).code;
  return typeof value === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(value) ? value : undefined;
}

function serializeError(error: unknown, includeStack: boolean, depth = 0): LogError {
  if (error instanceof Error) {
    const cause = depth < 3 ? (error as Error & { cause?: unknown }).cause : undefined;
    return {
      name: truncateText(error.name || 'Error', 256),
      ...(errorCode(error) ? { code: errorCode(error) } : {}),
      message: truncateText(error.message, 4 * 1024),
      ...(includeStack && error.stack ? { stack: truncateText(error.stack, 8 * 1024) } : {}),
      ...(includeStack && cause !== undefined ? { cause: serializeError(cause, true, depth + 1) } : {}),
    };
  }
  return { name: 'Error', message: truncateText(String(error), 4 * 1024) };
}

function recordWithinLimit(record: LogRecord, maxBytes: number): string {
  let json = JSON.stringify(record);
  if (Buffer.byteLength(json) <= maxBytes) return json;
  const compact: LogRecord = {
    ...record,
    message: truncateText(record.message, 1024),
    ...(record.error
      ? {
          error: {
            name: record.error.name,
            ...(record.error.code ? { code: record.error.code } : {}),
            message: truncateText(record.error.message, 1024),
            ...(record.error.stack ? { stack: truncateText(record.error.stack, 4 * 1024) } : {}),
          },
        }
      : {}),
  };
  json = JSON.stringify(compact);
  if (Buffer.byteLength(json) <= maxBytes) return json;
  delete compact.details;
  if (compact.error) delete compact.error.stack;
  return JSON.stringify(compact);
}

export function escapeLogTextForConsole(value: string): string {
  let output = '';
  for (const character of value) {
    const code = character.codePointAt(0)!;
    const control = code <= 0x1f || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029;
    if (!control) {
      output += character;
      continue;
    }
    if (character === '\r') output += '\\r';
    else if (character === '\n') output += '\\n';
    else if (character === '\t') output += '\\t';
    else
      output += code <= 0xff ? `\\x${code.toString(16).padStart(2, '0')}` : `\\u${code.toString(16).padStart(4, '0')}`;
  }
  return output;
}

function formatConsole(record: LogRecord): string {
  const singleLine = escapeLogTextForConsole;
  const code = record.error?.code ? ` [${singleLine(record.error.code)}]` : '';
  return `${record.timestamp} ${record.level.toUpperCase()} ${singleLine(record.event)}${code}: ${singleLine(record.message)}\n`;
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function readLockOwner(file: string): LockOwner | undefined {
  try {
    const owner = JSON.parse(readFileSync(file, 'utf8')) as Partial<LockOwner>;
    if (
      typeof owner.token !== 'string' ||
      typeof owner.pid !== 'number' ||
      typeof owner.hostname !== 'string' ||
      typeof owner.createdAt !== 'number'
    ) {
      return undefined;
    }
    return owner as LockOwner;
  } catch {
    return undefined;
  }
}

function canRemoveLock(file: string): boolean {
  const owner = readLockOwner(file);
  if (owner?.hostname === hostname()) return !processIsRunning(owner.pid);
  try {
    return Date.now() - statSync(file).mtimeMs > LOCK_STALE_MS;
  } catch {
    return false;
  }
}

function releaseOwnedLock(file: string, token: string): void {
  if (readLockOwner(file)?.token !== token) return;
  try {
    rmSync(file, { force: true });
  } catch {
    // A stale lock is recovered by a later operation.
  }
}

function tryRemoveAbandonedLock(file: string): boolean {
  const reclaimFile = `${file}.reclaim`;
  const token = randomBytes(16).toString('hex');
  const owner: LockOwner = { token, pid: process.pid, hostname: hostname(), createdAt: Date.now() };
  let descriptor: number | undefined;
  try {
    descriptor = openSync(reclaimFile, 'wx', 0o600);
    writeFileSync(descriptor, JSON.stringify(owner));
  } catch (error) {
    if (descriptor !== undefined) {
      closeSync(descriptor);
      rmSync(reclaimFile, { force: true });
    }
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }

  try {
    if (!canRemoveLock(file)) return false;
    rmSync(file, { force: true });
    return true;
  } finally {
    closeSync(descriptor);
    releaseOwnedLock(reclaimFile, token);
  }
}

function acquireLock(file: string): AcquiredLock | undefined {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const token = randomBytes(16).toString('hex');
    const owner: LockOwner = { token, pid: process.pid, hostname: hostname(), createdAt: Date.now() };
    let descriptor: number | undefined;
    try {
      descriptor = openSync(file, 'wx', 0o600);
      writeFileSync(descriptor, JSON.stringify(owner));
      return { descriptor, token };
    } catch (error) {
      if (descriptor !== undefined) {
        closeSync(descriptor);
        rmSync(file, { force: true });
      }
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (attempt === 0 && tryRemoveAbandonedLock(file)) continue;
      return undefined;
    }
  }
  return undefined;
}

function acquireReadLock(file: string): AcquiredLock {
  const startedAt = Date.now();
  while (true) {
    const descriptor = acquireLock(file);
    if (descriptor !== undefined) return descriptor;
    const elapsed = Date.now() - startedAt;
    if (elapsed >= LOCK_READ_TIMEOUT_MS) throw new Error('Timed out waiting to read the local log files.');
    Atomics.wait(LOCK_WAIT_ARRAY, 0, 0, Math.min(10, LOCK_READ_TIMEOUT_MS - elapsed));
  }
}

function releaseLock(file: string, lock: AcquiredLock): void {
  closeSync(lock.descriptor);
  releaseOwnedLock(file, lock.token);
}

function logPaths(logDir: string, count: number): string[] {
  return [
    path.join(logDir, 'fluxmail.jsonl'),
    ...Array.from({ length: count - 1 }, (_, index) => path.join(logDir, `fluxmail.jsonl.${index + 1}`)),
  ];
}

function restrictPermissions(file: string): void {
  try {
    chmodSync(file, 0o600);
  } catch {
    // The write itself reports permission failures. Permission repair is best effort.
  }
}

type FileWriteResult = 'written' | 'busy' | 'failed';

function appendBatch(dataDir: string, batch: string, limits: LoggerLimits): FileWriteResult {
  const logDir = path.join(dataDir, 'logs');
  const lockFile = path.join(logDir, '.write.lock');
  let lock: AcquiredLock | undefined;
  try {
    mkdirSync(logDir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(logDir, 0o700);
    } catch {
      // The append below reports a real permission failure.
    }
    lock = acquireLock(lockFile);
    if (lock === undefined) return 'busy';
    const files = logPaths(logDir, limits.segmentCount);
    for (const file of files) {
      if (existsSync(file) && statSync(file).size > limits.segmentBytes) rmSync(file, { force: true });
    }
    const active = files[0]!;
    const activeBytes = existsSync(active) ? statSync(active).size : 0;
    if (activeBytes + Buffer.byteLength(batch) > limits.segmentBytes) {
      rmSync(files.at(-1)!, { force: true });
      for (let index = files.length - 2; index >= 1; index -= 1) {
        if (existsSync(files[index]!)) renameSync(files[index]!, files[index + 1]!);
      }
      if (existsSync(active)) renameSync(active, files[1]!);
    }
    appendFileSync(active, batch, { encoding: 'utf8', flag: 'a', mode: 0o600 });
    restrictPermissions(active);
    return 'written';
  } catch {
    return 'failed';
  } finally {
    if (lock !== undefined) releaseLock(lockFile, lock);
  }
}

class BoundedLogger implements Logger {
  private readonly runId = randomBytes(8).toString('hex');
  private readonly now: () => number;
  private readonly consoleWrite: (value: string) => void;
  private readonly limits: LoggerLimits;
  private readonly duplicates = new Map<string, DuplicateState>();
  private queue: PendingRecord[] = [];
  private queueBytes = 0;
  private timer?: NodeJS.Timeout;
  private closed = false;
  private tokens: number;
  private lastRefillAt: number;
  private suppressedByRate = 0;
  private suppressedByQueue = 0;
  private lastFileFailureWarningAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly options: CreateLoggerOptions) {
    this.now = options.now ?? Date.now;
    this.consoleWrite = options.consoleWrite ?? ((value) => process.stderr.write(value));
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
    this.tokens = this.limits.rateBurstBytes;
    this.lastRefillAt = this.now();
  }

  info(event: string, message: string, context?: LogContext): void {
    this.add('info', event, message, undefined, context);
  }

  warn(event: string, message: string, error?: unknown, context?: LogContext): void {
    this.add('warn', event, message, error, context);
  }

  error(event: string, message: string, error?: unknown, context?: LogContext): void {
    this.add('error', event, message, error, context);
  }

  private accepts(level: Exclude<LogLevel, 'off'>): boolean {
    const configured = this.options.level ?? 'info';
    return configured !== 'off' && LEVEL_VALUE[level] >= LEVEL_VALUE[configured];
  }

  private refill(now: number): void {
    const elapsed = Math.max(0, now - this.lastRefillAt);
    this.tokens = Math.min(
      this.limits.rateBurstBytes,
      this.tokens + elapsed * (this.limits.rateBytesPerHour / (60 * 60_000)),
    );
    this.lastRefillAt = now;
  }

  private duplicateAllowed(key: string, now: number): boolean {
    const state = this.duplicates.get(key);
    if (!state || now - state.windowStartedAt >= this.limits.duplicateWindowMs) {
      if (state?.suppressed) this.enqueueSuppression('duplicate', state.suppressed, now);
      this.duplicates.set(key, { windowStartedAt: now, emitted: 1, suppressed: 0 });
      return true;
    }
    if (state.emitted < this.limits.duplicateLimit) {
      state.emitted += 1;
      return true;
    }
    state.suppressed += 1;
    return false;
  }

  private enqueueSuppression(reason: 'duplicate' | 'rate' | 'queue', count: number, now: number): void {
    if (!count || !this.accepts('warn')) return;
    const record: LogRecord = {
      timestamp: new Date(now).toISOString(),
      level: 'warn',
      event: 'logging.records_suppressed',
      message: `${count} local log record${count === 1 ? '' : 's'} suppressed`,
      version: VERSION,
      pid: process.pid,
      run_id: this.runId,
      process_mode: this.options.mode,
      details: { reason, count },
    };
    this.enqueue(record, false, true);
  }

  private add(
    level: Exclude<LogLevel, 'off'>,
    event: string,
    message: string,
    error: unknown,
    context?: LogContext,
  ): void {
    if (this.closed || !this.accepts(level)) return;
    const now = this.now();
    const code = errorCode(error);
    if (!this.duplicateAllowed(`${event}:${context?.operation ?? ''}:${code ?? ''}`, now)) return;
    this.refill(now);
    if (this.suppressedByRate > 0 && this.tokens >= 256) {
      const count = this.suppressedByRate;
      this.suppressedByRate = 0;
      this.enqueueSuppression('rate', count, now);
    }
    if (this.suppressedByQueue > 0 && this.queueBytes < this.limits.maxQueueBytes / 2) {
      const count = this.suppressedByQueue;
      this.suppressedByQueue = 0;
      this.enqueueSuppression('queue', count, now);
    }
    const record: LogRecord = {
      timestamp: new Date(now).toISOString(),
      level,
      event: truncateText(event, 256),
      message: truncateText(message, 4 * 1024),
      version: VERSION,
      pid: process.pid,
      run_id: this.runId,
      process_mode: this.options.mode,
      ...(context?.productSurface ? { product_surface: context.productSurface } : {}),
      ...(context?.operation ? { operation: truncateText(context.operation, 256) } : {}),
      ...(context?.durationMs !== undefined ? { duration_ms: Math.max(0, Math.round(context.durationMs)) } : {}),
      ...(context?.details
        ? {
            details: Object.fromEntries(
              Object.entries(context.details)
                .filter((entry): entry is [string, LogValue] => entry[1] !== undefined)
                .map(([key, value]) => [key, typeof value === 'string' ? truncateText(value, 1024) : value]),
            ),
          }
        : {}),
      ...(error !== undefined ? { error: serializeError(error, level === 'error' && !isEmailError(error)) } : {}),
    };
    this.enqueue(record, context?.skipConsole === true, false);
  }

  private enqueue(record: LogRecord, skipConsole: boolean, bypassRate: boolean): void {
    const json = recordWithinLimit(record, this.limits.maxRecordBytes) + '\n';
    const bytes = Buffer.byteLength(json);
    if (!bypassRate) {
      if (bytes > this.tokens) {
        this.suppressedByRate += 1;
        return;
      }
      this.tokens -= bytes;
    }
    if (this.queueBytes + bytes > this.limits.maxQueueBytes) {
      this.suppressedByQueue += 1;
      return;
    }
    const destination = this.options.destination ?? 'both';
    this.queue.push({
      json,
      console: formatConsole(record),
      bytes,
      filePending: destination === 'file' || destination === 'both',
      consolePending: !skipConsole && (destination === 'console' || destination === 'both'),
    });
    this.queueBytes += bytes;
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.timer || this.closed) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, this.limits.flushIntervalMs);
    this.timer.unref();
  }

  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.queue.length) return;

    const batch: PendingRecord[] = [];
    let batchBytes = 0;
    for (const item of this.queue) {
      if (batch.length && batchBytes + item.bytes > this.limits.maxBatchBytes) break;
      batch.push(item);
      batchBytes += item.bytes;
    }

    const consoleLines = batch
      .filter((item) => item.consolePending)
      .map((item) => item.console)
      .join('');
    if (consoleLines) {
      try {
        this.consoleWrite(consoleLines);
        for (const item of batch) item.consolePending = false;
      } catch {
        for (const item of batch) item.consolePending = false;
      }
    }

    const fileItems = batch.filter((item) => item.filePending);
    if (fileItems.length) {
      const result = appendBatch(this.options.dataDir, fileItems.map((item) => item.json).join(''), this.limits);
      if (result === 'written') {
        for (const item of fileItems) item.filePending = false;
      } else if (result === 'failed') {
        for (const item of fileItems) item.filePending = false;
        const now = this.now();
        if (now - this.lastFileFailureWarningAt >= FILE_FAILURE_WARNING_INTERVAL_MS) {
          this.lastFileFailureWarningAt = now;
          try {
            this.consoleWrite('Fluxmail could not write its local log file. Local file logging is unavailable.\n');
          } catch {
            // Logging cannot affect application work.
          }
        }
      }
    }

    this.queue = this.queue.filter((item) => item.filePending || item.consolePending);
    this.queueBytes = this.queue.reduce((total, item) => total + item.bytes, 0);
    if (this.queue.length) this.scheduleFlush();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    for (const state of this.duplicates.values()) {
      if (state.suppressed) this.enqueueSuppression('duplicate', state.suppressed, this.now());
    }
    const lockDeadline = Date.now() + LOCK_READ_TIMEOUT_MS;
    const flushUntilDeadline = async (): Promise<void> => {
      while (this.queue.length) {
        await this.flush();
        const remaining = lockDeadline - Date.now();
        if (!this.queue.length || remaining <= 0) return;
        await new Promise((resolve) => setTimeout(resolve, Math.min(10, remaining)));
      }
    };
    await flushUntilDeadline();
    if (this.suppressedByRate > 0 && !this.queue.length) {
      const count = this.suppressedByRate;
      this.suppressedByRate = 0;
      this.enqueueSuppression('rate', count, this.now());
      await flushUntilDeadline();
    }
    if (this.suppressedByQueue > 0 && !this.queue.length) {
      const count = this.suppressedByQueue;
      this.suppressedByQueue = 0;
      this.enqueueSuppression('queue', count, this.now());
      await flushUntilDeadline();
    }
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}

export function createLogger(options: CreateLoggerOptions): Logger {
  return new BoundedLogger(options);
}

export function logFailure(logger: Logger | undefined, event: string, error: unknown, context?: LogContext): void {
  const message = error instanceof Error ? error.message : String(error);
  if (isEmailError(error)) logger?.warn(event, message, error, context);
  else logger?.error(event, message, error, context);
}

export function logCodedFailure(
  logger: Logger | undefined,
  event: string,
  code: string,
  message: string,
  context?: LogContext,
): void {
  const error = Object.assign(new Error(message), { name: 'OperationError', code });
  logger?.warn(event, message, error, context);
}

const sharedLoggers = new Map<string, Logger>();

export function getLogger(
  dataDir: string,
  mode: ProcessMode,
  settings: { level: LogLevel; destination: LogDestination },
): Logger {
  const existing = sharedLoggers.get(dataDir);
  if (existing) return existing;
  const logger = createLogger({ dataDir, mode, ...settings });
  sharedLoggers.set(dataDir, logger);
  return logger;
}

export async function flushLogging(): Promise<void> {
  await Promise.all([...sharedLoggers.values()].map((logger) => logger.flush()));
}

export async function shutdownLogging(): Promise<void> {
  const loggers = [...sharedLoggers.values()];
  sharedLoggers.clear();
  await Promise.all(loggers.map((logger) => logger.close()));
}

export interface ReadLogsOptions {
  tail: number;
  minimumLevel?: Exclude<LogLevel, 'off'>;
}

export interface ReadLogEntry {
  record: LogRecord;
  raw: string;
}

export interface ReadLogsResult {
  entries: ReadLogEntry[];
  malformedLines: number;
}

function isLogRecord(value: unknown): value is LogRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<LogRecord>;
  return (
    typeof record.timestamp === 'string' &&
    (record.level === 'info' || record.level === 'warn' || record.level === 'error') &&
    typeof record.event === 'string' &&
    typeof record.message === 'string'
  );
}

export function readLocalLogs(dataDir: string, options: ReadLogsOptions): ReadLogsResult {
  const minimum = options.minimumLevel ?? 'info';
  const logDir = path.join(dataDir, 'logs');
  if (!existsSync(logDir)) return { entries: [], malformedLines: 0 };
  const lockFile = path.join(logDir, '.write.lock');
  const lock = acquireReadLock(lockFile);
  const files = logPaths(logDir, DEFAULT_LIMITS.segmentCount).reverse();
  const tail = Math.min(Math.max(Math.floor(options.tail), 1), 1000);
  try {
    const entries: ReadLogEntry[] = [];
    let malformedLines = 0;
    for (const file of files.filter((candidate) => existsSync(candidate))) {
      const content = readFileSync(file, 'utf8');
      for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        try {
          const record = JSON.parse(line) as unknown;
          if (!isLogRecord(record)) {
            malformedLines += 1;
            continue;
          }
          if (LEVEL_VALUE[record.level] < LEVEL_VALUE[minimum]) continue;
          entries.push({ record, raw: line });
          if (entries.length > tail) entries.shift();
        } catch {
          malformedLines += 1;
        }
      }
    }
    return { entries, malformedLines };
  } finally {
    releaseLock(lockFile, lock);
  }
}
