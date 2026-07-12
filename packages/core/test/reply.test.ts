import { describe, expect, it } from 'vitest';
import { computeReplyRecipients, forwardSubject, replySubject, type Message } from '../src/index.js';

function msg(overrides: Partial<Message>): Message {
  return {
    id: 'm1',
    threadId: 't1',
    accountId: 'acct_1',
    to: [],
    subject: 'Hello',
    date: '2026-07-09T00:00:00.000Z',
    attachments: [],
    flags: { read: true, starred: false, draft: false },
    ...overrides,
  };
}

describe('computeReplyRecipients', () => {
  const original = msg({
    from: { name: 'Ann', email: 'ann@example.com' },
    to: [{ email: 'me@example.com' }, { email: 'bob@example.com' }],
    cc: [{ email: 'carol@example.com' }, { email: 'me@example.com' }],
  });

  it('plain reply targets the sender only', () => {
    const r = computeReplyRecipients(original, 'me@example.com', false);
    expect(r.to).toEqual([{ name: 'Ann', email: 'ann@example.com' }]);
    expect(r.cc).toEqual([]);
  });

  it('reply-all includes original To/Cc minus own address', () => {
    const r = computeReplyRecipients(original, 'me@example.com', true);
    expect(r.to.map((a) => a.email)).toEqual(['ann@example.com', 'bob@example.com']);
    expect(r.cc.map((a) => a.email)).toEqual(['carol@example.com']);
  });

  it('prefers Reply-To over From', () => {
    const withReplyTo = msg({
      ...original,
      replyTo: [{ email: 'list@example.com' }],
    });
    const r = computeReplyRecipients(withReplyTo, 'me@example.com', false);
    expect(r.to).toEqual([{ email: 'list@example.com' }]);
  });

  it('own-address comparison is case-insensitive', () => {
    const r = computeReplyRecipients(original, 'ME@Example.com', true);
    expect(r.to.map((a) => a.email)).not.toContain('me@example.com');
  });

  it('replying to your own sent message falls back to the original To', () => {
    const own = msg({
      from: { email: 'me@example.com' },
      to: [{ email: 'bob@example.com' }],
    });
    const r = computeReplyRecipients(own, 'me@example.com', false);
    expect(r.to.map((a) => a.email)).toEqual(['bob@example.com']);
  });

  it('dedupes addresses across Reply-To and To', () => {
    const dup = msg({
      from: { email: 'ann@example.com' },
      to: [{ email: 'ann@example.com' }, { email: 'bob@example.com' }],
    });
    const r = computeReplyRecipients(dup, 'me@example.com', true);
    expect(r.to.map((a) => a.email)).toEqual(['ann@example.com', 'bob@example.com']);
  });
});

describe('subject prefixes', () => {
  it('adds Re: once', () => {
    expect(replySubject('Hello')).toBe('Re: Hello');
    expect(replySubject('Re: Hello')).toBe('Re: Hello');
    expect(replySubject('re: Hello')).toBe('re: Hello');
  });
  it('adds Fwd: once', () => {
    expect(forwardSubject('Hello')).toBe('Fwd: Hello');
    expect(forwardSubject('Fwd: Hello')).toBe('Fwd: Hello');
    expect(forwardSubject('FW: Hello')).toBe('FW: Hello');
  });
});
