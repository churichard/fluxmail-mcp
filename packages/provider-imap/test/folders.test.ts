import { describe, expect, it } from 'vitest';
import type { ListResponse } from 'imapflow';
import { resolveFolders } from '../src/folders.js';

function folder(path: string, specialUse?: string): ListResponse {
  return {
    path,
    pathAsListed: path,
    name: path.split('/').at(-1)!,
    delimiter: '/',
    parent: [],
    parentPath: '',
    flags: new Set(),
    ...(specialUse ? { specialUse } : {}),
    listed: true,
    subscribed: true,
  };
}

describe('resolveFolders', () => {
  it('prefers a valid user path over extension and name matches', () => {
    const result = resolveFolders(
      [folder('INBOX'), folder('Server Sent', '\\Sent'), folder('Sent'), folder('Custom')],
      { sent: 'Custom' },
    );
    expect(result.paths.sent).toBe('Custom');
    expect(result.folders.find((item) => item.id === 'Custom')).toMatchObject({
      role: 'sent',
      roleSource: 'user',
    });
  });

  it('uses extension flags before conservative name matching', () => {
    const result = resolveFolders([folder('INBOX'), folder('Sent', '\\Archive'), folder('Delivery', '\\Sent')]);
    expect(result.paths.sent).toBe('Delivery');
    expect(result.paths.archive).toBe('Sent');
  });

  it('does not guess when multiple folders claim a role', () => {
    const result = resolveFolders([folder('INBOX'), folder('Sent A', '\\Sent'), folder('Sent B', '\\Sent')]);
    expect(result.paths.sent).toBeUndefined();
    expect(result.warnings).toContainEqual(expect.objectContaining({ role: 'sent', reason: 'ambiguous' }));
  });

  it('treats duplicate conservative name matches as ambiguous', () => {
    const result = resolveFolders([folder('INBOX'), folder('Team/Sent'), folder('Legacy/Sent')]);
    expect(result.paths.sent).toBeUndefined();
    expect(result.warnings).toContainEqual(expect.objectContaining({ role: 'sent', reason: 'ambiguous' }));
  });

  it('marks a missing override as stale without falling back', () => {
    const result = resolveFolders([folder('INBOX'), folder('Sent', '\\Sent')], { sent: 'Old Sent' });
    expect(result.paths.sent).toBeUndefined();
    expect(result.warnings).toContainEqual(expect.objectContaining({ role: 'sent', reason: 'stale_override' }));
  });

  it('ignores non-selectable folders', () => {
    const drafts = folder('Drafts', '\\Drafts');
    drafts.flags.add('\\Noselect');
    expect(resolveFolders([folder('INBOX'), drafts]).paths.drafts).toBeUndefined();
  });

  it('reports every unresolved optional role without making the account unhealthy', () => {
    const result = resolveFolders([folder('INBOX')]);
    expect(result.paths).toEqual({ inbox: 'INBOX' });
    expect(result.warnings.map((warning) => [warning.role, warning.reason])).toEqual([
      ['sent', 'missing'],
      ['drafts', 'missing'],
      ['trash', 'missing'],
      ['archive', 'missing'],
      ['spam', 'missing'],
    ]);
  });
});
