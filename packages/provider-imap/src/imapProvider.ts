import { createHash, randomBytes } from 'node:crypto';
import {
  ImapFlow,
  type FetchMessageObject,
  type ImapFlowOptions,
  type MessageEnvelopeObject,
  type MessageStructureObject,
} from 'imapflow';
import nodemailer, { type Transporter } from 'nodemailer';
import PostalMime, { type Address as PostalAddress } from 'postal-mime';
import {
  EmailError,
  replySubject,
  type AttachmentMeta,
  type Capabilities,
  type DraftInput,
  type EmailAddress,
  type EmailProvider,
  type EmailQuery,
  type Folder,
  type FolderRole,
  type GetMessageOpts,
  type Message,
  type ModifyAction,
  type Page,
  type PageOpts,
  type SendResult,
  type Thread,
} from '@fluxmail/core';
import { downloadBody, inspectStructure } from './body.js';
import { mapImapError } from './errors.js';
import { resolveFolders, type ResolvedFolders } from './folders.js';
import { composeMessage, stripBccHeader, type ThreadingHeaders } from './mime.js';
import { toImapSearch } from './query.js';
import type { FolderWarning, ImapCredentials, ImapMessageLocation, ImapStateStore } from './types.js';

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;
export const POSTAL_OPTIONS = { maxNestingDepth: 100, maxHeadersSize: 2 * 1024 * 1024 } as const;
const HEADER_NAMES = ['Message-ID', 'References', 'In-Reply-To'];

function findStructurePart(
  structure: MessageStructureObject | undefined,
  partId: string,
): MessageStructureObject | undefined {
  if (!structure) return undefined;
  const visit = (node: MessageStructureObject): MessageStructureObject | undefined => {
    const part = node.part ?? (node === structure && !node.childNodes?.length ? '1' : undefined);
    if (part === partId) return node;
    for (const child of node.childNodes ?? []) {
      const found = visit(child);
      if (found) return found;
    }
    return undefined;
  };
  return visit(structure);
}

function bodyStructureSizeIsDecoded(node: MessageStructureObject | undefined): boolean {
  const encoding = node?.encoding?.toLowerCase();
  return encoding === '7bit' || encoding === '8bit' || encoding === 'binary';
}

export const IMAP_CAPABILITIES: Capabilities = {
  labels: false,
  serverThreads: false,
  serverSearch: 'basic',
  snippets: false,
};

export interface ImapProviderOptions {
  accountId: string;
  email: string;
  displayName?: string;
  credentials: ImapCredentials;
  store: ImapStateStore;
  imapFactory?: (options: ImapFlowOptions) => ImapFlow;
  smtpFactory?: (credentials: ImapCredentials['smtp']) => Transporter;
}

interface ParsedHeaders {
  messageId?: string;
  inReplyTo?: string;
  references: string[];
  selected?: Record<string, string>;
}

interface Cursor {
  v: 2;
  hash: string;
  folder: number;
  upperUid?: number;
}

function parseHeaders(raw: Buffer | undefined, includeSelected = false): ParsedHeaders {
  const unfolded = (raw?.toString('utf8') ?? '').replace(/\r?\n[ \t]+/g, ' ');
  const selected: Record<string, string> = {};
  for (const line of unfolded.split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator < 1) continue;
    const name = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (includeSelected) selected[name] = value;
  }
  const get = (name: string) => {
    const match = Object.entries(selected).find(([key]) => key.toLowerCase() === name.toLowerCase());
    if (match) return match[1];
    const regex = new RegExp(`^${name}:\\s*(.*)$`, 'im');
    return unfolded.match(regex)?.[1]?.trim();
  };
  return {
    ...(get('Message-ID') ? { messageId: get('Message-ID') } : {}),
    ...(get('In-Reply-To') ? { inReplyTo: get('In-Reply-To') } : {}),
    references: get('References')?.match(/<[^>]+>/g) ?? [],
    ...(includeSelected ? { selected } : {}),
  };
}

function threadId(headers: ParsedHeaders, fallback: string): string {
  const root = headers.references[0] ?? headers.inReplyTo ?? headers.messageId ?? fallback;
  return `ith_${createHash('sha256').update(root.toLowerCase()).digest('hex').slice(0, 24)}`;
}

function locationId(prefix: 'im' | 'draft', accountId: string, path: string, uidValidity: string, uid: number): string {
  const value = `${accountId}\0${path}\0${uidValidity}\0${uid}`;
  return `${prefix}_${createHash('sha256').update(value).digest('base64url').slice(0, 18)}`;
}

function addresses(values: MessageEnvelopeObject['from']): EmailAddress[] {
  return (values ?? []).flatMap((value) =>
    value.address ? [{ ...(value.name ? { name: value.name } : {}), email: value.address }] : [],
  );
}

function postalAddresses(values: PostalAddress[] | PostalAddress | undefined): EmailAddress[] {
  return (Array.isArray(values) ? values : values ? [values] : []).flatMap((value) => {
    if ('group' in value && value.group) {
      return value.group.map((entry) => ({ ...(entry.name ? { name: entry.name } : {}), email: entry.address }));
    }
    return value.address ? [{ ...(value.name ? { name: value.name } : {}), email: value.address }] : [];
  });
}

function cursorHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

function decodeCursor(value: string | undefined, hash: string): Cursor {
  if (!value) return { v: 2, hash, folder: 0 };
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Cursor;
    if (
      parsed.v !== 2 ||
      parsed.hash !== hash ||
      !Number.isInteger(parsed.folder) ||
      parsed.folder < 0 ||
      (parsed.upperUid !== undefined && (!Number.isInteger(parsed.upperUid) || parsed.upperUid < 1))
    ) {
      throw new Error();
    }
    return parsed;
  } catch {
    throw new EmailError('invalid_request', 'Invalid or expired IMAP page token');
  }
}

function recipients(input: DraftInput): string[] {
  return [...(input.to ?? []), ...(input.cc ?? []), ...(input.bcc ?? [])].map((value) => value.email);
}

function isoDate(value: Date | string | undefined): string {
  const parsed = new Date(value ?? Date.now());
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

export function smtpTransportOptions(config: ImapCredentials['smtp']) {
  return {
    host: config.host,
    port: config.port,
    secure: config.security === 'tls',
    requireTLS: config.security === 'starttls',
    auth: { user: config.user, pass: config.password },
  };
}

export class ImapProvider implements EmailProvider {
  readonly capabilities = IMAP_CAPABILITIES;
  private imap?: ImapFlow;
  private imapConnection?: Promise<ImapFlow>;
  private smtp?: Transporter;
  private resolved?: ResolvedFolders;

  constructor(private readonly options: ImapProviderOptions) {}

  async close(): Promise<void> {
    const imap = this.imap ?? (await this.imapConnection?.catch(() => undefined));
    this.imap = undefined;
    this.imapConnection = undefined;
    if (imap?.usable) {
      try {
        await imap.logout();
      } catch {
        imap.close();
      }
    }
    this.smtp?.close();
    this.smtp = undefined;
  }

  private imapOptions(): ImapFlowOptions {
    const config = this.options.credentials.imap;
    return {
      host: config.host,
      port: config.port,
      secure: config.security === 'tls',
      ...(config.security === 'starttls' ? { doSTARTTLS: true } : {}),
      auth: { user: config.user, pass: config.password },
      logger: false,
      clientInfo: { name: 'Fluxmail' },
    };
  }

  private buildSmtp(): Transporter {
    if (this.options.smtpFactory) return this.options.smtpFactory(this.options.credentials.smtp);
    return nodemailer.createTransport(smtpTransportOptions(this.options.credentials.smtp));
  }

  private async client(): Promise<ImapFlow> {
    if (this.imap?.usable) return this.imap;
    if (!this.imapConnection) {
      const client = this.options.imapFactory?.(this.imapOptions()) ?? new ImapFlow(this.imapOptions());
      client.on('error', () => {});
      this.imapConnection = (async () => {
        try {
          await client.connect();
          this.imap = client;
          return client;
        } catch (error) {
          client.close();
          throw mapImapError(error);
        } finally {
          this.imapConnection = undefined;
        }
      })();
    }
    return this.imapConnection;
  }

  private async refreshFolders(): Promise<ResolvedFolders> {
    try {
      const client = await this.client();
      const listing = await client.list({ statusQuery: { unseen: true } });
      this.resolved = resolveFolders(listing, this.options.credentials.folderOverrides);
      return this.resolved;
    } catch (error) {
      throw mapImapError(error);
    }
  }

  async getFolderWarnings(): Promise<FolderWarning[]> {
    return (await this.refreshFolders()).warnings;
  }

  async testConnection(): Promise<void> {
    await this.refreshFolders();
    try {
      this.smtp ??= this.buildSmtp();
      await this.smtp.verify();
    } catch (error) {
      throw mapImapError(error);
    }
  }

  async listFolders(): Promise<Folder[]> {
    return (await this.refreshFolders()).folders;
  }

  private rolePath(role: FolderRole, folders: ResolvedFolders): string | undefined {
    return folders.paths[role];
  }

  private requireRole(role: 'drafts' | 'sent' | 'trash' | 'archive'): string {
    const path = this.resolved?.paths[role];
    if (path) return path;
    throw new EmailError(
      'unsupported_capability',
      `This account has no resolved ${role} folder. Run "fluxmail accounts configure ${this.options.accountId} --${role}-folder <path>".`,
    );
  }

  private async withMailbox<T>(path: string, fn: (client: ImapFlow, uidValidity: string) => Promise<T>): Promise<T> {
    const client = await this.client();
    let lock;
    try {
      lock = await client.getMailboxLock(path);
      const uidValidity = client.mailbox && client.mailbox.uidValidity.toString();
      if (!uidValidity) throw new EmailError('provider_unavailable', `Mailbox ${path} has no UIDVALIDITY`);
      await this.options.store.invalidateMailbox(path, uidValidity);
      return await fn(client, uidValidity);
    } catch (error) {
      throw mapImapError(error);
    } finally {
      lock?.release();
    }
  }

  private async toMessage(
    client: ImapFlow,
    path: string,
    uidValidity: string,
    fetched: FetchMessageObject,
    options: { body?: boolean; includeHeaders?: boolean; draftId?: string; threadId?: string } = {},
  ): Promise<Message> {
    const envelope = fetched.envelope ?? {};
    const parsed = parseHeaders(fetched.headers, options.includeHeaders);
    const existing = await this.options.store.findByLocation(path, uidValidity, fetched.uid);
    const role = this.resolved?.folders.find((folder) => folder.id === path)?.role;
    const resolvedDraftId =
      options.draftId ??
      existing?.draftId ??
      (role === 'drafts' ? locationId('draft', this.options.accountId, path, uidValidity, fetched.uid) : undefined);
    const fallback = `${path}:${uidValidity}:${fetched.uid}`;
    const location: ImapMessageLocation = {
      id: existing?.id ?? locationId('im', this.options.accountId, path, uidValidity, fetched.uid),
      accountId: this.options.accountId,
      mailboxPath: path,
      uidValidity,
      uid: fetched.uid,
      ...((parsed.messageId ?? envelope.messageId) ? { messageId: parsed.messageId ?? envelope.messageId } : {}),
      ...((parsed.inReplyTo ?? envelope.inReplyTo) ? { inReplyTo: parsed.inReplyTo ?? envelope.inReplyTo } : {}),
      ...(parsed.references.length ? { references: parsed.references } : {}),
      threadId: options.threadId ?? threadId(parsed, fallback),
      ...(resolvedDraftId ? { draftId: resolvedDraftId } : {}),
      subject: envelope.subject ?? '',
      date: isoDate(envelope.date ?? fetched.internalDate),
    };
    await this.options.store.save(location);
    const flags = fetched.flags ?? new Set<string>();
    const parts = inspectStructure(fetched.bodyStructure);
    const message: Message = {
      id: location.id,
      threadId: location.threadId,
      accountId: this.options.accountId,
      ...(location.draftId ? { draftId: location.draftId } : {}),
      folder: { id: path, name: path, ...(role ? { role } : {}) },
      ...(addresses(envelope.from)[0] ? { from: addresses(envelope.from)[0] } : {}),
      to: addresses(envelope.to),
      ...(addresses(envelope.cc).length ? { cc: addresses(envelope.cc) } : {}),
      ...(addresses(envelope.bcc).length ? { bcc: addresses(envelope.bcc) } : {}),
      ...(addresses(envelope.replyTo).length ? { replyTo: addresses(envelope.replyTo) } : {}),
      subject: envelope.subject ?? '',
      date: location.date ?? new Date().toISOString(),
      flags: { read: flags.has('\\Seen'), starred: flags.has('\\Flagged'), draft: flags.has('\\Draft') },
      ...(fetched.bodyStructure ? { attachments: parts.attachments } : {}),
      ...(options.includeHeaders && parsed.selected ? { headers: parsed.selected } : {}),
    };
    if (options.body) {
      if (fetched.bodyStructure) {
        message.body = await downloadBody(client, fetched.uid, parts);
      } else if (fetched.source) {
        const parsedSource = await PostalMime.parse(fetched.source, POSTAL_OPTIONS);
        message.body = {
          ...(parsedSource.text !== undefined ? { text: parsedSource.text } : {}),
          ...(parsedSource.html !== undefined ? { html: parsedSource.html } : {}),
        };
        message.attachments = parsedSource.attachments.map((attachment, index) => ({
          id: `raw-${index}`,
          filename: attachment.filename ?? 'attachment',
          mimeType: attachment.mimeType,
          sizeBytes:
            typeof attachment.content === 'string'
              ? Buffer.byteLength(attachment.content)
              : attachment.content.byteLength,
          ...(attachment.contentId ? { contentId: attachment.contentId.replace(/^<|>$/g, '') } : {}),
          ...(attachment.disposition ? { disposition: attachment.disposition } : {}),
        }));
      } else {
        message.body = {};
      }
    }
    return message;
  }

  async listMessages(query: EmailQuery, page?: PageOpts): Promise<Page<Message>> {
    const folders = await this.refreshFolders();
    const explicit = query.folder;
    let paths: string[];
    if (explicit) {
      const rolePath = this.rolePath(explicit as FolderRole, folders);
      const exact = folders.selectablePaths.find((path) => path === explicit);
      if (!rolePath && !exact && (explicit === 'starred' || explicit === 'all'))
        paths = folders.selectablePaths.filter((p) => p !== folders.paths.all);
      else if (!rolePath && !exact) throw new EmailError('not_found', `No folder named "${explicit}"`);
      else paths = [rolePath ?? exact!];
    } else {
      paths = folders.selectablePaths.filter((path) => path !== folders.paths.all);
    }
    const normalizedQuery = { ...query, ...(explicit === 'starred' ? { starredOnly: true } : {}), folder: undefined };
    const hash = cursorHash({ query: { ...normalizedQuery, ...(explicit ? { folder: explicit } : {}) }, paths });
    const cursor = decodeCursor(page?.pageToken, hash);
    const pageSize = Math.min(Math.max(page?.pageSize ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
    const items: Message[] = [];
    let folderIndex = cursor.folder;
    let upperUid = cursor.upperUid;
    let nextCursor: Cursor | undefined;

    searchFolders: for (; folderIndex < paths.length; folderIndex++, upperUid = undefined) {
      const path = paths[folderIndex]!;
      await this.withMailbox(path, async (client, uidValidity) => {
        const found = await client.search(toImapSearch(normalizedQuery, client.capabilities.has('X-GM-EXT-1')), {
          uid: true,
        });
        const uids = (found || []).sort((a, b) => b - a).filter((uid) => upperUid === undefined || uid <= upperUid);
        for (const uid of uids) {
          const fetched = await client.fetchOne(
            uid,
            { envelope: true, flags: true, internalDate: true, bodyStructure: true, headers: HEADER_NAMES },
            { uid: true },
          );
          if (!fetched) continue;
          if (query.hasAttachment && !inspectStructure(fetched.bodyStructure).attachments.length) continue;
          if (items.length === pageSize) {
            nextCursor = { v: 2, hash, folder: folderIndex, upperUid: uid };
            return;
          }
          items.push(await this.toMessage(client, path, uidValidity, fetched));
        }
      });
      if (nextCursor) break searchFolders;
    }

    const out: Page<Message> = { items };
    if (nextCursor) out.nextPageToken = encodeCursor(nextCursor);
    return out;
  }

  private async fetchLocation(location: ImapMessageLocation, body: boolean, includeHeaders = false): Promise<Message> {
    return this.withMailbox(location.mailboxPath, async (client, uidValidity) => {
      if (uidValidity !== location.uidValidity)
        throw new EmailError('not_found', `Message ${location.id} is no longer available`);
      const fetched = await client.fetchOne(
        location.uid,
        {
          envelope: true,
          flags: true,
          internalDate: true,
          bodyStructure: true,
          headers: includeHeaders ? true : HEADER_NAMES,
        },
        { uid: true },
      );
      if (!fetched) throw new EmailError('not_found', `No message with id "${location.id}"`);
      if (body && !fetched.bodyStructure) {
        const source = await client.fetchOne(location.uid, { source: true }, { uid: true });
        if (source && source.source) fetched.source = source.source;
      }
      return this.toMessage(client, location.mailboxPath, uidValidity, fetched, {
        body,
        includeHeaders,
        threadId: location.threadId,
        ...(location.draftId ? { draftId: location.draftId } : {}),
      });
    });
  }

  async getMessage(id: string, options?: GetMessageOpts): Promise<Message> {
    const location = await this.options.store.findById(id);
    if (!location) throw new EmailError('not_found', `No message with id "${id}"`);
    return this.fetchLocation(location, true, options?.includeHeaders ?? false);
  }

  async getThread(id: string): Promise<Thread> {
    let locations = await this.options.store.listByThreadId(id);
    if (!locations.length) throw new EmailError('not_found', `No thread with id "${id}"`);
    const folders = await this.refreshFolders();
    const searched = new Set<string>();
    while (true) {
      const identifiers = new Set(
        locations
          .flatMap((location) => [location.messageId, location.inReplyTo, ...(location.references ?? [])])
          .filter(Boolean) as string[],
      );
      const pending = [...identifiers].filter((identifier) => !searched.has(identifier));
      if (!pending.length) break;
      pending.forEach((identifier) => searched.add(identifier));
      for (const path of folders.selectablePaths.filter((value) => value !== folders.paths.all)) {
        await this.withMailbox(path, async (client, uidValidity) => {
          for (const identifier of pending) {
            const found = await client.search(
              {
                or: [
                  { header: { 'Message-ID': identifier } },
                  { header: { References: identifier } },
                  { header: { 'In-Reply-To': identifier } },
                ],
              },
              { uid: true },
            );
            for (const uid of found || []) {
              const existing = await this.options.store.findByLocation(path, uidValidity, uid);
              if (existing) {
                if (existing.threadId !== id) await this.options.store.save({ ...existing, threadId: id });
                continue;
              }
              const fetched = await client.fetchOne(
                uid,
                { envelope: true, flags: true, internalDate: true, bodyStructure: true, headers: HEADER_NAMES },
                { uid: true },
              );
              if (fetched) await this.toMessage(client, path, uidValidity, fetched, { threadId: id });
            }
          }
        });
      }
      const expanded = await this.options.store.listByThreadId(id);
      if (expanded.length === locations.length) break;
      locations = expanded;
    }
    const messages = await Promise.all(locations.map((location) => this.fetchLocation(location, true)));
    messages.sort((a, b) => a.date.localeCompare(b.date));
    return { id, subject: messages[0]?.subject ?? '', messages };
  }

  private async threadingFor(input: DraftInput): Promise<{ input: DraftInput; headers?: ThreadingHeaders }> {
    if (!input.replyToMessageId) return { input };
    const original = await this.getMessage(input.replyToMessageId, { includeHeaders: true });
    const header = (name: string) =>
      Object.entries(original.headers ?? {}).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
    const messageId = header('Message-ID');
    const oldReferences = header('References');
    const references = [oldReferences, messageId].filter(Boolean).join(' ');
    return {
      input: { ...input, subject: input.subject ?? replySubject(original.subject), replyToMessageId: undefined },
      headers: {
        ...(messageId ? { inReplyTo: messageId } : {}),
        ...(references ? { references } : {}),
      },
    };
  }

  private async compose(input: DraftInput, existingThreading?: ThreadingHeaders): Promise<Buffer> {
    const resolved = input.replyToMessageId ? await this.threadingFor(input) : { input, headers: existingThreading };
    return composeMessage(
      resolved.input,
      { ...(this.options.displayName ? { name: this.options.displayName } : {}), email: this.options.email },
      resolved.headers,
    );
  }

  private async appendedLocation(
    path: string,
    result: false | { uid?: number; uidValidity?: bigint },
    messageId: string | undefined,
    kind: string,
  ): Promise<{ uid: number; uidValidity: string }> {
    if (result && result.uid && result.uidValidity) {
      return { uid: result.uid, uidValidity: result.uidValidity.toString() };
    }
    if (messageId) {
      const found = await this.withMailbox(path, async (client, uidValidity) => {
        const matches = await client.search({ header: { 'Message-ID': messageId } }, { uid: true });
        const uid = Math.max(...(matches || []));
        return Number.isFinite(uid) ? { uid, uidValidity } : undefined;
      });
      if (found) return found;
    }
    throw new EmailError('provider_unavailable', `The IMAP server did not return or expose an ID for the ${kind}`);
  }

  private async appendDraft(raw: Buffer, draftId: string, existingId?: string): Promise<Message> {
    await this.refreshFolders();
    const path = this.requireRole('drafts');
    const parsed = await PostalMime.parse(raw, POSTAL_OPTIONS);
    const client = await this.client();
    const result = await client.append(path, raw, ['\\Draft']);
    const appended = await this.appendedLocation(path, result, parsed.messageId, 'saved draft');
    const location: ImapMessageLocation = {
      id: existingId ?? locationId('im', this.options.accountId, path, appended.uidValidity, appended.uid),
      accountId: this.options.accountId,
      mailboxPath: path,
      uidValidity: appended.uidValidity,
      uid: appended.uid,
      ...(parsed.messageId ? { messageId: parsed.messageId } : {}),
      ...(parsed.inReplyTo ? { inReplyTo: parsed.inReplyTo } : {}),
      ...(parsed.references ? { references: parsed.references.match(/<[^>]+>/g) ?? [] } : {}),
      threadId: threadId(
        {
          messageId: parsed.messageId,
          inReplyTo: parsed.inReplyTo,
          references: parsed.references?.match(/<[^>]+>/g) ?? [],
        },
        draftId,
      ),
      draftId,
      subject: parsed.subject ?? '',
      date: parsed.date ?? new Date().toISOString(),
    };
    await this.options.store.save(location);
    return this.fetchLocation(location, true);
  }

  async createDraft(input: DraftInput): Promise<Message> {
    return this.appendDraft(await this.compose(input), `draft_${randomBytes(9).toString('base64url')}`);
  }

  async getDraft(draftId: string): Promise<Message> {
    const location = await this.options.store.findByDraftId(draftId);
    if (!location) throw new EmailError('not_found', `No draft with id "${draftId}"`);
    return this.fetchLocation(location, true);
  }

  async updateDraft(draftId: string, input: DraftInput): Promise<Message> {
    const location = await this.options.store.findByDraftId(draftId);
    if (!location) throw new EmailError('not_found', `No draft with id "${draftId}"`);
    const replacement = await this.appendDraft(
      await this.compose(input, {
        ...(location.inReplyTo ? { inReplyTo: location.inReplyTo } : {}),
        ...(location.references?.length ? { references: location.references.join(' ') } : {}),
      }),
      draftId,
      location.id,
    );
    await this.withMailbox(location.mailboxPath, async (client) => {
      await client.messageDelete(location.uid, { uid: true });
    });
    return replacement;
  }

  async deleteDraft(draftId: string): Promise<void> {
    const location = await this.options.store.findByDraftId(draftId);
    if (!location) throw new EmailError('not_found', `No draft with id "${draftId}"`);
    await this.withMailbox(location.mailboxPath, async (client) => {
      await client.messageDelete(location.uid, { uid: true });
    });
    await this.options.store.remove(location.id);
  }

  private async deliver(raw: Buffer, envelopeRecipients: string[]): Promise<string> {
    if (!envelopeRecipients.length) throw new EmailError('invalid_request', 'Cannot send a message with no recipients');
    try {
      this.smtp ??= this.buildSmtp();
      const info = await this.smtp.sendMail({
        envelope: { from: this.options.email, to: envelopeRecipients },
        raw: stripBccHeader(raw),
      });
      return info.messageId || `smtp_${randomBytes(9).toString('base64url')}`;
    } catch (error) {
      throw mapImapError(error);
    }
  }

  private async appendSent(raw: Buffer): Promise<ImapMessageLocation | undefined> {
    if (!this.options.credentials.saveSent) return undefined;
    await this.refreshFolders();
    const path = this.resolved?.paths.sent;
    if (!path) return undefined;
    const parsed = await PostalMime.parse(raw, POSTAL_OPTIONS);
    const result = await (await this.client()).append(path, raw, ['\\Seen']);
    const appended = await this.appendedLocation(path, result, parsed.messageId, 'Sent copy');
    const headers: ParsedHeaders = {
      ...(parsed.messageId ? { messageId: parsed.messageId } : {}),
      ...(parsed.inReplyTo ? { inReplyTo: parsed.inReplyTo } : {}),
      references: parsed.references?.match(/<[^>]+>/g) ?? [],
    };
    const location: ImapMessageLocation = {
      id: locationId('im', this.options.accountId, path, appended.uidValidity, appended.uid),
      accountId: this.options.accountId,
      mailboxPath: path,
      uidValidity: appended.uidValidity,
      uid: appended.uid,
      ...(parsed.messageId ? { messageId: parsed.messageId } : {}),
      ...(parsed.inReplyTo ? { inReplyTo: parsed.inReplyTo } : {}),
      ...(headers.references.length ? { references: headers.references } : {}),
      threadId: threadId(headers, parsed.messageId ?? String(appended.uid)),
      subject: parsed.subject ?? '',
      date: parsed.date ?? new Date().toISOString(),
    };
    await this.options.store.save(location);
    return location;
  }

  private async moveDraftToSent(location: ImapMessageLocation): Promise<ImapMessageLocation | undefined> {
    await this.refreshFolders();
    const destination = this.resolved?.paths.sent;
    if (!destination) return undefined;
    const moved = await this.withMailbox(location.mailboxPath, (client) =>
      client.messageMove(location.uid, destination, { uid: true }),
    );
    const mappedUid = moved && moved.uidMap?.get(location.uid);
    const target =
      moved && mappedUid && moved.uidValidity
        ? { uid: mappedUid, uidValidity: moved.uidValidity.toString() }
        : await this.appendedLocation(destination, false, location.messageId, 'moved Sent copy');
    await this.withMailbox(destination, async (client, uidValidity) => {
      if (uidValidity !== target.uidValidity) {
        throw new EmailError('provider_unavailable', 'The Sent folder changed while the draft was being moved');
      }
      await client.messageFlagsRemove(target.uid, ['\\Draft'], { uid: true });
      await client.messageFlagsAdd(target.uid, ['\\Seen'], { uid: true });
    });
    const { draftId: _draftId, ...withoutDraft } = location;
    const sent = {
      ...withoutDraft,
      mailboxPath: destination,
      uidValidity: target.uidValidity,
      uid: target.uid,
    };
    await this.options.store.save(sent);
    return sent;
  }

  async send(input: DraftInput | { draftId: string }): Promise<SendResult> {
    let raw: Buffer;
    let draftLocation: ImapMessageLocation | undefined;
    let envelopeRecipients: string[];
    if ('draftId' in input) {
      draftLocation = await this.options.store.findByDraftId(input.draftId);
      if (!draftLocation) throw new EmailError('not_found', `No draft with id "${input.draftId}"`);
      raw = await this.withMailbox(draftLocation.mailboxPath, async (client) => {
        const fetched = await client.fetchOne(draftLocation!.uid, { source: true }, { uid: true });
        if (!fetched || !fetched.source) throw new EmailError('not_found', `No draft with id "${input.draftId}"`);
        return fetched.source;
      });
      const parsed = await PostalMime.parse(raw, POSTAL_OPTIONS);
      envelopeRecipients = [
        ...postalAddresses(parsed.to),
        ...postalAddresses(parsed.cc),
        ...postalAddresses(parsed.bcc),
      ].map((value) => value.email);
    } else {
      raw = await this.compose(input);
      envelopeRecipients = recipients(input);
    }

    const deliveryId = await this.deliver(raw, envelopeRecipients);
    const warnings: string[] = [];
    let sent: ImapMessageLocation | undefined;
    if (draftLocation && this.options.credentials.saveSent) {
      try {
        sent = await this.moveDraftToSent(draftLocation);
        if (!sent) {
          warnings.push('Message delivered, but no Sent folder is configured, so Fluxmail could not save a copy.');
          await this.withMailbox(draftLocation.mailboxPath, async (client) => {
            await client.messageDelete(draftLocation!.uid, { uid: true });
          });
          await this.options.store.remove(draftLocation.id);
        }
      } catch (error) {
        warnings.push(
          `Message delivered, but Fluxmail could not move the draft to Sent: ${mapImapError(error).message}`,
        );
      }
    } else {
      try {
        sent = await this.appendSent(raw);
        if (this.options.credentials.saveSent && !sent) {
          warnings.push('Message delivered, but no Sent folder is configured, so Fluxmail could not save a copy.');
        }
      } catch (error) {
        warnings.push(`Message delivered, but Fluxmail could not save the Sent copy: ${mapImapError(error).message}`);
      }
      if (draftLocation) {
        try {
          await this.withMailbox(draftLocation.mailboxPath, async (client) => {
            await client.messageDelete(draftLocation!.uid, { uid: true });
          });
          await this.options.store.remove(draftLocation.id);
        } catch (error) {
          warnings.push(`Message delivered, but Fluxmail could not remove the draft: ${mapImapError(error).message}`);
        }
      }
    }
    return {
      id: sent?.id ?? deliveryId,
      threadId: sent?.threadId ?? `ith_${createHash('sha256').update(deliveryId).digest('hex').slice(0, 24)}`,
      ...(warnings.length ? { warnings } : {}),
    };
  }

  async modify(ids: string[], action: ModifyAction): Promise<void> {
    if (typeof action === 'object' && ('addLabels' in action || 'removeLabels' in action)) {
      throw new EmailError('unsupported_capability', 'IMAP accounts do not support labels');
    }
    const locations = await Promise.all(ids.map((id) => this.options.store.findById(id)));
    if (locations.some((location) => !location))
      throw new EmailError('not_found', 'One or more messages no longer exist');
    await this.refreshFolders();
    const groups = new Map<string, ImapMessageLocation[]>();
    for (const location of locations as ImapMessageLocation[]) {
      const group = groups.get(location.mailboxPath) ?? [];
      group.push(location);
      groups.set(location.mailboxPath, group);
    }
    const trashPath = this.resolved?.paths.trash;
    if (action === 'untrash') {
      if (!trashPath) this.requireRole('trash');
      if ([...groups.keys()].some((path) => path !== trashPath)) {
        throw new EmailError('invalid_request', 'The untrash action only accepts messages that are in Trash');
      }
    }
    if (action === 'archive' && trashPath && groups.has(trashPath)) {
      throw new EmailError('invalid_request', 'Use the untrash action before archiving a message from Trash');
    }
    let requestedMoveDestination: string | undefined;
    if (typeof action === 'object' && 'move' in action) {
      const roleDestination = this.resolved?.paths[action.move as FolderRole];
      requestedMoveDestination = roleDestination ?? action.move;
      if (!this.resolved?.selectablePaths.includes(requestedMoveDestination)) {
        throw new EmailError('not_found', `No folder named "${action.move}"`);
      }
      const protectedDestinations = [this.resolved?.paths.archive, trashPath].filter(
        (path): path is string => path !== undefined,
      );
      if (groups.has(trashPath ?? '') || protectedDestinations.includes(requestedMoveDestination)) {
        throw new EmailError(
          'invalid_request',
          'Use the archive, trash, or untrash action when moving messages through a protected folder',
        );
      }
    }
    for (const [path, group] of groups) {
      await this.withMailbox(path, async (client) => {
        const uids = group.map((location) => location.uid);
        if (action === 'markRead') await client.messageFlagsAdd(uids, ['\\Seen'], { uid: true });
        else if (action === 'markUnread') await client.messageFlagsRemove(uids, ['\\Seen'], { uid: true });
        else if (action === 'star') await client.messageFlagsAdd(uids, ['\\Flagged'], { uid: true });
        else if (action === 'unstar') await client.messageFlagsRemove(uids, ['\\Flagged'], { uid: true });
        else if (action === 'delete') {
          await client.messageDelete(uids, { uid: true });
          await Promise.all(group.map((location) => this.options.store.remove(location.id)));
        } else {
          let destination: string;
          if (action === 'archive') destination = this.requireRole('archive');
          else if (action === 'trash') destination = this.requireRole('trash');
          else if (action === 'untrash') {
            this.requireRole('trash');
            destination = this.resolved?.paths.inbox ?? 'INBOX';
          } else if (typeof action === 'object' && 'move' in action) {
            destination = requestedMoveDestination!;
          } else throw new EmailError('invalid_request', `Unsupported IMAP modify action: ${String(action)}`);
          if (destination === path) return;
          const moved = await client.messageMove(uids, destination, { uid: true });
          if (moved && moved.uidMap && moved.uidValidity) {
            for (const location of group) {
              const uid = moved.uidMap.get(location.uid);
              if (!uid) continue;
              await this.options.store.save({
                ...location,
                mailboxPath: destination,
                uidValidity: moved.uidValidity.toString(),
                uid,
              });
            }
          } else {
            await Promise.all(group.map((location) => this.options.store.remove(location.id)));
          }
        }
      });
    }
  }

  async getAttachment(
    messageId: string,
    attachmentId: string,
    opts: { maxBytes?: number } = {},
  ): Promise<{ meta: AttachmentMeta; content: Buffer }> {
    const location = await this.options.store.findById(messageId);
    if (!location) throw new EmailError('not_found', `No message with id "${messageId}"`);
    return this.withMailbox(location.mailboxPath, async (client, uidValidity) => {
      if (uidValidity !== location.uidValidity) throw new EmailError('not_found', 'The message location is stale');
      const fetched = await client.fetchOne(location.uid, { bodyStructure: true }, { uid: true });
      if (!fetched) throw new EmailError('not_found', `No message with id "${messageId}"`);
      const meta = inspectStructure(fetched.bodyStructure).attachments.find((item) => item.id === attachmentId);
      const structurePart = findStructurePart(fetched.bodyStructure, attachmentId);
      if (
        meta &&
        opts.maxBytes !== undefined &&
        bodyStructureSizeIsDecoded(structurePart) &&
        meta.sizeBytes > opts.maxBytes
      ) {
        throw new EmailError('invalid_request', 'Attachment is too large to return through MCP.', {
          sizeBytes: meta.sizeBytes,
          maxBytes: opts.maxBytes,
        });
      }
      if (!meta && attachmentId.startsWith('raw-')) {
        const index = Number(attachmentId.slice(4));
        const raw = await client.fetchOne(location.uid, { source: true }, { uid: true });
        if (!raw || !raw.source) throw new EmailError('not_found', `No attachment with id "${attachmentId}"`);
        const parsed = await PostalMime.parse(raw.source, POSTAL_OPTIONS);
        const attachment = parsed.attachments[index];
        if (!attachment) throw new EmailError('not_found', `No attachment with id "${attachmentId}"`);
        const content =
          typeof attachment.content === 'string'
            ? Buffer.from(attachment.content, attachment.encoding === 'base64' ? 'base64' : 'utf8')
            : attachment.content instanceof ArrayBuffer
              ? Buffer.from(attachment.content)
              : Buffer.from(attachment.content.buffer, attachment.content.byteOffset, attachment.content.byteLength);
        if (opts.maxBytes !== undefined && content.length > opts.maxBytes) {
          throw new EmailError('invalid_request', 'Attachment is too large to return through MCP.', {
            sizeBytes: content.length,
            maxBytes: opts.maxBytes,
          });
        }
        return {
          meta: {
            id: attachmentId,
            filename: attachment.filename ?? 'attachment',
            mimeType: attachment.mimeType,
            sizeBytes: content.length,
            ...(attachment.contentId ? { contentId: attachment.contentId.replace(/^<|>$/g, '') } : {}),
            ...(attachment.disposition ? { disposition: attachment.disposition } : {}),
          },
          content,
        };
      }
      if (!meta) throw new EmailError('not_found', `No attachment with id "${attachmentId}"`);
      const downloaded = await client.download(location.uid, attachmentId, { uid: true });
      const chunks: Buffer[] = [];
      let sizeBytes = 0;
      for await (const chunk of downloaded.content) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        sizeBytes += bytes.length;
        if (opts.maxBytes !== undefined && sizeBytes > opts.maxBytes) {
          downloaded.content.destroy();
          throw new EmailError('invalid_request', 'Attachment is too large to return through MCP.', {
            sizeBytes,
            maxBytes: opts.maxBytes,
          });
        }
        chunks.push(bytes);
      }
      return { meta, content: Buffer.concat(chunks, sizeBytes) };
    });
  }
}
