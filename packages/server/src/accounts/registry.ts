import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { OAuth2Client, type Credentials } from 'google-auth-library';
import { EmailError, type Account, type AccountSharingMode, type EmailProvider, type Provider } from '@fluxmail/core';
import { GmailProvider, GMAIL_CAPABILITIES } from '@fluxmail/provider-gmail';
import { ImapProvider, IMAP_CAPABILITIES, type ImapCredentials } from '@fluxmail/provider-imap';
import { OutlookProvider, OUTLOOK_CAPABILITIES } from '@fluxmail/provider-outlook';
import type { FluxmailConfig } from '../config.js';
import { accountCredentials, accountMemberShares, accounts, oauthTokens, type FluxmailDb } from '../storage/db.js';
import { decryptString, encryptString } from '../storage/crypto.js';
import { assertAccountLimit, getEntitlements } from '../licensing/entitlements.js';
import { getMember } from '../storage/members.js';
import { requireGoogleConfig } from './googleAuth.js';
import { SqliteImapStateStore } from '../storage/imapState.js';
import { refreshMicrosoftCredentials, requireMicrosoftConfig, type MicrosoftCredentials } from './microsoftAuth.js';

export interface AccountAccessInput {
  sharingMode: AccountSharingMode;
  sharedMemberIds?: readonly string[];
}

export class AccountRegistry {
  private readonly providers = new Map<string, { provider: EmailProvider; encryptedCredentials: string }>();

  constructor(
    private readonly db: FluxmailDb,
    private readonly config: FluxmailConfig,
  ) {}

  private evictProvider(accountId: string): void {
    const cached = this.providers.get(accountId)?.provider as EmailProvider & { close?: () => Promise<void> };
    this.providers.delete(accountId);
    void cached?.close?.();
  }

  listAccounts(): Account[] {
    const shares = new Map<string, string[]>();
    for (const row of this.db.select().from(accountMemberShares).all()) {
      const memberIds = shares.get(row.accountId) ?? [];
      memberIds.push(row.memberId);
      shares.set(row.accountId, memberIds);
    }
    return this.db
      .select()
      .from(accounts)
      .all()
      .map((row) => ({
        id: row.id,
        provider: row.provider as Provider,
        email: row.email,
        ...(row.displayName ? { displayName: row.displayName } : {}),
        status: row.status as Account['status'],
        capabilities:
          row.provider === 'imap'
            ? IMAP_CAPABILITIES
            : row.provider === 'outlook'
              ? OUTLOOK_CAPABILITIES
              : GMAIL_CAPABILITIES,
        sharingMode: row.sharingMode as AccountSharingMode,
        sharedMemberIds: shares.get(row.id) ?? [],
        ...(row.memberId ? { ownerId: row.memberId, memberId: row.memberId } : {}),
      }));
  }

  getAccount(accountId: string): Account {
    const account = this.listAccounts().find((a) => a.id === accountId);
    if (!account) throw new EmailError('not_found', `No account with id "${accountId}"`);
    return account;
  }

  /** Resolve an account by canonical id or mailbox address. Email matching is case-insensitive. */
  findAccount(ref: string): Account {
    const normalized = ref.trim().toLowerCase();
    const account = this.listAccounts().find(
      (candidate) => candidate.id === ref || candidate.email.toLowerCase() === normalized,
    );
    if (!account) {
      throw new EmailError('not_found', `No account with id or email "${ref}".`);
    }
    return account;
  }

  private normalizeAccess(ownerId: string | undefined, access?: AccountAccessInput): Required<AccountAccessInput> {
    const sharingMode = access?.sharingMode ?? (ownerId ? 'private' : 'all');
    const sharedMemberIds = sharingMode === 'selected' ? [...new Set(access?.sharedMemberIds ?? [])] : [];
    for (const memberId of sharedMemberIds) getMember(this.db, memberId);
    return { sharingMode, sharedMemberIds };
  }

  private writeAccess(
    db: Pick<FluxmailDb, 'update' | 'delete' | 'insert'>,
    accountId: string,
    ownerId: string | undefined,
    access?: AccountAccessInput,
  ): void {
    const normalized = this.normalizeAccess(ownerId, access);
    db.update(accounts).set({ sharingMode: normalized.sharingMode }).where(eq(accounts.id, accountId)).run();
    db.delete(accountMemberShares).where(eq(accountMemberShares.accountId, accountId)).run();
    if (normalized.sharingMode === 'selected' && normalized.sharedMemberIds.length) {
      db.insert(accountMemberShares)
        .values(normalized.sharedMemberIds.map((memberId) => ({ accountId, memberId })))
        .run();
    }
  }

  /** Fail before OAuth when a new account would exceed the current plan. */
  assertCanAddAccount(): void {
    const existing = this.listAccounts();
    try {
      assertAccountLimit(existing.length, getEntitlements(this.db));
    } catch (err) {
      if (!(err instanceof EmailError)) throw err;
      const reconnect =
        existing.length === 1
          ? `To reconnect ${existing[0]!.email}, rerun this command with ` + `"--reauthorize ${existing[0]!.id}".`
          : 'To reconnect an existing account, rerun this command with "--reauthorize <account-id>".';
      throw new EmailError(err.code, `${err.message} ${reconnect}`);
    }
  }

  /** Resolve an account id, defaulting to the sole account when only one exists. */
  resolveAccountId(accountId?: string): string {
    if (accountId) return this.getAccount(accountId).id;
    const all = this.listAccounts();
    if (all.length === 0) {
      throw new EmailError(
        'invalid_request',
        'No email accounts are connected yet. Run "fluxmail accounts add gmail --owner <member>", "fluxmail accounts add outlook --owner <member>", or the IMAP equivalent.',
      );
    }
    if (all.length > 1) {
      throw new EmailError(
        'invalid_request',
        `Multiple accounts are connected; specify accountId. Available: ${all
          .map((a) => `${a.id} (${a.email})`)
          .join(', ')}`,
      );
    }
    return all[0]!.id;
  }

  getProvider(accountId: string): EmailProvider {
    const account = this.getAccount(accountId);
    const credentialRow = this.loadCredentialRow(accountId);
    const cached = this.providers.get(accountId);
    if (cached?.encryptedCredentials === credentialRow.encryptedCredentials) return cached.provider;

    const stored = JSON.parse(decryptString(this.config.encryptionKey, credentialRow.encryptedCredentials)) as unknown;
    const provider =
      account.provider === 'gmail'
        ? this.buildGmailProvider(accountId, account.email, stored as Credentials, account.displayName)
        : account.provider === 'outlook'
          ? this.buildOutlookProvider(accountId, stored as MicrosoftCredentials)
          : account.provider === 'imap'
            ? new ImapProvider({
                accountId,
                email: account.email,
                ...(account.displayName ? { displayName: account.displayName } : {}),
                credentials: stored as ImapCredentials,
                store: new SqliteImapStateStore(this.db, accountId),
              })
            : undefined;
    if (!provider)
      throw new EmailError('unsupported_capability', `Provider "${account.provider}" is not supported yet`);
    this.providers.set(accountId, { provider, encryptedCredentials: credentialRow.encryptedCredentials });
    return provider;
  }

  private loadCredentialRow(accountId: string): { encryptedCredentials: string } {
    const row = this.db.select().from(accountCredentials).where(eq(accountCredentials.accountId, accountId)).get();
    if (!row) throw new EmailError('auth_expired', `No stored credentials for account ${accountId}`);
    return row;
  }

  private loadTokens(accountId: string): Credentials {
    const row = this.loadCredentialRow(accountId);
    return JSON.parse(decryptString(this.config.encryptionKey, row.encryptedCredentials)) as Credentials;
  }

  private writeCredentials(db: Pick<FluxmailDb, 'insert'>, accountId: string, credentials: unknown): string {
    const encrypted = encryptString(this.config.encryptionKey, JSON.stringify(credentials));
    db.insert(accountCredentials)
      .values({ accountId, encryptedCredentials: encrypted, updatedAt: Date.now() })
      .onConflictDoUpdate({
        target: accountCredentials.accountId,
        set: { encryptedCredentials: encrypted, updatedAt: Date.now() },
      })
      .run();
    return encrypted;
  }

  private saveTokens(accountId: string, tokens: Credentials): string {
    return this.writeTokens(this.db, accountId, tokens);
  }

  private writeTokens(db: Pick<FluxmailDb, 'insert'>, accountId: string, tokens: unknown): string {
    const encrypted = this.writeCredentials(db, accountId, tokens);
    const updatedAt = Date.now();
    db.insert(oauthTokens)
      .values({ accountId, encryptedTokens: encrypted, updatedAt })
      .onConflictDoUpdate({
        target: oauthTokens.accountId,
        set: { encryptedTokens: encrypted, updatedAt },
      })
      .run();
    return encrypted;
  }

  private buildGmailProvider(
    accountId: string,
    email: string,
    stored: Credentials,
    displayName?: string,
  ): EmailProvider {
    const { clientId, clientSecret } = requireGoogleConfig(this.config);
    const auth = new OAuth2Client({ clientId, clientSecret });
    auth.setCredentials(stored);
    const provider = new GmailProvider({
      accountId,
      email,
      ...(displayName ? { displayName } : {}),
      auth,
    });
    // google-auth-library refreshes access tokens transparently; persist them so
    // restarts don't need a refresh round-trip (and rotated refresh tokens survive).
    auth.on('tokens', (fresh) => {
      const encryptedCredentials = this.saveTokens(accountId, { ...this.loadTokens(accountId), ...fresh });
      const cached = this.providers.get(accountId);
      if (cached?.provider === provider) cached.encryptedCredentials = encryptedCredentials;
    });
    return provider;
  }

  private buildOutlookProvider(accountId: string, stored: MicrosoftCredentials): EmailProvider {
    requireMicrosoftConfig(this.config);
    let credentials = stored;
    let refresh: Promise<string> | undefined;
    const provider = new OutlookProvider({
      accountId,
      tokenProvider: {
        getAccessToken: async (forceRefresh = false): Promise<string> => {
          if (!forceRefresh && credentials.expiresAt > Date.now() + 60_000) return credentials.accessToken;
          if (refresh) return refresh;
          refresh = refreshMicrosoftCredentials(this.config, credentials)
            .then((fresh) => {
              credentials = fresh;
              const encryptedCredentials = this.writeTokens(this.db, accountId, fresh);
              const cached = this.providers.get(accountId);
              if (cached?.provider === provider) cached.encryptedCredentials = encryptedCredentials;
              return fresh.accessToken;
            })
            .finally(() => {
              refresh = undefined;
            });
          return refresh;
        },
      },
    });
    return provider;
  }

  addGmailAccount(
    email: string,
    tokens: Credentials,
    displayName?: string,
    memberId?: string,
    access?: AccountAccessInput,
  ): Account {
    // Validate up front for a clean not_found instead of a FK constraint error.
    if (memberId) getMember(this.db, memberId);
    const existing = this.db.select().from(accounts).all();
    const duplicate = existing.find((a) => a.email.toLowerCase() === email.toLowerCase());
    if (duplicate) {
      if (duplicate.provider !== 'gmail') {
        throw new EmailError(
          'invalid_request',
          `${duplicate.email} is already connected through ${duplicate.provider}. Remove it before connecting Gmail.`,
        );
      }
      // Re-authenticating an existing account: refresh tokens, clear error
      // state. Ownership is untouched; reassign with assignAccountMember.
      this.db.transaction((tx) => {
        this.writeTokens(tx, duplicate.id, tokens);
        tx.update(accounts)
          .set({ status: 'active', ...(displayName ? { displayName } : {}) })
          .where(eq(accounts.id, duplicate.id))
          .run();
      });
      this.evictProvider(duplicate.id);
      return this.getAccount(duplicate.id);
    }
    if (!memberId) {
      throw new EmailError('invalid_request', 'An owner is required when connecting a mailbox.');
    }

    const id = `acct_${randomBytes(6).toString('hex')}`;
    this.db.transaction((tx) => {
      const accountCount = tx.select().from(accounts).all().length;
      assertAccountLimit(accountCount, getEntitlements(tx));
      tx.insert(accounts)
        .values({
          id,
          provider: 'gmail',
          email,
          displayName: displayName ?? null,
          status: 'active',
          createdAt: Date.now(),
          memberId: memberId ?? null,
          sharingMode: this.normalizeAccess(memberId, access).sharingMode,
        })
        .run();
      this.writeTokens(tx, id, tokens);
      this.writeAccess(tx, id, memberId, access);
    });
    return this.getAccount(id);
  }

  addOutlookAccount(
    email: string,
    credentials: MicrosoftCredentials,
    displayName?: string,
    memberId?: string,
    reauthorizeId?: string,
    access?: AccountAccessInput,
  ): Account {
    if (memberId) getMember(this.db, memberId);
    const existingRows = this.db.select().from(accounts).all();
    const duplicate = reauthorizeId
      ? existingRows.find((row) => row.id === reauthorizeId)
      : existingRows.find((row) => row.email.toLowerCase() === email.toLowerCase());
    if (duplicate) {
      if (duplicate.provider !== 'outlook' || duplicate.email.toLowerCase() !== email.toLowerCase()) {
        if (duplicate.provider !== 'outlook' && duplicate.email.toLowerCase() === email.toLowerCase()) {
          throw new EmailError(
            'invalid_request',
            `${duplicate.email} is already connected through ${duplicate.provider}. Remove it before connecting Outlook.`,
          );
        }
        throw new EmailError('invalid_request', `Account ${duplicate.id} does not match Outlook mailbox ${email}.`);
      }
      this.db.transaction((tx) => {
        this.writeTokens(tx, duplicate.id, credentials);
        tx.update(accounts)
          .set({ status: 'active', ...(displayName ? { displayName } : {}) })
          .where(eq(accounts.id, duplicate.id))
          .run();
      });
      this.evictProvider(duplicate.id);
      return this.getAccount(duplicate.id);
    }
    if (reauthorizeId) throw new EmailError('not_found', `No account with id "${reauthorizeId}".`);
    if (!memberId) throw new EmailError('invalid_request', 'An owner is required when connecting a mailbox.');

    const id = `acct_${randomBytes(6).toString('hex')}`;
    this.db.transaction((tx) => {
      assertAccountLimit(tx.select().from(accounts).all().length, getEntitlements(tx));
      tx.insert(accounts)
        .values({
          id,
          provider: 'outlook',
          email,
          displayName: displayName ?? null,
          status: 'active',
          createdAt: Date.now(),
          memberId,
          sharingMode: this.normalizeAccess(memberId, access).sharingMode,
        })
        .run();
      this.writeTokens(tx, id, credentials);
      this.writeAccess(tx, id, memberId, access);
    });
    return this.getAccount(id);
  }

  async testImapCredentials(
    email: string,
    credentials: ImapCredentials,
    displayName?: string,
  ): Promise<Array<{ message: string }>> {
    const provider = new ImapProvider({
      accountId: 'imap_setup',
      email,
      ...(displayName ? { displayName } : {}),
      credentials,
      store: new SqliteImapStateStore(this.db, 'imap_setup'),
    });
    try {
      await provider.testConnection();
      return await provider.getFolderWarnings();
    } finally {
      await provider.close();
    }
  }

  addImapAccount(
    email: string,
    credentials: ImapCredentials,
    displayName?: string,
    memberId?: string,
    reauthorizeId?: string,
    access?: AccountAccessInput,
  ): Account {
    if (memberId) getMember(this.db, memberId);
    const existingRows = this.db.select().from(accounts).all();
    const duplicate = reauthorizeId
      ? existingRows.find((row) => row.id === reauthorizeId)
      : existingRows.find((row) => row.email.toLowerCase() === email.toLowerCase());
    if (duplicate) {
      if (duplicate.provider !== 'imap' || duplicate.email.toLowerCase() !== email.toLowerCase()) {
        if (duplicate.provider !== 'imap' && duplicate.email.toLowerCase() === email.toLowerCase()) {
          throw new EmailError(
            'invalid_request',
            `${duplicate.email} is already connected through ${duplicate.provider}. Remove it before connecting IMAP.`,
          );
        }
        throw new EmailError('invalid_request', `Account ${duplicate.id} does not match IMAP mailbox ${email}.`);
      }
      this.db.transaction((tx) => {
        this.writeCredentials(tx, duplicate.id, credentials);
        tx.update(accounts)
          .set({ status: 'active', ...(displayName ? { displayName } : {}) })
          .where(eq(accounts.id, duplicate.id))
          .run();
      });
      this.evictProvider(duplicate.id);
      return this.getAccount(duplicate.id);
    }
    if (reauthorizeId) {
      throw new EmailError('not_found', `No account with id "${reauthorizeId}".`);
    }
    if (!memberId) {
      throw new EmailError('invalid_request', 'An owner is required when connecting a mailbox.');
    }

    const id = `acct_${randomBytes(6).toString('hex')}`;
    this.db.transaction((tx) => {
      assertAccountLimit(tx.select().from(accounts).all().length, getEntitlements(tx));
      tx.insert(accounts)
        .values({
          id,
          provider: 'imap',
          email,
          displayName: displayName ?? null,
          status: 'active',
          createdAt: Date.now(),
          memberId: memberId ?? null,
          sharingMode: this.normalizeAccess(memberId, access).sharingMode,
        })
        .run();
      this.writeCredentials(tx, id, credentials);
      this.writeAccess(tx, id, memberId, access);
    });
    return this.getAccount(id);
  }

  loadImapCredentials(accountId: string): ImapCredentials {
    const account = this.getAccount(accountId);
    if (account.provider !== 'imap')
      throw new EmailError('invalid_request', `Account ${accountId} is not an IMAP account.`);
    const row = this.loadCredentialRow(accountId);
    return JSON.parse(decryptString(this.config.encryptionKey, row.encryptedCredentials)) as ImapCredentials;
  }

  saveImapCredentials(accountId: string, credentials: ImapCredentials): void {
    this.loadImapCredentials(accountId);
    this.writeCredentials(this.db, accountId, credentials);
    this.evictProvider(accountId);
  }

  /** Deprecated storage alias for assignAccountOwner. */
  assignAccountMember(accountId: string, memberId: string | null): Account {
    this.getAccount(accountId);
    if (!memberId) throw new EmailError('invalid_request', 'A mailbox must have an owner.');
    getMember(this.db, memberId);
    this.db.update(accounts).set({ memberId }).where(eq(accounts.id, accountId)).run();
    return this.getAccount(accountId);
  }

  assignAccountOwner(accountId: string, memberId: string): Account {
    return this.assignAccountMember(accountId, memberId);
  }

  setAccountAccess(accountId: string, access: AccountAccessInput): Account {
    const account = this.getAccount(accountId);
    this.db.transaction((tx) => this.writeAccess(tx, accountId, account.ownerId, access));
    return this.getAccount(accountId);
  }

  removeAccount(accountId: string): void {
    this.getAccount(accountId);
    this.db.delete(accounts).where(eq(accounts.id, accountId)).run();
    this.evictProvider(accountId);
  }

  markStatus(accountId: string, status: Account['status']): void {
    this.db.update(accounts).set({ status }).where(eq(accounts.id, accountId)).run();
  }
}
