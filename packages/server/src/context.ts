import {
  createConfigurationService,
  ensureDeploymentEncryptionKey,
  resolveStoreLocation,
  type ConfigurationService,
  type FluxmailConfig,
} from './config.js';
import { IncompatibleStoreError, inspectStoreCompatibility, openDb, type FluxmailDb } from './storage/db.js';
import { AccountRegistry } from './accounts/registry.js';
import { EmailService } from './service/emailService.js';
import { SendScheduler } from './scheduler/sendScheduler.js';
import { getTelemetry, type Telemetry } from './telemetry.js';
import { LicenseController } from './licensing/refresher.js';

export interface AppContext {
  config: FluxmailConfig;
  configuration: ConfigurationService;
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
  const deployment = ensureDeploymentEncryptionKey(storeLocation.deployment!);
  const db = openDb(deployment.dbPath, { dataDir: deployment.dataDir });
  let configuration: ConfigurationService;
  try {
    configuration = createConfigurationService(deployment, db);
  } catch (error) {
    (db as unknown as { $client: { close(): void } }).$client.close();
    throw error;
  }
  const config = configuration.config;
  const registry = new AccountRegistry(db, config);
  const service = new EmailService(registry, db);
  const scheduler = new SendScheduler(db, service);
  const telemetry = getTelemetry(config.dataDir, deployment.environment);
  const licenseController = new LicenseController({
    db,
    config,
    configuration,
    onRefreshed: () => scheduler.wake(),
  });
  service.onScheduleChanged = () => scheduler.wake();
  return { config, configuration, db, registry, service, scheduler, telemetry, licenseController };
}
