import { eq, sql } from 'drizzle-orm';
import { decryptString, encryptString } from './storage/crypto.js';
import { accountCredentials, accounts, instanceSettings, oauthTokens, type FluxmailDb } from './storage/db.js';

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

  dataVersion(): number {
    const sqlite = this.db as unknown as {
      $client: { pragma(source: string, options: { simple: true }): unknown };
    };
    return sqlite.$client.pragma('data_version', { simple: true }) as number;
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

  pinMicrosoftOAuthAppForAccounts(value: StoredMicrosoftOAuthApp): number {
    const application = parseMicrosoft(value);
    const sqlite = this.db as unknown as {
      $client: { transaction<T>(operation: () => T): { immediate(): T } };
    };
    return sqlite.$client
      .transaction(() => {
        const rows = this.db
          .select({
            accountId: accountCredentials.accountId,
            encryptedCredentials: accountCredentials.encryptedCredentials,
          })
          .from(accountCredentials)
          .innerJoin(accounts, eq(accounts.id, accountCredentials.accountId))
          .where(eq(accounts.provider, 'outlook'))
          .all();
        let pinned = 0;
        for (const row of rows) {
          const decoded = JSON.parse(decryptString(this.encryptionKey, row.encryptedCredentials)) as unknown;
          if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
            throw new Error('The encrypted Outlook credentials are invalid');
          }
          const credentials = decoded as Record<string, unknown>;
          if (credentials.fluxmailOAuthClient !== undefined) continue;

          const encryptedCredentials = encryptString(
            this.encryptionKey,
            JSON.stringify({ ...credentials, fluxmailOAuthClient: application }),
          );
          const updatedAt = Date.now();
          this.db
            .update(accountCredentials)
            .set({
              encryptedCredentials,
              updatedAt,
              revision: sql`${accountCredentials.revision} + 1`,
            })
            .where(eq(accountCredentials.accountId, row.accountId))
            .run();
          this.db
            .insert(oauthTokens)
            .values({ accountId: row.accountId, encryptedTokens: encryptedCredentials, updatedAt })
            .onConflictDoUpdate({
              target: oauthTokens.accountId,
              set: { encryptedTokens: encryptedCredentials, updatedAt },
            })
            .run();
          pinned += 1;
        }
        return pinned;
      })
      .immediate();
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
