import { loadConfig, type FluxmailConfig } from './config.js';
import { openDb, type FluxmailDb } from './storage/db.js';
import { AccountRegistry } from './accounts/registry.js';
import { EmailService } from './service/emailService.js';
import { SendScheduler } from './scheduler/sendScheduler.js';
import { getTelemetry, type Telemetry } from './telemetry.js';
import { LicenseController } from './licensing/refresher.js';

export interface AppContext {
  config: FluxmailConfig;
  db: FluxmailDb;
  registry: AccountRegistry;
  service: EmailService;
  telemetry: Telemetry;
  /** Inert until start(); only the long-lived serve/stdio commands start it. */
  scheduler: SendScheduler;
  licenseController: LicenseController;
}

export function createContext(): AppContext {
  const config = loadConfig();
  const db = openDb(config.dbPath);
  const registry = new AccountRegistry(db, config);
  const service = new EmailService(registry, db);
  const scheduler = new SendScheduler(db, service);
  const telemetry = getTelemetry(config.dataDir);
  const licenseController = new LicenseController({
    db,
    config,
    onRefreshed: () => scheduler.wake(),
  });
  service.onScheduleChanged = () => scheduler.wake();
  return { config, db, registry, service, scheduler, telemetry, licenseController };
}
