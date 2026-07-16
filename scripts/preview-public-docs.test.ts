import { describe, expect, it } from 'vitest';
import { fluxmailWorktreeCandidates, normalizePreviewArgs } from './preview-public-docs.js';

describe('public documentation preview', () => {
  it('finds sibling Fluxmail checkouts from MCP worktrees', () => {
    expect(
      fluxmailWorktreeCandidates(
        [
          'worktree /Users/example/github/fluxmail-mcp',
          'HEAD abc123',
          'branch refs/heads/main',
          '',
          'worktree /Users/example/conductor/workspaces/fluxmail-mcp/test',
          'HEAD def456',
          'branch refs/heads/test',
        ].join('\n'),
      ),
    ).toEqual(['/Users/example/github/fluxmail-web', '/Users/example/conductor/workspaces/fluxmail-mcp/fluxmail-web']);
  });

  it('removes package-manager argument separators', () => {
    expect(normalizePreviewArgs(['--', '--port', '3001'])).toEqual(['--port', '3001']);
    expect(normalizePreviewArgs(['--port', '3001'])).toEqual(['--port', '3001']);
  });
});
