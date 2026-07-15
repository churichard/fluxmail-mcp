import { EmailError, type EmailQuery } from '@fluxmail/core';

function quoteKqlClause(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function quoteKqlValue(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function dateOnly(value: string, field: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) throw new EmailError('invalid_request', `${field} must be a valid ISO date`);
  return date.toISOString().slice(0, 10);
}

/** Translate Fluxmail's structured query into Graph KQL and OData filters. */
export function toGraphQuery(q: EmailQuery): { search?: string; filter?: string } {
  if (q.rawProviderQuery && q.text) {
    throw new EmailError('invalid_request', 'rawProviderQuery cannot be combined with text');
  }
  const kql: string[] = [];
  if (q.rawProviderQuery) kql.push(q.rawProviderQuery);
  else if (q.text) kql.push(q.text);
  if (q.from) kql.push(`from:${quoteKqlValue(q.from)}`);
  if (q.to) kql.push(`to:${quoteKqlValue(q.to)}`);
  if (q.subject) kql.push(`subject:${quoteKqlValue(q.subject)}`);
  if (q.after) kql.push(`received>=${dateOnly(q.after, 'after')}`);
  if (q.before) kql.push(`received<${dateOnly(q.before, 'before')}`);

  const filter: string[] = [];
  if (q.unreadOnly) filter.push('isRead eq false');
  if (q.starredOnly) filter.push("flag/flagStatus eq 'flagged'");
  if (q.hasAttachment) filter.push('hasAttachments eq true');

  return {
    ...(kql.length ? { search: quoteKqlClause(kql.join(' AND ')) } : {}),
    ...(filter.length ? { filter: filter.join(' and ') } : {}),
  };
}
