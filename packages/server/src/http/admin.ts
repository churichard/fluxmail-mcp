import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi';
import { EmailError, isEmailError, type AccountSharingMode } from '@fluxmail/core';
import type { ImapCredentials } from '@fluxmail/provider-imap';
import type { AccountRegistry } from '../accounts/registry.js';
import { prepareHostedGmailConnection, prepareHostedOutlookConnection } from '../accounts/gmailConnection.js';
import type { FluxmailConfig } from '../config.js';
import { LICENSE_KEY_PATTERN } from '../licensing/client.js';
import { activateLicense } from '../licensing/activation.js';
import { checkLicenseState, readLeaseRow } from '../licensing/entitlements.js';
import type { LicenseController } from '../licensing/refresher.js';
import {
  ADMIN_CAPABILITIES,
  MCP_CAPABILITIES,
  NAMED_PERMISSION_PROFILES,
  customPermissionPolicy,
  permissionPolicyForProfile,
  type AdminCapability,
  type PermissionPolicy,
} from '../permissions.js';
import {
  countUsableRootKeys,
  createApiKey,
  isUsableRootKey,
  listApiKeys,
  revokeApiKey,
  updateApiKey,
  type ApiKeyAuth,
} from '../storage/apiKeys.js';
import type { FluxmailDb } from '../storage/db.js';
import { findMember } from '../storage/members.js';

export const ADMIN_BODY_LIMIT = 64 * 1024;
export const ADMIN_CONNECTION_TIMEOUT_MS = 30_000;

export const adminOperationRoutes = {
  createConnection: {
    method: 'post',
    path: '/api/v1/admin/connections',
    operationId: 'createAdministrativeConnection',
  },
  testImapConnection: {
    method: 'post',
    path: '/api/v1/admin/imap/tests',
    operationId: 'testAdministrativeImapConnection',
  },
  updateImapFolders: {
    method: 'patch',
    path: '/api/v1/admin/accounts/{accountId}/imap/folders',
    operationId: 'updateAdministrativeImapFolders',
  },
  listApiKeys: {
    method: 'get',
    path: '/api/v1/admin/api-keys',
    operationId: 'listAdministrativeApiKeys',
  },
  createApiKey: {
    method: 'post',
    path: '/api/v1/admin/api-keys',
    operationId: 'createAdministrativeApiKey',
  },
  updateApiKey: {
    method: 'patch',
    path: '/api/v1/admin/api-keys/{keyId}',
    operationId: 'updateAdministrativeApiKey',
  },
  revokeApiKey: {
    method: 'delete',
    path: '/api/v1/admin/api-keys/{keyId}',
    operationId: 'revokeAdministrativeApiKey',
  },
  getLicense: {
    method: 'get',
    path: '/api/v1/admin/license',
    operationId: 'getAdministrativeLicense',
  },
  activateLicense: {
    method: 'post',
    path: '/api/v1/admin/license/activate',
    operationId: 'activateAdministrativeLicense',
  },
} as const;

function matchesAdminRoute(template: string, path: string): boolean {
  const templateParts = template.split('/');
  const pathParts = path.split('/');
  return (
    templateParts.length === pathParts.length &&
    templateParts.every((part, index) =>
      part.startsWith('{') && part.endsWith('}') ? Boolean(pathParts[index]) : part === pathParts[index],
    )
  );
}

export function adminOperationId(method: string, path: string): string | undefined {
  const normalizedMethod = method.toLowerCase();
  return Object.values(adminOperationRoutes).find(
    (route) => route.method === normalizedMethod && matchesAdminRoute(route.path, path),
  )?.operationId;
}

export interface AdminConnectionSecurity {
  remoteAddress?: string;
  encrypted?: boolean;
}

function isLoopbackAddress(value: string): boolean {
  const normalized = value
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .split('%', 1)[0]!;
  return normalized === '::1' || normalized.startsWith('::ffff:127.') || /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

function isLoopbackHostname(value: string): boolean {
  return value.toLowerCase() === 'localhost' || isLoopbackAddress(value);
}

export function administrationUsesHttps(request: Request, connection?: AdminConnectionSecurity): boolean {
  if (connection?.encrypted) return true;
  if (connection?.remoteAddress !== undefined) return isLoopbackAddress(connection.remoteAddress);

  const requestUrl = new URL(request.url);
  // No socket is available in Hono's in-memory helper or in non-Node adapters.
  // These paths use the request URL itself. Node requests must pass the peer
  // and TLS state above so headers and configuration cannot bless plaintext.
  return requestUrl.protocol === 'https:' || isLoopbackHostname(requestUrl.hostname);
}

export async function requestBodyExceedsLimit(request: Request, limit = ADMIN_BODY_LIMIT): Promise<boolean> {
  const contentLength = request.headers.get('content-length');
  if (contentLength !== null) {
    const declared = Number(contentLength);
    if (Number.isFinite(declared) && declared > limit) return true;
  }

  const body = request.clone().body;
  if (!body) return false;
  const reader = body.getReader();
  let received = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return false;
      received += chunk.value.byteLength;
      if (received > limit) {
        void reader.cancel().catch(() => {});
        return true;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export interface AdminApiDeps {
  config: FluxmailConfig;
  db: FluxmailDb;
  registry?: AccountRegistry;
  licenseController?: LicenseController;
}

const identifier = z.string().trim().min(1).max(200);
const boundedName = z.string().trim().min(1).max(200);
const host = z.string().trim().min(1).max(255);
const username = z.string().min(1).max(320);
const password = z.string().min(1).max(4096);
const folderPath = z.string().min(1).max(1024);
const security = z.enum(['tls', 'starttls']);
const sharingMode = z.enum(['private', 'selected', 'all']);
const folderRoles = ['sent', 'drafts', 'trash', 'archive', 'spam'] as const;

const FolderOverridesSchema = z
  .object({
    sent: folderPath.optional(),
    drafts: folderPath.optional(),
    trash: folderPath.optional(),
    archive: folderPath.optional(),
    spam: folderPath.optional(),
  })
  .strict();
const FolderPatchSchema = z
  .object({
    sent: folderPath.nullable().optional(),
    drafts: folderPath.nullable().optional(),
    trash: folderPath.nullable().optional(),
    archive: folderPath.nullable().optional(),
    spam: folderPath.nullable().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'At least one folder override is required.')
  .openapi({ example: { sent: 'Sent' } });
const ServerSettingsSchema = z
  .object({ host, port: z.number().int().min(1).max(65_535), security, user: username, password })
  .strict();
const ImapSettingsSchema = z
  .object({
    email: z.string().email().max(320),
    displayName: z.string().trim().min(1).max(200).optional(),
    imap: ServerSettingsSchema,
    smtp: ServerSettingsSchema,
    saveSent: z.boolean().optional(),
    folderOverrides: FolderOverridesSchema.optional(),
  })
  .strict()
  .openapi({
    example: {
      email: 'you@example.com',
      imap: {
        host: 'imap.example.com',
        port: 993,
        security: 'tls',
        user: 'you@example.com',
        password: 'app-password',
      },
      smtp: {
        host: 'smtp.example.com',
        port: 465,
        security: 'tls',
        user: 'you@example.com',
        password: 'app-password',
      },
    },
  });
const SharingSchema = {
  owner: identifier.optional(),
  reauthorizeAccountId: identifier.optional(),
  sharingMode: sharingMode.optional(),
  shareWith: z.array(identifier).max(100).optional(),
};
const ConnectionSchema = z
  .discriminatedUnion('provider', [
    z.object({ provider: z.literal('gmail'), ...SharingSchema }).strict(),
    z.object({ provider: z.literal('outlook'), ...SharingSchema }).strict(),
    z.object({ provider: z.literal('imap'), ...SharingSchema, ...ImapSettingsSchema.shape }).strict(),
  ])
  .openapi({ example: { provider: 'gmail', owner: 'you@example.com' } });

const CapabilitySchema = z.enum([...MCP_CAPABILITIES, ...ADMIN_CAPABILITIES]);
const AdminCapabilitySchema = z.enum(ADMIN_CAPABILITIES);
const ApiKeyCreateSchema = z
  .object({
    name: boundedName,
    member: identifier,
    accounts: z.array(identifier).max(100).nullable().optional(),
    permissionProfile: z.enum(NAMED_PERMISSION_PROFILES).optional(),
    supplementalCapabilities: z.array(AdminCapabilitySchema).max(ADMIN_CAPABILITIES.length).optional(),
    customCapabilities: z
      .array(CapabilitySchema)
      .min(1)
      .max(MCP_CAPABILITIES.length + ADMIN_CAPABILITIES.length)
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.customCapabilities && (value.permissionProfile || value.supplementalCapabilities)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'customCapabilities cannot be combined with a named profile.',
      });
    }
    if (!value.customCapabilities && !value.permissionProfile) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Choose permissionProfile or customCapabilities.' });
    }
  })
  .openapi({ example: { name: 'reporting', member: 'you@example.com', permissionProfile: 'read-only' } });
const ApiKeyPatchSchema = z
  .object({
    permissionProfile: z.enum(NAMED_PERMISSION_PROFILES).optional(),
    supplementalCapabilities: z.array(AdminCapabilitySchema).max(ADMIN_CAPABILITIES.length).optional(),
    customCapabilities: z
      .array(CapabilitySchema)
      .min(1)
      .max(MCP_CAPABILITIES.length + ADMIN_CAPABILITIES.length)
      .optional(),
    accounts: z.array(identifier).max(100).nullable().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'At least one field is required.')
  .superRefine((value, ctx) => {
    if (value.customCapabilities && (value.permissionProfile || value.supplementalCapabilities)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'customCapabilities cannot be combined with a named profile.',
      });
    }
  })
  .openapi({ example: { permissionProfile: 'read-only' } });
const LicenseActivationSchema = z.object({ licenseKey: z.string().max(200) }).strict();

const ErrorSchema = z
  .object({
    error: z.object({ code: z.string(), message: z.string(), data: z.record(z.unknown()).optional() }).strict(),
  })
  .strict()
  .openapi('AdminRestError');
const ApiKeySchema = z
  .object({
    id: z.string(),
    name: z.string(),
    createdAt: z.string(),
    lastUsedAt: z.string().nullable(),
    memberId: z.string().nullable(),
    permissionProfile: z.enum([...NAMED_PERMISSION_PROFILES, 'custom']),
    capabilities: z.array(CapabilitySchema),
    supplementalCapabilities: z.array(AdminCapabilitySchema),
    accountIds: z.array(z.string()).nullable(),
  })
  .strict()
  .openapi('AdministrativeApiKey');
const GenericDataSchema = z.object({ data: z.record(z.unknown()) }).strict();
const ApiKeyCreateResponseSchema = z.object({ data: ApiKeySchema.extend({ key: z.string() }) }).strict();

const errors = {
  400: { content: { 'application/json': { schema: ErrorSchema } }, description: 'Invalid request' },
  401: { content: { 'application/json': { schema: ErrorSchema } }, description: 'Authentication required' },
  403: { content: { 'application/json': { schema: ErrorSchema } }, description: 'Administrative access denied' },
  404: { content: { 'application/json': { schema: ErrorSchema } }, description: 'Resource not found' },
  409: { content: { 'application/json': { schema: ErrorSchema } }, description: 'Request conflict' },
  413: { content: { 'application/json': { schema: ErrorSchema } }, description: 'Request body too large' },
  415: { content: { 'application/json': { schema: ErrorSchema } }, description: 'Unsupported media type' },
  500: { content: { 'application/json': { schema: ErrorSchema } }, description: 'Internal error' },
  502: { content: { 'application/json': { schema: ErrorSchema } }, description: 'License could not be verified' },
} as const;
const protectedRoute = { security: [{ bearerAuth: [] }] };

class AdminFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function failureResponse(error: unknown): Response {
  if (error instanceof AdminFailure) return json({ error: { code: error.code, message: error.message } }, error.status);
  if (isEmailError(error)) {
    const status = error.code === 'not_found' ? 404 : error.code === 'permission_denied' ? 403 : 400;
    return json({ error: { code: error.code, message: error.message } }, status);
  }
  return json({ error: { code: 'internal', message: 'The administrative request could not be completed.' } }, 500);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=UTF-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    },
  });
}

function requireAdmin(auth: ApiKeyAuth, capability: AdminCapability): void {
  if (!auth.permissions.capabilities.includes(capability)) {
    throw new AdminFailure('permission_denied', `This API key does not allow ${capability}.`, 403);
  }
  if (auth.memberId !== null && auth.role !== 'admin') {
    throw new AdminFailure('admin_role_required', 'The API key owner is not an admin member.', 403);
  }
}

function registry(deps: AdminApiDeps): AccountRegistry {
  if (!deps.registry) throw new AdminFailure('unavailable', 'Account administration is unavailable.', 500);
  return deps.registry;
}

function resolveSharing(
  deps: AdminApiDeps,
  input: { owner?: string; reauthorizeAccountId?: string; sharingMode?: AccountSharingMode; shareWith?: string[] },
): { memberId?: string; reauthorizeAccountId?: string; sharingMode?: AccountSharingMode; sharedMemberIds?: string[] } {
  const shareWith = input.shareWith ?? [];
  if (input.reauthorizeAccountId && (input.owner || input.sharingMode || shareWith.length)) {
    throw new EmailError(
      'invalid_request',
      'Ownership and sharing settings cannot be combined with reauthorizeAccountId.',
    );
  }
  if (input.reauthorizeAccountId)
    return { reauthorizeAccountId: registry(deps).getAccount(input.reauthorizeAccountId).id };
  if (!input.owner) throw new EmailError('invalid_request', 'owner is required for a new mailbox.');
  const memberId = findMember(deps.db, input.owner).id;
  const mode = input.sharingMode ?? (shareWith.length ? 'selected' : 'private');
  if (mode === 'selected' && !shareWith.length) {
    throw new EmailError('invalid_request', 'shareWith is required when sharingMode is "selected".');
  }
  if (mode !== 'selected' && shareWith.length) {
    throw new EmailError('invalid_request', 'shareWith can only be used when sharingMode is "selected".');
  }
  return { memberId, sharingMode: mode, sharedMemberIds: shareWith.map((ref) => findMember(deps.db, ref).id) };
}

function permissions(input: {
  permissionProfile?: (typeof NAMED_PERMISSION_PROFILES)[number];
  supplementalCapabilities?: AdminCapability[];
  customCapabilities?: Array<(typeof MCP_CAPABILITIES)[number] | AdminCapability>;
}): PermissionPolicy {
  return input.customCapabilities
    ? customPermissionPolicy(input.customCapabilities)
    : permissionPolicyForProfile(input.permissionProfile!, input.supplementalCapabilities ?? []);
}

function accountIds(deps: AdminApiDeps, refs: string[] | null | undefined): string[] | null | undefined {
  if (refs === undefined || refs === null) return refs;
  return [...new Set(refs.map((ref) => registry(deps).findAccount(ref).id))];
}

function serializeApiKey(key: ReturnType<typeof listApiKeys>[number]) {
  return {
    ...key,
    createdAt: new Date(key.createdAt).toISOString(),
    lastUsedAt: key.lastUsedAt === null ? null : new Date(key.lastUsedAt).toISOString(),
  };
}

async function run<T extends Response>(fn: () => Promise<T> | T): Promise<any> {
  try {
    return await fn();
  } catch (error) {
    return failureResponse(error);
  }
}

export function registerAdminRoutes(app: OpenAPIHono<any>, deps: AdminApiDeps): void {
  const connectionsRoute = createRoute({
    ...adminOperationRoutes.createConnection,
    summary: 'Create or reauthorize a connection',
    description: 'Create or reauthorize a Gmail, Outlook, or IMAP connection. Requires admin.accounts.',
    ...protectedRoute,
    request: { body: { required: true, content: { 'application/json': { schema: ConnectionSchema } } } },
    responses: {
      201: {
        content: { 'application/json': { schema: GenericDataSchema } },
        description: 'Connection prepared or saved',
      },
      ...errors,
    },
  });
  app.openapi(connectionsRoute, (c) =>
    run(async () => {
      requireAdmin(c.get('restAuth'), 'admin.accounts');
      const input = c.req.valid('json');
      const access = resolveSharing(deps, input);
      if (input.provider === 'gmail' || input.provider === 'outlook') {
        if (!access.reauthorizeAccountId) registry(deps).assertCanAddAccount();
        if (access.reauthorizeAccountId) {
          const existing = registry(deps).getAccount(access.reauthorizeAccountId);
          if (existing.provider !== input.provider) {
            throw new EmailError(
              'invalid_request',
              `Account ${existing.id} uses ${existing.provider}, not ${input.provider}.`,
            );
          }
        }
        const prepared =
          input.provider === 'gmail'
            ? prepareHostedGmailConnection(deps.db, deps.config, access)
            : prepareHostedOutlookConnection(deps.db, deps.config, access);
        return json(
          {
            data: {
              provider: input.provider,
              connectionUrl: prepared.connectionUrl,
              expiresAt: new Date(prepared.expiresAt).toISOString(),
            },
          },
          201,
        );
      }

      const existing = access.reauthorizeAccountId ? registry(deps).getAccount(access.reauthorizeAccountId) : undefined;
      if (existing && (existing.provider !== 'imap' || existing.email.toLowerCase() !== input.email.toLowerCase())) {
        throw new EmailError('invalid_request', `Account ${existing.id} does not match IMAP mailbox ${input.email}.`);
      }
      if (!existing) registry(deps).assertCanAddAccount();
      const previous = existing ? registry(deps).loadImapCredentials(existing.id) : undefined;
      const credentials: ImapCredentials = {
        imap: input.imap,
        smtp: input.smtp,
        saveSent: input.saveSent ?? previous?.saveSent ?? true,
        folderOverrides: { ...previous?.folderOverrides, ...input.folderOverrides },
      };
      const warnings = await registry(deps).testImapCredentials(
        input.email,
        credentials,
        input.displayName,
        ADMIN_CONNECTION_TIMEOUT_MS,
      );
      const connected = registry(deps).addImapAccount(
        input.email,
        credentials,
        input.displayName,
        access.memberId,
        access.reauthorizeAccountId,
        access.sharingMode ? { sharingMode: access.sharingMode, sharedMemberIds: access.sharedMemberIds } : undefined,
      );
      return json({ data: { account: connected, warnings } }, 201);
    }),
  );

  const imapTestRoute = createRoute({
    ...adminOperationRoutes.testImapConnection,
    summary: 'Test an IMAP connection',
    description: 'Test IMAP and SMTP settings without saving an account. Requires admin.accounts.',
    ...protectedRoute,
    request: { body: { required: true, content: { 'application/json': { schema: ImapSettingsSchema } } } },
    responses: {
      200: { content: { 'application/json': { schema: GenericDataSchema } }, description: 'Connection test result' },
      ...errors,
    },
  });
  app.openapi(imapTestRoute, (c) =>
    run(async () => {
      requireAdmin(c.get('restAuth'), 'admin.accounts');
      const input = c.req.valid('json');
      const warnings = await registry(deps).testImapCredentials(
        input.email,
        {
          imap: input.imap,
          smtp: input.smtp,
          saveSent: input.saveSent ?? true,
          folderOverrides: input.folderOverrides,
        },
        input.displayName,
        ADMIN_CONNECTION_TIMEOUT_MS,
      );
      return json({ data: { ok: true, warnings } });
    }),
  );

  const folderRoute = createRoute({
    ...adminOperationRoutes.updateImapFolders,
    summary: 'Update IMAP folders',
    description: 'Update the folder overrides for an IMAP account. Requires admin.accounts.',
    ...protectedRoute,
    request: {
      params: z.object({ accountId: identifier }).strict(),
      body: { required: true, content: { 'application/json': { schema: FolderPatchSchema } } },
    },
    responses: {
      200: { content: { 'application/json': { schema: GenericDataSchema } }, description: 'Updated folder overrides' },
      ...errors,
    },
  });
  app.openapi(folderRoute, (c) =>
    run(async () => {
      requireAdmin(c.get('restAuth'), 'admin.accounts');
      const { accountId } = c.req.valid('param');
      const patch = c.req.valid('json');
      const account = registry(deps).getAccount(accountId);
      const current = registry(deps).loadImapCredentials(account.id);
      const nextOverrides = { ...current.folderOverrides };
      for (const role of folderRoles) {
        if (!(role in patch)) continue;
        const value = patch[role];
        if (value === null) delete nextOverrides[role];
        else if (value !== undefined) nextOverrides[role] = value;
      }
      const proposed = { ...current, folderOverrides: nextOverrides };
      const warnings = await registry(deps).testImapFolderOverrides(
        account.email,
        proposed,
        account.displayName,
        ADMIN_CONNECTION_TIMEOUT_MS,
      );
      const invalid = warnings.find(
        (warning) => warning.reason === 'stale_override' && typeof patch[warning.role] === 'string',
      );
      if (invalid) throw new EmailError('invalid_request', invalid.message);
      registry(deps).saveImapCredentials(account.id, proposed);
      return json({ data: { accountId: account.id, folderOverrides: nextOverrides, warnings } });
    }),
  );

  const listKeysRoute = createRoute({
    ...adminOperationRoutes.listApiKeys,
    summary: 'List API keys',
    description: 'List API key metadata without returning plaintext secrets. Requires admin.api_keys.',
    ...protectedRoute,
    responses: {
      200: {
        content: { 'application/json': { schema: z.object({ data: z.array(ApiKeySchema) }) } },
        description: 'API keys',
      },
      ...errors,
    },
  });
  app.openapi(listKeysRoute, (c) =>
    run(() => {
      requireAdmin(c.get('restAuth'), 'admin.api_keys');
      return json({ data: listApiKeys(deps.db).map(serializeApiKey) });
    }),
  );

  const createKeyRoute = createRoute({
    ...adminOperationRoutes.createApiKey,
    summary: 'Create an API key',
    description: 'Create an API key and return its plaintext secret once. Requires admin.api_keys.',
    ...protectedRoute,
    request: { body: { required: true, content: { 'application/json': { schema: ApiKeyCreateSchema } } } },
    responses: {
      201: {
        content: { 'application/json': { schema: ApiKeyCreateResponseSchema } },
        description: 'Created API key with one-time plaintext secret',
      },
      ...errors,
    },
  });
  app.openapi(createKeyRoute, (c) =>
    run(() => {
      requireAdmin(c.get('restAuth'), 'admin.api_keys');
      const input = c.req.valid('json');
      const member = findMember(deps.db, input.member);
      const created = createApiKey(
        deps.db,
        input.name,
        member.id,
        permissions(input),
        accountIds(deps, input.accounts),
      );
      return json({ data: { ...serializeApiKey(created.info), key: created.key } }, 201);
    }),
  );

  const patchKeyRoute = createRoute({
    ...adminOperationRoutes.updateApiKey,
    summary: 'Update an API key',
    description: 'Update the permissions or mailbox scope of an API key. Requires admin.api_keys.',
    ...protectedRoute,
    request: {
      params: z.object({ keyId: identifier }).strict(),
      body: { required: true, content: { 'application/json': { schema: ApiKeyPatchSchema } } },
    },
    responses: {
      200: {
        content: { 'application/json': { schema: z.object({ data: ApiKeySchema }) } },
        description: 'Updated API key',
      },
      ...errors,
    },
  });
  app.openapi(patchKeyRoute, (c) =>
    run(() => {
      requireAdmin(c.get('restAuth'), 'admin.api_keys');
      const { keyId } = c.req.valid('param');
      const input = c.req.valid('json');
      const existing = listApiKeys(deps.db).find((key) => key.id === keyId);
      if (!existing) throw new EmailError('not_found', `No API key with id "${keyId}".`);

      let nextPermissions: PermissionPolicy | undefined;
      if (input.customCapabilities || input.permissionProfile) {
        nextPermissions = permissions(input);
      } else if (input.supplementalCapabilities) {
        if (existing.permissionProfile === 'custom') {
          throw new EmailError('invalid_request', 'supplementalCapabilities cannot be applied to a custom policy.');
        }
        nextPermissions = permissionPolicyForProfile(existing.permissionProfile, input.supplementalCapabilities);
      }
      if (
        isUsableRootKey(deps.db, keyId) &&
        nextPermissions &&
        !nextPermissions.capabilities.includes('admin.api_keys') &&
        countUsableRootKeys(deps.db, keyId) === 0
      ) {
        throw new AdminFailure('last_root_key', 'Another usable admin.api_keys credential is required first.', 409);
      }
      const updated = updateApiKey(deps.db, keyId, {
        ...(nextPermissions ? { permissions: nextPermissions } : {}),
        ...(input.accounts !== undefined ? { accountIds: accountIds(deps, input.accounts) } : {}),
      });
      return json({ data: serializeApiKey(updated!) });
    }),
  );

  const deleteKeyRoute = createRoute({
    ...adminOperationRoutes.revokeApiKey,
    summary: 'Revoke an API key',
    description: 'Revoke an API key. Requires admin.api_keys.',
    ...protectedRoute,
    request: { params: z.object({ keyId: identifier }).strict() },
    responses: {
      200: { content: { 'application/json': { schema: GenericDataSchema } }, description: 'Revoked API key' },
      ...errors,
    },
  });
  app.openapi(deleteKeyRoute, (c) =>
    run(() => {
      requireAdmin(c.get('restAuth'), 'admin.api_keys');
      const { keyId } = c.req.valid('param');
      if (isUsableRootKey(deps.db, keyId) && countUsableRootKeys(deps.db, keyId) === 0) {
        throw new AdminFailure('last_root_key', 'Another usable admin.api_keys credential is required first.', 409);
      }
      if (!revokeApiKey(deps.db, keyId)) throw new EmailError('not_found', `No API key with id "${keyId}".`);
      return json({ data: { id: keyId, revoked: true } });
    }),
  );

  const licenseRoute = createRoute({
    ...adminOperationRoutes.getLicense,
    summary: 'Get license status',
    description: 'Get license status and usage without returning the configured license key. Requires admin.license.',
    ...protectedRoute,
    responses: {
      200: {
        content: { 'application/json': { schema: GenericDataSchema } },
        description: 'License status without the configured key',
      },
      ...errors,
    },
  });
  app.openapi(licenseRoute, (c) =>
    run(() => {
      requireAdmin(c.get('restAuth'), 'admin.license');
      const state = checkLicenseState(deps.db);
      const row = readLeaseRow(deps.db);
      const configured = Boolean(deps.licenseController?.configuredKey() ?? deps.config.licenseKey);
      return json({
        data: {
          configured,
          source: configured ? (deps.config.licenseKeyFromEnvironment ? 'environment' : 'stored') : null,
          entitlements: state.entitlements,
          usage: { accounts: state.accountCount, members: state.memberCount, overQuota: state.overQuota },
          lastValidatedAt: row ? new Date(row.updatedAt).toISOString() : null,
          warning: state.warning ?? null,
        },
      });
    }),
  );

  const activateRoute = createRoute({
    ...adminOperationRoutes.activateLicense,
    summary: 'Activate a license',
    description: 'Validate and activate a Fluxmail license key. Requires admin.license.',
    ...protectedRoute,
    request: { body: { required: true, content: { 'application/json': { schema: LicenseActivationSchema } } } },
    responses: {
      200: { content: { 'application/json': { schema: GenericDataSchema } }, description: 'Validated activation' },
      202: {
        content: { 'application/json': { schema: GenericDataSchema } },
        description: 'Saved for retry after an outage',
      },
      ...errors,
    },
  });
  app.openapi(activateRoute, (c) =>
    run(async () => {
      requireAdmin(c.get('restAuth'), 'admin.license');
      const { licenseKey } = c.req.valid('json');
      if (!LICENSE_KEY_PATTERN.test(licenseKey)) {
        throw new AdminFailure('invalid_license_key', 'The license key format is invalid.', 400);
      }
      if (deps.config.licenseKeyFromEnvironment) {
        throw new AdminFailure(
          'license_from_environment',
          'REST cannot replace FLUXMAIL_LICENSE_KEY from the environment.',
          409,
        );
      }
      const result = await activateLicense(deps.db, {
        licenseKey,
        serverUrl: deps.config.licenseServerUrl,
        dataDir: deps.config.dataDir,
      });
      if (result.outcome === 'refreshed') {
        deps.licenseController?.wake();
        return json({ data: { outcome: 'activated', lease: result.lease } });
      }
      if (result.outcome === 'outage') {
        deps.licenseController?.wake();
        return json({ data: { outcome: 'saved_for_retry' } }, 202);
      }
      if (result.outcome === 'bad_lease') {
        throw new AdminFailure('unverifiable_lease', 'The license lease could not be verified.', 502);
      }
      const status = result.outcome === 'in_use' ? 409 : result.outcome === 'inactive' ? 403 : 400;
      throw new AdminFailure(`license_${result.outcome}`, result.message, status);
    }),
  );
}
