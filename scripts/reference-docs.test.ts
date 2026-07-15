import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { generateCliReference, generateMcpReference } from './reference-docs.js';

describe('MCP documentation generation', () => {
  it('creates an index and one page for each tool', () => {
    const reference = generateMcpReference(
      [
        {
          name: 'list_emails',
          description: 'List messages in a mailbox.',
          inputSchema: {
            type: 'object',
            properties: {
              accountId: { type: 'string', description: 'Mailbox to use.' },
              recipients: { type: 'array', items: { type: 'string' } },
              cc: { $ref: '#/properties/recipients', description: 'Carbon-copy recipients.' },
              pageSize: { type: 'integer', minimum: 1 },
            },
            required: ['pageSize'],
          },
        },
      ],
      new Map([['list_emails', [['mail.read']]]]),
      '2026-07-15',
    );

    expect(reference.meta).toContain('"pagesIndex": "index"');
    expect(reference.indexSection).toContain('](/docs/tools/list-emails)');
    expect(reference.pages.get('list-emails.md')).toContain('Required capabilities: `mail.read`.');
    expect(reference.pages.get('list-emails.md')).toContain(
      '| `cc` | No | array of `string` | Carbon-copy recipients. |',
    );
    expect(reference.pages.get('list-emails.md')).toContain('| `pageSize` | Yes | `integer` | Minimum: 1. |');
  });
});

describe('CLI documentation generation', () => {
  it('documents command arguments, options, defaults, and subcommands', () => {
    const program = new Command().name('fluxmail');
    const accounts = program.command('accounts').description('Manage accounts');
    accounts
      .command('add')
      .description('Add an account')
      .argument('<provider>', 'Provider name')
      .requiredOption('--owner <member>', 'Mailbox owner')
      .option('--port <port>', 'Server port', '993');

    const reference = generateCliReference(program, '2026-07-15');
    expect(reference.indexSection).toContain('](/docs/cli/accounts-add)');
    expect(reference.pages.get('accounts.md')).toContain('## Subcommands');
    expect(reference.pages.get('accounts-add.md')).toContain('fluxmail accounts add <provider> [options]');
    expect(reference.pages.get('accounts-add.md')).toContain('| `provider` | Yes | Provider name | None |');
    expect(reference.pages.get('accounts-add.md')).toContain('| `--owner <member>` | Yes | Mailbox owner | None |');
    expect(reference.pages.get('accounts-add.md')).toContain('| `--port <port>` | No | Server port | `993` |');
  });
});
