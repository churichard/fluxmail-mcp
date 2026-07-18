export const MCP_CAPABILITIES = [
  'mail.read',
  'mail.drafts',
  'mail.organize',
  'mail.trash',
  'mail.delete',
  'mail.send',
] as const;

export type McpCapability = (typeof MCP_CAPABILITIES)[number];

export const ADMIN_CAPABILITIES = [
  'admin.accounts',
  'admin.members',
  'admin.api_keys',
  'admin.license',
  'admin.audit',
] as const;
export type AdminCapability = (typeof ADMIN_CAPABILITIES)[number];
export type Capability = McpCapability | AdminCapability;

export const MCP_CAPABILITY_DESCRIPTIONS: Record<McpCapability, string> = {
  'mail.read':
    'List, search, and read mail; inspect status, folders, and labels; list scheduled sends; download attachments.',
  'mail.drafts': 'Create, update, and delete drafts; cancel scheduled sends.',
  'mail.organize': 'Mark read or unread, star, archive, move, and manage labels or Outlook categories.',
  'mail.trash': 'Move messages to or from Trash.',
  'mail.delete': 'Permanently delete messages.',
  'mail.send': 'Send or schedule messages.',
};

export const NAMED_PERMISSION_PROFILES = ['read-only', 'read-write', 'full'] as const;
export type NamedPermissionProfile = (typeof NAMED_PERMISSION_PROFILES)[number];
export type PermissionProfile = NamedPermissionProfile | 'custom';

export const PERMISSION_PROFILE_DESCRIPTIONS: Record<NamedPermissionProfile, string> = {
  'read-only': 'Read and search mail, inspect folders, labels, and scheduled sends, and download attachments.',
  'read-write': 'Read mail, manage drafts, organize messages, and move messages to or from Trash.',
  full: 'Use every Fluxmail email capability, including sending mail and permanently deleting messages.',
};

export interface PermissionPolicy {
  profile: PermissionProfile;
  capabilities: Capability[];
  /** Administrative capabilities added to a named mail profile. Empty for custom policies. */
  supplementalCapabilities: AdminCapability[];
}

const CAPABILITY_SET = new Set<string>(MCP_CAPABILITIES);
const ADMIN_CAPABILITY_SET = new Set<string>(ADMIN_CAPABILITIES);
const ALL_CAPABILITY_SET = new Set<string>([...MCP_CAPABILITIES, ...ADMIN_CAPABILITIES]);
const PROFILE_SET = new Set<string>(NAMED_PERMISSION_PROFILES);

const PROFILE_CAPABILITIES: Record<NamedPermissionProfile, readonly McpCapability[]> = {
  'read-only': ['mail.read'],
  'read-write': ['mail.read', 'mail.drafts', 'mail.organize', 'mail.trash'],
  full: MCP_CAPABILITIES,
};

export const FULL_PERMISSION_POLICY: PermissionPolicy = permissionPolicyForProfile('full');

export function isNamedPermissionProfile(value: string): value is NamedPermissionProfile {
  return PROFILE_SET.has(value);
}

export function isMcpCapability(value: string): value is McpCapability {
  return CAPABILITY_SET.has(value);
}

export function isAdminCapability(value: string): value is AdminCapability {
  return ADMIN_CAPABILITY_SET.has(value);
}

export function isCapability(value: string): value is Capability {
  return ALL_CAPABILITY_SET.has(value);
}

export function normalizeAdminCapabilities(capabilities: readonly string[]): AdminCapability[] {
  const unique = [...new Set(capabilities)];
  const invalid = unique.filter((capability) => !isAdminCapability(capability));
  if (invalid.length) {
    throw new Error(
      `Unknown administrative capability: ${invalid.join(', ')}. Expected one of: ${ADMIN_CAPABILITIES.join(', ')}.`,
    );
  }
  return ADMIN_CAPABILITIES.filter((capability) => unique.includes(capability));
}

export function permissionPolicyForProfile(
  profile: NamedPermissionProfile,
  supplementalCapabilities: readonly string[] = [],
): PermissionPolicy {
  const supplemental = normalizeAdminCapabilities(supplementalCapabilities);
  return {
    profile,
    capabilities: [...PROFILE_CAPABILITIES[profile], ...supplemental],
    supplementalCapabilities: supplemental,
  };
}

export function customPermissionPolicy(capabilities: readonly string[]): PermissionPolicy {
  if (!capabilities.length) throw new Error('A custom permission policy must allow at least one capability.');
  const unique = [...new Set(capabilities)];
  const invalid = unique.filter((capability) => !isCapability(capability));
  if (invalid.length) {
    throw new Error(
      `Unknown capability: ${invalid.join(', ')}. Expected one of: ${[...MCP_CAPABILITIES, ...ADMIN_CAPABILITIES].join(', ')}.`,
    );
  }
  return {
    profile: 'custom',
    capabilities: [...MCP_CAPABILITIES, ...ADMIN_CAPABILITIES].filter((capability) => unique.includes(capability)),
    supplementalCapabilities: [],
  };
}

export function normalizePermissionPolicy(policy: PermissionPolicy): PermissionPolicy {
  if (policy.profile === 'custom') return customPermissionPolicy(policy.capabilities);
  if (!isNamedPermissionProfile(policy.profile)) throw new Error(`Unknown permission profile: ${policy.profile}`);
  return permissionPolicyForProfile(policy.profile, policy.supplementalCapabilities);
}

function parseCapabilityArray(value: string, description: string): string[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) {
    throw new Error(`${description} must be a JSON array of strings.`);
  }
  return parsed;
}

export function deserializePermissionPolicy(
  profile: string,
  customCapabilities: string | null,
  supplementalCapabilities: string | null = null,
): PermissionPolicy {
  if (profile === 'custom') {
    if (customCapabilities === null) throw new Error('Custom permission policy has no capabilities.');
    if (
      supplementalCapabilities !== null &&
      parseCapabilityArray(supplementalCapabilities, 'Supplemental capabilities').length
    ) {
      throw new Error('Custom permission policies cannot store supplemental capabilities.');
    }
    return customPermissionPolicy(parseCapabilityArray(customCapabilities, 'Custom permission capabilities'));
  }
  if (customCapabilities !== null) throw new Error('Named permission profiles cannot store custom capabilities.');
  if (!isNamedPermissionProfile(profile)) throw new Error(`Unknown permission profile: ${profile}`);
  return permissionPolicyForProfile(
    profile,
    supplementalCapabilities === null
      ? []
      : parseCapabilityArray(supplementalCapabilities, 'Supplemental capabilities'),
  );
}

export function serializeCustomCapabilities(policy: PermissionPolicy): string | null {
  const normalized = normalizePermissionPolicy(policy);
  return normalized.profile === 'custom' ? JSON.stringify(normalized.capabilities) : null;
}

export function serializeSupplementalCapabilities(policy: PermissionPolicy): string {
  const normalized = normalizePermissionPolicy(policy);
  return JSON.stringify(normalized.profile === 'custom' ? [] : normalized.supplementalCapabilities);
}

export function hasCapability(policy: PermissionPolicy, capability: Capability): boolean {
  return policy.capabilities.includes(capability);
}
