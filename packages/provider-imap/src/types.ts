import type { FolderRole } from '@fluxmail/core';

export type ImapSecurity = 'tls' | 'starttls';

export interface ServerCredentials {
  host: string;
  port: number;
  security: ImapSecurity;
  user: string;
  password: string;
}

export interface ImapCredentials {
  imap: ServerCredentials;
  smtp: ServerCredentials;
  saveSent: boolean;
  folderOverrides?: Partial<Record<Extract<FolderRole, 'sent' | 'drafts' | 'trash' | 'archive' | 'spam'>, string>>;
}

export interface ImapMessageLocation {
  id: string;
  accountId: string;
  mailboxPath: string;
  uidValidity: string;
  uid: number;
  messageId?: string;
  inReplyTo?: string;
  references?: string[];
  threadId: string;
  draftId?: string;
  subject?: string;
  date?: string;
}

export interface ImapStateStore {
  findById(id: string): Promise<ImapMessageLocation | undefined>;
  findByLocation(mailboxPath: string, uidValidity: string, uid: number): Promise<ImapMessageLocation | undefined>;
  findByDraftId(draftId: string): Promise<ImapMessageLocation | undefined>;
  listByThreadId(threadId: string): Promise<ImapMessageLocation[]>;
  save(location: ImapMessageLocation): Promise<void>;
  remove(id: string): Promise<void>;
  invalidateMailbox(mailboxPath: string, uidValidity: string): Promise<void>;
}

export interface FolderWarning {
  role: Exclude<FolderRole, 'inbox' | 'starred' | 'all'>;
  reason: 'missing' | 'ambiguous' | 'stale_override';
  message: string;
}
