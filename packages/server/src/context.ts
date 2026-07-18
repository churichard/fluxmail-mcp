import { loadConfig, resolveStoreLocation, type FluxmailConfig } from './config.js';
import { IncompatibleStoreError, inspectStoreCompatibility, openDb, type FluxmailDb } from './storage/db.js';
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
  const storeLocation = resolveStoreLocation();
  const compatibility = inspectStoreCompatibility(storeLocation.dbPath, storeLocation.dataDir);
  if (!compatibility.compatible) throw new IncompatibleStoreError(compatibility);
  const config = loadConfig(storeLocation);
  const db = openDb(config.dbPath, { dataDir: config.dataDir });
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
