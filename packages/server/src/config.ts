import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { DEFAULT_LICENSE_SERVER_URL } from './licensing/client.js';

export interface FluxmailConfig {
  dataDir: string;
  dbPath: string;
  /** 32-byte key for AES-256-GCM token encryption. */
  encryptionKey: Buffer;
  port: number;
  /** Public base URL of the HTTP server, used to build OAuth redirect URIs. */
  baseUrl: string;
  /** Port for the ephemeral loopback OAuth listener used by `fluxmail accounts add`. */
  oauthPort: number;
  /** Bind address for the OAuth listener. Docker uses 0.0.0.0 so its published port can reach it. */
  oauthHost: string;
  /** 'apikey' (default) requires a bearer token on /mcp; 'none' is for trusted networks only. */
  authMode: 'apikey' | 'none';
  /** Paid-tier license key (fluxmail_lic_…); absent means free tier. */
  licenseKey?: string;
  /** Base URL of the hosted license server. */
  licenseServerUrl: string;
  google?: {
    clientId: string;
    clientSecret: string;
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
    const key = trimmed.slice(0, eq).trim().replace(/^export\s+/, '');
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
  const fromEnv = process.env.FLUXMAIL_DATA_DIR;
  const dataDir = fromEnv ? expandHome(fromEnv) : path.join(homedir(), '.fluxmail');
  mkdirSync(dataDir, { recursive: true });
  return dataDir;
}

export function configFilePath(dataDir: string): string {
  return path.join(dataDir, 'config.env');
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
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`${name} must be an integer between 1 and 65535, got "${raw}"`);
  }
  return value;
}

function readBaseUrl(port: number): string {
  const value = (process.env.FLUXMAIL_BASE_URL ?? `http://localhost:${port}`).replace(/\/+$/, '');
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`FLUXMAIL_BASE_URL must be a valid HTTP or HTTPS URL, got "${value}"`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`FLUXMAIL_BASE_URL must use HTTP or HTTPS, got "${parsed.protocol}"`);
  }
  if (parsed.username || parsed.password) {
    throw new Error('FLUXMAIL_BASE_URL cannot contain embedded credentials');
  }
  if (parsed.search || parsed.hash) {
    throw new Error('FLUXMAIL_BASE_URL cannot contain a query string or fragment');
  }
  return value;
}

function loadEncryptionKey(dataDir: string): Buffer {
  const fromEnv = process.env.FLUXMAIL_ENCRYPTION_KEY;
  if (fromEnv) {
    return decodeEncryptionKey(
      fromEnv,
      'FLUXMAIL_ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes)'
    );
  }
  // Auto-generate on first run so getting started requires zero key management.
  const keyPath = path.join(dataDir, 'encryption.key');
  if (existsSync(keyPath)) {
    tryRestrictPermissions(keyPath);
    const key = decodeEncryptionKey(
      readFileSync(keyPath, 'utf8').trim(),
      `Corrupt encryption key at ${keyPath}`
    );
    return key;
  }
  const key = randomBytes(32);
  writeFileSync(keyPath, key.toString('hex') + '\n', { mode: 0o600 });
  return key;
}

export function loadConfig(): FluxmailConfig {
  // Precedence: shell env > cwd .env.local > cwd .env > data-dir config.env.
  const dataDir = resolveDataDir();
  applyDotEnvFile(configFilePath(dataDir));

  const port = readPort('FLUXMAIL_PORT', 8977);
  const oauthPort = readPort('FLUXMAIL_OAUTH_PORT', 8976);
  const baseUrl = readBaseUrl(port);
  const authModeEnv = process.env.FLUXMAIL_AUTH ?? 'apikey';
  if (authModeEnv !== 'apikey' && authModeEnv !== 'none') {
    throw new Error(`FLUXMAIL_AUTH must be "apikey" or "none", got "${authModeEnv}"`);
  }

  const config: FluxmailConfig = {
    dataDir,
    dbPath: process.env.FLUXMAIL_DB_PATH
      ? expandHome(process.env.FLUXMAIL_DB_PATH)
      : path.join(dataDir, 'fluxmail.db'),
    encryptionKey: loadEncryptionKey(dataDir),
    port,
    baseUrl,
    oauthPort,
    oauthHost: process.env.FLUXMAIL_OAUTH_HOST ?? '127.0.0.1',
    authMode: authModeEnv,
    licenseServerUrl: (process.env.FLUXMAIL_LICENSE_SERVER_URL ?? DEFAULT_LICENSE_SERVER_URL).replace(/\/+$/, ''),
  };

  const licenseKey = process.env.FLUXMAIL_LICENSE_KEY?.trim();
  if (licenseKey) config.licenseKey = licenseKey;

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (clientId && clientSecret) {
    config.google = { clientId, clientSecret };
  }
  return config;
}
