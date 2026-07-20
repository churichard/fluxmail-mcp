import { chmodSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ConfigurationService,
  deploymentToml,
  expandHome,
  resolveDataDir,
  resolveDeploymentConfig,
  writeDeploymentConfig,
} from '../src/config.js';
import { DEFAULT_GOOGLE_CLIENT_ID } from '../src/accounts/defaultGoogleOAuth.js';
import { instanceSettings, openDb } from '../src/storage/db.js';

const DEFAULT_LICENSE_SERVER_URL = 'https://fluxmail.ai';

function tempDataDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'fluxmail-config-'));
}

function resolve(dataDir: string, env: NodeJS.ProcessEnv = {}, options: { generateEncryptionKey?: boolean } = {}) {
  return resolveDeploymentConfig({
    env: { FLUXMAIL_DATA_DIR: dataDir, ...env },
    defaultLicenseServerUrl: DEFAULT_LICENSE_SERVER_URL,
    generateEncryptionKey: options.generateEncryptionKey ?? false,
  });
}

afterEach(() => vi.restoreAllMocks());

describe('deployment configuration', () => {
  it('loads typed TOML values and records their source', () => {
    const dir = tempDataDir();
    writeDeploymentConfig(
      path.join(dir, 'config.toml'),
      deploymentToml({
        dbPath: '/tmp/mail.db',
        port: 9000,
        publicUrl: 'https://mail.example.com',
        trustProxy: true,
        oauthHost: '0.0.0.0',
        oauthPort: 9001,
        maxAttachmentMb: 20,
      }),
    );

    const config = resolve(dir);
    expect(config).toMatchObject({
      dbPath: '/tmp/mail.db',
      port: 9000,
      publicUrl: 'https://mail.example.com',
      trustProxy: true,
      oauthHost: '0.0.0.0',
      oauthPort: 9001,
      maxAttachmentBytes: 20 * 1024 * 1024,
    });
    expect(config.sources.port).toBe('toml');
    expect(config.sources.publicUrl).toBe('toml');
  });

  it('lets environment values override TOML without mutating process.env', () => {
    const dir = tempDataDir();
    writeDeploymentConfig(path.join(dir, 'config.toml'), deploymentToml({ port: 9000 }));
    const before = process.env.FLUXMAIL_PORT;

    const config = resolve(dir, { FLUXMAIL_PORT: '9100' });

    expect(config.port).toBe(9100);
    expect(config.sources.port).toBe('environment');
    expect(process.env.FLUXMAIL_PORT).toBe(before);
  });

  it('does not load environment files from the working directory', () => {
    const cwd = tempDataDir();
    writeFileSync(
      path.join(cwd, '.env'),
      'FLUXMAIL_PORT=9100\nGOOGLE_CLIENT_ID=dotenv-id\nGOOGLE_CLIENT_SECRET=dotenv-secret\n',
    );
    writeFileSync(path.join(cwd, '.env.local'), 'FLUXMAIL_PORT=9200\n');
    vi.spyOn(process, 'cwd').mockReturnValue(cwd);

    const config = resolve(tempDataDir());

    expect(config.port).toBe(8977);
    expect(config.environment.GOOGLE_CLIENT_ID).toBeUndefined();
    expect(config.environment.GOOGLE_CLIENT_SECRET).toBeUndefined();
  });

  it('does not read legacy config.env during normal resolution', () => {
    const dataDir = tempDataDir();
    writeFileSync(
      path.join(dataDir, 'config.env'),
      'FLUXMAIL_PORT=9100\nGOOGLE_CLIENT_ID=legacy-id\nGOOGLE_CLIENT_SECRET=legacy-secret\n',
    );

    const config = resolve(dataDir);

    expect(config.port).toBe(8977);
    expect(config.environment.GOOGLE_CLIENT_ID).toBeUndefined();
    expect(config.environment.GOOGLE_CLIENT_SECRET).toBeUndefined();
  });

  it('resolves the data directory without parsing deployment configuration or encryption secrets', () => {
    const dataDir = tempDataDir();
    writeFileSync(path.join(dataDir, 'config.toml'), 'not valid toml');
    writeFileSync(path.join(dataDir, 'encryption.key'), 'not a valid key');

    expect(resolveDataDir({ env: { FLUXMAIL_DATA_DIR: dataDir } })).toBe(dataDir);
  });

  it('rejects unknown TOML keys and invalid values', () => {
    const unknownDir = tempDataDir();
    writeFileSync(path.join(unknownDir, 'config.toml'), '[server]\nunknown = true\n');
    expect(() => resolve(unknownDir)).toThrow(/Unknown setting "server.unknown"/);

    const invalidDir = tempDataDir();
    writeFileSync(path.join(invalidDir, 'config.toml'), '[server]\nport = "many"\n');
    expect(() => resolve(invalidDir)).toThrow(/integer between 1 and 65535/);
  });

  it('supports secret files, removes one terminal newline, and preserves external permissions', () => {
    const dir = tempDataDir();
    const secretFile = path.join(tempDataDir(), 'encryption-secret');
    const hex = 'ab'.repeat(32);
    writeFileSync(secretFile, `${hex}\n`, { mode: 0o644 });
    chmodSync(secretFile, 0o644);

    const config = resolve(dir, { FLUXMAIL_ENCRYPTION_KEY_FILE: secretFile });

    expect(config.encryptionKey.toString('hex')).toBe(hex);
    expect(config.sources.encryptionKey).toBe('environment-file');
    expect(statSync(secretFile).mode & 0o777).toBe(0o644);
  });

  it('rejects conflicting, relative, and empty secret-file inputs', () => {
    const dir = tempDataDir();
    expect(() =>
      resolve(dir, {
        FLUXMAIL_ENCRYPTION_KEY: 'ab'.repeat(32),
        FLUXMAIL_ENCRYPTION_KEY_FILE: '/tmp/key',
      }),
    ).toThrow(/only one/);
    expect(() => resolve(dir, { FLUXMAIL_ENCRYPTION_KEY_FILE: 'relative/key' })).toThrow(/absolute path/);

    const empty = path.join(tempDataDir(), 'empty');
    writeFileSync(empty, '');
    expect(() => resolve(dir, { FLUXMAIL_ENCRYPTION_KEY_FILE: empty })).toThrow(/empty file/);
  });

  it('writes config.toml with owner-only permissions and refuses overwrite', () => {
    const dir = tempDataDir();
    const file = path.join(dir, 'config.toml');
    writeDeploymentConfig(file, deploymentToml(), { exclusive: true });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(() => writeDeploymentConfig(file, deploymentToml(), { exclusive: true })).toThrow(/already exists/);
  });

  it.each([
    ['FLUXMAIL_PORT', 'not-a-number'],
    ['FLUXMAIL_PORT', '0'],
    ['FLUXMAIL_OAUTH_PORT', '65536'],
    ['FLUXMAIL_MAX_ATTACHMENT_MB', '26'],
  ])('rejects invalid %s values', (name, value) => {
    expect(() => resolve(tempDataDir(), { [name]: value })).toThrow();
  });

  it('validates and normalizes the public URL', () => {
    expect(resolve(tempDataDir(), { FLUXMAIL_PUBLIC_URL: 'https://mail.example.com/' }).publicUrl).toBe(
      'https://mail.example.com',
    );
    for (const value of [
      'not a url',
      'ftp://mail.example.com',
      'https://mail.example.com?tenant=one',
      'https://user:password@mail.example.com',
    ]) {
      expect(() => resolve(tempDataDir(), { FLUXMAIL_PUBLIC_URL: value })).toThrow(/FLUXMAIL_PUBLIC_URL/);
    }
  });

  it('expands a leading home marker in paths', () => {
    expect(expandHome('~')).toBe(homedir());
    expect(expandHome('~/.fluxmail')).toBe(path.join(homedir(), '.fluxmail'));
    expect(expandHome('/abs/path')).toBe('/abs/path');
    expect(expandHome('~user/x')).toBe('~user/x');
  });
});

describe('encrypted instance configuration', () => {
  it('uses the built-in Google app and requires complete environment groups', () => {
    const db = openDb(':memory:');
    const service = new ConfigurationService(resolve(tempDataDir(), { FLUXMAIL_ENCRYPTION_KEY: '11'.repeat(32) }), db);
    expect(service.config.google?.clientId).toBe(DEFAULT_GOOGLE_CLIENT_ID);

    expect(
      () =>
        new ConfigurationService(
          resolve(tempDataDir(), {
            FLUXMAIL_ENCRYPTION_KEY: '11'.repeat(32),
            GOOGLE_CLIENT_ID: 'custom-id',
          }),
          openDb(':memory:'),
        ),
    ).toThrow(/GOOGLE_CLIENT_SECRET/);
    expect(
      () =>
        new ConfigurationService(
          resolve(tempDataDir(), {
            FLUXMAIL_ENCRYPTION_KEY: '11'.repeat(32),
            GOOGLE_CLIENT_SECRET: 'secret',
          }),
          openDb(':memory:'),
        ),
    ).toThrow(/GOOGLE_CLIENT_ID/);
  });

  it('treats blank OAuth and license placeholders as unset', () => {
    const service = new ConfigurationService(
      resolve(tempDataDir(), {
        FLUXMAIL_ENCRYPTION_KEY: '10'.repeat(32),
        GOOGLE_CLIENT_ID: '',
        GOOGLE_CLIENT_SECRET: '',
        MICROSOFT_CLIENT_ID: '',
        MICROSOFT_CLIENT_SECRET: '',
        FLUXMAIL_LICENSE_KEY: '',
      }),
      openDb(':memory:'),
    );

    expect(service.config.google?.clientId).toBe(DEFAULT_GOOGLE_CLIENT_ID);
    expect(service.config.microsoft).toBeUndefined();
    expect(service.config.licenseKey).toBeUndefined();
  });

  it('encrypts complete provider groups and license state at rest and applies updates immediately', () => {
    const privateSecret = 'private-google-secret';
    const license = `fluxmail_lic_${'ab'.repeat(20)}`;
    const db = openDb(':memory:');
    const service = new ConfigurationService(resolve(tempDataDir(), { FLUXMAIL_ENCRYPTION_KEY: '22'.repeat(32) }), db);

    service.setGoogle({ clientId: 'google-id', clientSecret: privateSecret });
    service.setMicrosoft({ clientId: 'microsoft-id', tenantId: 'common' });
    service.setLicenseKey(license);

    expect(service.config.google).toEqual({ clientId: 'google-id', clientSecret: privateSecret });
    expect(service.config.microsoft).toEqual({ clientId: 'microsoft-id', tenantId: 'common' });
    expect(service.config.licenseKey).toBe(license);
    const raw = db
      .select()
      .from(instanceSettings)
      .all()
      .map((row) => row.value);
    expect(raw.filter((value) => value.startsWith('v1:'))).toHaveLength(3);
    expect(JSON.stringify(raw)).not.toContain(privateSecret);
    expect(JSON.stringify(raw)).not.toContain(license);
  });

  it('round-trips encrypted settings and resets complete groups', () => {
    const deployment = resolve(tempDataDir(), { FLUXMAIL_ENCRYPTION_KEY: '33'.repeat(32) });
    const db = openDb(':memory:');
    const first = new ConfigurationService(deployment, db);
    first.setGoogle({ clientId: 'id', clientSecret: 'secret' });

    const reopened = new ConfigurationService(deployment, db);
    expect(reopened.config.google).toEqual({ clientId: 'id', clientSecret: 'secret' });
    expect(reopened.resetGoogle()).toBe(true);
    expect(reopened.oauthStatus().google.source).toBe('built-in');
  });

  it('uses complete environment groups and prevents API changes while controlled', () => {
    const secretFile = path.join(tempDataDir(), 'google-secret');
    writeFileSync(secretFile, 'file-secret\n');
    const deployment = resolve(tempDataDir(), {
      FLUXMAIL_ENCRYPTION_KEY: '44'.repeat(32),
      GOOGLE_CLIENT_ID: 'environment-id',
      GOOGLE_CLIENT_SECRET_FILE: secretFile,
      MICROSOFT_CLIENT_ID: 'microsoft-id',
    });
    const service = new ConfigurationService(deployment, openDb(':memory:'));

    expect(service.config.google).toEqual({ clientId: 'environment-id', clientSecret: 'file-secret' });
    expect(service.config.microsoft).toEqual({ clientId: 'microsoft-id', tenantId: 'common' });
    expect(service.oauthStatus().google.source).toBe('environment-file');
    expect(() => service.setGoogle({ clientId: 'next', clientSecret: 'next-secret' })).toThrow(/environment/);
    expect(() => service.resetMicrosoft()).toThrow(/environment/);
  });

  it('supports license secret files and never exposes their path through status', () => {
    const file = path.join(tempDataDir(), 'license');
    const license = `fluxmail_lic_${'cd'.repeat(20)}`;
    writeFileSync(file, `${license}\n`);
    const service = new ConfigurationService(
      resolve(tempDataDir(), {
        FLUXMAIL_ENCRYPTION_KEY: '55'.repeat(32),
        FLUXMAIL_LICENSE_KEY_FILE: file,
      }),
      openDb(':memory:'),
    );
    expect(service.config.licenseKey).toBe(license);
    expect(JSON.stringify(service.oauthStatus())).not.toContain(file);
    expect(() => service.setLicenseKey(`fluxmail_lic_${'ef'.repeat(20)}`)).toThrow(/environment/);
  });

  it('fails safely when encrypted settings are opened with a different key', () => {
    const db = openDb(':memory:');
    const first = new ConfigurationService(resolve(tempDataDir(), { FLUXMAIL_ENCRYPTION_KEY: '66'.repeat(32) }), db);
    first.setGoogle({ clientId: 'id', clientSecret: 'secret' });
    expect(
      () => new ConfigurationService(resolve(tempDataDir(), { FLUXMAIL_ENCRYPTION_KEY: '77'.repeat(32) }), db),
    ).toThrow(/decrypt/);
  });
});
