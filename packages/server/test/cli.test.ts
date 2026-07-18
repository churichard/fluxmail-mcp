import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createCliProgram,
  permissionPolicyForUpdate,
  permissionPolicyFromOptions,
  waitForServerListening,
} from '../src/cli.js';
import { customPermissionPolicy, permissionPolicyForProfile } from '../src/permissions.js';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function telemetrySpy() {
  const capture = vi.fn();
  return { capture, telemetry: { capture, shutdown: vi.fn().mockResolvedValue(undefined) } };
}

describe('CLI telemetry', () => {
  it('rejects server startup errors before the command can be recorded as successful', async () => {
    const startupError = new Error('address already in use');
    const server = createServer();
    const listening = waitForServerListening(server);

    server.emit('error', startupError);

    await expect(listening).rejects.toBe(startupError);
  });

  it('records successful commands with the shared operation schema', async () => {
    vi.stubEnv('FLUXMAIL_DATA_DIR', mkdtempSync(path.join(tmpdir(), 'fluxmail-cli-telemetry-')));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { capture, telemetry } = telemetrySpy();

    await createCliProgram({ telemetry }).parseAsync(['node', 'fluxmail', 'telemetry', 'status']);

    expect(capture).toHaveBeenCalledWith('operation completed', {
      product_surface: 'cli',
      operation: 'telemetry status',
      outcome: 'success',
      duration_ms: expect.any(Number),
    });
    expect(log).toHaveBeenCalled();
  });

  it('records command failures without arguments or error text', async () => {
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { capture, telemetry } = telemetrySpy();

    try {
      await createCliProgram({ telemetry }).parseAsync(['node', 'fluxmail', 'license', 'activate', 'private-key']);

      expect(capture).toHaveBeenCalledWith('operation completed', {
        product_surface: 'cli',
        operation: 'license activate',
        outcome: 'error',
        error_code: 'command_failed',
        duration_ms: expect.any(Number),
      });
      expect(JSON.stringify(capture.mock.calls)).not.toContain('private-key');
      expect(error).toHaveBeenCalled();
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it('records a safe error code when account setup rejects a provider', async () => {
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { capture, telemetry } = telemetrySpy();

    try {
      await createCliProgram({ telemetry }).parseAsync([
        'node',
        'fluxmail',
        'accounts',
        'add',
        'private-provider-value',
      ]);

      expect(capture).toHaveBeenCalledWith('operation completed', {
        product_surface: 'cli',
        operation: 'accounts add',
        outcome: 'error',
        error_code: 'invalid_request',
        duration_ms: expect.any(Number),
      });
      expect(JSON.stringify(capture.mock.calls)).not.toContain('private-provider-value');
      expect(error).toHaveBeenCalled();
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it('does not record the telemetry disable command', async () => {
    vi.stubEnv('FLUXMAIL_DATA_DIR', mkdtempSync(path.join(tmpdir(), 'fluxmail-cli-telemetry-')));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { capture, telemetry } = telemetrySpy();

    await createCliProgram({ telemetry }).parseAsync(['node', 'fluxmail', 'telemetry', 'disable']);

    expect(capture).not.toHaveBeenCalled();
  });

  it('shows an update notice after command output without changing telemetry', async () => {
    vi.stubEnv('FLUXMAIL_DATA_DIR', mkdtempSync(path.join(tmpdir(), 'fluxmail-cli-update-')));
    const events: string[] = [];
    vi.spyOn(console, 'log').mockImplementation(() => events.push('command output'));
    const notify = vi.fn(() => events.push('update notice'));
    const updateNotifierFactory = vi.fn(() => ({ notify }));
    const { capture, telemetry } = telemetrySpy();

    await createCliProgram({ telemetry, updateNotifierFactory }).parseAsync([
      'node',
      'fluxmail',
      'telemetry',
      'status',
    ]);

    expect(updateNotifierFactory).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledOnce();
    expect(events).toEqual(['command output', 'update notice']);
    expect(capture).toHaveBeenCalledWith('operation completed', {
      product_surface: 'cli',
      operation: 'telemetry status',
      outcome: 'success',
      duration_ms: expect.any(Number),
    });
    expect(JSON.stringify(capture.mock.calls)).not.toContain('update');
  });

  it.each([
    ['before the command', ['--no-update-notifier', 'telemetry', 'status']],
    ['after the command', ['telemetry', 'status', '--no-update-notifier']],
  ])('supports the update opt-out flag %s', async (_name, args) => {
    vi.stubEnv('FLUXMAIL_DATA_DIR', mkdtempSync(path.join(tmpdir(), 'fluxmail-cli-update-')));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const updateNotifierFactory = vi.fn(() => ({ notify: vi.fn() }));
    const { capture, telemetry } = telemetrySpy();

    await createCliProgram({ telemetry, updateNotifierFactory }).parseAsync(['node', 'fluxmail', ...args]);

    expect(updateNotifierFactory).not.toHaveBeenCalled();
    expect(capture).toHaveBeenCalledWith('operation completed', {
      product_surface: 'cli',
      operation: 'telemetry status',
      outcome: 'success',
      duration_ms: expect.any(Number),
    });
    expect(JSON.stringify(capture.mock.calls)).not.toContain('no-update-notifier');
  });

  it('does not create an update notifier for stdio MCP', async () => {
    vi.stubEnv('FLUXMAIL_DATA_DIR', mkdtempSync(path.join(tmpdir(), 'fluxmail-cli-update-')));
    const updateNotifierFactory = vi.fn(() => ({ notify: vi.fn() }));
    const { telemetry } = telemetrySpy();

    await expect(
      createCliProgram({ telemetry, updateNotifierFactory }).parseAsync(['node', 'fluxmail', 'stdio']),
    ).rejects.toThrow();

    expect(updateNotifierFactory).not.toHaveBeenCalled();
  });

  it('does not fail the command when an update notice cannot be displayed', async () => {
    vi.stubEnv('FLUXMAIL_DATA_DIR', mkdtempSync(path.join(tmpdir(), 'fluxmail-cli-update-')));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const updateNotifierFactory = vi.fn(() => ({
      notify: vi.fn(() => {
        throw new Error('private terminal failure');
      }),
    }));
    const { capture, telemetry } = telemetrySpy();

    await createCliProgram({ telemetry, updateNotifierFactory }).parseAsync([
      'node',
      'fluxmail',
      'telemetry',
      'status',
    ]);

    expect(capture).toHaveBeenCalledWith('operation completed', {
      product_surface: 'cli',
      operation: 'telemetry status',
      outcome: 'success',
      duration_ms: expect.any(Number),
    });
  });
});

describe('API key permission options', () => {
  it('preserves the named mail profile when changing only admin capabilities', () => {
    expect(
      permissionPolicyForUpdate({ allow: [], admin: ['admin.accounts'] }, { permissionProfile: 'read-only' }),
    ).toEqual(permissionPolicyForProfile('read-only', ['admin.accounts']));

    expect(
      permissionPolicyForUpdate(
        { profile: 'full', allow: [], admin: ['admin.accounts'] },
        { permissionProfile: 'read-only' },
      ),
    ).toEqual(permissionPolicyForProfile('full', ['admin.accounts']));
  });

  it('requires a complete allowlist when changing a custom policy', () => {
    expect(() =>
      permissionPolicyForUpdate({ allow: [], admin: ['admin.accounts'] }, { permissionProfile: 'custom' }),
    ).toThrow('This key uses a custom policy. Pass every capability with --allow.');

    expect(
      permissionPolicyForUpdate({ allow: ['mail.read', 'admin.accounts'], admin: [] }, { permissionProfile: 'custom' }),
    ).toEqual(customPermissionPolicy(['mail.read', 'admin.accounts']));
  });

  it('requires at least one permission option when updating a key', () => {
    expect(() => permissionPolicyForUpdate({ allow: [], admin: [] }, { permissionProfile: 'read-only' })).toThrow(
      'Choose --profile, --admin, or at least one --allow capability.',
    );
  });

  it('keeps full as the default mail profile when creating an administrative key', () => {
    expect(permissionPolicyFromOptions({ allow: [], admin: ['admin.accounts'] })).toEqual(
      permissionPolicyForProfile('full', ['admin.accounts']),
    );
  });
});
