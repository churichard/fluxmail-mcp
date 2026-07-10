import { loadConfig, type FluxmailConfig } from './config.js';
import { openDb, type FluxmailDb } from './storage/db.js';
import { AccountRegistry } from './accounts/registry.js';
import { EmailService } from './service/emailService.js';
import { getEntitlements } from './licensing/entitlements.js';

export interface AppContext {
  config: FluxmailConfig;
  db: FluxmailDb;
  registry: AccountRegistry;
  service: EmailService;
}

export function createContext(): AppContext {
  const config = loadConfig();
  const db = openDb(config.dbPath);
  const registry = new AccountRegistry(db, config);
  const service = new EmailService(registry, () => getEntitlements(db));
  return { config, db, registry, service };
}
