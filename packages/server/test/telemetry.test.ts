import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  captureOperation,
  createTelemetry,
  installTelemetryStreamEndHandler,
  isTelemetryEnabled,
  publishTelemetryId,
  setTelemetryEnabled,
  telemetryDisabled,
} from '../src/telemetry.js';

describe('telemetry', () => {
  it('uses one operation event and protects its common properties from overrides', () => {
    const capture = vi.fn();
    captureOperation(
      { capture, shutdown: async () => undefined },
      {
        productSurface: 'mcp',
        operation: 'search_emails',
        outcome: 'success',
        durationMs: 1.6,
        transport: 'stdio',
        properties: {
          product_surface: 'private',
          operation: 'private',
          outcome: 'error',
          duration_ms: 9_999,
          error_code: 'private',
          transport: 'private',
          scheduled: false,
        },
      },
    );

    expect(capture).toHaveBeenCalledWith('operation completed', {
      product_surface: 'mcp',
      operation: 'search_emails',
      outcome: 'success',
      duration_ms: 2,
      transport: 'stdio',
      scheduled: false,
    });
  });

  it('does not let an injected telemetry client break an operation', () => {
    expect(() =>
      captureOperation(
        {
          capture: () => {
            throw new Error('analytics unavailable');
          },
          shutdown: async () => undefined,
        },
        { productSurface: 'rest', operation: 'getStatus', outcome: 'success', durationMs: 1 },
      ),
    ).not.toThrow();
  });

  it('uses the ID published by another process during concurrent initialization', () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'fluxmail-telemetry-'));
    const file = path.join(dataDir, 'telemetry.id');
    const firstCandidate = path.join(dataDir, 'first.tmp');
    const secondCandidate = path.join(dataDir, 'second.tmp');
    const firstId = '1'.repeat(32);
    const secondId = '2'.repeat(32);
    writeFileSync(firstCandidate, `${firstId}\n`, { mode: 0o600 });
    writeFileSync(secondCandidate, `${secondId}\n`, { mode: 0o600 });

    expect(publishTelemetryId(file, firstCandidate, firstId)).toBe(firstId);
    expect(publishTelemetryId(file, secondCandidate, secondId)).toBe(firstId);
    expect(readFileSync(file, 'utf8').trim()).toBe(firstId);
  });

  it('uses a stable anonymous installation id and common package properties', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'fluxmail-telemetry-'));
    const capture = vi.fn();
    const shutdown = vi.fn().mockResolvedValue(undefined);
    const telemetry = createTelemetry({
      dataDir,
      env: {},
      client: { capture, shutdown },
    });

    telemetry.capture('mcp tool called', {
      tool: 'search_emails',
      $process_person_profile: true,
      platform: 'overridden',
    });
    await telemetry.shutdown();

    const telemetryId = readFileSync(path.join(dataDir, 'telemetry.id'), 'utf8').trim();
    expect(telemetryId).toMatch(/^[a-f0-9]{32}$/);
    expect(capture).toHaveBeenCalledWith({
      distinctId: telemetryId,
      event: 'mcp tool called',
      disableGeoip: true,
      properties: expect.objectContaining({
        $process_person_profile: false,
        fluxmail_version: expect.any(String),
        node_version: process.versions.node,
        platform: process.platform,
        arch: process.arch,
        tool: 'search_emails',
      }),
    });
    expect(shutdown).toHaveBeenCalledOnce();
  });

  it.each([
    [{ FLUXMAIL_TELEMETRY: '0' }, true],
    [{ FLUXMAIL_TELEMETRY: 'false' }, true],
    [{ DO_NOT_TRACK: '1' }, true],
    [{ DO_NOT_TRACK: 'true' }, true],
    [{ FLUXMAIL_TELEMETRY: '1' }, false],
    [{}, false],
  ] as const)('reads opt-out settings from the environment', (env, expected) => {
    expect(telemetryDisabled(env)).toBe(expected);
  });

  it('does not initialize a client after opt-out', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'fluxmail-telemetry-'));
    const capture = vi.fn();
    const shutdown = vi.fn().mockResolvedValue(undefined);
    const telemetry = createTelemetry({
      dataDir,
      env: { FLUXMAIL_TELEMETRY: '0' },
      client: { capture, shutdown },
    });

    telemetry.capture('cli command used', { command: 'status' });
    await telemetry.shutdown();

    expect(capture).not.toHaveBeenCalled();
    expect(shutdown).not.toHaveBeenCalled();
  });

  it('starts an existing telemetry instance after the installation is re-enabled', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'fluxmail-telemetry-'));
    const capture = vi.fn();
    const shutdown = vi.fn().mockResolvedValue(undefined);
    const telemetry = createTelemetry({
      dataDir,
      env: {},
      client: { capture, shutdown },
    });

    setTelemetryEnabled(dataDir, false);
    telemetry.capture('mcp tool called');
    expect(capture).not.toHaveBeenCalled();

    setTelemetryEnabled(dataDir, true);
    telemetry.capture('mcp tool called');
    await telemetry.shutdown();

    expect(capture).toHaveBeenCalledOnce();
    expect(shutdown).toHaveBeenCalledWith(1_000);
  });

  it('batches events until shutdown', async () => {
    let requests = 0;
    const endpoint = createServer((request, response) => {
      request.resume();
      request.once('end', () => {
        requests += 1;
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{}');
      });
    });
    await new Promise<void>((resolve) => endpoint.listen(0, '127.0.0.1', resolve));
    const address = endpoint.address();
    if (!address || typeof address === 'string') throw new Error('Expected a TCP test server');

    try {
      const dataDir = mkdtempSync(path.join(tmpdir(), 'fluxmail-telemetry-'));
      const telemetry = createTelemetry({
        dataDir,
        env: { FLUXMAIL_POSTHOG_HOST: `http://127.0.0.1:${address.port}` },
      });

      telemetry.capture('mcp tool called', { tool: 'search_emails' });
      telemetry.capture('mcp tool called', { tool: 'get_email' });
      expect(requests).toBe(0);

      await telemetry.shutdown();
      expect(requests).toBe(1);
    } finally {
      await new Promise<void>((resolve, reject) => {
        endpoint.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  it('flushes queued events when a stdio stream ends', async () => {
    let requests = 0;
    const endpoint = createServer((request, response) => {
      request.resume();
      request.once('end', () => {
        requests += 1;
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{}');
      });
    });
    await new Promise<void>((resolve) => endpoint.listen(0, '127.0.0.1', resolve));
    const address = endpoint.address();
    if (!address || typeof address === 'string') throw new Error('Expected a TCP test server');

    try {
      const dataDir = mkdtempSync(path.join(tmpdir(), 'fluxmail-telemetry-'));
      const telemetry = createTelemetry({
        dataDir,
        env: { FLUXMAIL_POSTHOG_HOST: `http://127.0.0.1:${address.port}` },
      });
      const stdin = new PassThrough();
      installTelemetryStreamEndHandler(stdin, () => telemetry.shutdown());

      telemetry.capture('mcp tool called', { tool: 'search_emails' });
      stdin.resume();
      stdin.end();

      await vi.waitFor(() => expect(requests).toBe(1));
    } finally {
      await new Promise<void>((resolve, reject) => {
        endpoint.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  it('waits for an active MCP call before flushing on stdio EOF', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'fluxmail-telemetry-'));
    const capture = vi.fn();
    const shutdown = vi.fn().mockResolvedValue(undefined);
    const telemetry = createTelemetry({ dataDir, env: {}, client: { capture, shutdown } });
    const stdin = new PassThrough();
    installTelemetryStreamEndHandler(stdin, () => telemetry.shutdown());

    const finishActivity = telemetry.beginActivity!();
    stdin.resume();
    stdin.end();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(shutdown).not.toHaveBeenCalled();
    telemetry.capture('mcp tool called', { tool: 'get_email' });
    finishActivity();

    await vi.waitFor(() => expect(shutdown).toHaveBeenCalledOnce());
    expect(capture).toHaveBeenCalledOnce();
  });

  it('bounds shutdown when the analytics endpoint does not respond', async () => {
    const endpoint = createServer();
    await new Promise<void>((resolve) => endpoint.listen(0, '127.0.0.1', resolve));
    const address = endpoint.address();
    if (!address || typeof address === 'string') throw new Error('Expected a TCP test server');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const dataDir = mkdtempSync(path.join(tmpdir(), 'fluxmail-telemetry-'));
      const telemetry = createTelemetry({
        dataDir,
        env: { FLUXMAIL_POSTHOG_HOST: `http://127.0.0.1:${address.port}` },
      });
      const startedAt = performance.now();

      telemetry.capture('cli command used', { command: 'status' });
      await telemetry.shutdown();

      expect(performance.now() - startedAt).toBeLessThan(2_000);
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
      endpoint.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        endpoint.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  it('stops an existing client when the installation opts out', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'fluxmail-telemetry-'));
    const capture = vi.fn();
    const shutdown = vi.fn().mockResolvedValue(undefined);
    const telemetry = createTelemetry({
      dataDir,
      env: {},
      client: { capture, shutdown },
    });

    telemetry.capture('mcp tool called');
    setTelemetryEnabled(dataDir, false);
    telemetry.capture('mcp tool called');
    await telemetry.shutdown();

    expect(capture).toHaveBeenCalledOnce();
  });

  it('stores a CLI opt-out that takes precedence over environment settings', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'fluxmail-telemetry-'));
    const capture = vi.fn();
    const shutdown = vi.fn().mockResolvedValue(undefined);

    setTelemetryEnabled(dataDir, false);
    expect(isTelemetryEnabled(dataDir, { FLUXMAIL_TELEMETRY: '1' })).toBe(false);

    const disabled = createTelemetry({
      dataDir,
      env: { FLUXMAIL_TELEMETRY: '1' },
      client: { capture, shutdown },
    });
    disabled.capture('cli command used');
    await disabled.shutdown();
    expect(capture).not.toHaveBeenCalled();
    expect(existsSync(path.join(dataDir, 'telemetry.id'))).toBe(false);

    setTelemetryEnabled(dataDir, true);
    expect(isTelemetryEnabled(dataDir, {})).toBe(true);
  });

  it('does not read telemetry settings from legacy config.env files', () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'fluxmail-telemetry-'));
    writeFileSync(path.join(dataDir, 'config.env'), 'FLUXMAIL_TELEMETRY=0\n', { mode: 0o600 });

    expect(isTelemetryEnabled(dataDir, { FLUXMAIL_TELEMETRY: '1' })).toBe(true);
  });
});
