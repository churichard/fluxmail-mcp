import { execFile } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  configFilePath,
  expandHome,
  loadConfig,
  maskStoredConfigValue,
  readStoredConfig,
  setStoredConfig,
  unsetStoredConfig,
} from '../src/config.js';
import { DEFAULT_GOOGLE_CLIENT_ID, DEFAULT_GOOGLE_CLIENT_SECRET } from '../src/accounts/defaultGoogleOAuth.js';
import { isTelemetryEnabled, telemetryDisabled, withStoredTelemetrySetting } from '../src/telemetry.js';
import { createContext } from '../src/context.js';

const ENV_KEYS = [
  'FLUXMAIL_DATA_DIR',
  'FLUXMAIL_DB_PATH',
  'FLUXMAIL_ENCRYPTION_KEY',
  'FLUXMAIL_PUBLIC_URL',
  'FLUXMAIL_PORT',
  'FLUXMAIL_OAUTH_PORT',
  'FLUXMAIL_OAUTH_HOST',
  'FLUXMAIL_TRUST_PROXY',
  'FLUXMAIL_MAX_ATTACHMENT_MB',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'MICROSOFT_CLIENT_ID',
  'MICROSOFT_CLIENT_SECRET',
  'MICROSOFT_TENANT_ID',
  'FLUXMAIL_TELEMETRY',
  'FM_STORED_TEST',
];
const saved: Record<string, string | undefined> = {};
const runFile = promisify(execFile);
const configModuleUrl = new URL('../src/config.ts', import.meta.url).href;

for (const k of ENV_KEYS) saved[k] = process.env[k];
beforeEach(() => {
  vi.spyOn(process, 'cwd').mockReturnValue(tempDataDir());
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function tempDataDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'fluxmail-config-'));
}

describe('stored config', () => {
  it('uses the built-in Google OAuth app by default', () => {
    process.env.FLUXMAIL_DATA_DIR = tempDataDir();
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;

    const google = loadConfig().google;

    expect(google).toEqual({
      clientId: DEFAULT_GOOGLE_CLIENT_ID,
      clientSecret: DEFAULT_GOOGLE_CLIENT_SECRET,
    });
  });

  it('requires both values for a custom Google OAuth client', () => {
    process.env.FLUXMAIL_DATA_DIR = tempDataDir();
    process.env.GOOGLE_CLIENT_ID = 'custom-client-id';
    delete process.env.GOOGLE_CLIENT_SECRET;

    expect(() => loadConfig()).toThrow(/GOOGLE_CLIENT_ID requires GOOGLE_CLIENT_SECRET/);

    process.env.GOOGLE_CLIENT_SECRET = 'custom-client-secret';
    expect(loadConfig().google).toEqual({
      clientId: 'custom-client-id',
      clientSecret: 'custom-client-secret',
    });
  });

  it('rejects a Google OAuth client secret without a client ID', () => {
    process.env.FLUXMAIL_DATA_DIR = tempDataDir();

    delete process.env.GOOGLE_CLIENT_ID;
    process.env.GOOGLE_CLIENT_SECRET = 'custom-client-secret';
    expect(() => loadConfig()).toThrow(/GOOGLE_CLIENT_SECRET requires GOOGLE_CLIENT_ID/);
  });

  it('set, read, unset round-trip', () => {
    const dir = tempDataDir();
    setStoredConfig(dir, 'GOOGLE_CLIENT_ID', 'abc.apps.googleusercontent.com');
    setStoredConfig(dir, 'FM_STORED_TEST', 'value with spaces');
    expect(readStoredConfig(dir)).toEqual({
      GOOGLE_CLIENT_ID: 'abc.apps.googleusercontent.com',
      FM_STORED_TEST: 'value with spaces',
    });
    expect(unsetStoredConfig(dir, 'FM_STORED_TEST')).toBe(true);
    expect(unsetStoredConfig(dir, 'FM_STORED_TEST')).toBe(false);
    expect(readStoredConfig(dir)).toEqual({ GOOGLE_CLIENT_ID: 'abc.apps.googleusercontent.com' });
  });

  it('round-trips quotes, backslashes, and newlines', () => {
    const dir = tempDataDir();
    const value = 'quote=" backslash=\\\nnext line';
    setStoredConfig(dir, 'FM_STORED_TEST', value);
    expect(readStoredConfig(dir).FM_STORED_TEST).toBe(value);
  });

  it('writes the file with owner-only permissions', () => {
    const dir = tempDataDir();
    setStoredConfig(dir, 'GOOGLE_CLIENT_SECRET', 'shh');
    const mode = statSync(configFilePath(dir)).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    expect(readdirSync(dir)).not.toContain('.config.lock');
  });

  it('recovers an abandoned config lock from an older Fluxmail process', () => {
    const dir = tempDataDir();
    const lock = path.join(dir, '.config.lock');
    mkdirSync(lock);
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);

    setStoredConfig(dir, 'FM_STORED_TEST', 'recovered');

    expect(readStoredConfig(dir).FM_STORED_TEST).toBe('recovered');
    expect(readdirSync(dir)).not.toContain('.config.lock');
  });

  it('preserves concurrent config updates from separate processes', async () => {
    const dir = tempDataDir();
    const updates = Array.from({ length: 6 }, (_, index) => [`FM_CONCURRENT_${index}`, `value-${index}`] as const);
    const script = `
      import { setStoredConfig } from ${JSON.stringify(configModuleUrl)};
      const [dataDir, key, value] = process.argv.slice(1);
      setStoredConfig(dataDir, key, value);
    `;

    await Promise.all(
      updates.map(([key, value]) =>
        runFile(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, dir, key, value]),
      ),
    );

    expect(readStoredConfig(dir)).toEqual(Object.fromEntries(updates));
  });

  it('repairs permissions when reading an existing stored-config file', () => {
    const dir = tempDataDir();
    const file = configFilePath(dir);
    writeFileSync(file, 'GOOGLE_CLIENT_SECRET="old"\n', { mode: 0o644 });
    chmodSync(file, 0o644);

    expect(readStoredConfig(dir)).toEqual({ GOOGLE_CLIENT_SECRET: 'old' });

    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('rejects invalid keys and FLUXMAIL_DATA_DIR', () => {
    const dir = tempDataDir();
    expect(() => setStoredConfig(dir, 'lower-case', 'x')).toThrow(/UPPER_SNAKE_CASE/);
    expect(() => setStoredConfig(dir, 'FLUXMAIL_DATA_DIR', '/x')).toThrow(/cannot be stored/);
  });

  it('loadConfig picks up stored settings, with shell env winning', () => {
    const dir = tempDataDir();
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
    process.env.FLUXMAIL_DATA_DIR = dir;
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
    setStoredConfig(dir, 'GOOGLE_CLIENT_ID', 'stored-id');
    setStoredConfig(dir, 'GOOGLE_CLIENT_SECRET', 'stored-secret');

    const config = loadConfig();
    expect(config.google).toEqual({ clientId: 'stored-id', clientSecret: 'stored-secret' });
    expect(config.oauthHost).toBe('127.0.0.1');
    expect(config.publicUrlConfigured).toBe(false);

    // Shell environment beats the stored value.
    delete process.env.GOOGLE_CLIENT_ID;
    process.env.GOOGLE_CLIENT_ID = 'shell-id';
    const config2 = loadConfig();
    expect(config2.google?.clientId).toBe('shell-id');
  });

  it('loads Microsoft OAuth settings and defaults to the common tenant', () => {
    const dir = tempDataDir();
    process.env.FLUXMAIL_DATA_DIR = dir;
    process.env.MICROSOFT_CLIENT_ID = 'microsoft-client-id';

    expect(loadConfig().microsoft).toEqual({ clientId: 'microsoft-client-id', tenantId: 'common' });

    process.env.MICROSOFT_CLIENT_SECRET = 'microsoft-secret';
    process.env.MICROSOFT_TENANT_ID = 'tenant-id';
    expect(loadConfig().microsoft).toEqual({
      clientId: 'microsoft-client-id',
      clientSecret: 'microsoft-secret',
      tenantId: 'tenant-id',
    });
  });

  it('reads a stored telemetry opt-out without applying unrelated settings', () => {
    const dir = tempDataDir();
    setStoredConfig(dir, 'FLUXMAIL_TELEMETRY', '0');
    setStoredConfig(dir, 'FLUXMAIL_LICENSE_KEY', 'stored-license');
    const env: NodeJS.ProcessEnv = {};

    const telemetryEnv = withStoredTelemetrySetting(dir, env);

    expect(telemetryDisabled(telemetryEnv)).toBe(true);
    expect(isTelemetryEnabled(dir)).toBe(false);
    expect(telemetryEnv.FLUXMAIL_LICENSE_KEY).toBeUndefined();
    expect(env.FLUXMAIL_TELEMETRY).toBeUndefined();
  });

  it('reads the OAuth listener host from the environment', () => {
    process.env.FLUXMAIL_DATA_DIR = tempDataDir();
    process.env.FLUXMAIL_OAUTH_HOST = '0.0.0.0';
    expect(loadConfig().oauthHost).toBe('0.0.0.0');
  });

  it('uses and validates trusted proxy configuration', () => {
    process.env.FLUXMAIL_DATA_DIR = tempDataDir();
    expect(loadConfig().trustProxy).toBe(false);

    process.env.FLUXMAIL_TRUST_PROXY = 'true';
    expect(loadConfig().trustProxy).toBe(true);
    process.env.FLUXMAIL_TRUST_PROXY = '0';
    expect(loadConfig().trustProxy).toBe(false);
    process.env.FLUXMAIL_TRUST_PROXY = 'sometimes';
    expect(() => loadConfig()).toThrow(/FLUXMAIL_TRUST_PROXY/);
  });

  it('uses and validates the attachment size limit', () => {
    process.env.FLUXMAIL_DATA_DIR = tempDataDir();
    expect(loadConfig().maxAttachmentBytes).toBe(10 * 1024 * 1024);

    process.env.FLUXMAIL_MAX_ATTACHMENT_MB = '1';
    expect(loadConfig().maxAttachmentBytes).toBe(1024 * 1024);

    process.env.FLUXMAIL_MAX_ATTACHMENT_MB = '25';
    expect(loadConfig().maxAttachmentBytes).toBe(25 * 1024 * 1024);

    process.env.FLUXMAIL_MAX_ATTACHMENT_MB = '26';
    expect(() => loadConfig()).toThrow(/FLUXMAIL_MAX_ATTACHMENT_MB/);

    process.env.FLUXMAIL_MAX_ATTACHMENT_MB = '1.5';
    expect(() => loadConfig()).toThrow(/FLUXMAIL_MAX_ATTACHMENT_MB/);
  });

  it('rejects encryption keys with trailing non-hex characters', () => {
    process.env.FLUXMAIL_DATA_DIR = tempDataDir();
    process.env.FLUXMAIL_ENCRYPTION_KEY = `${'aa'.repeat(32)}zz`;

    expect(() => loadConfig()).toThrow(/exactly 64 hex characters/);
  });

  it('repairs permissions on an existing encryption-key file', () => {
    const dir = tempDataDir();
    const keyPath = path.join(dir, 'encryption.key');
    writeFileSync(keyPath, `${'aa'.repeat(32)}\n`, { mode: 0o644 });
    chmodSync(keyPath, 0o644);
    process.env.FLUXMAIL_DATA_DIR = dir;

    loadConfig();

    expect(statSync(keyPath).mode & 0o777).toBe(0o600);
  });

  it('generates one encryption key when separate processes start together', async () => {
    const dir = tempDataDir();
    const script = `
      import { loadConfig } from ${JSON.stringify(configModuleUrl)};
      process.env.FLUXMAIL_DATA_DIR = process.argv[1];
      process.stdout.write(loadConfig().encryptionKey.toString('hex'));
    `;

    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        runFile(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, dir]),
      ),
    );

    expect(new Set(results.map((result) => result.stdout))).toHaveLength(1);
    expect(results[0]!.stdout).toHaveLength(64);
    expect(readdirSync(dir)).not.toContain('.encryption-key.lock');
  });

  it('rejects an incompatible configured store before generating an encryption key', () => {
    const dir = tempDataDir();
    const dbPath = path.join(dir, 'shared.db');
    const db = new Database(dbPath);
    db.pragma('user_version = 2');
    db.close();
    process.env.FLUXMAIL_DATA_DIR = dir;
    setStoredConfig(dir, 'FLUXMAIL_DB_PATH', dbPath);

    expect(() => createContext()).toThrow(/store format 2/);
    expect(existsSync(path.join(dir, 'encryption.key'))).toBe(false);
  });

  it.each([
    ['FLUXMAIL_PORT', 'not-a-number'],
    ['FLUXMAIL_PORT', '0'],
    ['FLUXMAIL_OAUTH_PORT', '65536'],
  ] as const)('rejects invalid %s values', (key, value) => {
    process.env.FLUXMAIL_DATA_DIR = tempDataDir();
    process.env[key] = value;

    expect(() => loadConfig()).toThrow(/integer between 1 and 65535/);
  });

  it('removes trailing slashes from the public base URL', () => {
    process.env.FLUXMAIL_DATA_DIR = tempDataDir();
    process.env.FLUXMAIL_PUBLIC_URL = 'https://mail.example.com/';

    const config = loadConfig();
    expect(config.publicUrl).toBe('https://mail.example.com');
    expect(config.publicUrlConfigured).toBe(true);
  });

  it('treats a stored public URL as explicitly configured', () => {
    const dir = tempDataDir();
    process.env.FLUXMAIL_DATA_DIR = dir;
    setStoredConfig(dir, 'FLUXMAIL_PUBLIC_URL', 'https://mail.example.com/');

    const config = loadConfig();
    expect(config.publicUrl).toBe('https://mail.example.com');
    expect(config.publicUrlConfigured).toBe(true);
  });

  it.each([
    'not a url',
    'ftp://mail.example.com',
    'https://mail.example.com?tenant=one',
    'https://user:password@mail.example.com',
  ])('rejects an invalid public base URL: %s', (publicUrl) => {
    process.env.FLUXMAIL_DATA_DIR = tempDataDir();
    process.env.FLUXMAIL_PUBLIC_URL = publicUrl;

    expect(() => loadConfig()).toThrow(/FLUXMAIL_PUBLIC_URL/);
  });

  it('masks short and long secret settings', () => {
    expect(maskStoredConfigValue('GOOGLE_CLIENT_SECRET', 'short')).toBe('********');
    expect(maskStoredConfigValue('FLUXMAIL_ENCRYPTION_KEY', '1234567890abcdef')).toBe('1234…cdef');
    expect(maskStoredConfigValue('GOOGLE_CLIENT_ID', 'public-id')).toBe('public-id');
  });

  it('expands a leading ~ in paths', () => {
    expect(expandHome('~')).toBe(homedir());
    expect(expandHome('~/.fluxmail')).toBe(path.join(homedir(), '.fluxmail'));
    expect(expandHome('/abs/path')).toBe('/abs/path');
    expect(expandHome('~user/x')).toBe('~user/x');
  });
});
