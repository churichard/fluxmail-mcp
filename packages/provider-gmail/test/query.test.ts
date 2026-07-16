import { describe, expect, it } from 'vitest';
import { toGmailQuery } from '../src/query.js';

const noLabels = () => null;

describe('toGmailQuery', () => {
  it('maps folder roles to system labels', () => {
    expect(toGmailQuery({ folder: 'inbox' }, noLabels)).toEqual({ labelIds: ['INBOX'] });
    expect(toGmailQuery({ folder: 'sent' }, noLabels)).toEqual({ labelIds: ['SENT'] });
  });

  it('includes spam/trash when targeting those folders', () => {
    expect(toGmailQuery({ folder: 'trash' }, noLabels)).toEqual({
      labelIds: ['TRASH'],
      includeSpamTrash: true,
    });
  });

  it("uses Gmail's archive search operator", () => {
    const q = toGmailQuery({ folder: 'archive' }, noLabels);
    expect(q.q).toBe('in:archive');
    expect(q.labelIds).toBeUndefined();
  });

  it('uses Gmail default scope when targeting all mail', () => {
    expect(toGmailQuery({ folder: 'all' }, noLabels)).toEqual({});
  });

  it('resolves user labels through the resolver', () => {
    expect(toGmailQuery({ folder: 'Projects' }, () => 'Label_42')).toEqual({ labelIds: ['Label_42'] });
  });

  it('builds q from filters', () => {
    const q = toGmailQuery(
      {
        text: 'quarterly report',
        from: 'ann@example.com',
        unreadOnly: true,
        hasAttachment: true,
        after: '2026-01-01T00:00:00.000Z',
      },
      noLabels,
    );
    expect(q.q).toContain('quarterly report');
    expect(q.q).toContain('from:ann@example.com');
    expect(q.q).toContain('is:unread');
    expect(q.q).toContain('has:attachment');
    expect(q.q).toMatch(/after:\d{10}/);
  });

  it('quotes values with spaces', () => {
    const q = toGmailQuery({ subject: 'hello world' }, noLabels);
    expect(q.q).toBe('subject:"hello world"');
  });

  it('passes rawProviderQuery through verbatim', () => {
    const q = toGmailQuery({ rawProviderQuery: 'in:anywhere label:foo' }, noLabels);
    expect(q.q).toBe('in:anywhere label:foo');
  });

  it('rejects invalid date filters before calling Gmail', () => {
    expect(() => toGmailQuery({ after: 'not-a-date' }, noLabels)).toThrow(/valid ISO date/);
  });
});
