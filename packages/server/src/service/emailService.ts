import {
  computeReplyRecipients,
  EmailError,
  formatAddressList,
  forwardSubject,
  isEmailError,
  type Account,
  type AttachmentInput,
  type AttachmentMeta,
  type DraftInput,
  type EmailAddress,
  type EmailQuery,
  type Folder,
  type Message,
  type ModifyAction,
  type Page,
  type PageOpts,
  type SendResult,
  type Thread,
} from '@fluxmail/core';
import type { AccountRegistry } from '../accounts/registry.js';
import { FREE_TIER, type Entitlements } from '../licensing/entitlements.js';

export interface SendInput extends DraftInput {
  /** With replyToMessageId: compute recipients from the original (reply-all semantics). */
  replyAll?: boolean;
}

export interface ForwardInput {
  messageId: string;
  to: EmailAddress[];
  cc?: EmailAddress[];
  /** Optional note placed above the forwarded content. */
  comment?: string;
  includeAttachments?: boolean;
}

export interface ServiceStatus {
  accounts: Array<
    Pick<Account, 'id' | 'provider' | 'email' | 'status'> & {
      error?: { code: string; message: string };
    }
  >;
  entitlements: Entitlements;
  providersAvailable: string[];
}

/**
 * All business logic lives here: account routing, reply/forward computation,
 * entitlement enforcement, auth-failure bookkeeping. MCP tools (and the future
 * REST API / CLI) are thin wrappers over this service.
 */
export class EmailService {
  constructor(
    private readonly registry: AccountRegistry,
    /** Effective plan limits, usually () => getEntitlements(db); defaults to free tier. */
    private readonly entitlements: () => Entitlements = () => FREE_TIER
  ) {}

  /** Route a call to the right provider, recording auth failures on the account. */
  private async withProvider<T>(
    accountId: string | undefined,
    fn: (provider: ReturnType<AccountRegistry['getProvider']>, resolvedId: string, account: Account) => Promise<T>
  ): Promise<T> {
    const resolvedId = this.registry.resolveAccountId(accountId);
    const account = this.registry.getAccount(resolvedId);
    if (account.status === 'disabled') {
      throw new EmailError('invalid_request', `Account ${resolvedId} is disabled`);
    }
    try {
      const result = await fn(this.registry.getProvider(resolvedId), resolvedId, account);
      if (account.status === 'auth_error') this.registry.markStatus(resolvedId, 'active');
      return result;
    } catch (err) {
      if (isEmailError(err) && err.code === 'auth_expired') {
        this.registry.markStatus(resolvedId, 'auth_error');
      }
      throw err;
    }
  }

  listAccounts(): Account[] {
    return this.registry.listAccounts();
  }

  async status(): Promise<ServiceStatus> {
    const accounts = this.registry.listAccounts();
    const errors = new Map<string, { code: string; message: string }>();
    await Promise.all(
      accounts
        .filter((account) => account.status !== 'disabled')
        .map(async (account) => {
          try {
            await this.registry.getProvider(account.id).testConnection();
            if (account.status === 'auth_error') this.registry.markStatus(account.id, 'active');
          } catch (err) {
            if (isEmailError(err) && err.code === 'auth_expired') {
              this.registry.markStatus(account.id, 'auth_error');
            }
            errors.set(
              account.id,
              isEmailError(err)
                ? { code: err.code, message: err.message }
                : { code: 'internal', message: err instanceof Error ? err.message : String(err) }
            );
          }
        })
    );

    return {
      accounts: this.registry
        .listAccounts()
        .map(({ id, provider, email, status }) => ({
          id,
          provider,
          email,
          status,
          ...(errors.has(id) ? { error: errors.get(id)! } : {}),
        })),
      entitlements: this.entitlements(),
      providersAvailable: ['gmail'],
    };
  }

  listFolders(accountId?: string): Promise<Folder[]> {
    return this.withProvider(accountId, (p) => p.listFolders());
  }

  listMessages(accountId: string | undefined, q: EmailQuery, page?: PageOpts): Promise<Page<Message>> {
    return this.withProvider(accountId, (p) => p.listMessages(q, page));
  }

  getMessage(accountId: string | undefined, id: string): Promise<Message> {
    return this.withProvider(accountId, (p) => p.getMessage(id));
  }

  getThread(accountId: string | undefined, threadId: string): Promise<Thread> {
    return this.withProvider(accountId, (p) => p.getThread(threadId));
  }

  createDraft(accountId: string | undefined, d: SendInput): Promise<Message> {
    return this.withProvider(accountId, async (p, _id, account) => {
      return p.createDraft(await this.resolveRecipients(p, account, d));
    });
  }

  updateDraft(accountId: string | undefined, draftId: string, d: SendInput): Promise<Message> {
    return this.withProvider(accountId, async (p, _id, account) => {
      return p.updateDraft(draftId, await this.resolveRecipients(p, account, d));
    });
  }

  deleteDraft(accountId: string | undefined, draftId: string): Promise<void> {
    return this.withProvider(accountId, (p) => p.deleteDraft(draftId));
  }

  send(accountId: string | undefined, input: SendInput | { draftId: string }): Promise<SendResult> {
    return this.withProvider(accountId, async (p, _id, account) => {
      if ('draftId' in input) return p.send({ draftId: input.draftId });
      return p.send(await this.resolveRecipients(p, account, input));
    });
  }

  /**
   * Reply recipient computation (provider-agnostic): when replying without explicit
   * recipients, derive them from the original message: Reply-To/From for a plain
   * reply; plus original To/Cc (minus our own address) for reply-all.
   */
  private async resolveRecipients(
    p: ReturnType<AccountRegistry['getProvider']>,
    account: Account,
    input: SendInput
  ): Promise<DraftInput> {
    const { replyAll, ...draft } = input;
    if (!draft.replyToMessageId || draft.to?.length) return draft;
    const original = await p.getMessage(draft.replyToMessageId);
    const recipients = computeReplyRecipients(original, account.email, replyAll ?? false);
    draft.to = recipients.to;
    if (recipients.cc.length && !draft.cc?.length) draft.cc = recipients.cc;
    return draft;
  }

  forward(accountId: string | undefined, input: ForwardInput): Promise<SendResult> {
    return this.withProvider(accountId, async (p) => {
      const original = await p.getMessage(input.messageId);
      const includeAttachments = input.includeAttachments ?? true;

      const attachments: AttachmentInput[] = [];
      if (includeAttachments) {
        for (const meta of original.attachments ?? []) {
          const { content } = await p.getAttachment(original.id, meta.id);
          attachments.push({
            filename: meta.filename,
            mimeType: meta.mimeType,
            content: content.toString('base64'),
            ...(meta.contentId ? { contentId: meta.contentId } : {}),
            ...(meta.disposition ? { disposition: meta.disposition } : {}),
          });
        }
      }

      const draft: DraftInput = {
        to: input.to,
        ...(input.cc?.length ? { cc: input.cc } : {}),
        subject: forwardSubject(original.subject),
        body: buildForwardBody(original, input.comment),
        ...(attachments.length ? { attachments } : {}),
      };
      return p.send(draft);
    });
  }

  modify(accountId: string | undefined, ids: string[], action: ModifyAction): Promise<void> {
    return this.withProvider(accountId, (p) => p.modify(ids, action));
  }

  getAttachment(
    accountId: string | undefined,
    messageId: string,
    attachmentId: string
  ): Promise<{ meta: AttachmentMeta; content: Buffer }> {
    return this.withProvider(accountId, (p) => p.getAttachment(messageId, attachmentId));
  }
}

export function buildForwardBody(original: Message, comment?: string): { text?: string; html?: string } {
  const headerLines = [
    '---------- Forwarded message ----------',
    `From: ${original.from ? formatAddressList([original.from]) : '(unknown)'}`,
    `Date: ${original.date}`,
    `Subject: ${original.subject}`,
    `To: ${formatAddressList(original.to)}`,
    ...(original.cc?.length ? [`Cc: ${formatAddressList(original.cc)}`] : []),
  ].join('\n');

  const body: { text?: string; html?: string } = {};
  const originalText = original.body?.text;
  const originalHtml = original.body?.html;

  if (originalText !== undefined || originalHtml === undefined) {
    body.text = [comment, headerLines, '', originalText ?? ''].filter((x) => x !== undefined).join('\n\n');
  }
  if (originalHtml !== undefined) {
    const escapedHeader = escapeHtml(headerLines).replace(/\n/g, '<br>');
    body.html =
      (comment ? `<p>${escapeHtml(comment)}</p>` : '') +
      `<p>${escapedHeader}</p><blockquote style="border-left:1px solid #ccc;padding-left:1ex;margin:0 0 0 0.8ex">${originalHtml}</blockquote>`;
  }
  return body;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
