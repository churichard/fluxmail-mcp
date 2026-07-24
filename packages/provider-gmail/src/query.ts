import { EmailError, normalizeEmailQuery, type EmailQuery } from '@fluxmail/core';

export const ROLE_TO_LABEL: Record<string, string> = {
  inbox: 'INBOX',
  sent: 'SENT',
  drafts: 'DRAFT',
  trash: 'TRASH',
  spam: 'SPAM',
  starred: 'STARRED',
};

export interface GmailQuery {
  q?: string;
  labelIds?: string[];
  includeSpamTrash?: boolean;
}

function quote(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function epochSeconds(date: string): number {
  return Math.floor(new Date(`${date}T00:00:00.000Z`).getTime() / 1000);
}

function requireNormalized(query: EmailQuery): EmailQuery {
  const normalized = normalizeEmailQuery(query);
  if (!normalized.success) {
    throw new EmailError('invalid_request', normalized.diagnostics.map((item) => item.message).join(' '), {
      diagnostics: normalized.diagnostics,
    });
  }
  return normalized.query;
}

/**
 * Translate the unified EmailQuery into Gmail's q= syntax + labelIds.
 * `resolveLabelId` maps a user folder name/id to a Gmail label id (null if unknown).
 */
export function toGmailQuery(input: EmailQuery, resolveLabelId: (folder: string) => string | null): GmailQuery {
  const q = requireNormalized(input);
  const parts: string[] = [];
  const out: GmailQuery = {};

  if (q.folder) {
    const role = q.folder.toLowerCase();
    if (role === 'archive') {
      parts.push('in:archive');
    } else if (role === 'all') {
      // Gmail's default scope is All Mail, which excludes Spam and Trash.
    } else if (ROLE_TO_LABEL[role]) {
      out.labelIds = [ROLE_TO_LABEL[role]];
      if (role === 'trash' || role === 'spam') out.includeSpamTrash = true;
    } else {
      const labelId = resolveLabelId(q.folder);
      if (labelId) out.labelIds = [labelId];
      else parts.push(`label:${quote(q.folder)}`);
    }
  }

  if (q.text) parts.push(...q.text.split(' ').map(quote));
  if (q.from) parts.push(`from:${quote(q.from)}`);
  if (q.to) parts.push(`to:${quote(q.to)}`);
  if (q.subject) parts.push(`subject:${quote(q.subject)}`);
  if (q.read !== undefined) parts.push(q.read ? 'is:read' : 'is:unread');
  if (q.starred !== undefined) parts.push(q.starred ? 'is:starred' : '-is:starred');
  // Gmail's has:attachment predicate is not the same as Fluxmail's canonical
  // non-inline attachment predicate. Attachment filtering happens after hydration.
  if (q.after) parts.push(`after:${epochSeconds(q.after)}`);
  if (q.before) parts.push(`before:${epochSeconds(q.before)}`);
  if (q.rawProviderQuery) parts.push(q.rawProviderQuery);

  if (parts.length) out.q = parts.join(' ');
  return out;
}
