import { setStoredConfig } from '../config.js';
import type { FluxmailDb } from '../storage/db.js';
import { refreshLicense, type RefreshOptions, type RefreshResult } from './refresher.js';

/** Validate a replacement key before allowing it to overwrite stored config. */
export async function activateLicense(
  db: FluxmailDb,
  opts: RefreshOptions
): Promise<RefreshResult> {
  const result = await refreshLicense(db, opts);
  if (result.outcome === 'refreshed' || result.outcome === 'outage') {
    setStoredConfig(opts.dataDir, 'FLUXMAIL_LICENSE_KEY', opts.licenseKey);
  }
  return result;
}
