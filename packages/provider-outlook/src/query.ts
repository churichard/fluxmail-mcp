import { EmailError, normalizeEmailQuery, type EmailQuery } from '@fluxmail/core';

function quoteKqlClause(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function quoteKqlValue(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
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

/** Translate Fluxmail's structured query into Graph KQL and OData filters. */
export function toGraphQuery(input: EmailQuery): { search?: string; filter?: string } {
  const q = requireNormalized(input);
  const kql: string[] = [];
  if (q.rawProviderQuery) kql.push(q.rawProviderQuery);
  else if (q.text) kql.push(...q.text.split(' ').map(quoteKqlValue));
  if (q.from) kql.push(`from:${quoteKqlValue(q.from)}`);
  if (q.to) kql.push(`to:${quoteKqlValue(q.to)}`);
  if (q.subject) kql.push(`subject:${quoteKqlValue(q.subject)}`);
  if (q.after) kql.push(`received>=${q.after}`);
  if (q.before) kql.push(`received<${q.before}`);

  const filter: string[] = [];
  if (q.read !== undefined) filter.push(`isRead eq ${q.read}`);
  if (q.starred !== undefined) {
    filter.push(q.starred ? "flag/flagStatus eq 'flagged'" : "flag/flagStatus ne 'flagged'");
  }
  if (q.hasAttachment === true) filter.push('hasAttachments eq true');

  return {
    ...(kql.length ? { search: quoteKqlClause(kql.join(' AND ')) } : {}),
    ...(filter.length ? { filter: filter.join(' and ') } : {}),
  };
}
