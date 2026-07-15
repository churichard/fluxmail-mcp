export const MCP_CAPABILITIES = [
  'mail.read',
  'mail.drafts',
  'mail.organize',
  'mail.trash',
  'mail.delete',
  'mail.send',
] as const;

export type McpCapability = (typeof MCP_CAPABILITIES)[number];

export const MCP_CAPABILITY_DESCRIPTIONS: Record<McpCapability, string> = {
  'mail.read': 'List, search, and read mail; inspect status and folders; list scheduled sends; download attachments.',
  'mail.drafts': 'Create, update, and delete drafts; cancel scheduled sends.',
  'mail.organize': 'Mark read or unread, star, archive, move, and manage user labels.',
  'mail.trash': 'Move messages to or from Trash.',
  'mail.delete': 'Permanently delete messages.',
  'mail.send': 'Send or schedule messages.',
};

export const NAMED_PERMISSION_PROFILES = ['read-only', 'read-write', 'full'] as const;
export type NamedPermissionProfile = (typeof NAMED_PERMISSION_PROFILES)[number];
export type PermissionProfile = NamedPermissionProfile | 'custom';

export const PERMISSION_PROFILE_DESCRIPTIONS: Record<NamedPermissionProfile, string> = {
  'read-only': 'Read and search mail, inspect folders and scheduled sends, and download attachments.',
  'read-write': 'Read mail, manage drafts, organize messages, and move messages to or from Trash.',
  full: 'Use every Fluxmail email capability, including sending mail and permanently deleting messages.',
};

export interface PermissionPolicy {
  profile: PermissionProfile;
  capabilities: McpCapability[];
}

const CAPABILITY_SET = new Set<string>(MCP_CAPABILITIES);
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

export function permissionPolicyForProfile(profile: NamedPermissionProfile): PermissionPolicy {
  return { profile, capabilities: [...PROFILE_CAPABILITIES[profile]] };
}

export function customPermissionPolicy(capabilities: readonly string[]): PermissionPolicy {
  if (!capabilities.length) throw new Error('A custom permission policy must allow at least one capability.');
  const unique = [...new Set(capabilities)];
  const invalid = unique.filter((capability) => !isMcpCapability(capability));
  if (invalid.length) {
    throw new Error(`Unknown MCP capability: ${invalid.join(', ')}. Expected one of: ${MCP_CAPABILITIES.join(', ')}.`);
  }
  return {
    profile: 'custom',
    capabilities: MCP_CAPABILITIES.filter((capability) => unique.includes(capability)),
  };
}

export function normalizePermissionPolicy(policy: PermissionPolicy): PermissionPolicy {
  if (policy.profile === 'custom') return customPermissionPolicy(policy.capabilities);
  if (!isNamedPermissionProfile(policy.profile)) throw new Error(`Unknown permission profile: ${policy.profile}`);
  return permissionPolicyForProfile(policy.profile);
}

export function deserializePermissionPolicy(profile: string, customCapabilities: string | null): PermissionPolicy {
  if (profile === 'custom') {
    if (customCapabilities === null) throw new Error('Custom permission policy has no capabilities.');
    const parsed = JSON.parse(customCapabilities) as unknown;
    if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === 'string')) {
      throw new Error('Custom permission capabilities must be a JSON array of strings.');
    }
    return customPermissionPolicy(parsed);
  }
  if (customCapabilities !== null) throw new Error('Named permission profiles cannot store custom capabilities.');
  if (!isNamedPermissionProfile(profile)) throw new Error(`Unknown permission profile: ${profile}`);
  return permissionPolicyForProfile(profile);
}

export function serializeCustomCapabilities(policy: PermissionPolicy): string | null {
  const normalized = normalizePermissionPolicy(policy);
  return normalized.profile === 'custom' ? JSON.stringify(normalized.capabilities) : null;
}

export function hasCapability(policy: PermissionPolicy, capability: McpCapability): boolean {
  return policy.capabilities.includes(capability);
}
