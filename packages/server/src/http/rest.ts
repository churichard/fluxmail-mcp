import { createHash } from 'node:crypto';
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { HttpBindings } from '@hono/node-server';
import { EmailError, isEmailError, type EmailQuery, type ModifyAction, type PageOpts } from '@fluxmail/core';
import type { FluxmailConfig } from '../config.js';
import type { AccountRegistry } from '../accounts/registry.js';
import type { LicenseController } from '../licensing/refresher.js';
import type { AccessScope, EmailService, SendInput } from '../service/emailService.js';
import type { FluxmailDb } from '../storage/db.js';
import { authenticateApiKey, type ApiKeyAuth } from '../storage/apiKeys.js';
import { completeIdempotencyKey, reserveIdempotencyKey } from '../storage/restIdempotency.js';
import { FULL_PERMISSION_POLICY, hasCapability, type McpCapability } from '../permissions.js';
import type { Telemetry, TelemetryProperties } from '../telemetry.js';
import { VERSION } from '../version.js';
import { administrationUsesHttps, registerAdminRoutes, requestBodyExceedsLimit } from './admin.js';
import { recordAdminAuditEvent } from '../storage/adminAudit.js';

interface RestVariables {
  restAuth: ApiKeyAuth;
  restService: EmailService;
}

type RestEnv = { Bindings: HttpBindings; Variables: RestVariables };
type RestContext = Context<RestEnv>;

export interface RestApiDeps {
  config: FluxmailConfig;
  db: FluxmailDb;
  service: EmailService;
  telemetry?: Telemetry;
  registry?: AccountRegistry;
  licenseController?: LicenseController;
}

const id = z.string().trim().min(1);
const accountId = id.openapi({ example: 'acct_123' });
const messageId = id.openapi({ example: 'msg_123' });
const threadId = id.openapi({ example: 'thread_123' });
const draftId = id.openapi({ example: 'draft_123' });
const scheduleId = id.openapi({ example: 'schedule_123' });
const attachmentId = id.openapi({ example: 'attachment_123' });
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected an ISO date in YYYY-MM-DD format')
  .refine((value) => {
    const parsed = Date.parse(`${value}T00:00:00Z`);
    return !Number.isNaN(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
  }, 'Expected a valid calendar date')
  .openapi({ format: 'date' });
const base64Content = z
  .string()
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/, 'Expected base64 content')
  .openapi({ format: 'byte' });
const accountParams = z.object({ accountId }).strict();
const messageParams = z.object({ accountId, messageId }).strict();
const threadParams = z.object({ accountId, threadId }).strict();
const draftParams = z.object({ accountId, draftId }).strict();
const scheduleParams = z.object({ accountId, scheduleId }).strict();
const attachmentParams = z.object({ accountId, messageId, attachmentId }).strict();

const EmailAddressSchema = z
  .object({ email: z.string().email(), name: z.string().min(1).optional() })
  .strict()
  .openapi('EmailAddress');
const MessageBodySchema = z
  .object({ text: z.string().optional(), html: z.string().optional() })
  .strict()
  .openapi('MessageBody');
const AttachmentInputSchema = z
  .object({
    filename: z.string().min(1),
    mimeType: z.string().min(1),
    content: base64Content.describe('Base64-encoded content'),
    contentId: z.string().min(1).optional(),
    disposition: z.enum(['inline', 'attachment']).optional(),
  })
  .strict()
  .openapi('AttachmentInput');
const AttachmentMetaSchema = z
  .object({
    id: z.string(),
    filename: z.string(),
    mimeType: z.string(),
    sizeBytes: z.number().int().nonnegative(),
    contentId: z.string().optional(),
    disposition: z.enum(['inline', 'attachment']).optional(),
  })
  .strict()
  .openapi('AttachmentMeta');
const FolderSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    role: z.enum(['inbox', 'sent', 'drafts', 'trash', 'spam', 'archive', 'starred', 'all']).optional(),
    roleSource: z.enum(['user', 'extension', 'name']).optional(),
    unreadCount: z.number().int().nonnegative().optional(),
  })
  .strict()
  .openapi('Folder');
const MessageSchema = z
  .object({
    id: z.string(),
    threadId: z.string(),
    accountId: z.string(),
    draftId: z.string().optional(),
    folder: FolderSchema.optional(),
    labels: z.array(z.string()).optional(),
    from: EmailAddressSchema.optional(),
    to: z.array(EmailAddressSchema),
    cc: z.array(EmailAddressSchema).optional(),
    bcc: z.array(EmailAddressSchema).optional(),
    replyTo: z.array(EmailAddressSchema).optional(),
    subject: z.string(),
    date: z.string(),
    snippet: z.string().optional(),
    body: MessageBodySchema.optional(),
    attachments: z.array(AttachmentMetaSchema).optional(),
    flags: z.object({ read: z.boolean(), starred: z.boolean(), draft: z.boolean() }).strict(),
    headers: z.record(z.string()).optional(),
  })
  .strict()
  .openapi('Message');
const ThreadSchema = z
  .object({ id: z.string(), subject: z.string(), messages: z.array(MessageSchema) })
  .strict()
  .openapi('Thread');
const AccountSchema = z
  .object({
    id: z.string(),
    provider: z.enum(['gmail', 'outlook', 'imap']),
    email: z.string(),
    displayName: z.string().optional(),
    status: z.enum(['active', 'auth_error', 'disabled']),
    capabilities: z
      .object({
        labels: z.boolean(),
        serverThreads: z.boolean(),
        serverSearch: z.enum(['rich', 'basic']),
        snippets: z.boolean(),
      })
      .strict(),
    ownerId: z.string().optional(),
    sharingMode: z.enum(['private', 'all', 'selected']),
    sharedMemberIds: z.array(z.string()),
    memberId: z.string().optional(),
  })
  .strict()
  .openapi('Account');
const ScheduledSendSchema = z
  .object({
    scheduleId: z.string(),
    accountId: z.string(),
    draftId: z.string(),
    sendAt: z.string(),
    status: z.enum(['pending', 'sending', 'sent', 'failed', 'canceled']),
    attempts: z.number().int().nonnegative(),
    subject: z.string().optional(),
    to: z.string().optional(),
    lastError: z.string().optional(),
    sentMessageId: z.string().optional(),
    sentThreadId: z.string().optional(),
  })
  .strict()
  .openapi('ScheduledSend');
const SendResultSchema = z
  .object({ id: z.string(), threadId: z.string(), warnings: z.array(z.string()).optional() })
  .strict()
  .openapi('SendResult');
const ErrorSchema = z
  .object({
    error: z.object({ code: z.string(), message: z.string(), data: z.record(z.unknown()).optional() }).strict(),
  })
  .strict()
  .openapi('RestError');

function dataEnvelope<T extends z.ZodTypeAny>(schema: T) {
  return z.object({ data: schema, warnings: z.array(z.string()).optional() }).strict();
}

function pagedEnvelope<T extends z.ZodTypeAny>(schema: T) {
  return z
    .object({
      data: z.array(schema),
      meta: z.object({ nextPageToken: z.string().optional() }).strict(),
      warnings: z.array(z.string()).optional(),
    })
    .strict();
}

const errorResponses = {
  400: { content: { 'application/json': { schema: ErrorSchema } }, description: 'Invalid request' },
  401: { content: { 'application/json': { schema: ErrorSchema } }, description: 'Authentication required' },
  403: { content: { 'application/json': { schema: ErrorSchema } }, description: 'Permission or plan denied' },
  404: { content: { 'application/json': { schema: ErrorSchema } }, description: 'Resource not found' },
  409: { content: { 'application/json': { schema: ErrorSchema } }, description: 'Request conflict' },
  422: { content: { 'application/json': { schema: ErrorSchema } }, description: 'Unsupported capability' },
  429: { content: { 'application/json': { schema: ErrorSchema } }, description: 'Provider rate limit' },
  500: { content: { 'application/json': { schema: ErrorSchema } }, description: 'Internal error' },
  503: { content: { 'application/json': { schema: ErrorSchema } }, description: 'Provider unavailable' },
} as const;

const protectedRoute: { security: Array<Record<string, string[]>> } = {
  security: [{ bearerAuth: [] }],
};
const idempotencyHeaders = z.object({
  'Idempotency-Key': z
    .string()
    .min(1)
    .max(255)
    .regex(/^[\x21-\x7e]+$/, 'Idempotency-Key must contain printable ASCII without spaces')
    .describe('A unique key for one intended delivery. Reuse it when retrying the same request.'),
});

const draftShape = {
  to: z.array(EmailAddressSchema).optional(),
  cc: z.array(EmailAddressSchema).optional(),
  bcc: z.array(EmailAddressSchema).optional(),
  subject: z.string().optional(),
  body: MessageBodySchema,
  replyToMessageId: messageId.optional(),
  replyAll: z.boolean().optional().describe('Requires replyToMessageId when true.'),
  attachments: z.array(AttachmentInputSchema).optional(),
};

function requireReplyTarget(value: { replyAll?: boolean; replyToMessageId?: string }, ctx: z.RefinementCtx): void {
  if (value.replyAll && !value.replyToMessageId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['replyAll'], message: 'replyAll requires replyToMessageId' });
  }
}

const DraftRequestSchema = z.object(draftShape).strict().superRefine(requireReplyTarget).openapi('DraftRequest');
const SendContentSchema = z
  .object({ ...draftShape, sendAt: z.string().datetime({ offset: true }).optional() })
  .strict()
  .superRefine(requireReplyTarget);
const SendDraftSchema = z.object({ draftId, sendAt: z.string().datetime({ offset: true }).optional() }).strict();
const SendRequestSchema = z.union([SendDraftSchema, SendContentSchema]).openapi('SendRequest');
const ForwardRequestSchema = z
  .object({
    to: z.array(EmailAddressSchema).min(1),
    cc: z.array(EmailAddressSchema).optional(),
    comment: z.string().optional(),
    includeAttachments: z
      .boolean()
      .optional()
      .openapi({ description: 'Include attachments from the original message. Defaults to true.', default: true }),
  })
  .strict()
  .openapi('ForwardRequest');

const modifyActionNames = [
  'markRead',
  'markUnread',
  'star',
  'unstar',
  'archive',
  'trash',
  'untrash',
  'delete',
  'move',
  'addLabels',
  'removeLabels',
] as const;
type ModifyActionName = (typeof modifyActionNames)[number];
const ModifyRequestSchema = z
  .object({
    messageIds: z.array(messageId).min(1),
    action: z.enum(modifyActionNames),
    folder: z
      .string()
      .min(1)
      .optional()
      .describe('Required when action is move. Use archive or trash instead of moving to those folders.'),
    labels: z
      .array(z.string().min(1))
      .max(100)
      .optional()
      .describe('Required when action is addLabels or removeLabels. Change system labels with dedicated actions.'),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.action === 'move' && !value.folder) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['folder'], message: 'action=move requires folder' });
    }
    if ((value.action === 'addLabels' || value.action === 'removeLabels') && !value.labels?.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['labels'],
        message: `action=${value.action} requires labels`,
      });
    }
  })
  .openapi('ModifyMessagesRequest');

const messageQuerySchema = z
  .object({
    folder: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Folder role (inbox, sent, drafts, trash, spam, starred, archive, all) or a label/folder name. Use all or omit this field to search all mail except Spam and Trash. An IMAP server's \\All mailbox may use different rules.",
      ),
    text: z.string().optional(),
    from: z.string().optional(),
    to: z.string().optional(),
    subject: z.string().optional(),
    unreadOnly: z.enum(['true', 'false']).optional(),
    starredOnly: z.enum(['true', 'false']).optional(),
    hasAttachment: z.enum(['true', 'false']).optional(),
    after: isoDate.optional(),
    before: isoDate.optional(),
    rawProviderQuery: z.string().optional(),
    pageSize: z
      .string()
      .regex(/^(?:[1-9]|[1-9][0-9]|100)$/)
      .optional(),
    pageToken: z.string().min(1).optional(),
  })
  .strict();

const MODIFY_CAPABILITIES: Record<ModifyActionName, McpCapability> = {
  markRead: 'mail.organize',
  markUnread: 'mail.organize',
  star: 'mail.organize',
  unstar: 'mail.organize',
  archive: 'mail.organize',
  trash: 'mail.trash',
  untrash: 'mail.trash',
  delete: 'mail.delete',
  move: 'mail.organize',
  addLabels: 'mail.organize',
  removeLabels: 'mail.organize',
};
const PROTECTED_MOVE_DESTINATIONS = new Set(['archive', 'trash']);
const SYSTEM_LABELS = new Set(['inbox', 'sent', 'draft', 'drafts', 'trash', 'spam', 'starred', 'unread', 'important']);

interface ApiFailure {
  status: number;
  payload: { error: { code: string; message: string; data?: Record<string, unknown> } };
  retryAfter?: string;
}

class RestFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly data?: Record<string, unknown>,
    readonly retryAfter?: string,
  ) {
    super(message);
  }
}

function apiFailure(err: unknown): ApiFailure {
  if (err instanceof RestFailure) {
    return {
      status: err.status,
      payload: { error: { code: err.code, message: err.message, ...(err.data ? { data: err.data } : {}) } },
      ...(err.retryAfter ? { retryAfter: err.retryAfter } : {}),
    };
  }
  if (isEmailError(err)) {
    const status: Record<string, number> = {
      invalid_request: 400,
      permission_denied: 403,
      entitlement_exceeded: 403,
      not_found: 404,
      auth_expired: 409,
      unsupported_capability: 422,
      rate_limited: 429,
      provider_unavailable: 503,
    };
    return {
      status: status[err.code] ?? 500,
      payload: {
        error: { code: err.code, message: err.message, ...(err.data ? { data: err.data } : {}) },
      },
    };
  }
  return {
    status: 500,
    payload: { error: { code: 'internal', message: 'The request could not be completed.' } },
  };
}

function jsonResponse(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=UTF-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      ...headers,
    },
  });
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function requestHash(operation: string, request: unknown): string {
  return createHash('sha256').update(canonicalJson({ operation, request })).digest('hex');
}

function encodeContentDispositionFilename(filename: string): string {
  return encodeURIComponent(filename).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function safeAttachmentFilename(filename: string): string {
  let safe = '';
  for (const character of filename) {
    const code = character.charCodeAt(0);
    safe += code < 32 || code === 127 || '/\\:*?"<>|'.includes(character) ? '_' : character;
  }
  return safe || 'attachment';
}

function captureRestTelemetry(telemetry: Telemetry | undefined, properties: TelemetryProperties): void {
  try {
    telemetry?.capture('rest api called', { product_surface: 'rest', ...properties });
  } catch {
    // Telemetry must not affect API responses.
  }
}

interface JsonResult {
  data: unknown;
  meta?: Record<string, unknown>;
}

async function runJson(
  c: RestContext,
  deps: RestApiDeps,
  options: {
    operation: string;
    capabilities: McpCapability[];
    quota?: boolean;
    successStatus?: number;
    request?: unknown;
    idempotent?: boolean;
    accountId?: string;
    telemetry?: TelemetryProperties;
  },
  fn: () => Promise<JsonResult> | JsonResult,
): Promise<never> {
  const finishActivity = deps.telemetry?.beginActivity?.();
  const startedAt = performance.now();
  let outcome = 'error';
  let errorCode: string | undefined;
  let idempotencyStatus: string | undefined;
  let reservation: { principalId: string; idempotencyKey: string; requestHash: string } | undefined;

  try {
    const auth = c.get('restAuth');
    const missing = options.capabilities.filter((capability) => !hasCapability(auth.permissions, capability));
    if (missing.length) {
      throw new EmailError('permission_denied', `This API key does not allow: ${missing.join(', ')}.`);
    }
    const service = c.get('restService');

    if (options.idempotent) {
      const idempotencyKey = c.req.header('idempotency-key');
      if (!idempotencyKey || !/^[\x21-\x7e]{1,255}$/.test(idempotencyKey)) {
        throw new RestFailure(
          'invalid_request',
          'Idempotency-Key is required and must contain 1 to 255 printable ASCII characters without spaces.',
          400,
        );
      }
      if (options.accountId !== undefined) service.assertAccountAccess(options.accountId);
      const hash = requestHash(options.operation, options.request);
      const principalId = auth.keyId;
      const result = reserveIdempotencyKey(deps.db, {
        principalId,
        idempotencyKey,
        requestHash: hash,
      });
      idempotencyStatus = result.status;
      if (result.status === 'conflict') {
        throw new RestFailure(
          'idempotency_conflict',
          'This Idempotency-Key was already used for a different request.',
          409,
        );
      }
      if (result.status === 'in_progress') {
        throw new RestFailure(
          'idempotency_in_progress',
          'A request with this Idempotency-Key is still in progress or ended with an uncertain outcome.',
          409,
          undefined,
          '1',
        );
      }
      if (result.status === 'replay') {
        outcome = result.responseStatus < 400 ? 'success' : 'error';
        try {
          const parsed = JSON.parse(result.responseBody) as { error?: { code?: string } };
          errorCode = parsed.error?.code;
        } catch {
          errorCode = result.responseStatus >= 400 ? 'internal' : undefined;
        }
        return new Response(result.responseBody, {
          status: result.responseStatus,
          headers: {
            'content-type': 'application/json; charset=UTF-8',
            'cache-control': 'no-store',
            'idempotency-replayed': 'true',
          },
        }) as never;
      }
      reservation = { principalId, idempotencyKey, requestHash: hash };
    }

    try {
      const warning = options.quota === false ? undefined : service.enforceQuota();
      const result = await fn();
      const payload = {
        data: result.data,
        ...(result.meta ? { meta: result.meta } : {}),
        ...(warning ? { warnings: [warning] } : {}),
      };
      const status = options.successStatus ?? 200;
      const body = JSON.stringify(payload);
      if (reservation) {
        completeIdempotencyKey(deps.db, { ...reservation, responseStatus: status, responseBody: body });
      }
      outcome = 'success';
      return new Response(body, {
        status,
        headers: { 'content-type': 'application/json; charset=UTF-8', 'cache-control': 'no-store' },
      }) as never;
    } catch (err) {
      const failure = apiFailure(err);
      const body = JSON.stringify(failure.payload);
      if (reservation) {
        completeIdempotencyKey(deps.db, {
          ...reservation,
          responseStatus: failure.status,
          responseBody: body,
        });
      }
      errorCode = failure.payload.error.code;
      return new Response(body, {
        status: failure.status,
        headers: {
          'content-type': 'application/json; charset=UTF-8',
          'cache-control': 'no-store',
          ...(failure.retryAfter ? { 'retry-after': failure.retryAfter } : {}),
        },
      }) as never;
    }
  } catch (err) {
    const failure = apiFailure(err);
    errorCode = failure.payload.error.code;
    return jsonResponse(
      failure.payload,
      failure.status,
      failure.retryAfter ? { 'retry-after': failure.retryAfter } : {},
    ) as never;
  } finally {
    captureRestTelemetry(deps.telemetry, {
      operation: options.operation,
      outcome,
      duration_ms: Math.round(performance.now() - startedAt),
      ...(errorCode ? { error_code: errorCode } : {}),
      ...(idempotencyStatus ? { idempotency_status: idempotencyStatus } : {}),
      ...options.telemetry,
    });
    finishActivity?.();
  }
}

async function runAttachment(
  c: RestContext,
  deps: RestApiDeps,
  accountId: string,
  messageId: string,
  attachmentId: string,
): Promise<never> {
  const finishActivity = deps.telemetry?.beginActivity?.();
  const startedAt = performance.now();
  let outcome = 'error';
  let errorCode: string | undefined;
  try {
    const auth = c.get('restAuth');
    if (!hasCapability(auth.permissions, 'mail.read')) {
      throw new EmailError('permission_denied', 'This API key does not allow: mail.read.');
    }
    const service = c.get('restService');
    const warning = service.enforceQuota();
    const { meta, content } = await service.getAttachment(
      accountId,
      messageId,
      attachmentId,
      deps.config.maxAttachmentBytes,
    );
    if (content.length > deps.config.maxAttachmentBytes) {
      throw new EmailError('invalid_request', 'Attachment is too large to return through the REST API.', {
        sizeBytes: content.length,
        maxBytes: deps.config.maxAttachmentBytes,
      });
    }
    const safeName = safeAttachmentFilename(meta.filename);
    const asciiName = safeName.replace(/[^\x20-\x7e]/g, '_');
    const mimeType = /^[\w!#$&^_.+-]+\/[\w!#$&^_.+-]+$/.test(meta.mimeType)
      ? meta.mimeType
      : 'application/octet-stream';
    outcome = 'success';
    return new Response(new Uint8Array(content), {
      status: 200,
      headers: {
        'content-type': mimeType,
        'content-length': String(content.length),
        'content-disposition': `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeContentDispositionFilename(safeName)}`,
        'cache-control': 'no-store',
        ...(warning ? { 'fluxmail-warning': warning.replace(/[\r\n]/g, ' ') } : {}),
      },
    }) as never;
  } catch (err) {
    const failure = apiFailure(err);
    errorCode = failure.payload.error.code;
    return jsonResponse(failure.payload, failure.status) as never;
  } finally {
    captureRestTelemetry(deps.telemetry, {
      operation: 'downloadAttachment',
      outcome,
      duration_ms: Math.round(performance.now() - startedAt),
      ...(errorCode ? { error_code: errorCode } : {}),
    });
    finishActivity?.();
  }
}

function toSendInput(input: z.infer<typeof DraftRequestSchema>): SendInput {
  return {
    body: input.body,
    ...(input.to ? { to: input.to } : {}),
    ...(input.cc ? { cc: input.cc } : {}),
    ...(input.bcc ? { bcc: input.bcc } : {}),
    ...(input.subject !== undefined ? { subject: input.subject } : {}),
    ...(input.replyToMessageId ? { replyToMessageId: input.replyToMessageId } : {}),
    ...(input.replyAll !== undefined ? { replyAll: input.replyAll } : {}),
    ...(input.attachments ? { attachments: input.attachments } : {}),
  };
}

function toEmailQuery(input: z.infer<typeof messageQuerySchema>): { query: EmailQuery; page: PageOpts } {
  const query: EmailQuery = {};
  for (const key of ['folder', 'text', 'from', 'to', 'subject', 'after', 'before', 'rawProviderQuery'] as const) {
    if (input[key] !== undefined) query[key] = input[key];
  }
  for (const key of ['unreadOnly', 'starredOnly', 'hasAttachment'] as const) {
    if (input[key] !== undefined) query[key] = input[key] === 'true';
  }
  return {
    query,
    page: {
      ...(input.pageSize ? { pageSize: Number(input.pageSize) } : {}),
      ...(input.pageToken ? { pageToken: input.pageToken } : {}),
    },
  };
}

const FIXED_ADMIN_AUDIT_PATHS = new Set([
  '/api/v1/admin/connections',
  '/api/v1/admin/imap/tests',
  '/api/v1/admin/api-keys',
  '/api/v1/admin/license/activate',
]);

function adminAuditPath(path: string): string {
  if (FIXED_ADMIN_AUDIT_PATHS.has(path)) return path;
  if (/^\/api\/v1\/admin\/api-keys\/[^/]+$/.test(path)) return '/api/v1/admin/api-keys/:id';
  if (/^\/api\/v1\/admin\/accounts\/[^/]+\/imap\/folders$/.test(path)) {
    return '/api/v1/admin/accounts/:id/imap/folders';
  }
  return '/api/v1/admin/*';
}

function modifyAction(input: z.infer<typeof ModifyRequestSchema>): ModifyAction {
  if (input.action === 'move') {
    const folder = input.folder!;
    if (PROTECTED_MOVE_DESTINATIONS.has(folder.trim().toLowerCase())) {
      throw new EmailError('invalid_request', 'Use the dedicated archive or trash action for this folder.');
    }
    return { move: folder };
  }
  if (input.action === 'addLabels' || input.action === 'removeLabels') {
    const labels = input.labels!;
    if (labels.some((label) => SYSTEM_LABELS.has(label.trim().toLowerCase()))) {
      throw new EmailError('invalid_request', 'System labels must be changed with their dedicated message action.');
    }
    return input.action === 'addLabels' ? { addLabels: labels } : { removeLabels: labels };
  }
  return input.action;
}

export function createRestApi(deps: RestApiDeps): OpenAPIHono<RestEnv> {
  const app = new OpenAPIHono<RestEnv>({
    defaultHook(result, _c) {
      if (result.success) return;
      return jsonResponse(
        {
          error: {
            code: 'invalid_request',
            message: 'Request validation failed.',
            data: {
              issues: result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
            },
          },
        },
        400,
      );
    },
  });

  app.use('/api/v1/admin/*', async (c, next) => {
    await next();
    if (!['POST', 'PATCH', 'PUT', 'DELETE'].includes(c.req.method)) return;
    const auth = c.get('restAuth');
    if (!auth) return;
    const resource = c.req.path.match(/\/(api-keys|accounts)\/((?:key|acct)_[^/]+)/);
    const operation = `${c.req.method.toLowerCase()} ${adminAuditPath(c.req.path)}`;
    let errorCode: string | undefined;
    if (c.res.status >= 400) {
      try {
        const payload = (await c.res.clone().json()) as { error?: { code?: unknown } };
        if (typeof payload.error?.code === 'string') errorCode = payload.error.code;
      } catch {
        errorCode = 'internal';
      }
    }
    try {
      recordAdminAuditEvent(deps.db, {
        operation,
        outcome: c.res.status < 400 ? 'success' : 'error',
        actorKeyId: auth.keyId,
        actorMemberId: auth.memberId,
        ...(resource
          ? { resourceType: resource[1] === 'api-keys' ? 'api_key' : 'account', resourceId: resource[2] }
          : {}),
        ...(errorCode ? { errorCode } : {}),
      });
    } catch {
      // Auditing must not replace the API response.
    }
  });

  app.use('/api/v1/*', async (c, next) => {
    if (c.req.path === '/api/v1' || c.req.path === '/api/v1/openapi.json') return next();
    const administrative = c.req.path.startsWith('/api/v1/admin/');
    if (administrative) {
      c.header('cache-control', 'no-store');
      c.header('x-content-type-options', 'nosniff');
      c.header('referrer-policy', 'no-referrer');
      if (
        !administrationUsesHttps(c.req.raw, {
          remoteAddress: c.env?.incoming?.socket.remoteAddress,
          encrypted: Boolean((c.env?.incoming?.socket as { encrypted?: boolean } | undefined)?.encrypted),
        })
      ) {
        return jsonResponse(
          { error: { code: 'https_required', message: 'Administrative routes require HTTPS outside loopback.' } },
          400,
        );
      }
    }
    let auth: ApiKeyAuth | null;
    if (deps.config.authMode === 'none' && !administrative) {
      auth = {
        keyId: 'auth:none',
        memberId: null,
        role: null,
        permissions: FULL_PERMISSION_POLICY,
        accountIds: null,
      };
    } else {
      const authorization = c.req.header('authorization');
      const bearer = authorization?.match(/^Bearer\s+([^\s]+)$/i)?.[1];
      auth = bearer ? authenticateApiKey(deps.db, bearer) : null;
    }
    if (!auth) {
      return jsonResponse({ error: { code: 'unauthorized', message: 'Pass an API key as a Bearer token.' } }, 401, {
        'www-authenticate': 'Bearer',
      });
    }
    c.set('restAuth', auth);
    if (administrative && (c.req.method === 'POST' || c.req.method === 'PATCH' || c.req.method === 'PUT')) {
      const mediaType = c.req.header('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
      if (mediaType !== 'application/json') {
        return jsonResponse(
          { error: { code: 'unsupported_media_type', message: 'Content-Type must be application/json.' } },
          415,
        );
      }
      if (await requestBodyExceedsLimit(c.req.raw)) {
        return jsonResponse(
          { error: { code: 'request_too_large', message: 'Administrative request bodies are limited to 64 KiB.' } },
          413,
        );
      }
    }
    const scope: AccessScope =
      deps.config.authMode === 'none'
        ? { memberId: null }
        : { memberId: auth.memberId, role: auth.role, accountIds: auth.accountIds };
    c.set('restService', deps.service.withScope(scope));
    return next();
  });

  registerAdminRoutes(app, deps);

  const discoveryRoute = createRoute({
    method: 'get',
    path: '/api/v1',
    operationId: 'getApiInfo',
    summary: 'Get API information',
    description: 'Return the Fluxmail version and the URL of the OpenAPI document.',
    responses: {
      200: {
        content: {
          'application/json': {
            schema: dataEnvelope(
              z.object({ name: z.literal('fluxmail'), version: z.string(), openapi: z.string() }).strict(),
            ),
          },
        },
        description: 'REST API discovery',
      },
    },
  });
  app.openapi(discoveryRoute, (c) =>
    c.json({ data: { name: 'fluxmail' as const, version: VERSION, openapi: '/api/v1/openapi.json' } }),
  );

  const statusRoute = createRoute({
    method: 'get',
    path: '/api/v1/status',
    operationId: 'getStatus',
    summary: 'Get server status',
    description: 'Return provider and mailbox status for the accounts available to the API key.',
    ...protectedRoute,
    responses: {
      200: { content: { 'application/json': { schema: dataEnvelope(z.record(z.unknown())) } }, description: 'Status' },
      ...errorResponses,
    },
  });
  app.openapi(statusRoute, (c) =>
    runJson(c, deps, { operation: 'getStatus', capabilities: ['mail.read'], quota: false }, async () => ({
      data: await c.get('restService').status(),
    })),
  );

  const accountsRoute = createRoute({
    method: 'get',
    path: '/api/v1/accounts',
    operationId: 'listAccounts',
    summary: 'List accounts',
    description: 'List the email accounts available to the API key.',
    ...protectedRoute,
    responses: {
      200: {
        content: { 'application/json': { schema: dataEnvelope(z.array(AccountSchema)) } },
        description: 'Accounts',
      },
      ...errorResponses,
    },
  });
  app.openapi(accountsRoute, (c) =>
    runJson(c, deps, { operation: 'listAccounts', capabilities: ['mail.read'] }, () => ({
      data: c.get('restService').listAccounts(),
    })),
  );

  const foldersRoute = createRoute({
    method: 'get',
    path: '/api/v1/accounts/{accountId}/folders',
    operationId: 'listFolders',
    summary: 'List folders',
    description: 'List folders in an email account.',
    request: { params: accountParams },
    ...protectedRoute,
    responses: {
      200: { content: { 'application/json': { schema: dataEnvelope(z.array(FolderSchema)) } }, description: 'Folders' },
      ...errorResponses,
    },
  });
  app.openapi(foldersRoute, (c) => {
    const { accountId } = c.req.valid('param');
    return runJson(c, deps, { operation: 'listFolders', capabilities: ['mail.read'] }, async () => ({
      data: await c.get('restService').listFolders(accountId),
    }));
  });

  const listMessagesRoute = createRoute({
    method: 'get',
    path: '/api/v1/accounts/{accountId}/messages',
    operationId: 'listMessages',
    summary: 'List messages',
    description: 'List and filter messages in an email account.',
    request: { params: accountParams, query: messageQuerySchema },
    ...protectedRoute,
    responses: {
      200: { content: { 'application/json': { schema: pagedEnvelope(MessageSchema) } }, description: 'Messages' },
      ...errorResponses,
    },
  });
  app.openapi(listMessagesRoute, (c) => {
    const { accountId } = c.req.valid('param');
    const { query, page } = toEmailQuery(c.req.valid('query'));
    return runJson(c, deps, { operation: 'listMessages', capabilities: ['mail.read'] }, async () => {
      const result = await c.get('restService').listMessages(accountId, query, page);
      return { data: result.items, meta: result.nextPageToken ? { nextPageToken: result.nextPageToken } : {} };
    });
  });

  const getMessageRoute = createRoute({
    method: 'get',
    path: '/api/v1/accounts/{accountId}/messages/{messageId}',
    operationId: 'getMessage',
    summary: 'Get a message',
    description: 'Get one message by its provider ID.',
    request: { params: messageParams },
    ...protectedRoute,
    responses: {
      200: { content: { 'application/json': { schema: dataEnvelope(MessageSchema) } }, description: 'Message' },
      ...errorResponses,
    },
  });
  app.openapi(getMessageRoute, (c) => {
    const { accountId, messageId } = c.req.valid('param');
    return runJson(c, deps, { operation: 'getMessage', capabilities: ['mail.read'] }, async () => ({
      data: await c.get('restService').getMessage(accountId, messageId),
    }));
  });

  const getThreadRoute = createRoute({
    method: 'get',
    path: '/api/v1/accounts/{accountId}/threads/{threadId}',
    operationId: 'getThread',
    summary: 'Get a thread',
    description: 'Get a complete email thread by its provider ID.',
    request: { params: threadParams },
    ...protectedRoute,
    responses: {
      200: { content: { 'application/json': { schema: dataEnvelope(ThreadSchema) } }, description: 'Thread' },
      ...errorResponses,
    },
  });
  app.openapi(getThreadRoute, (c) => {
    const { accountId, threadId } = c.req.valid('param');
    return runJson(c, deps, { operation: 'getThread', capabilities: ['mail.read'] }, async () => ({
      data: await c.get('restService').getThread(accountId, threadId),
    }));
  });

  const createDraftRoute = createRoute({
    method: 'post',
    path: '/api/v1/accounts/{accountId}/drafts',
    operationId: 'createDraft',
    summary: 'Create a draft',
    description: 'Create a new draft or a reply draft in an email account.',
    request: {
      params: accountParams,
      body: { required: true, content: { 'application/json': { schema: DraftRequestSchema } } },
    },
    ...protectedRoute,
    responses: {
      201: { content: { 'application/json': { schema: dataEnvelope(MessageSchema) } }, description: 'Draft created' },
      ...errorResponses,
    },
  });
  app.openapi(createDraftRoute, (c) => {
    const { accountId } = c.req.valid('param');
    const input = c.req.valid('json');
    const capabilities: McpCapability[] = ['mail.drafts', ...(input.replyToMessageId ? ['mail.read' as const] : [])];
    return runJson(c, deps, { operation: 'createDraft', capabilities, successStatus: 201 }, async () => ({
      data: await c.get('restService').createDraft(accountId, toSendInput(input)),
    }));
  });

  const updateDraftRoute = createRoute({
    method: 'put',
    path: '/api/v1/accounts/{accountId}/drafts/{draftId}',
    operationId: 'updateDraft',
    summary: 'Replace a draft',
    description: 'Replace the full content of an existing draft.',
    request: {
      params: draftParams,
      body: { required: true, content: { 'application/json': { schema: DraftRequestSchema } } },
    },
    ...protectedRoute,
    responses: {
      200: { content: { 'application/json': { schema: dataEnvelope(MessageSchema) } }, description: 'Draft replaced' },
      ...errorResponses,
    },
  });
  app.openapi(updateDraftRoute, (c) => {
    const { accountId, draftId } = c.req.valid('param');
    const input = c.req.valid('json');
    const capabilities: McpCapability[] = ['mail.drafts', ...(input.replyToMessageId ? ['mail.read' as const] : [])];
    return runJson(c, deps, { operation: 'updateDraft', capabilities }, async () => ({
      data: await c.get('restService').updateDraft(accountId, draftId, toSendInput(input)),
    }));
  });

  const deleteDraftRoute = createRoute({
    method: 'delete',
    path: '/api/v1/accounts/{accountId}/drafts/{draftId}',
    operationId: 'deleteDraft',
    summary: 'Delete a draft',
    description: 'Delete an existing draft from an email account.',
    request: { params: draftParams },
    ...protectedRoute,
    responses: {
      200: {
        content: { 'application/json': { schema: dataEnvelope(z.object({ deleted: z.string() }).strict()) } },
        description: 'Draft deleted',
      },
      ...errorResponses,
    },
  });
  app.openapi(deleteDraftRoute, (c) => {
    const { accountId, draftId } = c.req.valid('param');
    return runJson(c, deps, { operation: 'deleteDraft', capabilities: ['mail.drafts'] }, async () => {
      await c.get('restService').deleteDraft(accountId, draftId);
      return { data: { deleted: draftId } };
    });
  });

  const sendRoute = createRoute({
    method: 'post',
    path: '/api/v1/accounts/{accountId}/send',
    operationId: 'sendMessage',
    summary: 'Send or schedule a message',
    description: 'Send a message now or schedule it for a specified time.',
    request: {
      params: accountParams,
      headers: idempotencyHeaders,
      body: { required: true, content: { 'application/json': { schema: SendRequestSchema } } },
    },
    ...protectedRoute,
    responses: {
      200: { content: { 'application/json': { schema: dataEnvelope(SendResultSchema) } }, description: 'Message sent' },
      202: {
        content: { 'application/json': { schema: dataEnvelope(ScheduledSendSchema) } },
        description: 'Message scheduled',
      },
      ...errorResponses,
    },
  });
  app.openapi(sendRoute, (c) => {
    const { accountId } = c.req.valid('param');
    const input = c.req.valid('json');
    const capabilities: McpCapability[] = [
      'mail.send',
      ...('replyToMessageId' in input && input.replyToMessageId ? ['mail.read' as const] : []),
    ];
    const sendAt = input.sendAt;
    const request: SendInput | { draftId: string } =
      'draftId' in input ? { draftId: input.draftId } : toSendInput(input);
    return runJson(
      c,
      deps,
      {
        operation: 'sendMessage',
        capabilities,
        successStatus: sendAt ? 202 : 200,
        request: { accountId, input },
        idempotent: true,
        accountId,
        telemetry: {
          mode: 'draftId' in input ? 'draft' : input.replyToMessageId ? 'reply' : 'direct',
          scheduled: sendAt !== undefined,
          reply_all: 'replyAll' in input && input.replyAll === true,
        },
      },
      async () => ({
        data: sendAt
          ? await c.get('restService').scheduleSend(accountId, request, sendAt)
          : await c.get('restService').send(accountId, request),
      }),
    );
  });

  const listScheduledRoute = createRoute({
    method: 'get',
    path: '/api/v1/accounts/{accountId}/scheduled-sends',
    operationId: 'listScheduledSends',
    summary: 'List scheduled sends',
    description: 'List scheduled messages in an email account.',
    request: { params: accountParams },
    ...protectedRoute,
    responses: {
      200: {
        content: { 'application/json': { schema: dataEnvelope(z.array(ScheduledSendSchema)) } },
        description: 'Scheduled sends',
      },
      ...errorResponses,
    },
  });
  app.openapi(listScheduledRoute, (c) => {
    const { accountId } = c.req.valid('param');
    return runJson(c, deps, { operation: 'listScheduledSends', capabilities: ['mail.read'] }, () => ({
      data: c.get('restService').listScheduled(accountId),
    }));
  });

  const cancelScheduledRoute = createRoute({
    method: 'delete',
    path: '/api/v1/accounts/{accountId}/scheduled-sends/{scheduleId}',
    operationId: 'cancelScheduledSend',
    summary: 'Cancel a scheduled send',
    description: 'Cancel a pending scheduled send and keep its provider draft.',
    request: { params: scheduleParams },
    ...protectedRoute,
    responses: {
      200: {
        content: {
          'application/json': {
            schema: dataEnvelope(
              z.object({ scheduleId: z.string(), draftId: z.string(), draftKept: z.literal(true) }).strict(),
            ),
          },
        },
        description: 'Scheduled send canceled',
      },
      ...errorResponses,
    },
  });
  app.openapi(cancelScheduledRoute, (c) => {
    const { accountId, scheduleId } = c.req.valid('param');
    return runJson(c, deps, { operation: 'cancelScheduledSend', capabilities: ['mail.drafts'] }, () => {
      const exists = c
        .get('restService')
        .listScheduled(accountId)
        .some((schedule) => schedule.scheduleId === scheduleId);
      if (!exists) throw new EmailError('not_found', `No scheduled send with id ${scheduleId}`);
      return { data: c.get('restService').cancelScheduled(scheduleId) };
    });
  });

  const forwardRoute = createRoute({
    method: 'post',
    path: '/api/v1/accounts/{accountId}/messages/{messageId}/forward',
    operationId: 'forwardMessage',
    summary: 'Forward a message',
    description: 'Forward a message to one or more recipients.',
    request: {
      params: messageParams,
      headers: idempotencyHeaders,
      body: { required: true, content: { 'application/json': { schema: ForwardRequestSchema } } },
    },
    ...protectedRoute,
    responses: {
      200: { content: { 'application/json': { schema: dataEnvelope(SendResultSchema) } }, description: 'Forward sent' },
      ...errorResponses,
    },
  });
  app.openapi(forwardRoute, (c) => {
    const { accountId, messageId } = c.req.valid('param');
    const input = c.req.valid('json');
    return runJson(
      c,
      deps,
      {
        operation: 'forwardMessage',
        capabilities: ['mail.send', 'mail.read'],
        request: { accountId, messageId, input },
        idempotent: true,
        accountId,
        telemetry: { include_attachments: input.includeAttachments !== false },
      },
      async () => ({
        data: await c.get('restService').forward(accountId, { messageId, ...input }),
      }),
    );
  });

  const modifyRoute = createRoute({
    method: 'post',
    path: '/api/v1/accounts/{accountId}/messages/actions',
    operationId: 'modifyMessages',
    summary: 'Modify messages',
    description: 'Apply one mailbox action to a batch of messages.',
    request: {
      params: accountParams,
      body: { required: true, content: { 'application/json': { schema: ModifyRequestSchema } } },
    },
    ...protectedRoute,
    responses: {
      200: {
        content: {
          'application/json': {
            schema: dataEnvelope(z.object({ modified: z.number().int(), action: z.enum(modifyActionNames) }).strict()),
          },
        },
        description: 'Messages modified',
      },
      ...errorResponses,
    },
  });
  app.openapi(modifyRoute, (c) => {
    const { accountId } = c.req.valid('param');
    const input = c.req.valid('json');
    const capability = MODIFY_CAPABILITIES[input.action];
    return runJson(
      c,
      deps,
      {
        operation: 'modifyMessages',
        capabilities: [capability],
        telemetry: { action: input.action },
      },
      async () => {
        await c.get('restService').modify(accountId, input.messageIds, modifyAction(input));
        return { data: { modified: input.messageIds.length, action: input.action } };
      },
    );
  });

  const attachmentRoute = createRoute({
    method: 'get',
    path: '/api/v1/accounts/{accountId}/messages/{messageId}/attachments/{attachmentId}',
    operationId: 'downloadAttachment',
    summary: 'Download an attachment',
    description: 'Download one attachment as raw bytes.',
    request: { params: attachmentParams },
    ...protectedRoute,
    responses: {
      200: {
        content: { 'application/octet-stream': { schema: z.string().openapi({ format: 'binary' }) } },
        description: 'Attachment bytes',
      },
      ...errorResponses,
    },
  });
  app.openapi(attachmentRoute, (c) => {
    const { accountId, messageId, attachmentId } = c.req.valid('param');
    return runAttachment(c, deps, accountId, messageId, attachmentId);
  });

  app.openAPIRegistry.registerComponent('securitySchemes', 'bearerAuth', {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'Fluxmail API key',
  });
  app.doc31('/api/v1/openapi.json', {
    openapi: '3.1.0',
    info: {
      title: 'Fluxmail REST API',
      version: VERSION,
      description: 'Read, draft, send, schedule, and organize email through connected Fluxmail accounts.',
    },
  });

  app.all('/api/v1/*', () =>
    jsonResponse({ error: { code: 'not_found', message: 'No REST route matches this request.' } }, 404),
  );
  app.onError((err) => {
    const malformedJson =
      err instanceof SyntaxError || (err instanceof HTTPException && err.status === 400)
        ? new EmailError('invalid_request', 'Malformed JSON body.')
        : err;
    const failure = apiFailure(malformedJson);
    return jsonResponse(failure.payload, failure.status);
  });

  return app;
}
