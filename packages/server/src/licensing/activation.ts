import type { ConfigurationService } from '../config.js';
import type { FluxmailDb } from '../storage/db.js';
import { refreshLicense, type RefreshOptions, type RefreshResult } from './refresher.js';

/** Validate a replacement key before allowing it to overwrite stored config. */
export async function activateLicense(
  db: FluxmailDb,
  configuration: ConfigurationService,
  opts: RefreshOptions,
): Promise<RefreshResult> {
  const result = await refreshLicense(db, opts);
  if (result.outcome === 'refreshed' || result.outcome === 'outage') {
    configuration.setLicenseKey(opts.licenseKey);
  }
  return result;
}
