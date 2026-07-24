import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { lookup as lookupMimeType } from 'mime-types';
import {
  EmailError,
  parseEmailSearch,
  parseSingleAddress,
  type AttachmentInput,
  type EmailAddress,
} from '@fluxmail/core';
import type { Command } from 'commander';
import {
  apiErrorCode,
  instanceClient,
  instanceResponseError,
  type ApiEnvelope,
  type InstanceClient,
} from './cliInstances.js';

interface MailCommandOptions {
  selectedInstance: () => string | undefined;
  selectedAccount: () => string | undefined;
  reportError: (error: unknown, code: string) => void;
}

interface AccountSummary {
  id: string;
  email: string;
  provider: string;
  ownerMemberId: string;
  sharedWithAll: boolean;
  grantedMemberIds: string[];
}

interface InputOptions {
  input?: string;
}

interface QueryOptions {
  folder?: string;
  text?: string;
  from?: string;
  to?: string;
  subject?: string;
  read?: boolean;
  starred?: boolean;
  hasAttachment?: boolean;
  after?: string;
  before?: string;
  rawProviderQuery?: string;
  pageSize?: string;
  pageToken?: string;
}

interface MessageContentOptions extends InputOptions {
  to: string[];
  cc: string[];
  bcc: string[];
  subject?: string;
  body?: string;
  bodyFile?: string;
  html?: string;
  htmlFile?: string;
  attach: string[];
  replyTo?: string;
  replyAll?: boolean;
}

interface SendOptions extends MessageContentOptions {
  draft?: string;
  sendAt?: string;
  idempotencyKey?: string;
}

interface ForwardOptions extends InputOptions {
  to: string[];
  cc: string[];
  comment?: string;
  attachments: boolean;
  idempotencyKey?: string;
}

const MODIFY_ACTIONS: Record<string, string> = {
  markRead: 'markRead',
  'mark-read': 'markRead',
  markUnread: 'markUnread',
  'mark-unread': 'markUnread',
  star: 'star',
  unstar: 'unstar',
  archive: 'archive',
  trash: 'trash',
  untrash: 'untrash',
  delete: 'delete',
  move: 'move',
  addLabels: 'addLabels',
  'add-labels': 'addLabels',
  removeLabels: 'removeLabels',
  'remove-labels': 'removeLabels',
};

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function booleanOption(value: string): boolean {
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new EmailError('invalid_request', 'Boolean search options accept true or false.');
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function readSource(source: string): string {
  try {
    return readFileSync(source === '-' ? 0 : source, 'utf8');
  } catch (error) {
    throw new EmailError(
      'invalid_request',
      `Could not read ${source === '-' ? 'stdin' : source}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function readJsonInput(source: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readSource(source));
  } catch (error) {
    if (error instanceof EmailError) throw error;
    throw new EmailError(
      'invalid_request',
      `Could not parse JSON input: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new EmailError('invalid_request', 'JSON input must be an object.');
  }
  return parsed as Record<string, unknown>;
}

function parseAddresses(values: string[]): EmailAddress[] {
  return values.map((value) => {
    const parsed = parseSingleAddress(value);
    if (!parsed) throw new EmailError('invalid_request', `Could not parse email address: "${value}".`);
    return parsed;
  });
}

function readAttachment(filePath: string): AttachmentInput {
  let content: Buffer;
  try {
    content = readFileSync(filePath);
  } catch (error) {
    throw new EmailError(
      'invalid_request',
      `Could not read attachment ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const filename = path.basename(filePath);
  return {
    filename,
    mimeType: lookupMimeType(filename) || 'application/octet-stream',
    content: content.toString('base64'),
  };
}

function hasMessageContentOptions(options: MessageContentOptions): boolean {
  return Boolean(
    options.to.length ||
    options.cc.length ||
    options.bcc.length ||
    options.subject !== undefined ||
    options.body !== undefined ||
    options.bodyFile !== undefined ||
    options.html !== undefined ||
    options.htmlFile !== undefined ||
    options.attach.length ||
    options.replyTo !== undefined ||
    options.replyAll,
  );
}

function messageRequest(options: MessageContentOptions): Record<string, unknown> {
  if (options.input) {
    if (hasMessageContentOptions(options)) {
      throw new EmailError('invalid_request', '--input cannot be combined with message content options.');
    }
    return readJsonInput(options.input);
  }
  if (options.body !== undefined && options.bodyFile !== undefined) {
    throw new EmailError('invalid_request', '--body and --body-file cannot be used together.');
  }
  if (options.html !== undefined && options.htmlFile !== undefined) {
    throw new EmailError('invalid_request', '--html and --html-file cannot be used together.');
  }
  let text = options.body ?? (options.bodyFile ? readSource(options.bodyFile) : undefined);
  const html = options.html ?? (options.htmlFile ? readSource(options.htmlFile) : undefined);
  if (text === undefined && html === undefined && !process.stdin.isTTY) text = readSource('-');
  return {
    ...(options.to.length ? { to: parseAddresses(options.to) } : {}),
    ...(options.cc.length ? { cc: parseAddresses(options.cc) } : {}),
    ...(options.bcc.length ? { bcc: parseAddresses(options.bcc) } : {}),
    ...(options.subject !== undefined ? { subject: options.subject } : {}),
    body: {
      ...(text !== undefined ? { text } : {}),
      ...(html !== undefined ? { html } : {}),
    },
    ...(options.attach.length ? { attachments: options.attach.map(readAttachment) } : {}),
    ...(options.replyTo ? { replyToMessageId: options.replyTo } : {}),
    ...(options.replyAll ? { replyAll: true } : {}),
  };
}

function addMessageContentOptions(command: Command): Command {
  return command
    .option('--to <address>', 'Add a To recipient; repeat as needed', collect, [])
    .option('--cc <address>', 'Add a Cc recipient; repeat as needed', collect, [])
    .option('--bcc <address>', 'Add a Bcc recipient; repeat as needed', collect, [])
    .option('--subject <subject>', 'Set the subject')
    .option('--body <text>', 'Set the plain-text body')
    .option('--body-file <path>', 'Read the plain-text body from a file')
    .option('--html <html>', 'Set the HTML body')
    .option('--html-file <path>', 'Read the HTML body from a file')
    .option('--attach <path>', 'Attach a local file; repeat as needed', collect, [])
    .option('--reply-to <message-id>', 'Reply to a message')
    .option('--reply-all', 'Include the original recipients in the reply')
    .option('--input <file>', 'Read an exact REST JSON body from a file, or pass - for stdin');
}

function addQueryOptions(command: Command, includeText: boolean): Command {
  command
    .option('--folder <folder>', 'Filter by folder ID, role, or name')
    .option('--from <address>', 'Filter by sender')
    .option('--to <address>', 'Filter by recipient')
    .option('--subject <text>', 'Filter by subject')
    .option('--read <boolean>', 'Filter by read state', booleanOption)
    .option('--starred <boolean>', 'Filter by starred state', booleanOption)
    .option('--has-attachment <boolean>', 'Filter by attachment state', booleanOption)
    .option('--after <date>', 'Return messages on or after this YYYY-MM-DD date')
    .option('--before <date>', 'Return messages before this YYYY-MM-DD date')
    .option('--raw-provider-query <query>', 'Pass a provider-native query')
    .option('--page-size <number>', 'Return 1 to 100 messages')
    .option('--page-token <token>', 'Continue from a previous response');
  if (includeText) command.option('--text <query>', 'Filter by literal full-text search');
  return command;
}

function queryString(options: QueryOptions, typedQuery?: string): string {
  const query = new URLSearchParams();
  for (const [key, value] of [
    ['folder', options.folder],
    ['query', typedQuery],
    ['text', options.text],
    ['from', options.from],
    ['to', options.to],
    ['subject', options.subject],
    ['after', options.after],
    ['before', options.before],
    ['rawProviderQuery', options.rawProviderQuery],
    ['pageSize', options.pageSize],
    ['pageToken', options.pageToken],
  ] as const) {
    if (value !== undefined) query.set(key, value);
  }
  if (options.read !== undefined) query.set('read', String(options.read));
  if (options.starred !== undefined) query.set('starred', String(options.starred));
  if (options.hasAttachment !== undefined) query.set('hasAttachment', String(options.hasAttachment));
  return query.size ? `?${query}` : '';
}

async function resolveAccountId(client: InstanceClient, requested?: string): Promise<string> {
  const requestedRef = requested?.trim();
  if (requestedRef && /^acct_[^@\s]+$/.test(requestedRef)) return requestedRef;

  const listed = await client.json<AccountSummary[]>('/api/v1/accounts');
  if (listed.length === 0) {
    throw new EmailError('invalid_request', 'No email accounts are available. Connect an account first.');
  }
  const member = await client.json<{ id: string }>('/api/v1/me');
  const accounts = listed.filter(
    (account) =>
      account.ownerMemberId === member.id || account.sharedWithAll || account.grantedMemberIds.includes(member.id),
  );
  if (requestedRef) {
    const normalized = requestedRef.toLowerCase();
    const account = accounts.find(
      (candidate) => candidate.id === requestedRef || candidate.email.toLowerCase() === normalized,
    );
    if (!account) throw new EmailError('not_found', `No accessible account has id or email "${requestedRef}".`);
    return account.id;
  }
  if (accounts.length === 0) {
    throw new EmailError('invalid_request', 'No email accounts are accessible to this member.');
  }
  if (accounts.length > 1) {
    throw new EmailError(
      'invalid_request',
      `Multiple accounts are available. Pass --mail-account or -a with one of: ${accounts
        .map((account) => `${account.id} (${account.email})`)
        .join(', ')}.`,
    );
  }
  return accounts[0]!.id;
}

async function responseError(response: Response): Promise<never> {
  let error: { code?: string; message?: string; data?: Record<string, unknown> } | undefined;
  try {
    const body = (await response.json()) as {
      error?: { code?: string; message?: string; data?: Record<string, unknown> };
    };
    error = body.error;
  } catch {
    // The fallback below does not expose response content.
  }
  throw instanceResponseError(
    error?.code ?? 'request_failed',
    error?.message ?? `Request failed with HTTP ${response.status}.`,
    response.status,
    error?.data,
  );
}

function jsonRequest(body: Record<string, unknown>, headers: Record<string, string> = {}): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  };
}

export function registerMailCommands(program: Command, options: MailCommandOptions): void {
  const run =
    (fn: () => Promise<void>): (() => Promise<void>) =>
    async () => {
      try {
        await fn();
      } catch (error) {
        options.reportError(error, apiErrorCode(error));
      }
    };
  const accountContext = async (): Promise<{ client: InstanceClient; accountId: string }> => {
    const client = instanceClient(options.selectedInstance());
    const accountId = await resolveAccountId(client, options.selectedAccount());
    return { client, accountId };
  };
  const printEnvelope = async <T>(request: Promise<ApiEnvelope<T>>): Promise<void> => printJson(await request);

  const folders = program.command('folders').description('Work with navigable mailbox folders');
  folders
    .command('list')
    .description('List folders in an email account')
    .action(
      run(async () => {
        const { client, accountId } = await accountContext();
        await printEnvelope(client.jsonEnvelope(`/api/v1/accounts/${encodeURIComponent(accountId)}/folders`));
      }),
    );

  const labels = program.command('labels').description('Work with Gmail labels and Outlook categories');
  labels
    .command('list')
    .description('List Gmail user labels or Outlook categories')
    .action(
      run(async () => {
        const { client, accountId } = await accountContext();
        await printEnvelope(client.jsonEnvelope(`/api/v1/accounts/${encodeURIComponent(accountId)}/labels`));
      }),
    );

  const emails = program.command('emails').description('Read, send, and organize email');
  const listEmails = addQueryOptions(emails.command('list').description('List and filter messages'), true);
  listEmails.action(async (query: QueryOptions) =>
    run(async () => {
      const { client, accountId } = await accountContext();
      await printEnvelope(
        client.jsonEnvelope(`/api/v1/accounts/${encodeURIComponent(accountId)}/messages${queryString(query)}`),
      );
    })(),
  );

  const search = addQueryOptions(
    emails.command('search').argument('<query>', 'Typed portable search query').description('Search messages'),
    false,
  ).allowUnknownOption();
  search.action(async (query: string, queryOptions: QueryOptions) =>
    run(async () => {
      const parsed = parseEmailSearch(query);
      if (!parsed.valid) {
        throw new EmailError('invalid_request', parsed.diagnostics.map((item) => item.message).join(' '), {
          diagnostics: parsed.diagnostics,
        });
      }
      for (const warning of parsed.diagnostics.filter((item) => item.severity === 'warning')) {
        console.error(`Search warning: ${warning.message}`);
      }
      const { client, accountId } = await accountContext();
      await printEnvelope(
        client.jsonEnvelope(
          `/api/v1/accounts/${encodeURIComponent(accountId)}/messages${queryString(queryOptions, query)}`,
        ),
      );
    })(),
  );

  emails
    .command('get')
    .argument('<message-id>', 'Provider message ID')
    .description('Get a complete message')
    .action(async (messageId: string) =>
      run(async () => {
        const { client, accountId } = await accountContext();
        await printEnvelope(
          client.jsonEnvelope(
            `/api/v1/accounts/${encodeURIComponent(accountId)}/messages/${encodeURIComponent(messageId)}`,
          ),
        );
      })(),
    );

  const send = addMessageContentOptions(emails.command('send').description('Send or schedule a message'))
    .option('--draft <draft-id>', 'Send an existing draft')
    .option('--send-at <timestamp>', 'Schedule delivery at an ISO timestamp')
    .option('--idempotency-key <key>', 'Reuse a delivery request safely');
  send.action(async (sendOptions: SendOptions) =>
    run(async () => {
      let request: Record<string, unknown>;
      if (sendOptions.input) {
        if (sendOptions.draft || sendOptions.sendAt || hasMessageContentOptions(sendOptions)) {
          throw new EmailError(
            'invalid_request',
            '--input cannot be combined with draft, scheduling, or message content options.',
          );
        }
        request = readJsonInput(sendOptions.input);
      } else if (sendOptions.draft) {
        if (hasMessageContentOptions(sendOptions)) {
          throw new EmailError('invalid_request', '--draft cannot be combined with message content options.');
        }
        request = { draftId: sendOptions.draft, ...(sendOptions.sendAt ? { sendAt: sendOptions.sendAt } : {}) };
      } else {
        request = {
          ...messageRequest(sendOptions),
          ...(sendOptions.sendAt ? { sendAt: sendOptions.sendAt } : {}),
        };
      }
      const { client, accountId } = await accountContext();
      await printEnvelope(
        client.jsonEnvelope(
          `/api/v1/accounts/${encodeURIComponent(accountId)}/send`,
          jsonRequest(request, { 'idempotency-key': sendOptions.idempotencyKey ?? randomUUID() }),
        ),
      );
    })(),
  );

  const forward = emails
    .command('forward')
    .argument('<message-id>', 'Provider message ID')
    .description('Forward a message')
    .option('--to <address>', 'Add a To recipient; repeat as needed', collect, [])
    .option('--cc <address>', 'Add a Cc recipient; repeat as needed', collect, [])
    .option('--comment <text>', 'Add a comment above the forwarded message')
    .option('--no-attachments', 'Do not include attachments from the original message')
    .option('--idempotency-key <key>', 'Reuse a delivery request safely')
    .option('--input <file>', 'Read an exact REST JSON body from a file, or pass - for stdin');
  forward.action(async (messageId: string, forwardOptions: ForwardOptions) =>
    run(async () => {
      let request: Record<string, unknown>;
      if (forwardOptions.input) {
        if (
          forwardOptions.to.length ||
          forwardOptions.cc.length ||
          forwardOptions.comment !== undefined ||
          forwardOptions.attachments === false
        ) {
          throw new EmailError('invalid_request', '--input cannot be combined with forwarding options.');
        }
        request = readJsonInput(forwardOptions.input);
      } else {
        request = {
          to: parseAddresses(forwardOptions.to),
          ...(forwardOptions.cc.length ? { cc: parseAddresses(forwardOptions.cc) } : {}),
          ...(forwardOptions.comment !== undefined ? { comment: forwardOptions.comment } : {}),
          includeAttachments: forwardOptions.attachments,
        };
      }
      const { client, accountId } = await accountContext();
      await printEnvelope(
        client.jsonEnvelope(
          `/api/v1/accounts/${encodeURIComponent(accountId)}/messages/${encodeURIComponent(messageId)}/forward`,
          jsonRequest(request, { 'idempotency-key': forwardOptions.idempotencyKey ?? randomUUID() }),
        ),
      );
    })(),
  );

  const modify = emails
    .command('modify')
    .argument('[action]', 'Message action, such as mark-read, archive, move, or add-labels')
    .argument('[message-ids...]', 'Provider message IDs')
    .description('Apply one action to one or more messages')
    .option('--folder <folder>', 'Destination folder for move')
    .option('--label <label>', 'Label or Outlook category; repeat as needed', collect, [])
    .option('--input <file>', 'Read an exact REST JSON body from a file, or pass - for stdin');
  modify.action(
    async (
      action: string | undefined,
      messageIds: string[],
      modifyOptions: { folder?: string; label: string[]; input?: string },
    ) =>
      run(async () => {
        let request: Record<string, unknown>;
        if (modifyOptions.input) {
          if (action || messageIds.length || modifyOptions.folder || modifyOptions.label.length) {
            throw new EmailError('invalid_request', '--input cannot be combined with action, message IDs, or options.');
          }
          request = readJsonInput(modifyOptions.input);
        } else {
          if (!action || !messageIds.length) {
            throw new EmailError('invalid_request', 'Pass an action and at least one message ID.');
          }
          const normalizedAction = MODIFY_ACTIONS[action];
          if (!normalizedAction) {
            throw new EmailError('invalid_request', `Unknown message action "${action}".`);
          }
          request = {
            messageIds,
            action: normalizedAction,
            ...(modifyOptions.folder ? { folder: modifyOptions.folder } : {}),
            ...(modifyOptions.label.length ? { labels: modifyOptions.label } : {}),
          };
        }
        const { client, accountId } = await accountContext();
        await printEnvelope(
          client.jsonEnvelope(
            `/api/v1/accounts/${encodeURIComponent(accountId)}/messages/actions`,
            jsonRequest(request),
          ),
        );
      })(),
  );

  const threads = program.command('threads').description('Read email threads');
  threads
    .command('get')
    .argument('<thread-id>', 'Provider thread ID')
    .description('Get a complete thread')
    .action(async (threadId: string) =>
      run(async () => {
        const { client, accountId } = await accountContext();
        await printEnvelope(
          client.jsonEnvelope(
            `/api/v1/accounts/${encodeURIComponent(accountId)}/threads/${encodeURIComponent(threadId)}`,
          ),
        );
      })(),
    );

  const drafts = program.command('drafts').description('Create and manage drafts');
  const createDraft = addMessageContentOptions(drafts.command('create').description('Create a draft'));
  createDraft.action(async (draftOptions: MessageContentOptions) =>
    run(async () => {
      const request = messageRequest(draftOptions);
      const { client, accountId } = await accountContext();
      await printEnvelope(
        client.jsonEnvelope(`/api/v1/accounts/${encodeURIComponent(accountId)}/drafts`, jsonRequest(request)),
      );
    })(),
  );
  const updateDraft = addMessageContentOptions(
    drafts.command('update').argument('<draft-id>', 'Provider draft ID').description('Replace the content of a draft'),
  );
  updateDraft.action(async (draftId: string, draftOptions: MessageContentOptions) =>
    run(async () => {
      const request = messageRequest(draftOptions);
      const { client, accountId } = await accountContext();
      await printEnvelope(
        client.jsonEnvelope(`/api/v1/accounts/${encodeURIComponent(accountId)}/drafts/${encodeURIComponent(draftId)}`, {
          ...jsonRequest(request),
          method: 'PUT',
        }),
      );
    })(),
  );
  drafts
    .command('delete')
    .argument('<draft-id>', 'Provider draft ID')
    .description('Delete a draft')
    .action(async (draftId: string) =>
      run(async () => {
        const { client, accountId } = await accountContext();
        await printEnvelope(
          client.jsonEnvelope(
            `/api/v1/accounts/${encodeURIComponent(accountId)}/drafts/${encodeURIComponent(draftId)}`,
            { method: 'DELETE' },
          ),
        );
      })(),
    );

  const scheduled = program.command('scheduled').description('Manage scheduled sends');
  scheduled
    .command('list')
    .description('List scheduled sends')
    .action(
      run(async () => {
        const { client, accountId } = await accountContext();
        await printEnvelope(client.jsonEnvelope(`/api/v1/accounts/${encodeURIComponent(accountId)}/scheduled-sends`));
      }),
    );
  scheduled
    .command('cancel')
    .argument('<schedule-id>', 'Scheduled send ID')
    .description('Cancel a scheduled send and keep its draft')
    .action(async (scheduleId: string) =>
      run(async () => {
        const { client, accountId } = await accountContext();
        await printEnvelope(
          client.jsonEnvelope(
            `/api/v1/accounts/${encodeURIComponent(accountId)}/scheduled-sends/${encodeURIComponent(scheduleId)}`,
            { method: 'DELETE' },
          ),
        );
      })(),
    );

  const attachments = program.command('attachments').description('Download message attachments');
  attachments
    .command('download')
    .argument('<message-id>', 'Provider message ID')
    .argument('<attachment-id>', 'Provider attachment ID')
    .requiredOption('--output <path>', 'Write the attachment to this path')
    .option('--force', 'Overwrite an existing file')
    .description('Download an attachment')
    .action(async (messageId: string, attachmentId: string, downloadOptions: { output: string; force?: boolean }) =>
      run(async () => {
        const outputPath = path.resolve(downloadOptions.output);
        if (!downloadOptions.force && existsSync(outputPath)) {
          throw new EmailError('invalid_request', `Output file already exists: ${outputPath}`);
        }
        const { client, accountId } = await accountContext();
        const response = await client.request(
          `/api/v1/accounts/${encodeURIComponent(accountId)}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
        );
        if (!response.ok) await responseError(response);
        const content = Buffer.from(await response.arrayBuffer());
        try {
          writeFileSync(outputPath, content, { flag: downloadOptions.force ? 'w' : 'wx' });
        } catch (error) {
          throw new EmailError(
            'invalid_request',
            `Could not write attachment to ${outputPath}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        const warning = response.headers.get('fluxmail-warning');
        printJson({
          data: {
            output: outputPath,
            mimeType: response.headers.get('content-type') ?? 'application/octet-stream',
            sizeBytes: content.length,
          },
          ...(warning ? { warnings: [warning] } : {}),
        });
      })(),
    );
}
