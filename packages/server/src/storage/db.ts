import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const accounts = sqliteTable(
  'accounts',
  {
    id: text('id').primaryKey(),
    provider: text('provider').notNull(),
    email: text('email').notNull(),
    displayName: text('display_name'),
    status: text('status').notNull().default('active'),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [uniqueIndex('accounts_provider_email_unique').on(table.provider, table.email)]
);

export const oauthTokens = sqliteTable('oauth_tokens', {
  accountId: text('account_id')
    .primaryKey()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  /** AES-256-GCM encrypted JSON blob of provider tokens. */
  encryptedTokens: text('encrypted_tokens').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const apiKeys = sqliteTable('api_keys', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  /** SHA-256 hex of the key; the key itself is shown once at creation. */
  keyHash: text('key_hash').notNull().unique(),
  createdAt: integer('created_at').notNull(),
  lastUsedAt: integer('last_used_at'),
});

export const licenseLease = sqliteTable('license_lease', {
  /** Single-row table; the row id is always 'current'. */
  id: text('id').primaryKey(),
  /** Signed entitlement lease exactly as issued by the license server. */
  token: text('token').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const scheduledSends = sqliteTable(
  'scheduled_sends',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    draftId: text('draft_id').notNull(),
    /** Epoch milliseconds. */
    sendAt: integer('send_at').notNull(),
    createdAt: integer('created_at').notNull(),
    status: text('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    sentMessageId: text('sent_message_id'),
    sentThreadId: text('sent_thread_id'),
    /** Display snapshots taken at schedule time so listing never hits the provider. */
    subject: text('subject'),
    toRecipients: text('to_recipients'),
    claimToken: text('claim_token'),
    claimUntil: integer('claim_until'),
  },
  (table) => [index('scheduled_sends_pending_due').on(table.status, table.sendAt)]
);

export type FluxmailDb = BetterSQLite3Database;

const BOOTSTRAP_SQL = `
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  email TEXT NOT NULL,
  display_name TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS accounts_provider_email_unique
  ON accounts(provider, email);
CREATE TABLE IF NOT EXISTS oauth_tokens (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  encrypted_tokens TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE TABLE IF NOT EXISTS license_lease (
  id TEXT PRIMARY KEY,
  token TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS scheduled_sends (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  draft_id TEXT NOT NULL,
  send_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  sent_message_id TEXT,
  sent_thread_id TEXT,
  subject TEXT,
  to_recipients TEXT,
  claim_token TEXT,
  claim_until INTEGER
);
CREATE INDEX IF NOT EXISTS scheduled_sends_pending_due
  ON scheduled_sends(status, send_at);
`;

export function openDb(dbPath: string): FluxmailDb {
  const sqlite = new Database(dbPath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.exec(BOOTSTRAP_SQL);
  const columns = new Set(
    (sqlite.prepare('PRAGMA table_info(scheduled_sends)').all() as Array<{ name: string }>).map((column) => column.name)
  );
  if (!columns.has('claim_token')) sqlite.exec('ALTER TABLE scheduled_sends ADD COLUMN claim_token TEXT');
  if (!columns.has('claim_until')) sqlite.exec('ALTER TABLE scheduled_sends ADD COLUMN claim_until INTEGER');
  return drizzle(sqlite);
}
