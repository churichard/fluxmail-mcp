import { EmailError, normalizeEmailQuery, type EmailQuery } from '@fluxmail/core';
import type { SearchObject } from 'imapflow';

function utcDate(value: string, offsetDays = 0): Date {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date;
}

export function toImapSearches(input: EmailQuery, supportsGmailRaw: boolean): SearchObject[] {
  const normalized = normalizeEmailQuery(input);
  if (!normalized.success) {
    throw new EmailError('invalid_request', normalized.diagnostics.map((item) => item.message).join(' '), {
      diagnostics: normalized.diagnostics,
    });
  }
  const query = normalized.query;
  const search: SearchObject = { all: true };
  if (query.from) search.from = query.from;
  if (query.to) search.to = query.to;
  if (query.subject) search.subject = query.subject;
  if (query.read !== undefined) search.seen = query.read;
  if (query.starred !== undefined) search.flagged = query.starred;
  // IMAP dates are mailbox-local calendar dates. Broaden the server search and
  // apply the exact UTC boundary to each hydrated message.
  if (query.after) search.since = utcDate(query.after, -1);
  if (query.before) search.before = utcDate(query.before, 1);
  if (query.rawProviderQuery) {
    if (!supportsGmailRaw) {
      throw new EmailError('unsupported_capability', 'rawProviderQuery requires an IMAP server with Gmail raw search');
    }
    search.gmraw = query.rawProviderQuery;
  }
  const textTerms = query.text?.split(' ') ?? [];
  return textTerms.length ? textTerms.map((text) => ({ ...search, text })) : [search];
}
