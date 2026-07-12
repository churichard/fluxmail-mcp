import { describe, expect, it } from 'vitest';
import { toImapSearch } from '../src/query.js';

describe('toImapSearch', () => {
  it('maps structured filters', () => {
    expect(
      toImapSearch(
        { text: 'report', from: 'ann@example.com', unreadOnly: true, starredOnly: true, after: '2026-01-01' },
        false,
      ),
    ).toMatchObject({ text: 'report', from: 'ann@example.com', seen: false, flagged: true });
  });

  it('only permits raw queries on Gmail IMAP', () => {
    expect(() => toImapSearch({ rawProviderQuery: 'has:attachment' }, false)).toThrow(/Gmail raw search/);
    expect(toImapSearch({ rawProviderQuery: 'has:attachment' }, true)).toMatchObject({ gmraw: 'has:attachment' });
  });

  it('rejects invalid dates', () => {
    expect(() => toImapSearch({ after: 'yesterday' }, false)).toThrow(/ISO date/);
  });
});
