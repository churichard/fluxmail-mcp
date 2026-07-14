import { VERSION } from '../version.js';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  EmailError,
  isEmailError,
  parseSingleAddress,
  type EmailAddress,
  type EmailQuery,
  type Message,
  type ModifyAction,
  type PageOpts,
} from '@fluxmail/core';
import type { EmailService, SendInput } from '../service/emailService.js';
import { DEFAULT_MAX_ATTACHMENT_BYTES } from '../config.js';
import {
  FULL_PERMISSION_POLICY,
  hasCapability,
  normalizePermissionPolicy,
  type McpCapability,
  type PermissionPolicy,
} from '../permissions.js';
import type { Telemetry, TelemetryProperties } from '../telemetry.js';

const MAX_BODY_CHARS = 50_000;

const accountIdParam = z
  .string()
  .min(1)
  .optional()
  .describe('Account to operate on. Optional when exactly one account is connected.');

const idParam = z.string().min(1);

const addressList = z.array(z.string().min(1)).describe('Recipients, each "Name <a@x.com>" or "a@x.com"');

const queryShape = {
  folder: z
    .string()
    .min(1)
    .optional()
    .describe('Folder role (inbox, sent, drafts, trash, spam, starred, archive, all) or a label/folder name'),
  text: z.string().optional().describe('Full-text search terms'),
  from: z.string().optional(),
  to: z.string().optional(),
  subject: z.string().optional(),
  unreadOnly: z.boolean().optional(),
  starredOnly: z.boolean().optional(),
  hasAttachment: z.boolean().optional(),
  after: z.string().min(1).optional().describe('ISO date, inclusive'),
  before: z.string().min(1).optional().describe('ISO date, exclusive'),
  rawProviderQuery: z
    .string()
    .optional()
    .describe('Escape hatch passed verbatim to the provider (e.g. Gmail q= syntax)'),
  pageSize: z.number().int().min(1).max(100).optional().describe('Defaults to 25'),
  pageToken: z.string().min(1).optional().describe('nextPageToken from a previous call'),
};

const draftShape = {
  accountId: accountIdParam,
  to: addressList.optional(),
  cc: addressList.optional(),
  bcc: addressList.optional(),
  subject: z.string().optional().describe('Defaults to "Re: ..." when replying'),
  bodyText: z.string().optional().describe('Plain-text body'),
  bodyHtml: z.string().optional().describe('HTML body'),
  replyToMessageId: idParam
    .optional()
    .describe('Message being replied to; threads correctly and computes recipients if "to" is omitted'),
  replyAll: z.boolean().optional().describe('With replyToMessageId: reply to all original recipients'),
  attachments: z
    .array(
      z.object({
        filename: z.string().min(1),
        mimeType: z.string().min(1),
        content: z.string().describe('base64'),
      }),
    )
    .optional(),
};

function parseAddresses(raw: string[] | undefined): EmailAddress[] | undefined {
  if (!raw) return undefined;
  const parsed = raw.map((r) => {
    const addr = parseSingleAddress(r);
    if (!addr) throw new EmailError('invalid_request', `Could not parse email address: "${r}"`);
    return addr;
  });
  return parsed;
}

type DraftArgs = {
  accountId?: string;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  bodyText?: string;
  bodyHtml?: string;
  replyToMessageId?: string;
  replyAll?: boolean;
  attachments?: Array<{ filename: string; mimeType: string; content: string }>;
};

function toSendInput(args: DraftArgs): SendInput {
  if (args.replyAll && !args.replyToMessageId) {
    throw new EmailError('invalid_request', 'replyAll requires replyToMessageId');
  }
  const input: SendInput = {
    body: {
      ...(args.bodyText !== undefined ? { text: args.bodyText } : {}),
      ...(args.bodyHtml !== undefined ? { html: args.bodyHtml } : {}),
    },
  };
  const to = parseAddresses(args.to);
  if (to?.length) input.to = to;
  const cc = parseAddresses(args.cc);
  if (cc?.length) input.cc = cc;
  const bcc = parseAddresses(args.bcc);
  if (bcc?.length) input.bcc = bcc;
  if (args.subject !== undefined) input.subject = args.subject;
  if (args.replyToMessageId) input.replyToMessageId = args.replyToMessageId;
  if (args.replyAll !== undefined) input.replyAll = args.replyAll;
  if (args.attachments?.length) input.attachments = args.attachments;
  return input;
}

export function toSendRequest(args: DraftArgs & { draftId?: string }): SendInput | { draftId: string } {
  if (args.draftId !== undefined) {
    const contentKeys = [
      'to',
      'cc',
      'bcc',
      'subject',
      'bodyText',
      'bodyHtml',
      'replyToMessageId',
      'replyAll',
      'attachments',
    ] as const;
    if (contentKeys.some((key) => args[key] !== undefined)) {
      throw new EmailError(
        'invalid_request',
        'draftId cannot be combined with message content; update the draft before sending it',
      );
    }
    return { draftId: args.draftId };
  }
  return toSendInput(args);
}

function truncateBody(message: Message): Message {
  if (!message.body) return message;
  const body = { ...message.body };
  for (const key of ['text', 'html'] as const) {
    const value = body[key];
    if (value && value.length > MAX_BODY_CHARS) {
      body[key] = value.slice(0, MAX_BODY_CHARS) + `\n… [truncated ${value.length - MAX_BODY_CHARS} characters]`;
    }
  }
  return { ...message, body };
}

function ok(data: unknown): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
  };
}

function toolError(err: unknown): CallToolResult {
  const payload = isEmailError(err)
    ? { error: err.code, message: err.message, ...(err.data ? { data: err.data } : {}) }
    : { error: 'internal', message: err instanceof Error ? err.message : String(err) };
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

export type McpTransport = 'http' | 'stdio' | 'unknown';

export interface BuildMcpServerOptions {
  permissions?: PermissionPolicy;
  maxAttachmentBytes?: number;
  telemetry?: Telemetry;
  transport?: McpTransport;
}

export type McpServerOptions = BuildMcpServerOptions;

function toolFeatureProperties(tool: string, args: unknown): TelemetryProperties {
  if (!args || typeof args !== 'object') return {};
  const input = args as Record<string, unknown>;

  switch (tool) {
    case 'create_draft':
      return { reply: input.replyToMessageId !== undefined, reply_all: input.replyAll === true };
    case 'send_email':
      return {
        mode: input.draftId !== undefined ? 'draft' : input.replyToMessageId !== undefined ? 'reply' : 'direct',
        scheduled: input.sendAt !== undefined,
        reply_all: input.replyAll === true,
      };
    case 'forward_email':
      return { include_attachments: input.includeAttachments !== false };
    case 'modify_emails':
      return typeof input.action === 'string' ? { action: input.action } : {};
    case 'download_attachment':
      return { destination: 'inline' };
    default:
      return {};
  }
}

function captureToolTelemetry(options: BuildMcpServerOptions, properties: TelemetryProperties): void {
  try {
    options.telemetry?.capture('mcp tool called', { ...properties, product_surface: 'mcp' });
  } catch {
    // An injected telemetry client must not affect MCP results.
  }
}

function handleResult<A extends unknown[]>(
  tool: string,
  fn: (...args: A) => Promise<CallToolResult>,
  gate?: () => string | undefined,
  options: BuildMcpServerOptions = {},
): (...args: A) => Promise<CallToolResult> {
  return async (...args: A) => {
    const finishActivity = options.telemetry?.beginActivity?.();
    const startedAt = performance.now();
    try {
      // The gate throws when a lapsed license leaves the instance over quota,
      // and yields a renewal warning to attach while the license is in grace.
      const warning = gate?.();
      const result = await fn(...args);
      if (warning) result.content.push({ type: 'text', text: `Note: ${warning}` });
      captureToolTelemetry(options, {
        tool,
        transport: options.transport ?? 'unknown',
        outcome: 'success',
        duration_ms: Math.round(performance.now() - startedAt),
        ...toolFeatureProperties(tool, args[0]),
      });
      return result;
    } catch (err) {
      captureToolTelemetry(options, {
        tool,
        transport: options.transport ?? 'unknown',
        outcome: 'error',
        error_code: isEmailError(err) ? err.code : 'internal',
        duration_ms: Math.round(performance.now() - startedAt),
        ...toolFeatureProperties(tool, args[0]),
      });
      return toolError(err);
    } finally {
      finishActivity?.();
    }
  };
}

function handle<A extends unknown[]>(
  tool: string,
  fn: (...args: A) => Promise<unknown>,
  gate?: () => string | undefined,
  options: BuildMcpServerOptions = {},
): (...args: A) => Promise<CallToolResult> {
  return handleResult(tool, async (...args: A) => ok(await fn(...args)), gate, options);
}

function pageOpts(args: { pageSize?: number; pageToken?: string }): PageOpts {
  return {
    ...(args.pageSize !== undefined ? { pageSize: args.pageSize } : {}),
    ...(args.pageToken !== undefined ? { pageToken: args.pageToken } : {}),
  };
}

function emailQuery(args: Record<string, unknown>): EmailQuery {
  const keys = [
    'folder',
    'text',
    'from',
    'to',
    'subject',
    'unreadOnly',
    'starredOnly',
    'hasAttachment',
    'after',
    'before',
    'rawProviderQuery',
  ] as const;
  const q: Record<string, unknown> = {};
  for (const key of keys) if (args[key] !== undefined) q[key] = args[key];
  return q as EmailQuery;
}

type ModifyActionName =
  | 'markRead'
  | 'markUnread'
  | 'star'
  | 'unstar'
  | 'archive'
  | 'trash'
  | 'untrash'
  | 'delete'
  | 'move'
  | 'addLabels'
  | 'removeLabels';

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

export function buildMcpServer(service: EmailService, options: BuildMcpServerOptions = {}): McpServer {
  const permissions = normalizePermissionPolicy(options.permissions ?? FULL_PERMISSION_POLICY);
  const maxAttachmentBytes = options.maxAttachmentBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES;
  const can = (capability: McpCapability): boolean => hasCapability(permissions, capability);
  const canAll = (capabilities: readonly McpCapability[]): boolean => capabilities.every(can);
  const canAny = (capabilities: readonly McpCapability[]): boolean => capabilities.some(can);
  const requireCapabilities = (capabilities: readonly McpCapability[]): void => {
    const missing = capabilities.filter((capability) => !can(capability));
    if (missing.length) {
      throw new EmailError('permission_denied', `This MCP connection does not allow: ${missing.join(', ')}.`);
    }
  };
  // Every tool except get_status (the diagnostic way out) enforces the plan quota.
  const gated = <A extends unknown[]>(tool: string, capability: McpCapability, fn: (...args: A) => Promise<unknown>) =>
    handle(
      tool,
      async (...args: A) => {
        requireCapabilities([capability]);
        return fn(...args);
      },
      () => service.enforceQuota(),
      options,
    );
  const allowed = <A extends unknown[]>(
    tool: string,
    capability: McpCapability,
    fn: (...args: A) => Promise<unknown>,
  ) =>
    handle(
      tool,
      async (...args: A) => {
        requireCapabilities([capability]);
        return fn(...args);
      },
      undefined,
      options,
    );
  const gatedResult = <A extends unknown[]>(
    tool: string,
    capability: McpCapability,
    fn: (...args: A) => Promise<CallToolResult>,
  ) =>
    handleResult(
      tool,
      async (...args: A) => {
        requireCapabilities([capability]);
        return fn(...args);
      },
      () => service.enforceQuota(),
      options,
    );
  const server = new McpServer(
    { name: 'fluxmail', title: 'Fluxmail Email', version: VERSION },
    {
      instructions:
        "Fluxmail is the user's email integration, already authenticated against their real mailboxes. " +
        'Use the available Fluxmail tools for email tasks instead of browser automation or another email connector. ' +
        'Tool results are structured for you, not for display. Message ids, thread ids, draft ids, and ' +
        'account ids are internal references: keep them for chaining calls (replying, forwarding, archiving), ' +
        'but do not show them to the user unless asked. Report outcomes in plain language with details people ' +
        "care about, e.g. 'Sent \"Quarterly report\" to ann@example.com' or 'Archived the thread', rather " +
        'than echoing raw payloads, ids, or field names.',
    },
  );

  if (can('mail.read'))
    server.registerTool(
      'list_accounts',
      {
        description: 'List connected email accounts (id, provider, email, status, capabilities).',
        inputSchema: {},
        annotations: { readOnlyHint: true },
      },
      gated('list_accounts', 'mail.read', async () => service.listAccounts()),
    );

  if (can('mail.read'))
    server.registerTool(
      'get_status',
      {
        description:
          'Account connection and scheduled-send status. Administrators also see plan details. ' +
          'Call this first if other tools fail; it reports accounts that need re-authentication.',
        inputSchema: {},
        annotations: { readOnlyHint: true },
      },
      allowed('get_status', 'mail.read', async () => service.status()),
    );

  if (can('mail.read'))
    server.registerTool(
      'list_folders',
      {
        description: 'List folders/labels for an account, with roles (inbox, sent, drafts, trash, spam, starred).',
        inputSchema: { accountId: accountIdParam },
        annotations: { readOnlyHint: true },
      },
      gated('list_folders', 'mail.read', async (args: { accountId?: string }) => service.listFolders(args.accountId)),
    );

  if (can('mail.read'))
    server.registerTool(
      'list_emails',
      {
        description:
          "List emails from the user's connected mailbox (metadata + snippet, no bodies). Filter by folder, " +
          'sender, unread, dates, etc. Paginate with pageToken. Use get_email for full bodies. ' +
          "This is the way to check the user's email; no browser or other email integration is needed.",
        inputSchema: { accountId: accountIdParam, ...queryShape },
        annotations: { readOnlyHint: true },
      },
      gated(
        'list_emails',
        'mail.read',
        async (args: { accountId?: string; pageSize?: number; pageToken?: string } & Record<string, unknown>) =>
          service.listMessages(args.accountId, emailQuery(args), pageOpts(args)),
      ),
    );

  const { text: _text, ...searchFilterShape } = queryShape;
  if (can('mail.read'))
    server.registerTool(
      'search_emails',
      {
        description:
          'Full-text search across an account\'s email. Same filters as list_emails; "query" is the search text.',
        inputSchema: {
          accountId: accountIdParam,
          query: z.string().describe('Search text'),
          ...searchFilterShape,
        },
        annotations: { readOnlyHint: true },
      },
      gated(
        'search_emails',
        'mail.read',
        async (
          args: { accountId?: string; query: string; pageSize?: number; pageToken?: string } & Record<string, unknown>,
        ) => service.listMessages(args.accountId, { ...emailQuery(args), text: args.query }, pageOpts(args)),
      ),
    );

  if (can('mail.read'))
    server.registerTool(
      'get_email',
      {
        description: 'Fetch one email in full: body (text and/or HTML), recipients, attachment metadata.',
        inputSchema: { accountId: accountIdParam, messageId: idParam },
        annotations: { readOnlyHint: true },
      },
      gated('get_email', 'mail.read', async (args: { accountId?: string; messageId: string }) =>
        truncateBody(await service.getMessage(args.accountId, args.messageId)),
      ),
    );

  if (can('mail.read'))
    server.registerTool(
      'get_thread',
      {
        description: 'Fetch a full conversation thread with all message bodies.',
        inputSchema: { accountId: accountIdParam, threadId: idParam },
        annotations: { readOnlyHint: true },
      },
      gated('get_thread', 'mail.read', async (args: { accountId?: string; threadId: string }) => {
        const thread = await service.getThread(args.accountId, args.threadId);
        return { ...thread, messages: thread.messages.map(truncateBody) };
      }),
    );

  if (can('mail.drafts'))
    server.registerTool(
      'create_draft',
      {
        description:
          'Create a draft. For a reply draft, pass replyToMessageId (recipients/subject are derived; replyAll for reply-all).',
        inputSchema: draftShape,
      },
      gated('create_draft', 'mail.drafts', async (args: DraftArgs) => {
        if (args.replyToMessageId) requireCapabilities(['mail.read']);
        return service.createDraft(args.accountId, toSendInput(args));
      }),
    );

  if (can('mail.drafts'))
    server.registerTool(
      'update_draft',
      {
        description: 'Replace the content of an existing draft (full replacement, not a patch).',
        inputSchema: { draftId: idParam, ...draftShape },
      },
      gated('update_draft', 'mail.drafts', async (args: DraftArgs & { draftId: string }) => {
        if (args.replyToMessageId) requireCapabilities(['mail.read']);
        return service.updateDraft(args.accountId, args.draftId, toSendInput(args));
      }),
    );

  if (can('mail.drafts'))
    server.registerTool(
      'delete_draft',
      {
        description: 'Delete a draft.',
        inputSchema: { accountId: accountIdParam, draftId: idParam },
        annotations: { destructiveHint: true },
      },
      gated('delete_draft', 'mail.drafts', async (args: { accountId?: string; draftId: string }) => {
        await service.deleteDraft(args.accountId, args.draftId);
        return { deleted: args.draftId };
      }),
    );

  if (can('mail.send'))
    server.registerTool(
      'send_email',
      {
        description:
          "Send an email from the user's connected account; this actually delivers mail, so prefer it over " +
          'browser automation or leaving a draft when the user asked to send. Three modes: direct (to + subject ' +
          '+ body), sending an existing draft (draftId), or replying (replyToMessageId, optionally replyAll) ' +
          'where recipients, subject, and threading are derived from the original. Confirm with the user when ' +
          'intent is ambiguous. Add sendAt to any mode to schedule instead of sending now.',
        inputSchema: {
          draftId: idParam.optional().describe('Send this existing draft'),
          ...draftShape,
          sendAt: z
            .string()
            .datetime({ offset: true })
            .optional()
            .describe(
              'Schedule delivery instead of sending now: ISO 8601 with timezone offset or Z ' +
                '(e.g. 2026-07-11T09:00:00-07:00). Fluxmail saves the message as a real draft in the mailbox ' +
                'and sends it at this time; the server must be running then (anything missed while it was ' +
                'down goes out at the next startup). Returns a scheduleId for list/cancel.',
            ),
        },
        annotations: { destructiveHint: true },
      },
      handle(
        'send_email',
        async (args: DraftArgs & { draftId?: string; sendAt?: string }) => {
          requireCapabilities(['mail.send']);
          if (args.replyToMessageId !== undefined) requireCapabilities(['mail.read']);
          const { sendAt, ...sendArgs } = args;
          return sendAt !== undefined
            ? service.scheduleSend(args.accountId, toSendRequest(sendArgs), sendAt)
            : service.send(args.accountId, toSendRequest(sendArgs));
        },
        () => service.enforceQuota(),
        options,
      ),
    );

  if (can('mail.read'))
    server.registerTool(
      'list_scheduled_emails',
      {
        description:
          'List scheduled sends: pending ones first (with sendAt), then past ones (sent, failed, canceled). ' +
          'For failed entries, lastError says what went wrong. Pending sends only fire while the ' +
          'Fluxmail server is running.',
        inputSchema: { accountId: accountIdParam },
        annotations: { readOnlyHint: true },
      },
      gated('list_scheduled_emails', 'mail.read', async (args: { accountId?: string }) =>
        service.listScheduled(args.accountId),
      ),
    );

  if (can('mail.drafts'))
    server.registerTool(
      'cancel_scheduled_email',
      {
        description:
          'Cancel a pending scheduled send by scheduleId (from send_email with sendAt, or list_scheduled_emails). ' +
          'The draft stays in the Drafts folder, so the content is not lost.',
        inputSchema: { scheduleId: idParam },
      },
      gated('cancel_scheduled_email', 'mail.drafts', async (args: { scheduleId: string }) =>
        service.cancelScheduled(args.scheduleId),
      ),
    );

  if (canAll(['mail.send', 'mail.read']))
    server.registerTool(
      'forward_email',
      {
        description:
          'Forward an email to new recipients: quoted original body, "Fwd:" subject, original attachments included ' +
          'unless includeAttachments=false. Optional comment appears above the forwarded content.',
        inputSchema: {
          accountId: accountIdParam,
          messageId: idParam,
          to: addressList.min(1),
          cc: addressList.optional(),
          comment: z.string().optional(),
          includeAttachments: z.boolean().optional().describe('Default true'),
        },
        annotations: { destructiveHint: true },
      },
      handle(
        'forward_email',
        async (args: {
          accountId?: string;
          messageId: string;
          to: string[];
          cc?: string[];
          comment?: string;
          includeAttachments?: boolean;
        }) => {
          requireCapabilities(['mail.send', 'mail.read']);
          const to = parseAddresses(args.to) ?? [];
          const cc = parseAddresses(args.cc);
          return service.forward(args.accountId, {
            messageId: args.messageId,
            to,
            ...(cc?.length ? { cc } : {}),
            ...(args.comment !== undefined ? { comment: args.comment } : {}),
            ...(args.includeAttachments !== undefined ? { includeAttachments: args.includeAttachments } : {}),
          });
        },
        () => service.enforceQuota(),
        options,
      ),
    );

  const modifyActions = (Object.keys(MODIFY_CAPABILITIES) as ModifyActionName[]).filter((action) =>
    can(MODIFY_CAPABILITIES[action]),
  );
  if (modifyActions.length) {
    const allowedModifyActions = new Set<ModifyActionName>(modifyActions);
    server.registerTool(
      'modify_emails',
      {
        description:
          'Batch-modify emails using the actions allowed for this connection. Moving requires folder; labels require labels.',
        inputSchema: {
          accountId: accountIdParam,
          messageIds: z.array(idParam).min(1),
          action: z.enum(modifyActions as [ModifyActionName, ...ModifyActionName[]]),
          folder: z.string().min(1).optional().describe('Target folder for action=move'),
          labels: z.array(z.string().min(1)).max(100).optional().describe('Labels for addLabels/removeLabels'),
        },
        annotations: {
          destructiveHint: canAny(['mail.trash', 'mail.delete']),
        },
      },
      handle(
        'modify_emails',
        async (args: {
          accountId?: string;
          messageIds: string[];
          action: ModifyActionName;
          folder?: string;
          labels?: string[];
        }) => {
          if (!allowedModifyActions.has(args.action)) {
            throw new EmailError('permission_denied', `This MCP connection does not allow action=${args.action}.`);
          }
          requireCapabilities([MODIFY_CAPABILITIES[args.action]]);
          let action: ModifyAction;
          if (args.action === 'move') {
            if (!args.folder) throw new EmailError('invalid_request', 'action=move requires "folder"');
            if (PROTECTED_MOVE_DESTINATIONS.has(args.folder.trim().toLowerCase())) {
              throw new EmailError('invalid_request', 'Use the dedicated archive or trash action for this folder');
            }
            action = { move: args.folder };
          } else if (args.action === 'addLabels' || args.action === 'removeLabels') {
            if (!args.labels?.length) {
              throw new EmailError('invalid_request', `action=${args.action} requires "labels"`);
            }
            if (args.labels.some((label) => SYSTEM_LABELS.has(label.trim().toLowerCase()))) {
              throw new EmailError(
                'invalid_request',
                'System labels must be changed with their dedicated message action',
              );
            }
            action = args.action === 'addLabels' ? { addLabels: args.labels } : { removeLabels: args.labels };
          } else {
            action = args.action;
          }
          await service.modify(args.accountId, args.messageIds, action);
          return { modified: args.messageIds.length, action: args.action };
        },
        () => service.enforceQuota(),
        options,
      ),
    );
  }

  if (can('mail.read'))
    server.registerTool(
      'download_attachment',
      {
        description: 'Download an email attachment as an embedded MCP resource.',
        inputSchema: {
          accountId: accountIdParam,
          messageId: idParam,
          attachmentId: idParam,
        },
        annotations: { readOnlyHint: true, destructiveHint: false },
      },
      gatedResult(
        'download_attachment',
        'mail.read',
        async (args: { accountId?: string; messageId: string; attachmentId: string }) => {
          const { meta, content } = await service.getAttachment(
            args.accountId,
            args.messageId,
            args.attachmentId,
            maxAttachmentBytes,
          );
          if (content.length > maxAttachmentBytes) {
            throw new EmailError('invalid_request', 'Attachment is too large to return through MCP.', {
              sizeBytes: content.length,
              maxBytes: maxAttachmentBytes,
            });
          }
          const uri = [
            'fluxmail://attachment',
            encodeURIComponent(args.accountId ?? 'default'),
            encodeURIComponent(args.messageId),
            encodeURIComponent(args.attachmentId),
            encodeURIComponent(meta.filename),
          ].join('/');
          return {
            content: [
              { type: 'text', text: JSON.stringify(meta, null, 2) },
              {
                type: 'resource',
                resource: {
                  uri,
                  mimeType: meta.mimeType || 'application/octet-stream',
                  blob: content.toString('base64'),
                },
              },
            ],
          };
        },
      ),
    );

  return server;
}
