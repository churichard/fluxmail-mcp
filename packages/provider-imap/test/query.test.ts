import { describe, expect, it } from 'vitest';
import { toImapSearches } from '../src/query.js';

describe('toImapSearches', () => {
  it('maps structured filters', () => {
    expect(
      toImapSearches(
        { text: 'report', from: 'ann@example.com', read: false, starred: true, after: '2026-01-01' },
        false,
      ),
    ).toEqual([expect.objectContaining({ text: 'report', from: 'ann@example.com', seen: false, flagged: true })]);
  });

  it('builds one IMAP search per literal full-text term', () => {
    expect(toImapSearches({ text: 'quarterly report', read: false }, false)).toEqual([
      expect.objectContaining({ text: 'quarterly', seen: false }),
      expect.objectContaining({ text: 'report', seen: false }),
    ]);
  });

  it('only permits raw queries on Gmail IMAP', () => {
    expect(() => toImapSearches({ rawProviderQuery: 'has:attachment' }, false)).toThrow(/Gmail raw search/);
    expect(toImapSearches({ rawProviderQuery: 'has:attachment' }, true)).toEqual([
      expect.objectContaining({ gmraw: 'has:attachment' }),
    ]);
  });

  it('maps both values of tri-state flags', () => {
    expect(toImapSearches({ read: true, starred: false }, false)).toEqual([
      expect.objectContaining({ seen: true, flagged: false }),
    ]);
    expect(toImapSearches({}, false)[0]).not.toHaveProperty('seen');
  });

  it('rejects invalid dates', () => {
    expect(() => toImapSearches({ after: 'yesterday' }, false)).toThrow(/YYYY-MM-DD/);
  });
});
