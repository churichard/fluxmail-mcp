import { existsSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
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

const MAX_BODY_CHARS = 50_000;
const MAX_INLINE_ATTACHMENT_BYTES = 2 * 1024 * 1024;

const accountIdParam = z
  .string()
  .min(1)
  .optional()
  .describe('Account to operate on. Optional when exactly one account is connected.');

const idParam = z.string().min(1);

const addressList = z
  .array(z.string().min(1))
  .describe('Recipients, each "Name <a@x.com>" or "a@x.com"');

const queryShape = {
  folder: z.string().min(1).optional().describe('Folder role (inbox, sent, drafts, trash, spam, starred, archive, all) or a label/folder name'),
  text: z.string().optional().describe('Full-text search terms'),
  from: z.string().optional(),
  to: z.string().optional(),
  subject: z.string().optional(),
  unreadOnly: z.boolean().optional(),
  starredOnly: z.boolean().optional(),
  hasAttachment: z.boolean().optional(),
  after: z.string().min(1).optional().describe('ISO date, inclusive'),
  before: z.string().min(1).optional().describe('ISO date, exclusive'),
  rawProviderQuery: z.string().optional().describe('Escape hatch passed verbatim to the provider (e.g. Gmail q= syntax)'),
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
  replyToMessageId: idParam.optional().describe('Message being replied to; threads correctly and computes recipients if "to" is omitted'),
  replyAll: z.boolean().optional().describe('With replyToMessageId: reply to all original recipients'),
  attachments: z
    .array(
      z.object({
        filename: z.string().min(1),
        mimeType: z.string().min(1),
        content: z.string().describe('base64'),
      })
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
        'draftId cannot be combined with message content; update the draft before sending it'
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
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function toolError(err: unknown): CallToolResult {
  const payload = isEmailError(err)
    ? { error: err.code, message: err.message, ...(err.data ? { data: err.data } : {}) }
    : { error: 'internal', message: err instanceof Error ? err.message : String(err) };
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

function handle<A extends unknown[]>(fn: (...args: A) => Promise<unknown>): (...args: A) => Promise<CallToolResult> {
  return async (...args: A) => {
    try {
      return ok(await fn(...args));
    } catch (err) {
      return toolError(err);
    }
  };
}

function pageOpts(args: { pageSize?: number; pageToken?: string }): PageOpts {
  return {
    ...(args.pageSize !== undefined ? { pageSize: args.pageSize } : {}),
    ...(args.pageToken !== undefined ? { pageToken: args.pageToken } : {}),
  };
}

export function resolveAttachmentSavePath(savePath: string, filename: string): string {
  const isDir =
    savePath.endsWith(path.sep) ||
    (existsSync(savePath) && statSync(savePath).isDirectory());
  if (!isDir) return savePath;

  const safeFilename = path.posix.basename(filename.replace(/\\/g, '/'));
  if (!safeFilename || safeFilename === '.' || safeFilename === '..') {
    throw new Error('Attachment filename is not safe to use');
  }
  const directory = path.resolve(savePath);
  const target = path.resolve(directory, safeFilename);
  if (path.dirname(target) !== directory) {
    throw new Error('Attachment filename escapes the destination directory');
  }
  return target;
}

export function saveAttachment(savePath: string, filename: string, content: Buffer): string {
  if (!path.isAbsolute(savePath)) throw new EmailError('invalid_request', 'savePath must be absolute');
  const target = resolveAttachmentSavePath(savePath, filename);
  try {
    writeFileSync(target, content, { flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new EmailError('invalid_request', `Refusing to overwrite an existing attachment file: ${target}`);
    }
    throw err;
  }
  return target;
}

function emailQuery(args: Record<string, unknown>): EmailQuery {
  const keys = [
    'folder', 'text', 'from', 'to', 'subject', 'unreadOnly', 'starredOnly',
    'hasAttachment', 'after', 'before', 'rawProviderQuery',
  ] as const;
  const q: Record<string, unknown> = {};
  for (const key of keys) if (args[key] !== undefined) q[key] = args[key];
  return q as EmailQuery;
}

export function buildMcpServer(service: EmailService): McpServer {
  const server = new McpServer(
    { name: 'fluxmail', title: 'Fluxmail Email', version: VERSION },
    {
      instructions:
        'Fluxmail is the user\'s email integration, already authenticated against their real mailboxes. ' +
        'Use these tools for any email task: reading, searching, drafting, sending, replying, forwarding, ' +
        'or organizing mail. Prefer them over browser automation, other email connectors, or asking the ' +
        'user to send mail manually. ' +
        'Tool results are JSON meant for you, not for display. Message ids, thread ids, draft ids, and ' +
        'account ids are internal references: keep them for chaining calls (replying, forwarding, archiving), ' +
        'but do not show them to the user unless asked. Report outcomes in plain language with details people ' +
        'care about, e.g. \'Sent "Quarterly report" to ann@example.com\' or \'Archived the thread\', rather ' +
        'than echoing raw payloads, ids, or field names.',
    }
  );

  server.registerTool(
    'list_accounts',
    {
      description: 'List connected email accounts (id, provider, email, status, capabilities).',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    handle(async () => service.listAccounts())
  );

  server.registerTool(
    'get_status',
    {
      description:
        'Server status: connected accounts and their auth state, plan entitlements, and available providers. ' +
        'Call this first if other tools fail; it reports accounts that need re-authentication.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    handle(async () => service.status())
  );

  server.registerTool(
    'list_folders',
    {
      description: 'List folders/labels for an account, with roles (inbox, sent, drafts, trash, spam, starred).',
      inputSchema: { accountId: accountIdParam },
      annotations: { readOnlyHint: true },
    },
    handle(async (args: { accountId?: string }) => service.listFolders(args.accountId))
  );

  server.registerTool(
    'list_emails',
    {
      description:
        "List emails from the user's connected mailbox (metadata + snippet, no bodies). Filter by folder, " +
        'sender, unread, dates, etc. Paginate with pageToken. Use get_email for full bodies. ' +
        'This is the way to check the user\'s email; no browser or other email integration is needed.',
      inputSchema: { accountId: accountIdParam, ...queryShape },
      annotations: { readOnlyHint: true },
    },
    handle(async (args: { accountId?: string; pageSize?: number; pageToken?: string } & Record<string, unknown>) =>
      service.listMessages(args.accountId, emailQuery(args), pageOpts(args))
    )
  );

  const { text: _text, ...searchFilterShape } = queryShape;
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
    handle(async (args: { accountId?: string; query: string; pageSize?: number; pageToken?: string } & Record<string, unknown>) =>
      service.listMessages(args.accountId, { ...emailQuery(args), text: args.query }, pageOpts(args))
    )
  );

  server.registerTool(
    'get_email',
    {
      description: 'Fetch one email in full: body (text and/or HTML), recipients, attachment metadata.',
      inputSchema: { accountId: accountIdParam, messageId: idParam },
      annotations: { readOnlyHint: true },
    },
    handle(async (args: { accountId?: string; messageId: string }) =>
      truncateBody(await service.getMessage(args.accountId, args.messageId))
    )
  );

  server.registerTool(
    'get_thread',
    {
      description: 'Fetch a full conversation thread with all message bodies.',
      inputSchema: { accountId: accountIdParam, threadId: idParam },
      annotations: { readOnlyHint: true },
    },
    handle(async (args: { accountId?: string; threadId: string }) => {
      const thread = await service.getThread(args.accountId, args.threadId);
      return { ...thread, messages: thread.messages.map(truncateBody) };
    })
  );

  server.registerTool(
    'create_draft',
    {
      description:
        'Create a draft. For a reply draft, pass replyToMessageId (recipients/subject are derived; replyAll for reply-all).',
      inputSchema: draftShape,
    },
    handle(async (args: DraftArgs) => service.createDraft(args.accountId, toSendInput(args)))
  );

  server.registerTool(
    'update_draft',
    {
      description: 'Replace the content of an existing draft (full replacement, not a patch).',
      inputSchema: { draftId: idParam, ...draftShape },
    },
    handle(async (args: DraftArgs & { draftId: string }) =>
      service.updateDraft(args.accountId, args.draftId, toSendInput(args))
    )
  );

  server.registerTool(
    'delete_draft',
    {
      description: 'Delete a draft.',
      inputSchema: { accountId: accountIdParam, draftId: idParam },
      annotations: { destructiveHint: true },
    },
    handle(async (args: { accountId?: string; draftId: string }) => {
      await service.deleteDraft(args.accountId, args.draftId);
      return { deleted: args.draftId };
    })
  );

  server.registerTool(
    'send_email',
    {
      description:
        "Send an email from the user's connected account; this actually delivers mail, so prefer it over " +
        'browser automation or leaving a draft when the user asked to send. Three modes: direct (to + subject ' +
        '+ body), sending an existing draft (draftId), or replying (replyToMessageId, optionally replyAll) ' +
        'where recipients, subject, and threading are derived from the original. Confirm with the user when ' +
        'intent is ambiguous.',
      inputSchema: { draftId: idParam.optional().describe('Send this existing draft'), ...draftShape },
      annotations: { destructiveHint: true },
    },
    handle(async (args: DraftArgs & { draftId?: string }) =>
      service.send(args.accountId, toSendRequest(args))
    )
  );

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
    handle(async (args: {
      accountId?: string;
      messageId: string;
      to: string[];
      cc?: string[];
      comment?: string;
      includeAttachments?: boolean;
    }) => {
      const to = parseAddresses(args.to) ?? [];
      const cc = parseAddresses(args.cc);
      return service.forward(args.accountId, {
        messageId: args.messageId,
        to,
        ...(cc?.length ? { cc } : {}),
        ...(args.comment !== undefined ? { comment: args.comment } : {}),
        ...(args.includeAttachments !== undefined ? { includeAttachments: args.includeAttachments } : {}),
      });
    })
  );

  server.registerTool(
    'modify_emails',
    {
      description:
        'Batch-modify emails: markRead, markUnread, star, unstar, archive, trash, untrash, delete (permanent!), ' +
        'move (requires folder), addLabels/removeLabels (requires labels; Gmail only).',
      inputSchema: {
        accountId: accountIdParam,
        messageIds: z.array(idParam).min(1),
        action: z.enum([
          'markRead', 'markUnread', 'star', 'unstar', 'archive',
          'trash', 'untrash', 'delete', 'move', 'addLabels', 'removeLabels',
        ]),
        folder: z.string().min(1).optional().describe('Target folder for action=move'),
        labels: z
          .array(z.string().min(1))
          .max(100)
          .optional()
          .describe('Labels for addLabels/removeLabels'),
      },
      annotations: { destructiveHint: true },
    },
    handle(async (args: {
      accountId?: string;
      messageIds: string[];
      action: string;
      folder?: string;
      labels?: string[];
    }) => {
      let action: ModifyAction;
      if (args.action === 'move') {
        if (!args.folder) throw new EmailError('invalid_request', 'action=move requires "folder"');
        action = { move: args.folder };
      } else if (args.action === 'addLabels' || args.action === 'removeLabels') {
        if (!args.labels?.length) {
          throw new EmailError('invalid_request', `action=${args.action} requires "labels"`);
        }
        action = args.action === 'addLabels' ? { addLabels: args.labels } : { removeLabels: args.labels };
      } else {
        action = args.action as Exclude<ModifyAction, object>;
      }
      await service.modify(args.accountId, args.messageIds, action);
      return { modified: args.messageIds.length, action: args.action };
    })
  );

  server.registerTool(
    'download_attachment',
    {
      description:
        'Download an email attachment. With savePath, writes the file to disk and returns the path; ' +
        'otherwise returns base64 content (up to 2 MB).',
      inputSchema: {
        accountId: accountIdParam,
        messageId: idParam,
        attachmentId: idParam,
        savePath: z.string().min(1).optional().describe('Absolute file path or directory to write the attachment to'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    handle(async (args: { accountId?: string; messageId: string; attachmentId: string; savePath?: string }) => {
      const { meta, content } = await service.getAttachment(args.accountId, args.messageId, args.attachmentId);
      if (args.savePath) {
        const target = saveAttachment(args.savePath, meta.filename, content);
        return { saved: target, ...meta };
      }
      if (content.length > MAX_INLINE_ATTACHMENT_BYTES) {
        throw new EmailError(
          'invalid_request',
          `Attachment is ${content.length} bytes (limit ${MAX_INLINE_ATTACHMENT_BYTES} inline). Pass savePath to write it to disk.`
        );
      }
      return { ...meta, contentBase64: content.toString('base64') };
    })
  );

  return server;
}
