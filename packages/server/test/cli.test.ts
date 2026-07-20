import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
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
import { createContext } from '../src/context.js';
import { customPermissionPolicy, permissionPolicyForProfile } from '../src/permissions.js';
import { instanceSettings } from '../src/storage/db.js';

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

  it('records config init without including paths or configuration values', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'fluxmail-cli-config-'));
    vi.stubEnv('FLUXMAIL_DATA_DIR', dataDir);
    vi.spyOn(process, 'cwd').mockReturnValue(mkdtempSync(path.join(tmpdir(), 'fluxmail-cli-cwd-')));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { capture, telemetry } = telemetrySpy();

    await createCliProgram({ telemetry, updateNotifierFactory: () => ({ notify: () => {} }) }).parseAsync([
      'node',
      'fluxmail',
      'config',
      'init',
    ]);

    const file = path.join(dataDir, 'config.toml');
    expect(readFileSync(file, 'utf8')).toContain('[server]');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(capture).toHaveBeenCalledWith(
      'operation completed',
      expect.objectContaining({ product_surface: 'cli', operation: 'config init', outcome: 'success' }),
    );
    expect(JSON.stringify(capture.mock.calls)).not.toContain(dataDir);
  });

  it('dry-runs an explicit config migration without deleting the source or recording its secret', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'fluxmail-cli-config-'));
    const source = path.join(dataDir, 'legacy.env');
    const privateSecret = 'private-migration-secret';
    writeFileSync(source, `GOOGLE_CLIENT_ID=client-id\nGOOGLE_CLIENT_SECRET=${privateSecret}\n`);
    vi.stubEnv('FLUXMAIL_DATA_DIR', dataDir);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { capture, telemetry } = telemetrySpy();

    await createCliProgram({ telemetry, updateNotifierFactory: () => ({ notify: () => {} }) }).parseAsync([
      'node',
      'fluxmail',
      'config',
      'migrate',
      '--from',
      source,
      '--dry-run',
    ]);

    expect(existsSync(source)).toBe(true);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('GOOGLE_CLIENT_SECRET'));
    expect(JSON.stringify(capture.mock.calls)).not.toContain(privateSecret);
    expect(JSON.stringify(capture.mock.calls)).not.toContain(source);
  });

  it('does not migrate config.env during unrelated commands', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'fluxmail-cli-config-'));
    const legacyFile = path.join(dataDir, 'config.env');
    writeFileSync(legacyFile, 'FLUXMAIL_TELEMETRY=0\n', { mode: 0o600 });
    vi.stubEnv('FLUXMAIL_DATA_DIR', dataDir);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { telemetry } = telemetrySpy();

    await createCliProgram({ telemetry, updateNotifierFactory: () => ({ notify: () => {} }) }).parseAsync([
      'node',
      'fluxmail',
      'telemetry',
      'status',
    ]);

    expect(existsSync(legacyFile)).toBe(true);
    expect(existsSync(path.join(dataDir, 'telemetry.disabled'))).toBe(false);
  });

  it('imports config.env only through the explicit migration command', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'fluxmail-cli-config-'));
    const legacyFile = path.join(dataDir, 'config.env');
    const legacyDb = path.join(dataDir, 'legacy.db');
    const privateSecret = 'manual-migration-secret';
    const licenseKey = `fluxmail_lic_${'ab'.repeat(20)}`;
    writeFileSync(
      legacyFile,
      [
        `FLUXMAIL_DB_PATH=${legacyDb}`,
        `FLUXMAIL_ENCRYPTION_KEY=${'12'.repeat(32)}`,
        'FLUXMAIL_PORT=9123',
        'GOOGLE_CLIENT_ID=manual-google-id',
        `GOOGLE_CLIENT_SECRET=${privateSecret}`,
        `FLUXMAIL_LICENSE_KEY=${licenseKey}`,
        'FLUXMAIL_TELEMETRY=0',
      ].join('\n') + '\n',
      { mode: 0o600 },
    );
    vi.stubEnv('FLUXMAIL_DATA_DIR', dataDir);
    vi.stubEnv('FLUXMAIL_ENCRYPTION_KEY', '12'.repeat(32));
    vi.stubEnv('GOOGLE_CLIENT_ID', 'manual-google-id');
    vi.stubEnv('GOOGLE_CLIENT_SECRET', privateSecret);
    vi.stubEnv('FLUXMAIL_LICENSE_KEY', licenseKey);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { capture, telemetry } = telemetrySpy();

    await createCliProgram({ telemetry, updateNotifierFactory: () => ({ notify: () => {} }) }).parseAsync([
      'node',
      'fluxmail',
      'config',
      'migrate',
      '--from',
      legacyFile,
    ]);

    expect(existsSync(legacyFile)).toBe(true);
    expect(readFileSync(path.join(dataDir, 'config.toml'), 'utf8')).toContain(legacyDb);
    expect(readFileSync(path.join(dataDir, 'encryption.key'), 'utf8').trim()).toBe('12'.repeat(32));
    expect(existsSync(path.join(dataDir, 'telemetry.disabled'))).toBe(true);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Imported'));

    const context = createContext();
    try {
      expect(context.config.dbPath).toBe(legacyDb);
      expect(context.config.port).toBe(9123);
      expect(context.config.google).toEqual({ clientId: 'manual-google-id', clientSecret: privateSecret });
      expect(context.config.licenseKey).toBe(licenseKey);
      expect(context.configuration.store.google()).toEqual({
        clientId: 'manual-google-id',
        clientSecret: privateSecret,
      });
      expect(context.configuration.store.licenseKey()).toBe(licenseKey);
      expect(JSON.stringify(context.db.select().from(instanceSettings).all())).not.toContain(privateSecret);
      expect(JSON.stringify(context.db.select().from(instanceSettings).all())).not.toContain(licenseKey);
    } finally {
      context.licenseController.stop();
      (context.db as unknown as { $client: { close(): void } }).$client.close();
    }
    expect(JSON.stringify(capture.mock.calls)).not.toContain(privateSecret);
    expect(JSON.stringify(capture.mock.calls)).not.toContain(licenseKey);
    expect(JSON.stringify(capture.mock.calls)).not.toContain(legacyFile);
  });

  it('validates imported deployment values before writing files, even when the process overrides them', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'fluxmail-cli-config-'));
    const source = path.join(dataDir, 'invalid.env');
    writeFileSync(source, [`FLUXMAIL_ENCRYPTION_KEY=${'34'.repeat(32)}`, 'FLUXMAIL_PORT=70000'].join('\n') + '\n', {
      mode: 0o600,
    });
    vi.stubEnv('FLUXMAIL_DATA_DIR', dataDir);
    vi.stubEnv('FLUXMAIL_PORT', '8977');
    const { telemetry } = telemetrySpy();

    await expect(
      createCliProgram({ telemetry, updateNotifierFactory: () => ({ notify: () => {} }) }).parseAsync([
        'node',
        'fluxmail',
        'config',
        'migrate',
        '--from',
        source,
      ]),
    ).rejects.toThrow(/integer between 1 and 65535/);

    expect(existsSync(source)).toBe(true);
    expect(existsSync(path.join(dataDir, 'config.toml'))).toBe(false);
    expect(existsSync(path.join(dataDir, 'encryption.key'))).toBe(false);
  });

  it('removes newly created configuration files when encrypted instance import cannot open the database', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'fluxmail-cli-config-'));
    const source = path.join(dataDir, 'unwritable.env');
    const nonDirectory = path.join(dataDir, 'not-a-directory');
    writeFileSync(nonDirectory, 'file');
    writeFileSync(
      source,
      [
        `FLUXMAIL_DB_PATH=${path.join(nonDirectory, 'fluxmail.db')}`,
        'FLUXMAIL_PORT=9123',
        'GOOGLE_CLIENT_ID=client-id',
        'GOOGLE_CLIENT_SECRET=private-secret',
      ].join('\n') + '\n',
      { mode: 0o600 },
    );
    vi.stubEnv('FLUXMAIL_DATA_DIR', dataDir);
    const { telemetry } = telemetrySpy();

    await expect(
      createCliProgram({ telemetry, updateNotifierFactory: () => ({ notify: () => {} }) }).parseAsync([
        'node',
        'fluxmail',
        'config',
        'migrate',
        '--from',
        source,
      ]),
    ).rejects.toThrow();

    expect(existsSync(source)).toBe(true);
    expect(existsSync(path.join(dataDir, 'config.toml'))).toBe(false);
    expect(existsSync(path.join(dataDir, 'encryption.key'))).toBe(false);
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
