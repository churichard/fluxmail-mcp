import { createHash, randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { apiKeys, type FluxmailDb } from './db.js';

export interface ApiKeyInfo {
  id: string;
  name: string;
  createdAt: number;
  lastUsedAt: number | null;
}

function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

/** Returns the plaintext key exactly once; only its hash is stored. */
export function createApiKey(db: FluxmailDb, name: string): { key: string; info: ApiKeyInfo } {
  const id = `key_${randomBytes(8).toString('hex')}`;
  const key = `fmk_${randomBytes(24).toString('hex')}`;
  const createdAt = Date.now();
  db.insert(apiKeys).values({ id, name, keyHash: hashKey(key), createdAt }).run();
  return { key, info: { id, name, createdAt, lastUsedAt: null } };
}

export function verifyApiKey(db: FluxmailDb, key: string): boolean {
  const row = db.select().from(apiKeys).where(eq(apiKeys.keyHash, hashKey(key))).get();
  if (!row) return false;
  db.update(apiKeys).set({ lastUsedAt: Date.now() }).where(eq(apiKeys.id, row.id)).run();
  return true;
}

export function listApiKeys(db: FluxmailDb): ApiKeyInfo[] {
  return db
    .select()
    .from(apiKeys)
    .all()
    .map((r) => ({ id: r.id, name: r.name, createdAt: r.createdAt, lastUsedAt: r.lastUsedAt }));
}

export function revokeApiKey(db: FluxmailDb, id: string): boolean {
  const result = db.delete(apiKeys).where(eq(apiKeys.id, id)).run();
  return result.changes > 0;
}
