import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const members = sqliteTable(
  'members',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    email: text('email'),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [uniqueIndex('members_email_unique').on(table.email)],
);

export const accounts = sqliteTable(
  'accounts',
  {
    id: text('id').primaryKey(),
    provider: text('provider').notNull(),
    email: text('email').notNull(),
    displayName: text('display_name'),
    status: text('status').notNull().default('active'),
    createdAt: integer('created_at').notNull(),
    /** Owning member; NULL means the mailbox is shared across the instance. */
    memberId: text('member_id').references(() => members.id, { onDelete: 'set null' }),
  },
  (table) => [uniqueIndex('accounts_provider_email_unique').on(table.provider, table.email)],
);

export const oauthTokens = sqliteTable('oauth_tokens', {
  accountId: text('account_id')
    .primaryKey()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  /** AES-256-GCM encrypted JSON blob of provider tokens. */
  encryptedTokens: text('encrypted_tokens').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const accountCredentials = sqliteTable('account_credentials', {
  accountId: text('account_id')
    .primaryKey()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  /** AES-256-GCM encrypted provider-specific credentials. */
  encryptedCredentials: text('encrypted_credentials').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const imapMessages = sqliteTable(
  'imap_messages',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    mailboxPath: text('mailbox_path').notNull(),
    uidValidity: text('uid_validity').notNull(),
    uid: integer('uid').notNull(),
    messageId: text('message_id'),
    inReplyTo: text('in_reply_to'),
    references: text('reference_ids'),
    threadId: text('thread_id').notNull(),
    draftId: text('draft_id'),
    subject: text('subject'),
    date: text('date'),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('imap_messages_location_unique').on(table.accountId, table.mailboxPath, table.uidValidity, table.uid),
    index('imap_messages_message_id').on(table.accountId, table.messageId),
    index('imap_messages_thread_id').on(table.accountId, table.threadId),
    uniqueIndex('imap_messages_draft_id_unique').on(table.accountId, table.draftId),
  ],
);

export const apiKeys = sqliteTable('api_keys', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  /** SHA-256 hex of the key; the key itself is shown once at creation. */
  keyHash: text('key_hash').notNull().unique(),
  createdAt: integer('created_at').notNull(),
  lastUsedAt: integer('last_used_at'),
  /** Member the key was issued to; NULL means an unscoped admin key. */
  memberId: text('member_id').references(() => members.id, { onDelete: 'set null' }),
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
  (table) => [index('scheduled_sends_pending_due').on(table.status, table.sendAt)],
);

export type FluxmailDb = BetterSQLite3Database;

const BOOTSTRAP_SQL = `
CREATE TABLE IF NOT EXISTS members (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS members_email_unique ON members(email);
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  email TEXT NOT NULL,
  display_name TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  member_id TEXT REFERENCES members(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS accounts_provider_email_unique
  ON accounts(provider, email);
CREATE TABLE IF NOT EXISTS oauth_tokens (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  encrypted_tokens TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS account_credentials (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  encrypted_credentials TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS imap_messages (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  mailbox_path TEXT NOT NULL,
  uid_validity TEXT NOT NULL,
  uid INTEGER NOT NULL,
  message_id TEXT,
  in_reply_to TEXT,
  reference_ids TEXT,
  thread_id TEXT NOT NULL,
  draft_id TEXT,
  subject TEXT,
  date TEXT,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS imap_messages_location_unique
  ON imap_messages(account_id, mailbox_path, uid_validity, uid);
CREATE INDEX IF NOT EXISTS imap_messages_message_id
  ON imap_messages(account_id, message_id);
CREATE INDEX IF NOT EXISTS imap_messages_thread_id
  ON imap_messages(account_id, thread_id);
CREATE UNIQUE INDEX IF NOT EXISTS imap_messages_draft_id_unique
  ON imap_messages(account_id, draft_id);
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  member_id TEXT REFERENCES members(id) ON DELETE SET NULL
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

function tableColumns(sqlite: Database.Database, table: string): Set<string> {
  return new Set(
    (sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name),
  );
}

export function openDb(dbPath: string): FluxmailDb {
  const sqlite = new Database(dbPath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.exec(BOOTSTRAP_SQL);
  // Keep the generic credential row in sync if an older binary updated the
  // legacy Gmail token table before this version reopened the database.
  sqlite.exec(`
    INSERT INTO account_credentials (account_id, encrypted_credentials, updated_at)
    SELECT account_id, encrypted_tokens, updated_at FROM oauth_tokens WHERE true
    ON CONFLICT(account_id) DO UPDATE SET
      encrypted_credentials = excluded.encrypted_credentials,
      updated_at = excluded.updated_at
    WHERE excluded.updated_at > account_credentials.updated_at
  `);
  const scheduledCols = tableColumns(sqlite, 'scheduled_sends');
  if (!scheduledCols.has('claim_token')) sqlite.exec('ALTER TABLE scheduled_sends ADD COLUMN claim_token TEXT');
  if (!scheduledCols.has('claim_until')) sqlite.exec('ALTER TABLE scheduled_sends ADD COLUMN claim_until INTEGER');
  // Pre-members databases: NULL means shared mailbox / unscoped key, so old rows need no backfill.
  if (!tableColumns(sqlite, 'accounts').has('member_id')) {
    sqlite.exec('ALTER TABLE accounts ADD COLUMN member_id TEXT REFERENCES members(id) ON DELETE SET NULL');
  }
  if (!tableColumns(sqlite, 'api_keys').has('member_id')) {
    sqlite.exec('ALTER TABLE api_keys ADD COLUMN member_id TEXT REFERENCES members(id) ON DELETE SET NULL');
  }
  return drizzle(sqlite);
}
