export { createContext, type AppContext } from './context.js';
export { createApp } from './http/app.js';
export { buildMcpServer } from './mcp/buildServer.js';
export { EmailService, buildForwardBody, type SendInput, type ForwardInput } from './service/emailService.js';
export { AccountRegistry } from './accounts/registry.js';
export {
  loadConfig,
  loadDotEnv,
  resolveDataDir,
  configFilePath,
  maskStoredConfigValue,
  readStoredConfig,
  setStoredConfig,
  unsetStoredConfig,
  type FluxmailConfig,
} from './config.js';
export { openDb } from './storage/db.js';
export { encryptString, decryptString } from './storage/crypto.js';
export {
  getEntitlements,
  checkLicenseState,
  assertAccountLimit,
  assertMemberLimit,
  assertWithinQuota,
  readLeaseRow,
  saveLeaseToken,
  clearLease,
  PERSONAL_TIER,
  GRACE_PERIOD_MS,
  type Entitlements,
  type LicenseState,
} from './licensing/entitlements.js';
export {
  addMember,
  getMember,
  findMember,
  listMembers,
  removeMember,
  type MemberInfo,
} from './storage/members.js';
export {
  verifyLease,
  licensePublicKeys,
  PINNED_LICENSE_PUBLIC_KEYS,
  type LeasePayload,
} from './licensing/lease.js';
export {
  validateLicense,
  releaseLicense,
  DEFAULT_LICENSE_SERVER_URL,
  LICENSE_KEY_PATTERN,
  type ValidateOutcome,
} from './licensing/client.js';
export {
  refreshLicense,
  startLicenseRefresher,
  loadInstanceId,
  type RefreshResult,
} from './licensing/refresher.js';
