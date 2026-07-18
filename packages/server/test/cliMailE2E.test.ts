import { spawn } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import type { Account, DraftInput, EmailProvider, Message, ModifyAction } from '@fluxmail/core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FluxmailConfig } from '../src/config.js';
import type { AccountRegistry } from '../src/accounts/registry.js';
import { createApp } from '../src/http/app.js';
import { createContext } from '../src/context.js';
import { EmailService } from '../src/service/emailService.js';
import { setupInitialAdmin } from '../src/auth.js';
import { createApiKey } from '../src/storage/apiKeys.js';
import { accounts, openDb } from '../src/storage/db.js';
import { addMember } from '../src/storage/members.js';
import { saveLocalInstance, saveRemoteInstance, saveSessionToken } from '../src/cliInstances.js';
import { customPermissionPolicy } from '../src/permissions.js';

const cliPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/cli.ts');

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runCli(
  dataDir: string,
  args: string[],
  input?: string,
  selection: { instance: string; account: string; encryptionKey?: string } = {
    instance: 'e2e',
    account: 'acct_e2e',
  },
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        cliPath,
        '--no-update-notifier',
        '--instance',
        selection.instance,
        '--mail-account',
        selection.account,
        ...args,
      ],
      {
        cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..'),
        env: {
          ...process.env,
          FLUXMAIL_DATA_DIR: dataDir,
          FLUXMAIL_ENCRYPTION_KEY: selection.encryptionKey ?? '44'.repeat(32),
          FLUXMAIL_TELEMETRY: '0',
          NO_UPDATE_NOTIFIER: '1',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    child.once('error', reject);
    child.once('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(input);
  });
}

describe('CLI mail process integration', () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'fluxmail-cli-mail-e2e-'));
  const db = openDb(':memory:');
  const member = addMember(db, {
    id: 'member_e2e',
    name: 'CLI E2E Owner',
    email: 'owner@example.com',
    role: 'admin',
  });
  const account: Account = {
    id: 'acct_e2e',
    provider: 'gmail',
    email: 'owner@example.com',
    status: 'active',
    capabilities: { labels: true, serverThreads: true, serverSearch: 'rich', snippets: true },
    ownerMemberId: member.id,
    sharedWithAll: false,
    grantedMemberIds: [],
  };
  db.insert(accounts)
    .values({
      id: account.id,
      provider: account.provider,
      email: account.email,
      status: account.status,
      createdAt: Date.now(),
      ownerMemberId: account.ownerMemberId,
      sharedWithAll: account.sharedWithAll,
    })
    .run();
  const draftMessage = (input: DraftInput): Message => ({
    id: 'msg_draft_e2e',
    threadId: 'thread_e2e',
    accountId: account.id,
    draftId: 'draft_e2e',
    to: input.to ?? [],
    subject: input.subject ?? '',
    date: '2026-07-18T12:00:00.000Z',
    body: input.body,
    attachments: [],
    flags: { read: true, starred: false, draft: true },
  });
  const provider: EmailProvider = {
    capabilities: account.capabilities,
    testConnection: vi.fn(async () => undefined),
    listMessages: vi.fn(async () => ({ items: [] })),
    getMessage: vi.fn(async () => draftMessage({ body: {} })),
    getThread: vi.fn(async () => ({ id: 'thread_e2e', subject: 'E2E', messages: [] })),
    listFolders: vi.fn(async () => [{ id: 'INBOX', name: 'Inbox', role: 'inbox' }] as const),
    listLabels: vi.fn(async () => [{ id: 'Label_e2e', name: 'E2E label' }]),
    createDraft: vi.fn(async (input) => draftMessage(input)),
    getDraft: vi.fn(async () => draftMessage({ body: {} })),
    updateDraft: vi.fn(async (_id, input) => draftMessage(input)),
    deleteDraft: vi.fn(async () => undefined),
    send: vi.fn(async () => ({ id: 'sent_e2e', threadId: 'thread_e2e' })),
    modify: vi.fn(async () => undefined),
    getAttachment: vi.fn(async () => ({
      meta: { id: 'att_e2e', filename: 'e2e.txt', mimeType: 'text/plain', sizeBytes: 3 },
      content: Buffer.from('e2e'),
    })),
  };
  const registry = {
    listAccounts: () => [account],
    getAccount: (accountId: string) => {
      if (accountId !== account.id) throw new Error(`Unexpected account ${accountId}`);
      return account;
    },
    getProvider: (accountId: string) => {
      if (accountId !== account.id) throw new Error(`Unexpected account ${accountId}`);
      return provider;
    },
    resolveAccountId: () => account.id,
    markStatus: vi.fn(),
  } as unknown as AccountRegistry;
  const config: FluxmailConfig = {
    dataDir,
    dbPath: ':memory:',
    encryptionKey: Buffer.alloc(32),
    port: 0,
    publicUrl: 'http://127.0.0.1',
    publicUrlConfigured: false,
    oauthPort: 8976,
    oauthHost: '127.0.0.1',
    maxAttachmentBytes: 1024,
    licenseServerUrl: 'https://license.invalid',
  };
  const service = new EmailService(registry, db);
  const server = serve({ fetch: createApp({ config, db, registry, service }).fetch, hostname: '127.0.0.1', port: 0 });

  beforeAll(async () => {
    if (!server.listening) await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address() as AddressInfo;
    const { key } = createApiKey(db, 'cli-e2e', member.id);
    const { key: composeKey } = createApiKey(
      db,
      'cli-e2e-compose',
      member.id,
      customPermissionPolicy(['mail.send', 'mail.drafts']),
      [account.id],
    );
    vi.stubEnv('FLUXMAIL_DATA_DIR', dataDir);
    saveRemoteInstance('e2e', `http://127.0.0.1:${address.port}`);
    saveSessionToken('e2e', key);
    saveRemoteInstance('e2e-compose', `http://127.0.0.1:${address.port}`);
    saveSessionToken('e2e-compose', composeKey);
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      }),
    );
  });

  it('runs a subprocess through HTTP, authentication, EmailService, and the provider', async () => {
    const labels = await runCli(dataDir, ['labels', 'list']);
    expect(labels.status, labels.stderr).toBe(0);
    expect(JSON.parse(labels.stdout)).toEqual({ data: [{ id: 'Label_e2e', name: 'E2E label' }] });
    expect(provider.listLabels).toHaveBeenCalledOnce();

    const modified = await runCli(dataDir, ['emails', 'modify', 'add-labels', 'msg_e2e', '--label', 'E2E label']);
    expect(modified.status, modified.stderr).toBe(0);
    expect(provider.modify).toHaveBeenCalledWith(['msg_e2e'], {
      addLabels: ['E2E label'],
    } satisfies ModifyAction);
  });

  it('uses redirected stdin as a plain-text body across the process boundary', async () => {
    const created = await runCli(
      dataDir,
      ['drafts', 'create', '--to', 'recipient@example.com', '--subject', 'stdin E2E'],
      'body supplied through stdin',
    );

    expect(created.status, created.stderr).toBe(0);
    expect(provider.createDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        to: [{ email: 'recipient@example.com' }],
        subject: 'stdin E2E',
        body: { text: 'body supplied through stdin' },
      }),
    );
    expect(JSON.parse(created.stdout)).toMatchObject({ data: { draftId: 'draft_e2e' } });
  });

  it('uses an explicit account ID with an API key that cannot read mail', async () => {
    const selection = { instance: 'e2e-compose', account: account.id };
    const listed = await runCli(dataDir, ['emails', 'list'], undefined, selection);
    expect(listed.status).toBe(1);
    expect(listed.stderr).toContain('Error [permission_denied]');

    const drafted = await runCli(
      dataDir,
      ['drafts', 'create', '--to', 'recipient@example.com', '--body', 'restricted draft'],
      undefined,
      selection,
    );
    expect(drafted.status, drafted.stderr).toBe(0);

    const sent = await runCli(
      dataDir,
      ['emails', 'send', '--to', 'recipient@example.com', '--body', 'restricted send'],
      undefined,
      selection,
    );
    expect(sent.status, sent.stderr).toBe(0);
  });

  it('passes REST JSON stdin and binary attachments across the process and HTTP boundaries', async () => {
    const modified = await runCli(
      dataDir,
      ['emails', 'modify', '--input', '-'],
      JSON.stringify({ messageIds: ['msg_json_e2e'], action: 'move', folder: 'Projects' }),
    );
    expect(modified.status, modified.stderr).toBe(0);
    expect(provider.modify).toHaveBeenCalledWith(['msg_json_e2e'], { move: 'Projects' });

    const outputPath = path.join(dataDir, 'downloaded-e2e.txt');
    const downloaded = await runCli(dataDir, ['attachments', 'download', 'msg_e2e', 'att_e2e', '--output', outputPath]);
    expect(downloaded.status, downloaded.stderr).toBe(0);
    expect(readFileSync(outputPath, 'utf8')).toBe('e2e');
    expect(provider.getAttachment).toHaveBeenCalledWith('msg_e2e', 'att_e2e', { maxBytes: 1024 });
    expect(JSON.parse(downloaded.stdout)).toMatchObject({
      data: { output: outputPath, mimeType: 'text/plain', sizeBytes: 3 },
    });
  });

  it('schedules, lists, and cancels through the real service and persistence layer', async () => {
    const sendAt = new Date(Date.now() + 60 * 60_000).toISOString();
    const scheduled = await runCli(dataDir, [
      'emails',
      'send',
      '--to',
      'recipient@example.com',
      '--subject',
      'scheduled E2E',
      '--body',
      'scheduled body',
      '--send-at',
      sendAt,
    ]);
    expect(scheduled.status, scheduled.stderr).toBe(0);
    const scheduleId = (JSON.parse(scheduled.stdout) as { data: { scheduleId: string } }).data.scheduleId;
    expect(scheduleId).toMatch(/^sch_/);
    expect(provider.createDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        to: [{ email: 'recipient@example.com' }],
        subject: 'scheduled E2E',
        body: { text: 'scheduled body' },
      }),
    );

    const listed = await runCli(dataDir, ['scheduled', 'list']);
    expect(listed.status, listed.stderr).toBe(0);
    expect(JSON.parse(listed.stdout)).toMatchObject({ data: [{ scheduleId, status: 'pending' }] });

    const canceled = await runCli(dataDir, ['scheduled', 'cancel', scheduleId]);
    expect(canceled.status, canceled.stderr).toBe(0);
    expect(JSON.parse(canceled.stdout)).toEqual({
      data: { scheduleId, draftId: 'draft_e2e', draftKept: true },
    });
  });

  it('runs the local instance path through the real app and IMAP provider without connecting', async () => {
    const localDataDir = mkdtempSync(path.join(tmpdir(), 'fluxmail-cli-mail-local-'));
    vi.stubEnv('FLUXMAIL_DATA_DIR', localDataDir);
    vi.stubEnv('FLUXMAIL_ENCRYPTION_KEY', '55'.repeat(32));
    vi.stubEnv('FLUXMAIL_TELEMETRY', '0');
    const context = createContext();
    const setup = await setupInitialAdmin(context.db, {
      name: 'Local E2E Owner',
      email: 'local@example.com',
      password: 'River42!',
    });
    const localAccount = context.registry.addImapAccount(
      'local@example.com',
      {
        imap: { host: '127.0.0.1', port: 1, security: 'tls', user: 'local', password: 'private' },
        smtp: { host: '127.0.0.1', port: 1, security: 'tls', user: 'local', password: 'private' },
        saveSent: false,
      },
      undefined,
      setup.member.id,
    );
    saveLocalInstance('local');
    saveSessionToken('local', setup.session.token);
    vi.unstubAllEnvs();

    const labels = await runCli(localDataDir, ['labels', 'list'], undefined, {
      instance: 'local',
      account: localAccount.id,
      encryptionKey: '55'.repeat(32),
    });

    expect(labels.status).toBe(1);
    expect(labels.stderr).toContain('Error [unsupported_capability]');
    expect(labels.stderr).toContain('IMAP accounts do not support labels');
  });
});
