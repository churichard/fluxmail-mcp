import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const members = sqliteTable(
  'members',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    email: text('email'),
    role: text('role').notNull().default('member'),
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
    /** Owning member. NULL is retained only for migrated installs with no members. */
    memberId: text('member_id').references(() => members.id, { onDelete: 'set null' }),
    sharingMode: text('sharing_mode').notNull().default('private'),
  },
  (table) => [uniqueIndex('accounts_provider_email_unique').on(table.provider, table.email)],
);

export const accountMemberShares = sqliteTable(
  'account_member_shares',
  {
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    memberId: text('member_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
  },
  (table) => [primaryKey({ columns: [table.accountId, table.memberId] })],
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
  /** Member the key was issued to; NULL is reserved for migrated system credentials. */
  memberId: text('member_id').references(() => members.id, { onDelete: 'set null' }),
  /** Named MCP permission profile, or "custom" when customCapabilities is populated. */
  permissionProfile: text('permission_profile').notNull().default('full'),
  /** JSON array of explicit MCP capabilities for custom policies. */
  customCapabilities: text('custom_capabilities'),
  /** NULL means no extra narrowing; otherwise a JSON array of canonical account ids. */
  accountIds: text('account_ids'),
});

export const gmailConnectionGrants = sqliteTable('gmail_connection_grants', {
  /** SHA-256 hex digest. The raw token is printed once and never stored. */
  tokenHash: text('token_hash').primaryKey(),
  scope: text('scope').notNull(),
  memberId: text('member_id'),
  reauthorizeAccountId: text('reauthorize_account_id'),
  sharingMode: text('sharing_mode'),
  sharedMemberIds: text('shared_member_ids'),
  createdAt: integer('created_at').notNull(),
  expiresAt: integer('expires_at').notNull(),
  consumedAt: integer('consumed_at'),
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
  role TEXT NOT NULL DEFAULT 'member',
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
  member_id TEXT REFERENCES members(id) ON DELETE SET NULL,
  sharing_mode TEXT NOT NULL DEFAULT 'private'
);
CREATE TABLE IF NOT EXISTS account_member_shares (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  PRIMARY KEY (account_id, member_id)
);
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
  member_id TEXT REFERENCES members(id) ON DELETE SET NULL,
  permission_profile TEXT NOT NULL DEFAULT 'full',
  custom_capabilities TEXT,
  account_ids TEXT
);
CREATE TABLE IF NOT EXISTS gmail_connection_grants (
  token_hash TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  member_id TEXT,
  reauthorize_account_id TEXT,
  sharing_mode TEXT,
  shared_member_ids TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);
CREATE INDEX IF NOT EXISTS gmail_connection_grants_expires_at
  ON gmail_connection_grants(expires_at);
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
  const memberCols = tableColumns(sqlite, 'members');
  if (!memberCols.has('role')) {
    sqlite.exec("ALTER TABLE members ADD COLUMN role TEXT NOT NULL DEFAULT 'member'");
    // Existing installations gain one administrator: the earliest member.
    sqlite.exec(`
      UPDATE members SET role = 'admin'
      WHERE id = (SELECT id FROM members ORDER BY created_at, id LIMIT 1)
    `);
  }

  if (!tableColumns(sqlite, 'accounts').has('member_id')) {
    sqlite.exec('ALTER TABLE accounts ADD COLUMN member_id TEXT REFERENCES members(id) ON DELETE SET NULL');
  }
  const accountCols = tableColumns(sqlite, 'accounts');
  if (!accountCols.has('sharing_mode')) {
    sqlite.exec('ALTER TABLE accounts ADD COLUMN sharing_mode TEXT');
    sqlite.exec("UPDATE accounts SET sharing_mode = CASE WHEN member_id IS NULL THEN 'all' ELSE 'private' END");
  }
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS account_member_shares (
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      PRIMARY KEY (account_id, member_id)
    )
  `);
  // Migrated ownerless mailboxes remain shared with all, but receive an owner
  // when the installation already has a member.
  sqlite.exec(`
    UPDATE accounts SET member_id = (
      SELECT id FROM members ORDER BY CASE role WHEN 'admin' THEN 0 ELSE 1 END, created_at, id LIMIT 1
    )
    WHERE member_id IS NULL AND sharing_mode = 'all' AND EXISTS (SELECT 1 FROM members)
  `);
  if (!tableColumns(sqlite, 'api_keys').has('member_id')) {
    sqlite.exec('ALTER TABLE api_keys ADD COLUMN member_id TEXT REFERENCES members(id) ON DELETE SET NULL');
  }
  const apiKeyCols = tableColumns(sqlite, 'api_keys');
  if (!apiKeyCols.has('permission_profile')) {
    sqlite.exec("ALTER TABLE api_keys ADD COLUMN permission_profile TEXT NOT NULL DEFAULT 'full'");
  }
  if (!apiKeyCols.has('custom_capabilities')) {
    sqlite.exec('ALTER TABLE api_keys ADD COLUMN custom_capabilities TEXT');
  }
  if (!apiKeyCols.has('account_ids')) {
    sqlite.exec('ALTER TABLE api_keys ADD COLUMN account_ids TEXT');
  }
  const grantCols = tableColumns(sqlite, 'gmail_connection_grants');
  if (!grantCols.has('sharing_mode')) {
    sqlite.exec('ALTER TABLE gmail_connection_grants ADD COLUMN sharing_mode TEXT');
  }
  if (!grantCols.has('shared_member_ids')) {
    sqlite.exec('ALTER TABLE gmail_connection_grants ADD COLUMN shared_member_ids TEXT');
  }

  // Account identity is the mailbox address, regardless of provider. Gmail
  // wins when an older database contains the same address as both Gmail and IMAP.
  sqlite.exec(`
    DELETE FROM accounts
    WHERE EXISTS (
      SELECT 1 FROM accounts AS winner
      WHERE lower(winner.email) = lower(accounts.email)
        AND (
          CASE winner.provider WHEN 'gmail' THEN 0 ELSE 1 END
            < CASE accounts.provider WHEN 'gmail' THEN 0 ELSE 1 END
          OR (
            CASE winner.provider WHEN 'gmail' THEN 0 ELSE 1 END
              = CASE accounts.provider WHEN 'gmail' THEN 0 ELSE 1 END
            AND (
              winner.created_at < accounts.created_at
              OR (winner.created_at = accounts.created_at AND winner.id < accounts.id)
            )
          )
        )
    )
  `);
  sqlite.exec('DROP INDEX IF EXISTS accounts_provider_email_unique');
  sqlite.exec('CREATE UNIQUE INDEX IF NOT EXISTS accounts_email_unique_ci ON accounts(lower(email))');
  return drizzle(sqlite);
}
