import { EmailError } from '@fluxmail/core';
import { execFile } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { createLogger, getLogger, logFailure, readLocalLogs, shutdownLogging, type LogRecord } from '../src/logging.js';

const runFile = promisify(execFile);
const loggingModuleUrl = new URL('../src/logging.ts', import.meta.url).href;

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'fluxmail-logging-'));
}

function records(dataDir: string): LogRecord[] {
  return readLocalLogs(dataDir, { tail: 1000 }).entries.map((entry) => entry.record);
}

async function waitForFile(file: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (existsSync(file)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${file}`);
}

describe('local logging', () => {
  it('writes structured known and unexpected failures without known-error stacks', async () => {
    const dataDir = tempDir();
    const logger = createLogger({ dataDir, mode: 'serve', destination: 'file' });

    logFailure(logger, 'rest.operation_failed', new EmailError('rate_limited', 'Try later.'), {
      productSurface: 'rest',
      operation: 'searchMessages',
      durationMs: 12.6,
    });
    const cause = new Error('socket failed');
    logFailure(logger, 'scheduler.tick_failed', new Error('worker failed', { cause }));
    await logger.close();

    const [known, unexpected] = records(dataDir);
    expect(known).toMatchObject({
      level: 'warn',
      event: 'rest.operation_failed',
      product_surface: 'rest',
      operation: 'searchMessages',
      duration_ms: 13,
      error: { name: 'EmailError', code: 'rate_limited', message: 'Try later.' },
    });
    expect(known?.error?.stack).toBeUndefined();
    expect(unexpected).toMatchObject({
      level: 'error',
      event: 'scheduler.tick_failed',
      error: { name: 'Error', message: 'worker failed', cause: { message: 'socket failed' } },
    });
    expect(unexpected?.error?.stack).toContain('worker failed');
    expect(statSync(path.join(dataDir, 'logs')).mode & 0o777).toBe(0o700);
    expect(statSync(path.join(dataDir, 'logs', 'fluxmail.jsonl')).mode & 0o777).toBe(0o600);
  });

  it('redacts common secrets and omits EmailError data', async () => {
    const dataDir = tempDir();
    const logger = createLogger({ dataDir, mode: 'cli', destination: 'file' });
    const secret = 'fluxmail_lic_super-secret';
    const apiKey = `fmk_${'a'.repeat(64)}`;
    const error = new EmailError(
      'auth_expired',
      `Bearer abc123 failed at https://example.test/?refresh_token=private-token with ${secret} and ${apiKey}`,
      { reauthUrl: 'https://private.test/code' },
    );

    logFailure(logger, 'cli.operation_failed', error, { productSurface: 'cli', operation: 'accounts add' });
    await logger.close();

    const output = readFileSync(path.join(dataDir, 'logs', 'fluxmail.jsonl'), 'utf8');
    expect(output).not.toContain('abc123');
    expect(output).not.toContain('private-token');
    expect(output).not.toContain(secret);
    expect(output).not.toContain(apiKey);
    expect(output).not.toContain('reauthUrl');
    expect(output).toContain('[REDACTED]');
  });

  it('escapes line breaks and terminal control characters in console records', async () => {
    const dataDir = tempDir();
    const consoleLines: string[] = [];
    const logger = createLogger({
      dataDir,
      mode: 'serve',
      destination: 'console',
      consoleWrite: (value) => consoleLines.push(value),
    });

    logger.warn('provider.failed\nforged.event\u001b[2J', 'First line\r\n2026-01-01 ERROR forged: second line\u0007');
    await logger.close();

    expect(consoleLines).toHaveLength(1);
    expect(consoleLines[0]!.split('\n')).toHaveLength(2);
    expect(consoleLines[0]).toContain('provider.failed\\nforged.event');
    expect(consoleLines[0]).toContain('First line\\r\\n2026-01-01 ERROR forged: second line');
    expect(consoleLines[0]).toContain('\\x1b[2J');
    expect(consoleLines[0]).toContain('\\x07');
    expect(
      Array.from(consoleLines[0]!.slice(0, -1)).some((character) => {
        const code = character.codePointAt(0)!;
        return code <= 0x1f || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029;
      }),
    ).toBe(false);
  });

  it('flushes shared loggers for every data directory during shutdown', async () => {
    const firstDataDir = tempDir();
    const secondDataDir = tempDir();
    getLogger(firstDataDir, 'library', { level: 'info', destination: 'file' }).error('first.failed', 'First failure');
    getLogger(secondDataDir, 'library', { level: 'info', destination: 'file' }).error(
      'second.failed',
      'Second failure',
    );

    await shutdownLogging();

    expect(records(firstDataDir)).toContainEqual(expect.objectContaining({ event: 'first.failed' }));
    expect(records(secondDataDir)).toContainEqual(expect.objectContaining({ event: 'second.failed' }));
  });

  it('caps a single serialized record at 16 KiB', async () => {
    const dataDir = tempDir();
    const logger = createLogger({ dataDir, mode: 'serve', destination: 'file' });
    logger.error('oversized.failure', 'x'.repeat(1_000_000), new Error('y'.repeat(1_000_000)));
    await logger.close();

    const line = readFileSync(path.join(dataDir, 'logs', 'fluxmail.jsonl'), 'utf8').trim();
    expect(Buffer.byteLength(line)).toBeLessThanOrEqual(16 * 1024);
    expect(() => JSON.parse(line)).not.toThrow();
    expect(line).toContain('[truncated]');
  });

  it('bounds rotation to the configured segment count and size', async () => {
    const dataDir = tempDir();
    const logger = createLogger({
      dataDir,
      mode: 'serve',
      destination: 'file',
      limits: {
        segmentBytes: 700,
        segmentCount: 4,
        maxRecordBytes: 500,
        maxBatchBytes: 500,
        maxQueueBytes: 20_000,
        rateBurstBytes: 20_000,
        rateBytesPerHour: 20_000,
        duplicateLimit: 100,
      },
    });
    for (let index = 0; index < 30; index += 1) {
      logger.error(`test.failure_${index}`, `failure ${index} ${'x'.repeat(150)}`, new Error(`boom ${index}`));
      await logger.flush();
    }
    await logger.close();

    const logDir = path.join(dataDir, 'logs');
    const files = readdirSync(logDir).filter((file) => file.startsWith('fluxmail.jsonl'));
    expect(files).toHaveLength(4);
    expect(files.every((file) => statSync(path.join(logDir, file)).size <= 700)).toBe(true);
    expect(files.reduce((total, file) => total + statSync(path.join(logDir, file)).size, 0)).toBeLessThanOrEqual(2_800);
  });

  it('deduplicates repeated failures and reports suppression', async () => {
    let now = 1_700_000_000_000;
    const dataDir = tempDir();
    const logger = createLogger({
      dataDir,
      mode: 'serve',
      destination: 'file',
      now: () => now,
      limits: { duplicateWindowMs: 1_000, duplicateLimit: 3 },
    });
    for (let index = 0; index < 10; index += 1) {
      logger.warn('provider.failed', 'Provider unavailable', new EmailError('provider_unavailable', 'offline'));
    }
    now += 1_001;
    logger.warn('provider.failed', 'Provider unavailable', new EmailError('provider_unavailable', 'offline'));
    await logger.close();

    const output = records(dataDir);
    expect(output.filter((record) => record.event === 'provider.failed')).toHaveLength(4);
    expect(output).toContainEqual(
      expect.objectContaining({
        event: 'logging.records_suppressed',
        details: expect.objectContaining({ reason: 'duplicate', count: 7 }),
      }),
    );
  });

  it('does not emit suppression warnings below the configured log level', async () => {
    const dataDir = tempDir();
    const consoleLines: string[] = [];
    const logger = createLogger({
      dataDir,
      mode: 'serve',
      level: 'error',
      destination: 'console',
      consoleWrite: (value) => consoleLines.push(value),
      limits: { duplicateLimit: 1 },
    });

    logger.error('provider.failed', 'Provider unavailable');
    logger.error('provider.failed', 'Provider unavailable');
    await logger.close();

    expect(consoleLines).toHaveLength(1);
    expect(consoleLines[0]).toContain('ERROR provider.failed');
    expect(consoleLines[0]).not.toContain('logging.records_suppressed');
  });

  it('keeps failures from separate operations when they share an event and error code', async () => {
    const dataDir = tempDir();
    const logger = createLogger({ dataDir, mode: 'serve', destination: 'file' });
    for (const operation of ['listLabels', 'getMessage', 'createDraft', 'sendMessage']) {
      logger.warn('rest.operation_failed', 'Provider unavailable', new EmailError('provider_unavailable', 'offline'), {
        operation,
      });
    }
    await logger.close();

    expect(records(dataDir).map((record) => record.operation)).toEqual([
      'listLabels',
      'getMessage',
      'createDraft',
      'sendMessage',
    ]);
  });

  it('keeps JSONL valid when separate processes share the log file', async () => {
    const dataDir = tempDir();
    const script = `
      import { createLogger } from ${JSON.stringify(loggingModuleUrl)};
      const [dataDir, index] = process.argv.slice(1);
      const logger = createLogger({ dataDir, mode: 'cli', destination: 'file' });
      logger.error('child.failed_' + index, 'child failure ' + index, new Error('boom ' + index));
      await logger.close();
    `;

    await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        runFile(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, dataDir, String(index)]),
      ),
    );

    const result = readLocalLogs(dataDir, { tail: 10 });
    expect(result.malformedLines).toBe(0);
    expect(result.entries.map((entry) => entry.record.event).sort()).toEqual([
      'child.failed_0',
      'child.failed_1',
      'child.failed_2',
      'child.failed_3',
    ]);
  });

  it('waits for a contended file lock before closing', async () => {
    const dataDir = tempDir();
    const logDir = path.join(dataDir, 'logs');
    mkdirSync(logDir);
    const lockFile = path.join(logDir, '.write.lock');
    writeFileSync(lockFile, JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
    const releaseLock = setTimeout(() => rmSync(lockFile, { force: true }), 100);
    const logger = createLogger({ dataDir, mode: 'cli', destination: 'file' });
    logger.error('cli.operation_failed', 'Command failed while another process read the logs');

    try {
      await logger.close();
    } finally {
      clearTimeout(releaseLock);
      rmSync(lockFile, { force: true });
    }

    expect(records(dataDir)).toContainEqual(expect.objectContaining({ event: 'cli.operation_failed' }));
  });

  it('serializes abandoned-lock recovery before writing', async () => {
    const dataDir = tempDir();
    const logDir = path.join(dataDir, 'logs');
    mkdirSync(logDir);
    const lockFile = path.join(logDir, '.write.lock');
    const reclaimFile = `${lockFile}.reclaim`;
    writeFileSync(
      lockFile,
      JSON.stringify({ token: 'stale', pid: process.pid, hostname: 'another-host', createdAt: 0 }),
    );
    utimesSync(lockFile, new Date(0), new Date(0));
    writeFileSync(reclaimFile, 'reclaim in progress');
    const logger = createLogger({ dataDir, mode: 'cli', destination: 'file' });
    logger.error('cli.operation_failed', 'Command failed during lock recovery');

    const closing = logger.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(existsSync(path.join(logDir, 'fluxmail.jsonl'))).toBe(false);
    rmSync(reclaimFile);
    await closing;

    expect(records(dataDir)).toContainEqual(expect.objectContaining({ event: 'cli.operation_failed' }));
  });

  it('applies a byte budget and reports rate suppression when capacity returns', async () => {
    let now = 1_700_000_000_000;
    const dataDir = tempDir();
    const logger = createLogger({
      dataDir,
      mode: 'serve',
      destination: 'file',
      now: () => now,
      limits: { rateBurstBytes: 1_000, rateBytesPerHour: 1_000, duplicateLimit: 100 },
    });
    for (let index = 0; index < 20; index += 1) {
      logger.warn(`limited.${index}`, `failure ${index} ${'x'.repeat(100)}`);
    }
    now += 60 * 60_000;
    logger.warn('limited.after_refill', 'after refill');
    await logger.close();

    const output = records(dataDir);
    expect(output.filter((record) => record.event.startsWith('limited.')).length).toBeLessThan(20);
    expect(output).toContainEqual(
      expect.objectContaining({
        event: 'logging.records_suppressed',
        details: expect.objectContaining({ reason: 'rate' }),
      }),
    );
  });

  it('reports rate suppression when closing before capacity returns', async () => {
    const dataDir = tempDir();
    const logger = createLogger({
      dataDir,
      mode: 'serve',
      destination: 'file',
      limits: { rateBurstBytes: 1_000, rateBytesPerHour: 0, duplicateLimit: 100 },
    });
    for (let index = 0; index < 20; index += 1) {
      logger.warn(`limited.${index}`, `failure ${index} ${'x'.repeat(100)}`);
    }
    await logger.close();

    expect(records(dataDir)).toContainEqual(
      expect.objectContaining({
        event: 'logging.records_suppressed',
        details: expect.objectContaining({ reason: 'rate' }),
      }),
    );
  });

  it('bounds the in-memory queue and reports dropped records on close', async () => {
    const dataDir = tempDir();
    const logger = createLogger({
      dataDir,
      mode: 'serve',
      destination: 'file',
      limits: {
        maxQueueBytes: 1_000,
        rateBurstBytes: 100_000,
        rateBytesPerHour: 100_000,
        duplicateLimit: 100,
      },
    });
    for (let index = 0; index < 20; index += 1) logger.warn(`queued.${index}`, `failure ${'x'.repeat(100)}`);
    await logger.close();

    expect(records(dataDir)).toContainEqual(
      expect.objectContaining({
        event: 'logging.records_suppressed',
        details: expect.objectContaining({ reason: 'queue' }),
      }),
    );
  });

  it('does not throw or retry in a loop when the file destination is unwritable', async () => {
    const dataDir = tempDir();
    const logDir = path.join(dataDir, 'logs');
    writeFileSync(logDir, 'not a directory');
    const consoleLines: string[] = [];
    const logger = createLogger({
      dataDir,
      mode: 'serve',
      destination: 'file',
      consoleWrite: (value) => consoleLines.push(value),
    });

    expect(() => logger.error('test.failed', 'failure', new Error('boom'))).not.toThrow();
    await logger.close();
    expect(consoleLines).toEqual(['Fluxmail could not write its local log file. Local file logging is unavailable.\n']);
  });

  it('reads rotated logs in order, filters levels, and skips malformed lines', () => {
    const dataDir = tempDir();
    const logDir = path.join(dataDir, 'logs');
    mkdirSync(logDir);
    const record = (timestamp: string, level: 'info' | 'warn' | 'error', event: string) =>
      JSON.stringify({
        timestamp,
        level,
        event,
        message: event,
        version: 'test',
        pid: 1,
        run_id: 'run',
        process_mode: 'serve',
      });
    writeFileSync(path.join(logDir, 'fluxmail.jsonl.1'), `${record('2026-01-01T00:00:00Z', 'warn', 'old')}\n`);
    writeFileSync(
      path.join(logDir, 'fluxmail.jsonl'),
      `${record('2026-01-01T00:00:01Z', 'info', 'ignored')}\nmalformed\n${record('2026-01-01T00:00:02Z', 'error', 'new')}\n`,
    );

    const result = readLocalLogs(dataDir, { tail: 10, minimumLevel: 'warn' });
    expect(result.entries.map((entry) => entry.record.event)).toEqual(['old', 'new']);
    expect(result.malformedLines).toBe(1);
  });

  it('waits for rotation to finish before reading a log snapshot', async () => {
    const dataDir = tempDir();
    const logDir = path.join(dataDir, 'logs');
    mkdirSync(logDir);
    const record = (event: string) =>
      JSON.stringify({
        timestamp: '2026-01-01T00:00:00Z',
        level: 'error',
        event,
        message: event,
        version: 'test',
        pid: 1,
        run_id: 'run',
        process_mode: 'serve',
      });
    writeFileSync(path.join(logDir, 'fluxmail.jsonl.1'), `${record('old')}\n`);
    writeFileSync(path.join(logDir, 'fluxmail.jsonl'), `${record('middle')}\n`);
    const readyFile = path.join(dataDir, 'rotation-ready');
    const script = `
      import { closeSync, openSync, renameSync, rmSync, writeFileSync } from 'node:fs';
      import path from 'node:path';
      const [logDir, readyFile, newRecord] = process.argv.slice(1);
      const lockFile = path.join(logDir, '.write.lock');
      const descriptor = openSync(lockFile, 'wx', 0o600);
      writeFileSync(descriptor, JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
      closeSync(descriptor);
      writeFileSync(readyFile, 'ready');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
      renameSync(path.join(logDir, 'fluxmail.jsonl.1'), path.join(logDir, 'fluxmail.jsonl.2'));
      renameSync(path.join(logDir, 'fluxmail.jsonl'), path.join(logDir, 'fluxmail.jsonl.1'));
      writeFileSync(path.join(logDir, 'fluxmail.jsonl'), newRecord + '\\n');
      rmSync(lockFile);
    `;
    const rotation = runFile(process.execPath, ['--input-type=module', '-e', script, logDir, readyFile, record('new')]);
    await waitForFile(readyFile);

    const result = readLocalLogs(dataDir, { tail: 10 });
    await rotation;

    expect(result.entries.map((entry) => entry.record.event)).toEqual(['old', 'middle', 'new']);
  });
});
