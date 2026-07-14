import { chmodSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  configFilePath,
  expandHome,
  loadConfig,
  maskStoredConfigValue,
  readStoredConfig,
  setStoredConfig,
  unsetStoredConfig,
} from '../src/config.js';
import { isTelemetryEnabled, telemetryDisabled, withStoredTelemetrySetting } from '../src/telemetry.js';

const ENV_KEYS = [
  'FLUXMAIL_DATA_DIR',
  'FLUXMAIL_ENCRYPTION_KEY',
  'FLUXMAIL_PUBLIC_URL',
  'FLUXMAIL_PORT',
  'FLUXMAIL_OAUTH_PORT',
  'FLUXMAIL_OAUTH_HOST',
  'FLUXMAIL_MAX_ATTACHMENT_MB',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'FLUXMAIL_TELEMETRY',
  'FM_STORED_TEST',
];
const saved: Record<string, string | undefined> = {};

for (const k of ENV_KEYS) saved[k] = process.env[k];
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function tempDataDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'fluxmail-config-'));
}

describe('stored config', () => {
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
