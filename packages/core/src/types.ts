export type Provider = 'gmail' | 'outlook' | 'imap';

export interface Capabilities {
  /** Gmail: many-to-many labels. Outlook/IMAP: a message lives in exactly one folder. */
  labels: boolean;
  /** Gmail/Outlook thread server-side; IMAP threads are synthesized from References headers. */
  serverThreads: boolean;
  /** Gmail q= / Graph $search vs IMAP SEARCH. */
  serverSearch: 'rich' | 'basic';
  /** Whether list results include snippets without fetching bodies. */
  snippets: boolean;
}

export interface Account {
  id: string;
  provider: Provider;
  email: string;
  displayName?: string;
  status: 'active' | 'auth_error' | 'disabled';
  capabilities: Capabilities;
  /** Owning member on the instance. */
  ownerMemberId: string;
  /** Whether every active member on this instance can access the mailbox. */
  sharedWithAll: boolean;
  /** Explicit grants used when the mailbox is not shared with all members. */
  grantedMemberIds: string[];
}

export interface EmailAddress {
  name?: string;
  email: string;
}

export type FolderRole = 'inbox' | 'sent' | 'drafts' | 'trash' | 'spam' | 'archive' | 'starred' | 'all';

export interface Folder {
  id: string;
  /** Display path, e.g. "Projects/2026". */
  name: string;
  role?: FolderRole;
  /** How an IMAP folder role was resolved. */
  roleSource?: 'user' | 'extension' | 'name';
  unreadCount?: number;
}

export interface AttachmentMeta {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  /** RFC Content-ID without angle brackets, used by HTML cid: references. */
  contentId?: string;
  disposition?: 'inline' | 'attachment';
}

export interface MessageBody {
  text?: string;
  html?: string;
}

export interface MessageFlags {
  read: boolean;
  starred: boolean;
  draft: boolean;
}

export interface Message {
  id: string;
  threadId: string;
  accountId: string;
  /** Present when this message is a draft; use with updateDraft/deleteDraft/send. */
  draftId?: string;
  /** Canonical location. Gmail: derived from labels; Outlook/IMAP: the containing folder. */
  folder?: Folder;
  /** Gmail only (capabilities.labels). Label names. */
  labels?: string[];
  from?: EmailAddress;
  to: EmailAddress[];
  cc?: EmailAddress[];
  bcc?: EmailAddress[];
  replyTo?: EmailAddress[];
  subject: string;
  /** ISO 8601. */
  date: string;
  snippet?: string;
  /** Populated on getMessage/getThread, not on list. */
  body?: MessageBody;
  /** Populated on getMessage/getThread; omitted when a list response has no MIME metadata. */
  attachments?: AttachmentMeta[];
  flags: MessageFlags;
  /** Selected RFC 5322 headers (Message-ID, References, In-Reply-To, ...) when requested. */
  headers?: Record<string, string>;
}

export interface Thread {
  id: string;
  subject: string;
  messages: Message[];
}

export interface AttachmentInput {
  filename: string;
  mimeType: string;
  /** Base64-encoded content. */
  content: string;
  /** Preserve embedded HTML images when forwarding. */
  contentId?: string;
  disposition?: 'inline' | 'attachment';
}

export interface DraftInput {
  /** Optional when derived from a reply (replyToMessageId). */
  to?: EmailAddress[];
  cc?: EmailAddress[];
  bcc?: EmailAddress[];
  /** Defaults to "Re: ..." when replying. */
  subject?: string;
  body: MessageBody;
  attachments?: AttachmentInput[];
  /**
   * Reply threading: the adapter resolves this message's Message-ID/References
   * (and provider thread id) so the sent message threads correctly everywhere.
   */
  replyToMessageId?: string;
}

export interface SendResult {
  id: string;
  threadId: string;
  /** Non-fatal provider outcomes, such as a delivered message whose Sent copy could not be saved. */
  warnings?: string[];
}

export type ModifyAction =
  | 'markRead'
  | 'markUnread'
  | 'star'
  | 'unstar'
  | 'archive'
  | 'trash'
  | 'untrash'
  | 'delete'
  | { move: string }
  | { addLabels: string[] }
  | { removeLabels: string[] };

export interface EmailQuery {
  /** Folder id or role. An omitted folder uses All Mail, excluding Spam and Trash. */
  folder?: string;
  /** Full-text search. */
  text?: string;
  from?: string;
  to?: string;
  subject?: string;
  unreadOnly?: boolean;
  starredOnly?: boolean;
  hasAttachment?: boolean;
  /** ISO date (inclusive). */
  after?: string;
  /** ISO date (exclusive). */
  before?: string;
  /** Escape hatch: passed to the provider verbatim (e.g. Gmail q=). */
  rawProviderQuery?: string;
}

export interface PageOpts {
  pageSize?: number;
  pageToken?: string;
}

export interface Page<T> {
  items: T[];
  nextPageToken?: string;
}
