import { createHash, randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { EmailError } from '@fluxmail/core';
import { apiKeys, type FluxmailDb } from './db.js';
import { getMember, type MemberRole } from './members.js';
import {
  deserializePermissionPolicy,
  FULL_PERMISSION_POLICY,
  normalizePermissionPolicy,
  serializeCustomCapabilities,
  type McpCapability,
  type PermissionPolicy,
  type PermissionProfile,
} from '../permissions.js';

export interface ApiKeyInfo {
  id: string;
  name: string;
  createdAt: number;
  lastUsedAt: number | null;
  /** Member the key was issued to; null identifies a migrated system credential. */
  memberId: string | null;
  permissionProfile: PermissionProfile;
  capabilities: McpCapability[];
  /** Additional mailbox narrowing. null means all mailboxes granted to the member. */
  accountIds: string[] | null;
}

function uniqueAccountIds(accountIds: readonly string[]): string[] {
  return [...new Set(accountIds)];
}

function serializeAccountIds(accountIds: readonly string[] | null): string | null {
  return accountIds === null ? null : JSON.stringify(uniqueAccountIds(accountIds));
}

function deserializeAccountIds(value: string | null): string[] | null {
  if (value === null) return null;
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) {
    throw new Error('API key account scope must be a JSON array of strings.');
  }
  return uniqueAccountIds(parsed);
}

function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

/** Returns the plaintext key exactly once; only its hash is stored. */
export function createApiKey(
  db: FluxmailDb,
  name: string,
  memberId?: string,
  permissions: PermissionPolicy = FULL_PERMISSION_POLICY,
  accountIds: readonly string[] | null = null,
): { key: string; info: ApiKeyInfo } {
  if (!memberId) {
    throw new EmailError('invalid_request', 'A member is required when creating an API key.');
  }
  getMember(db, memberId);
  const policy = normalizePermissionPolicy(permissions);
  const id = `key_${randomBytes(8).toString('hex')}`;
  const key = `fmk_${randomBytes(24).toString('hex')}`;
  const createdAt = Date.now();
  db.insert(apiKeys)
    .values({
      id,
      name,
      keyHash: hashKey(key),
      createdAt,
      memberId,
      permissionProfile: policy.profile,
      customCapabilities: serializeCustomCapabilities(policy),
      accountIds: serializeAccountIds(accountIds),
    })
    .run();
  return {
    key,
    info: {
      id,
      name,
      createdAt,
      lastUsedAt: null,
      memberId,
      permissionProfile: policy.profile,
      capabilities: policy.capabilities,
      accountIds: accountIds === null ? null : uniqueAccountIds(accountIds),
    },
  };
}

export interface ApiKeyAuth {
  /** Member the key was issued to; null for a migrated system credential. */
  memberId: string | null;
  /** Current member role. null identifies a migrated management-only system key. */
  role: MemberRole | null;
  permissions: PermissionPolicy;
  accountIds: string[] | null;
}

/**
 * Verify a key, record its use, and return its live member role and mailbox
 * narrowing. Memberless migrated keys authenticate for management only.
 */
export function authenticateApiKey(db: FluxmailDb, key: string): ApiKeyAuth | null {
  const row = db
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.keyHash, hashKey(key)))
    .get();
  if (!row) return null;
  let permissions: PermissionPolicy;
  try {
    permissions = deserializePermissionPolicy(row.permissionProfile, row.customCapabilities);
    const accountIds = deserializeAccountIds(row.accountIds);
    const member = row.memberId ? getMember(db, row.memberId) : null;
    db.update(apiKeys).set({ lastUsedAt: Date.now() }).where(eq(apiKeys.id, row.id)).run();
    return { memberId: row.memberId, role: member?.role ?? null, permissions, accountIds };
  } catch {
    return null;
  }
}

export function verifyApiKey(db: FluxmailDb, key: string): boolean {
  return authenticateApiKey(db, key) !== null;
}

export function listApiKeys(db: FluxmailDb): ApiKeyInfo[] {
  return db
    .select()
    .from(apiKeys)
    .all()
    .map((r) => {
      const permissions = deserializePermissionPolicy(r.permissionProfile, r.customCapabilities);
      const accountIds = deserializeAccountIds(r.accountIds);
      return {
        id: r.id,
        name: r.name,
        createdAt: r.createdAt,
        lastUsedAt: r.lastUsedAt,
        memberId: r.memberId,
        permissionProfile: permissions.profile,
        capabilities: permissions.capabilities,
        accountIds,
      };
    });
}

export function updateApiKeyAccounts(db: FluxmailDb, id: string, accountIds: readonly string[] | null): boolean {
  const result = db
    .update(apiKeys)
    .set({ accountIds: serializeAccountIds(accountIds) })
    .where(eq(apiKeys.id, id))
    .run();
  return result.changes > 0;
}

export function updateApiKeyPermissions(db: FluxmailDb, id: string, permissions: PermissionPolicy): boolean {
  const policy = normalizePermissionPolicy(permissions);
  const result = db
    .update(apiKeys)
    .set({
      permissionProfile: policy.profile,
      customCapabilities: serializeCustomCapabilities(policy),
    })
    .where(eq(apiKeys.id, id))
    .run();
  return result.changes > 0;
}

export function revokeApiKey(db: FluxmailDb, id: string): boolean {
  const result = db.delete(apiKeys).where(eq(apiKeys.id, id)).run();
  return result.changes > 0;
}
