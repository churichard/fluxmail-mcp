#!/usr/bin/env node
import { Command } from 'commander';
import { serve } from '@hono/node-server';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { EmailError } from '@fluxmail/core';
import { createContext } from './context.js';
import {
  configFilePath,
  maskStoredConfigValue,
  readStoredConfig,
  resolveDataDir,
  setStoredConfig,
  unsetStoredConfig,
} from './config.js';
import { createApp } from './http/app.js';
import { buildMcpServer } from './mcp/buildServer.js';
import { runLoopbackFlow } from './accounts/googleAuth.js';
import { createApiKey, listApiKeys, revokeApiKey } from './storage/apiKeys.js';
import { addMember, findMember, listMembers, removeMember } from './storage/members.js';
import { activateLicense } from './licensing/activation.js';
import { LICENSE_KEY_PATTERN, releaseLicense } from './licensing/client.js';
import { licensePublicKeys, verifyLease } from './licensing/lease.js';
import {
  checkLicenseState,
  clearLease,
  getEntitlements,
  readLeaseRow,
  type Entitlements,
} from './licensing/entitlements.js';
import { loadInstanceId, refreshLicense, startLicenseRefresher } from './licensing/refresher.js';
import { VERSION } from './version.js';
import { countPending } from './storage/scheduledSends.js';
import type { FluxmailDb } from './storage/db.js';

function planLine(ent: Entitlements): string {
  const members = `${ent.maxMembers} member${ent.maxMembers === 1 ? '' : 's'}`;
  return `${ent.plan} (up to ${ent.maxAccounts} mailboxes, ${members})`;
}

/** Renewal warning for an expiring or lapsed license; printed by every command that opens the db. */
function warnLicense(db: FluxmailDb, log: (line: string) => void = console.error): void {
  const { warning } = checkLicenseState(db);
  if (warning) log(`Warning: ${warning}`);
}

const program = new Command();
program.name('fluxmail').description('Fluxmail, a self-hosted MCP server for your email').version(VERSION);

program
  .command('serve')
  .description('Run the HTTP server (Streamable HTTP MCP at /mcp)')
  .action(() => {
    const ctx = createContext();
    const app = createApp(ctx);
    ctx.scheduler.start();
    serve({ fetch: app.fetch, port: ctx.config.port }, () => {
      console.log(`Fluxmail listening on ${ctx.config.baseUrl}`);
      console.log(`  MCP endpoint:   ${ctx.config.baseUrl}/mcp`);
      console.log(`  Auth mode:      ${ctx.config.authMode}`);
      if (ctx.config.authMode === 'apikey' && listApiKeys(ctx.db).length === 0) {
        console.log('  Note: no API keys exist yet. Run "fluxmail apikey create --name <name>" to create one.');
      }
      const accounts = ctx.registry.listAccounts();
      console.log(
        accounts.length
          ? `  Accounts:       ${accounts.map((a) => `${a.email} (${a.status})`).join(', ')}`
          : '  Accounts:       none (run "fluxmail accounts add gmail")'
      );
      console.log(`  Plan:           ${planLine(getEntitlements(ctx.db))}`);
      warnLicense(ctx.db, console.log);
      startLicenseRefresher({
        db: ctx.db,
        config: ctx.config,
        log: console.log,
        onRefreshed: () => ctx.scheduler.wake(),
      });
    });
  });

program
  .command('stdio')
  .description('Run as a stdio MCP server (for Claude Desktop / Claude Code local config)')
  .action(async () => {
    const ctx = createContext();
    const server = buildMcpServer(ctx.service);
    ctx.scheduler.start();
    await server.connect(new StdioServerTransport());
    // stdout belongs to the MCP protocol; log to stderr only.
    startLicenseRefresher({
      db: ctx.db,
      config: ctx.config,
      log: console.error,
      onRefreshed: () => ctx.scheduler.wake(),
    });
    console.error('Fluxmail MCP server running on stdio');
    warnLicense(ctx.db);
    const { pending } = countPending(ctx.db);
    if (pending > 0) console.error(`Scheduled sends pending: ${pending}`);
  });

const accounts = program.command('accounts').description('Manage connected email accounts');

accounts
  .command('add')
  .argument('<provider>', 'Email provider (currently: gmail)')
  .option('--reauthorize <account-id>', 'Reconnect an existing account')
  .option('--member <member>', 'Member (id or email) who owns the new mailbox; omit for a shared mailbox')
  .description('Connect an account via OAuth (opens a browser consent flow)')
  .action(async (provider: string, opts: { reauthorize?: string; member?: string }) => {
    if (provider !== 'gmail') {
      console.error(`Provider "${provider}" is not supported yet. Available: gmail`);
      process.exitCode = 1;
      return;
    }
    const ctx = createContext();
    warnLicense(ctx.db);
    try {
      if (opts.reauthorize && opts.member) {
        throw new EmailError(
          'invalid_request',
          '--member cannot be combined with --reauthorize; use "fluxmail accounts assign" to change ownership.'
        );
      }
      // Resolve before the OAuth flow so a typo fails fast.
      const member = opts.member ? findMember(ctx.db, opts.member) : undefined;
      const existing = opts.reauthorize ? ctx.registry.getAccount(opts.reauthorize) : undefined;
      if (existing && existing.provider !== provider) {
        throw new EmailError(
          'invalid_request',
          `Account ${existing.id} uses ${existing.provider}, not ${provider}.`
        );
      }
      if (!existing) ctx.registry.assertCanAddAccount();

      const account = await runLoopbackFlow(
        ctx.config,
        (url) => {
          console.log('\nOpen this URL in your browser to authorize Gmail access:\n');
          console.log(`  ${url}\n`);
          console.log('Waiting for Google to redirect back…');
        },
        (result) => {
          if (existing && result.email !== existing.email) {
            throw new EmailError(
              'invalid_request',
              `Google authorized ${result.email}, but account ${existing.id} belongs to ${existing.email}. ` +
                'Try again and choose the matching Google account.'
            );
          }
          return ctx.registry.addGmailAccount(result.email, result.tokens, result.displayName, member?.id);
        }
      );
      console.log(
        `\nConnected ${account.email} (account id: ${account.id})` +
          (member && account.memberId === member.id ? ` for member ${member.name}` : '')
      );
      if (member && account.memberId !== member.id) {
        // The mailbox was already connected; re-auth keeps its existing owner.
        console.log(
          `${account.email} was already connected, so its ownership is unchanged. ` +
            `To assign it to ${member.name}, run "fluxmail accounts assign ${account.id} --member ${member.id}".`
        );
      }
    } catch (err) {
      console.error(`\nError: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  });

accounts
  .command('list')
  .description('List connected accounts')
  .action(() => {
    const ctx = createContext();
    warnLicense(ctx.db);
    const all = ctx.registry.listAccounts();
    if (!all.length) {
      console.log('No accounts connected. Run "fluxmail accounts add gmail".');
      return;
    }
    const memberNames = new Map(listMembers(ctx.db).map((m) => [m.id, m.name]));
    for (const a of all) {
      const owner = a.memberId ? (memberNames.get(a.memberId) ?? a.memberId) : 'shared';
      console.log(`${a.id}  ${a.provider}  ${a.email}  [${a.status}]  owner=${owner}`);
    }
  });

accounts
  .command('remove')
  .argument('<accountId>')
  .description('Disconnect an account and delete its stored tokens')
  .action((accountId: string) => {
    const ctx = createContext();
    warnLicense(ctx.db);
    ctx.registry.removeAccount(accountId);
    console.log(`Removed ${accountId}`);
  });

accounts
  .command('assign')
  .argument('<accountId>')
  .option('--member <member>', 'Member (id or email) to own the mailbox')
  .option('--shared', 'Make the mailbox shared across the instance')
  .description('Assign a mailbox to a member, or make it shared')
  .action((accountId: string, opts: { member?: string; shared?: boolean }) => {
    const ctx = createContext();
    warnLicense(ctx.db);
    try {
      if (!opts.member === !opts.shared) {
        throw new EmailError('invalid_request', 'Pass exactly one of --member <member> or --shared.');
      }
      const member = opts.member ? findMember(ctx.db, opts.member) : undefined;
      const account = ctx.registry.assignAccountMember(accountId, member?.id ?? null);
      console.log(
        member
          ? `${account.email} is now owned by ${member.name}`
          : `${account.email} is now shared`
      );
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  });

const membersCmd = program.command('members').description('Manage members (people using this instance)');

membersCmd
  .command('add')
  .requiredOption('--name <name>', 'Member name')
  .option('--email <email>', 'Member email, usable as a shorthand in --member flags')
  .description('Add a member (subject to the plan seat limit)')
  .action((opts: { name: string; email?: string }) => {
    const ctx = createContext();
    warnLicense(ctx.db);
    try {
      const member = addMember(ctx.db, { name: opts.name, ...(opts.email ? { email: opts.email } : {}) });
      console.log(`Added member ${member.name} (id: ${member.id})`);
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  });

membersCmd
  .command('list')
  .description('List members with their mailbox and API key counts')
  .action(() => {
    const ctx = createContext();
    warnLicense(ctx.db);
    const all = listMembers(ctx.db);
    if (!all.length) {
      console.log('No members. Run "fluxmail members add --name <name>".');
      return;
    }
    for (const m of all) {
      console.log(
        `${m.id}  ${m.name}  email=${m.email ?? '-'}  mailboxes=${m.accountCount}  keys=${m.apiKeyCount}`
      );
    }
  });

membersCmd
  .command('remove')
  .argument('<memberId>')
  .description('Remove a member; their mailboxes become shared and their API keys are revoked')
  .action((memberId: string) => {
    const ctx = createContext();
    warnLicense(ctx.db);
    try {
      const { name, freedAccounts, revokedApiKeys } = removeMember(ctx.db, memberId);
      console.log(
        `Removed ${name}. ${freedAccounts} mailbox(es) are now shared and ${revokedApiKeys} API key(s) revoked.`
      );
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  });

const apikey = program.command('apikey').description('Manage API keys for the HTTP MCP endpoint');

apikey
  .command('create')
  .requiredOption('--name <name>', 'Human-readable key name')
  .option('--member <member>', 'Member (id or email) the key is issued to')
  .description('Create an API key (shown once)')
  .action((opts: { name: string; member?: string }) => {
    const ctx = createContext();
    warnLicense(ctx.db);
    try {
      const member = opts.member ? findMember(ctx.db, opts.member) : undefined;
      const { key, info } = createApiKey(ctx.db, opts.name, member?.id);
      console.log(
        `Created API key "${info.name}" (id: ${info.id})` + (member ? ` for member ${member.name}` : '') + '\n'
      );
      console.log(`  ${key}\n`);
      console.log('Store it now; it cannot be shown again.');
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  });

apikey
  .command('list')
  .description('List API keys')
  .action(() => {
    const ctx = createContext();
    warnLicense(ctx.db);
    const keys = listApiKeys(ctx.db);
    if (!keys.length) {
      console.log('No API keys. Run "fluxmail apikey create --name <name>".');
      return;
    }
    const memberNames = new Map(listMembers(ctx.db).map((m) => [m.id, m.name]));
    for (const k of keys) {
      const lastUsed = k.lastUsedAt ? new Date(k.lastUsedAt).toISOString() : 'never';
      const member = k.memberId ? (memberNames.get(k.memberId) ?? k.memberId) : '-';
      console.log(
        `${k.id}  ${k.name}  member=${member}  created=${new Date(k.createdAt).toISOString()}  lastUsed=${lastUsed}`
      );
    }
  });

apikey
  .command('revoke')
  .argument('<keyId>')
  .description('Revoke an API key')
  .action((keyId: string) => {
    const ctx = createContext();
    warnLicense(ctx.db);
    console.log(revokeApiKey(ctx.db, keyId) ? `Revoked ${keyId}` : `No key with id ${keyId}`);
  });

const license = program.command('license').description('Manage the paid-tier license');

license
  .command('activate')
  .argument('<key>', 'License key (fluxmail_lic_…), shown once at purchase')
  .description('Store a license key and validate it with the license server')
  .action(async (key: string) => {
    if (!LICENSE_KEY_PATTERN.test(key)) {
      console.error(
        'That does not look like a Fluxmail license key (expected "fluxmail_lic_" followed by 40 hex characters).'
      );
      process.exitCode = 1;
      return;
    }
    const dataDir = resolveDataDir();
    const overridingKey = process.env.FLUXMAIL_LICENSE_KEY?.trim();
    if (overridingKey && overridingKey !== key) {
      console.error(
        'FLUXMAIL_LICENSE_KEY is already set by the shell or a .env file, which takes precedence over stored settings. Remove it before activating a different key.'
      );
      process.exitCode = 1;
      return;
    }
    const ctx = createContext();
    const result = await activateLicense(ctx.db, {
      licenseKey: key,
      serverUrl: ctx.config.licenseServerUrl,
      dataDir,
    });
    if (result.outcome === 'refreshed') {
      const { lease } = result;
      console.log(
        `License activated: ${lease.plan} plan, up to ${lease.maxAccounts} mailboxes and ` +
          `${lease.maxMembers} member${lease.maxMembers === 1 ? '' : 's'}.`
      );
      console.log(
        `The lease is valid until ${lease.expiresAt} and renews automatically while the server runs.`
      );
      return;
    }
    console.error(result.message);
    if (result.outcome === 'outage') {
      console.error('The key is saved; validation will be retried automatically once the server can reach it.');
    } else {
      process.exitCode = 1;
    }
  });

license
  .command('status')
  .description('Show the configured license and cached lease')
  .action(() => {
    const ctx = createContext();
    if (ctx.config.licenseKey) {
      console.log(`License key: ${maskStoredConfigValue('FLUXMAIL_LICENSE_KEY', ctx.config.licenseKey)}`);
    } else {
      console.log('No license key configured. Run "fluxmail license activate <key>" after purchasing one.');
    }
    const row = readLeaseRow(ctx.db);
    if (row) {
      console.log(`Last validated: ${new Date(row.updatedAt).toISOString()}`);
      try {
        const lease = verifyLease(row.token, licensePublicKeys(), new Date(), { allowExpired: true });
        const expired = Date.parse(lease.expiresAt) <= Date.now();
        console.log(
          `Lease ${expired ? 'expired' : 'valid until'} ${lease.expiresAt}: ${lease.plan} plan, ` +
            `up to ${lease.maxAccounts} mailboxes and ${lease.maxMembers} member${lease.maxMembers === 1 ? '' : 's'}.`
        );
      } catch (err) {
        console.log(`Cached lease is not usable (${err instanceof Error ? err.message : String(err)}).`);
      }
    } else {
      console.log('No cached lease.');
    }
    console.log(`Current plan: ${planLine(getEntitlements(ctx.db))}`);
    warnLicense(ctx.db, console.log);
  });

license
  .command('deactivate')
  .description('Release the license from this instance and remove the stored key and cached lease')
  .action(async () => {
    const dataDir = resolveDataDir();
    // Captured before createContext() merges the stored config into the
    // environment: truthy only when the key comes from the shell or a .env file.
    const envLicenseKey = process.env.FLUXMAIL_LICENSE_KEY?.trim();
    const ctx = createContext();
    // Best effort: free the server-side instance binding so the key can be
    // activated elsewhere. Local deactivation proceeds either way.
    if (ctx.config.licenseKey) {
      const released = await releaseLicense({
        serverUrl: ctx.config.licenseServerUrl,
        licenseKey: ctx.config.licenseKey,
        instanceId: loadInstanceId(dataDir),
      });
      console.log(
        released
          ? 'Released the license from this instance; it can now be activated elsewhere.'
          : 'Could not reach the license server to release this instance; unused bindings are released automatically after a while.'
      );
    }
    const removed = unsetStoredConfig(dataDir, 'FLUXMAIL_LICENSE_KEY');
    clearLease(ctx.db);
    console.log(
      removed
        ? 'License removed; this instance is back to Personal-plan limits.'
        : 'No stored license key; cleared any cached lease.'
    );
    if (envLicenseKey) {
      console.log('Note: FLUXMAIL_LICENSE_KEY is still set in the environment or a .env file.');
    }
  });

const configCmd = program
  .command('config')
  .description('Persistent settings stored in the data dir, usable from any directory');

configCmd
  .command('set')
  .argument('<key>', 'Setting name, e.g. GOOGLE_CLIENT_ID')
  .argument('<value>')
  .description('Store a setting (shell env vars and local .env files still take precedence)')
  .action((key: string, value: string) => {
    try {
      const dataDir = resolveDataDir();
      setStoredConfig(dataDir, key, value);
      console.log(`Set ${key} in ${configFilePath(dataDir)}`);
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  });

configCmd
  .command('unset')
  .argument('<key>')
  .description('Remove a stored setting')
  .action((key: string) => {
    const dataDir = resolveDataDir();
    console.log(unsetStoredConfig(dataDir, key) ? `Removed ${key}` : `${key} is not set`);
  });

configCmd
  .command('list')
  .description('Show stored settings (secret values are masked)')
  .action(() => {
    const dataDir = resolveDataDir();
    const stored = readStoredConfig(dataDir);
    const keys = Object.keys(stored);
    if (!keys.length) {
      console.log(`No stored settings. Run "fluxmail config set <KEY> <value>" (file: ${configFilePath(dataDir)}).`);
      return;
    }
    for (const key of keys) {
      const value = stored[key] ?? '';
      console.log(`${key}=${maskStoredConfigValue(key, value)}`);
    }
  });

program
  .command('status')
  .description('Show accounts, members, entitlements, and provider availability')
  .action(async () => {
    const ctx = createContext();
    warnLicense(ctx.db);
    console.log(JSON.stringify(await ctx.service.status(), null, 2));
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
