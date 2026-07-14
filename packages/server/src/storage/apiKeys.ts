import { createHash, randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { apiKeys, type FluxmailDb } from './db.js';
import { getMember } from './members.js';
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
  /** Member the key was issued to; null means an unscoped admin key. */
  memberId: string | null;
  permissionProfile: PermissionProfile;
  capabilities: McpCapability[];
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
): { key: string; info: ApiKeyInfo } {
  if (memberId) getMember(db, memberId);
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
      memberId: memberId ?? null,
      permissionProfile: policy.profile,
      customCapabilities: serializeCustomCapabilities(policy),
    })
    .run();
  return {
    key,
    info: {
      id,
      name,
      createdAt,
      lastUsedAt: null,
      memberId: memberId ?? null,
      permissionProfile: policy.profile,
      capabilities: policy.capabilities,
    },
  };
}

export interface ApiKeyAuth {
  /** Member the key was issued to; null for an unscoped admin key. */
  memberId: string | null;
  permissions: PermissionPolicy;
}

/**
 * Verify a key, record its use, and return the scope it authorizes. Callers must
 * honour `memberId`: a member-scoped key may only reach shared or owned mailboxes.
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
  } catch {
    return null;
  }
  db.update(apiKeys).set({ lastUsedAt: Date.now() }).where(eq(apiKeys.id, row.id)).run();
  return { memberId: row.memberId, permissions };
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
      return {
        id: r.id,
        name: r.name,
        createdAt: r.createdAt,
        lastUsedAt: r.lastUsedAt,
        memberId: r.memberId,
        permissionProfile: permissions.profile,
        capabilities: permissions.capabilities,
      };
    });
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
