import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { DEFAULT_LICENSE_SERVER_URL } from './licensing/client.js';

export const DEFAULT_MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const HARD_MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const BYTES_PER_MEGABYTE = 1024 * 1024;

export interface ConfigReferenceEntry {
  defaultValue: string;
  description: string;
  secret?: boolean;
  documented?: boolean;
}

/**
 * User-settable environment variables understood by the server. The public
 * documentation generator reads this registry, and config loading uses its
 * keys so adding a new setting cannot bypass the reference list by accident.
 */
export const CONFIG_REFERENCE = {
  GOOGLE_CLIENT_ID: {
    defaultValue: 'required for Gmail',
    description: 'Google OAuth client ID.',
  },
  GOOGLE_CLIENT_SECRET: {
    defaultValue: 'required for Gmail',
    description: 'Google OAuth client secret.',
    secret: true,
  },
  MICROSOFT_CLIENT_ID: {
    defaultValue: 'required for Outlook',
    description: 'Microsoft Entra application client ID.',
  },
  MICROSOFT_CLIENT_SECRET: {
    defaultValue: 'required for hosted Outlook connections',
    description: 'Microsoft Entra application client secret.',
    secret: true,
  },
  MICROSOFT_TENANT_ID: {
    defaultValue: 'common',
    description: 'Microsoft Entra tenant ID or verified domain.',
  },
  FLUXMAIL_DATA_DIR: {
    defaultValue: '~/.fluxmail (/data in Docker)',
    description: 'Directory for the SQLite database, stored config, and generated encryption key.',
  },
  FLUXMAIL_DB_PATH: {
    defaultValue: '<data dir>/fluxmail.db',
    description: 'Override the SQLite database path.',
  },
  FLUXMAIL_ENCRYPTION_KEY: {
    defaultValue: 'generated automatically',
    description: 'A 64-character hexadecimal key used to encrypt provider credentials.',
    secret: true,
  },
  FLUXMAIL_PORT: {
    defaultValue: '8977',
    description: 'HTTP server port.',
  },
  FLUXMAIL_PUBLIC_URL: {
    defaultValue: 'http://localhost:<FLUXMAIL_PORT>',
    description: 'Public base URL used for HTTP APIs and hosted OAuth callbacks.',
  },
  FLUXMAIL_AUTH: {
    defaultValue: 'apikey',
    description: 'HTTP authentication mode. Use none only behind a trusted network boundary.',
  },
  FLUXMAIL_OAUTH_PORT: {
    defaultValue: '8976',
    description: 'Port for the local OAuth callback listener.',
  },
  FLUXMAIL_OAUTH_HOST: {
    defaultValue: '127.0.0.1',
    description: 'Bind address for the local OAuth callback listener.',
  },
  FLUXMAIL_MAX_ATTACHMENT_MB: {
    defaultValue: '10',
    description: 'Largest decoded attachment returned through MCP or REST, from 1 through 25 MB.',
  },
  FLUXMAIL_LICENSE_KEY: {
    defaultValue: 'none',
    description: 'Paid-plan license key, normally stored with fluxmail license activate.',
    secret: true,
  },
  FLUXMAIL_TELEMETRY: {
    defaultValue: '1',
    description: 'Set to 0 to turn off anonymous CLI, MCP, and REST usage telemetry.',
  },
  DO_NOT_TRACK: {
    defaultValue: 'unset',
    description: 'Set to 1 to turn off anonymous usage telemetry.',
  },
  FLUXMAIL_LICENSE_SERVER_URL: {
    defaultValue: DEFAULT_LICENSE_SERVER_URL,
    description: 'License validation service override used for development and testing.',
    documented: false,
  },
} as const satisfies Record<string, ConfigReferenceEntry>;

export type ConfigEnvironmentName = keyof typeof CONFIG_REFERENCE;

function readEnvironment(name: ConfigEnvironmentName): string | undefined {
  return process.env[name];
}

export interface FluxmailConfig {
  dataDir: string;
  dbPath: string;
  /** 32-byte key for AES-256-GCM token encryption. */
  encryptionKey: Buffer;
  port: number;
  /** Public base URL of the HTTP server, used to build OAuth redirect URIs. */
  publicUrl: string;
  /** Whether FLUXMAIL_PUBLIC_URL was explicitly set instead of using the localhost default. */
  publicUrlConfigured?: boolean;
  /** Port for the ephemeral loopback OAuth listener used by `fluxmail accounts add`. */
  oauthPort: number;
  /** Bind address for the OAuth listener. Docker uses 0.0.0.0 so its published port can reach it. */
  oauthHost: string;
  /** 'apikey' (default) requires a bearer token on email APIs; 'none' is for trusted networks only. */
  authMode: 'apikey' | 'none';
  /** Largest attachment Fluxmail will return through MCP or REST. */
  maxAttachmentBytes: number;
  /** Paid-tier license key (fluxmail_lic_…); absent means free tier. */
  licenseKey?: string;
  /** Base URL of the hosted license server. */
  licenseServerUrl: string;
  google?: {
    clientId: string;
    clientSecret: string;
  };
  microsoft?: {
    clientId: string;
    /** Optional for public-client app registrations that use PKCE. */
    clientSecret?: string;
    /** common supports both personal Microsoft accounts and Entra work accounts. */
    tenantId: string;
  };
}

function unquoteEnvValue(value: string): string {
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      const parsed = JSON.parse(value) as unknown;
      return typeof parsed === 'string' ? parsed : value.slice(1, -1);
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  return value;
}

function parseEnvValue(raw: string): string {
  // A fully quoted value may contain "#" verbatim.
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return unquoteEnvValue(raw);
  }
  // Otherwise strip an inline comment (whitespace + #), like dotenv and docker compose do.
  const quoted = raw.match(/^("(?:[^"\\]|\\.)*"|'[^']*')\s+#/);
  if (quoted?.[1]) return unquoteEnvValue(quoted[1]);
  const comment = raw.search(/\s#/);
  return comment === -1 ? raw : raw.slice(0, comment).trimEnd();
}

function parseEnvContent(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed
      .slice(0, eq)
      .trim()
      .replace(/^export\s+/, '');
    if (key) out[key] = parseEnvValue(trimmed.slice(eq + 1).trim());
  }
  return out;
}

function applyDotEnvFile(file: string): void {
  if (!existsSync(file)) return;
  for (const [key, value] of Object.entries(parseEnvContent(readFileSync(file, 'utf8')))) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

/**
 * Load .env.local and .env from the working directory. Real environment
 * variables always win; .env.local wins over .env.
 */
export function loadDotEnv(cwd = process.cwd()): void {
  applyDotEnvFile(path.join(cwd, '.env.local'));
  applyDotEnvFile(path.join(cwd, '.env'));
}

/** Expand a leading "~" (e.g. FLUXMAIL_DATA_DIR=~/.fluxmail), which Node does not do. */
export function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return path.join(homedir(), p.slice(2));
  return p;
}

/** Resolve (and create) the data dir, honoring cwd .env files and FLUXMAIL_DATA_DIR. */
export function resolveDataDir(): string {
  loadDotEnv();
  const fromEnv = readEnvironment('FLUXMAIL_DATA_DIR');
  const dataDir = fromEnv ? expandHome(fromEnv) : path.join(homedir(), '.fluxmail');
  mkdirSync(dataDir, { recursive: true });
  return dataDir;
}

export function configFilePath(dataDir: string): string {
  return path.join(dataDir, 'config.env');
}

/** Apply settings persisted by `fluxmail config set` without overriding the current environment. */
export function applyStoredConfig(dataDir: string): void {
  applyDotEnvFile(configFilePath(dataDir));
}

/** Best-effort permission tightening: chmod fails on files owned by another user, but the read may still work. */
function tryRestrictPermissions(file: string): void {
  try {
    chmodSync(file, 0o600);
  } catch {
    // Reading (or a later write) will surface a real permission problem.
  }
}

/** Settings persisted by `fluxmail config set`, e.g. GOOGLE_CLIENT_ID. */
export function readStoredConfig(dataDir: string): Record<string, string> {
  const file = configFilePath(dataDir);
  if (!existsSync(file)) return {};
  tryRestrictPermissions(file);
  return parseEnvContent(readFileSync(file, 'utf8'));
}

const CONFIG_KEY_PATTERN = /^[A-Z][A-Z0-9_]*$/;

export function setStoredConfig(dataDir: string, key: string, value: string): void {
  if (!CONFIG_KEY_PATTERN.test(key)) {
    throw new Error(`Invalid key "${key}": use UPPER_SNAKE_CASE, e.g. GOOGLE_CLIENT_ID`);
  }
  if (key === 'FLUXMAIL_DATA_DIR') {
    throw new Error('FLUXMAIL_DATA_DIR cannot be stored in the data dir itself; set it in your shell or a .env file');
  }
  const stored = readStoredConfig(dataDir);
  stored[key] = value;
  writeStoredConfig(dataDir, stored);
}

export function unsetStoredConfig(dataDir: string, key: string): boolean {
  const stored = readStoredConfig(dataDir);
  if (!(key in stored)) return false;
  delete stored[key];
  writeStoredConfig(dataDir, stored);
  return true;
}

export function maskStoredConfigValue(key: string, value: string): string {
  if (!/SECRET|KEY|TOKEN|PASSWORD/i.test(key)) return value;
  return value.length > 8 ? `${value.slice(0, 4)}…${value.slice(-4)}` : '********';
}

function writeStoredConfig(dataDir: string, values: Record<string, string>): void {
  const file = configFilePath(dataDir);
  const lines = Object.entries(values).map(([k, v]) => `${k}=${JSON.stringify(v)}`);
  writeFileSync(file, lines.join('\n') + (lines.length ? '\n' : ''), { mode: 0o600 });
  tryRestrictPermissions(file);
}

function decodeEncryptionKey(value: string, errorMessage: string): Buffer {
  if (!/^[0-9a-fA-F]{64}$/.test(value)) throw new Error(errorMessage);
  return Buffer.from(value, 'hex');
}

function readPort(name: 'FLUXMAIL_PORT' | 'FLUXMAIL_OAUTH_PORT', fallback: number): number {
  const raw = readEnvironment(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`${name} must be an integer between 1 and 65535, got "${raw}"`);
  }
  return value;
}

function readMaxAttachmentBytes(): number {
  const raw = readEnvironment('FLUXMAIL_MAX_ATTACHMENT_MB');
  if (raw === undefined) return DEFAULT_MAX_ATTACHMENT_BYTES;
  const value = Number(raw);
  const hardMaxMegabytes = HARD_MAX_ATTACHMENT_BYTES / BYTES_PER_MEGABYTE;
  if (!Number.isInteger(value) || value < 1 || value > hardMaxMegabytes) {
    throw new Error(`FLUXMAIL_MAX_ATTACHMENT_MB must be an integer between 1 and ${hardMaxMegabytes}, got "${raw}"`);
  }
  return value * BYTES_PER_MEGABYTE;
}

function readPublicUrl(port: number): string {
  const value = (readEnvironment('FLUXMAIL_PUBLIC_URL') ?? `http://localhost:${port}`).replace(/\/+$/, '');
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`FLUXMAIL_PUBLIC_URL must be a valid HTTP or HTTPS URL, got "${value}"`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`FLUXMAIL_PUBLIC_URL must use HTTP or HTTPS, got "${parsed.protocol}"`);
  }
  if (parsed.username || parsed.password) {
    throw new Error('FLUXMAIL_PUBLIC_URL cannot contain embedded credentials');
  }
  if (parsed.search || parsed.hash) {
    throw new Error('FLUXMAIL_PUBLIC_URL cannot contain a query string or fragment');
  }
  return value;
}

function loadEncryptionKey(dataDir: string): Buffer {
  const fromEnv = readEnvironment('FLUXMAIL_ENCRYPTION_KEY');
  if (fromEnv) {
    return decodeEncryptionKey(fromEnv, 'FLUXMAIL_ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes)');
  }
  // Auto-generate on first run so getting started requires zero key management.
  const keyPath = path.join(dataDir, 'encryption.key');
  if (existsSync(keyPath)) {
    tryRestrictPermissions(keyPath);
    const key = decodeEncryptionKey(readFileSync(keyPath, 'utf8').trim(), `Corrupt encryption key at ${keyPath}`);
    return key;
  }
  const key = randomBytes(32);
  writeFileSync(keyPath, key.toString('hex') + '\n', { mode: 0o600 });
  return key;
}

export function loadConfig(): FluxmailConfig {
  // Precedence: shell env > cwd .env.local > cwd .env > data-dir config.env.
  const dataDir = resolveDataDir();
  applyStoredConfig(dataDir);

  const port = readPort('FLUXMAIL_PORT', 8977);
  const oauthPort = readPort('FLUXMAIL_OAUTH_PORT', 8976);
  const publicUrlConfigured = readEnvironment('FLUXMAIL_PUBLIC_URL') !== undefined;
  const publicUrl = readPublicUrl(port);
  const databasePath = readEnvironment('FLUXMAIL_DB_PATH');
  const authModeEnv = readEnvironment('FLUXMAIL_AUTH') ?? 'apikey';
  if (authModeEnv !== 'apikey' && authModeEnv !== 'none') {
    throw new Error(`FLUXMAIL_AUTH must be "apikey" or "none", got "${authModeEnv}"`);
  }

  const config: FluxmailConfig = {
    dataDir,
    dbPath: databasePath ? expandHome(databasePath) : path.join(dataDir, 'fluxmail.db'),
    encryptionKey: loadEncryptionKey(dataDir),
    port,
    publicUrl,
    publicUrlConfigured,
    oauthPort,
    oauthHost: readEnvironment('FLUXMAIL_OAUTH_HOST') ?? '127.0.0.1',
    authMode: authModeEnv,
    maxAttachmentBytes: readMaxAttachmentBytes(),
    licenseServerUrl: (readEnvironment('FLUXMAIL_LICENSE_SERVER_URL') ?? DEFAULT_LICENSE_SERVER_URL).replace(
      /\/+$/,
      '',
    ),
  };

  const licenseKey = readEnvironment('FLUXMAIL_LICENSE_KEY')?.trim();
  if (licenseKey) config.licenseKey = licenseKey;

  const clientId = readEnvironment('GOOGLE_CLIENT_ID');
  const clientSecret = readEnvironment('GOOGLE_CLIENT_SECRET');
  if (clientId && clientSecret) {
    config.google = { clientId, clientSecret };
  }
  const microsoftClientId = readEnvironment('MICROSOFT_CLIENT_ID')?.trim();
  if (microsoftClientId) {
    const microsoftClientSecret = readEnvironment('MICROSOFT_CLIENT_SECRET')?.trim();
    config.microsoft = {
      clientId: microsoftClientId,
      tenantId: readEnvironment('MICROSOFT_TENANT_ID')?.trim() || 'common',
      ...(microsoftClientSecret ? { clientSecret: microsoftClientSecret } : {}),
    };
  }
  return config;
}
