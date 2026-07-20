import { eq } from 'drizzle-orm';
import { decryptString, encryptString } from './storage/crypto.js';
import { instanceSettings, type FluxmailDb } from './storage/db.js';

const ENVELOPE_PREFIX = 'v1:';

export const INSTANCE_CONFIG_KEYS = {
  google: 'config.oauth.google',
  microsoft: 'config.oauth.microsoft',
  license: 'config.license.key',
} as const;

export interface StoredGoogleOAuthApp {
  clientId: string;
  clientSecret: string;
}

export interface StoredMicrosoftOAuthApp {
  clientId: string;
  clientSecret?: string;
  tenantId: string;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim())
    throw new Error(`${field} is missing from encrypted instance settings`);
  return value.trim();
}

function parseGoogle(value: unknown): StoredGoogleOAuthApp {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('The encrypted Google OAuth application is invalid');
  }
  const record = value as Record<string, unknown>;
  return {
    clientId: requiredString(record.clientId, 'Google client ID'),
    clientSecret: requiredString(record.clientSecret, 'Google client secret'),
  };
}

function parseMicrosoft(value: unknown): StoredMicrosoftOAuthApp {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('The encrypted Microsoft OAuth application is invalid');
  }
  const record = value as Record<string, unknown>;
  const clientSecret = typeof record.clientSecret === 'string' ? record.clientSecret.trim() : undefined;
  return {
    clientId: requiredString(record.clientId, 'Microsoft client ID'),
    tenantId: requiredString(record.tenantId ?? 'common', 'Microsoft tenant ID'),
    ...(clientSecret ? { clientSecret } : {}),
  };
}

export class InstanceConfigStore {
  constructor(
    private readonly db: FluxmailDb,
    private readonly encryptionKey: Buffer,
  ) {}

  private raw(key: string): string | undefined {
    return this.db.select().from(instanceSettings).where(eq(instanceSettings.key, key)).get()?.value;
  }

  private readEncrypted(key: string): unknown | undefined {
    const value = this.raw(key);
    if (value === undefined) return undefined;
    if (!value.startsWith(ENVELOPE_PREFIX)) {
      throw new Error(`Instance setting ${key} is not stored in a supported encrypted envelope`);
    }
    try {
      return JSON.parse(decryptString(this.encryptionKey, value.slice(ENVELOPE_PREFIX.length))) as unknown;
    } catch {
      throw new Error(`Could not decrypt instance setting ${key}; check the Fluxmail encryption key`);
    }
  }

  private writeEncrypted(key: string, value: unknown): void {
    const encrypted = `${ENVELOPE_PREFIX}${encryptString(this.encryptionKey, JSON.stringify(value))}`;
    this.db
      .insert(instanceSettings)
      .values({ key, value: encrypted })
      .onConflictDoUpdate({ target: instanceSettings.key, set: { value: encrypted } })
      .run();
  }

  private remove(key: string): boolean {
    return this.db.delete(instanceSettings).where(eq(instanceSettings.key, key)).run().changes > 0;
  }

  google(): StoredGoogleOAuthApp | undefined {
    const value = this.readEncrypted(INSTANCE_CONFIG_KEYS.google);
    return value === undefined ? undefined : parseGoogle(value);
  }

  setGoogle(value: StoredGoogleOAuthApp): void {
    this.writeEncrypted(INSTANCE_CONFIG_KEYS.google, parseGoogle(value));
  }

  removeGoogle(): boolean {
    return this.remove(INSTANCE_CONFIG_KEYS.google);
  }

  microsoft(): StoredMicrosoftOAuthApp | undefined {
    const value = this.readEncrypted(INSTANCE_CONFIG_KEYS.microsoft);
    return value === undefined ? undefined : parseMicrosoft(value);
  }

  setMicrosoft(value: StoredMicrosoftOAuthApp): void {
    this.writeEncrypted(INSTANCE_CONFIG_KEYS.microsoft, parseMicrosoft(value));
  }

  removeMicrosoft(): boolean {
    return this.remove(INSTANCE_CONFIG_KEYS.microsoft);
  }

  licenseKey(): string | undefined {
    const value = this.readEncrypted(INSTANCE_CONFIG_KEYS.license);
    if (value === undefined) return undefined;
    return requiredString(value, 'License key');
  }

  setLicenseKey(value: string): void {
    this.writeEncrypted(INSTANCE_CONFIG_KEYS.license, requiredString(value, 'License key'));
  }

  removeLicenseKey(): boolean {
    return this.remove(INSTANCE_CONFIG_KEYS.license);
  }
}
