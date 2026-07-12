import { EmailError, type EmailQuery } from '@fluxmail/core';
import type { SearchObject } from 'imapflow';

function date(value: string, field: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new EmailError('invalid_request', `${field} must be an ISO date`);
  return parsed;
}

export function toImapSearch(query: EmailQuery, supportsGmailRaw: boolean): SearchObject {
  const search: SearchObject = { all: true };
  if (query.text) search.text = query.text;
  if (query.from) search.from = query.from;
  if (query.to) search.to = query.to;
  if (query.subject) search.subject = query.subject;
  if (query.unreadOnly) search.seen = false;
  if (query.starredOnly) search.flagged = true;
  if (query.after) search.since = date(query.after, 'after');
  if (query.before) search.before = date(query.before, 'before');
  if (query.rawProviderQuery) {
    if (!supportsGmailRaw) {
      throw new EmailError('unsupported_capability', 'rawProviderQuery requires an IMAP server with Gmail raw search');
    }
    search.gmraw = query.rawProviderQuery;
  }
  return search;
}
