import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { ImapFlow } from 'imapflow';
import { beforeAll, describe, expect, it } from 'vitest';

const host = process.env.GREENMAIL_HOST;
const cliPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist/cli.js');
const dataDir = mkdtempSync(path.join(tmpdir(), 'fluxmail-cli-imap-'));
const ownerEmail = 'cli-owner@example.com';

function run(args: string[]) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      FLUXMAIL_DATA_DIR: dataDir,
      FLUXMAIL_PASSWORD: 'Granite harbor compass 2026!',
      FLUXMAIL_TELEMETRY: '0',
      CLI_IMAP_PASSWORD: 'pwd3',
      NODE_TLS_REJECT_UNAUTHORIZED: '0',
    },
  });
}

describe.skipIf(!host || !existsSync(cliPath)).sequential('IMAP CLI integration', () => {
  beforeAll(async () => {
    const setup = run(['setup', '--name', 'CLI integration owner', '--email', ownerEmail]);
    expect(setup.status, setup.stderr).toBe(0);

    const client = new ImapFlow({
      host: host!,
      port: 3993,
      secure: true,
      auth: { user: 'cli', pass: 'pwd3' },
      logger: false,
    });
    await client.connect();
    try {
      if (!(await client.list()).some((folder) => folder.path === 'Sent')) await client.mailboxCreate('Sent');
    } finally {
      await client.logout();
    }
  });

  it('adds, lists, configures, and reauthorizes an IMAP account', () => {
    const connectionArgs = [
      '--email',
      'cli@example.com',
      '--imap-host',
      host!,
      '--imap-port',
      '3993',
      '--imap-security',
      'tls',
      '--imap-user',
      'cli',
      '--imap-password-env',
      'CLI_IMAP_PASSWORD',
      '--smtp-host',
      host!,
      '--smtp-port',
      '3465',
      '--smtp-security',
      'tls',
      '--smtp-user',
      'cli',
    ];
    const added = run(['accounts', 'add', 'imap', ...connectionArgs]);
    expect(added.status, added.stderr).toBe(0);
    expect(added.stdout).toMatch(/Connected cli@example.com/);
    expect(added.stdout).toMatch(/Warning: no drafts folder could be resolved/);
    const accountId = added.stdout.match(/account id: ([^)]+)/)?.[1];
    expect(accountId).toMatch(/^acct_/);

    const listed = run(['accounts', 'list']);
    expect(listed.status, listed.stderr).toBe(0);
    expect(listed.stdout).toContain(`${accountId}  imap  cli@example.com  [active]`);

    const configured = run(['accounts', 'configure', accountId!, '--sent-folder', 'Sent']);
    expect(configured.status, configured.stderr).toBe(0);
    expect(configured.stdout).toContain(`Updated folder settings for ${accountId}.`);
    const automatic = run(['accounts', 'configure', accountId!, '--sent-folder', 'auto']);
    expect(automatic.status, automatic.stderr).toBe(0);

    const reauthorized = run(['accounts', 'add', 'imap', '--reauthorize', accountId!, ...connectionArgs]);
    expect(reauthorized.status, reauthorized.stderr).toBe(0);
    expect(reauthorized.stdout).toContain(`account id: ${accountId}`);
    expect(run(['accounts', 'list']).stdout.match(/cli@example.com/g)).toHaveLength(1);
  }, 30_000);

  it('rejects nonexistent folder mappings and literal password flags', () => {
    const listed = run(['accounts', 'list']);
    const accountId = listed.stdout.match(/^(acct_\S+)\s+imap\s+cli@example\.com/m)?.[1];
    expect(accountId).toBeTruthy();

    const missing = run(['accounts', 'configure', accountId!, '--trash-folder', 'Does Not Exist']);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toMatch(/trash folder override "Does Not Exist" does not match a selectable mailbox/);

    const literal = run([
      'accounts',
      'add',
      'imap',
      '--email',
      'cli@example.com',
      '--imap-host',
      host!,
      '--smtp-host',
      host!,
      '--imap-password',
      'secret',
    ]);
    expect(literal.status).not.toBe(0);
    expect(literal.stderr).toMatch(/unknown option.*--imap-password/i);
  }, 30_000);
});
