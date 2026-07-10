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
import { LICENSE_KEY_PATTERN } from './licensing/client.js';
import { licensePublicKeys, verifyLease } from './licensing/lease.js';
import { clearLease, getEntitlements, readLeaseRow } from './licensing/entitlements.js';
import { refreshLicense, startLicenseRefresher } from './licensing/refresher.js';
import { countPending } from './storage/scheduledSends.js';

const program = new Command();
program.name('fluxmail').description('Fluxmail, a self-hosted MCP server for your email').version('0.1.0');

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
      const entitlements = getEntitlements(ctx.db);
      console.log(
        `  Plan:           ${
          entitlements.tier === 'paid'
            ? `paid (up to ${entitlements.maxAccounts} accounts)`
            : 'free tier (1 account)'
        }`
      );
      startLicenseRefresher({ db: ctx.db, config: ctx.config, log: console.log });
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
    startLicenseRefresher({ db: ctx.db, config: ctx.config, log: console.error });
    console.error('Fluxmail MCP server running on stdio');
    const { pending } = countPending(ctx.db);
    if (pending > 0) console.error(`Scheduled sends pending: ${pending}`);
  });

const accounts = program.command('accounts').description('Manage connected email accounts');

accounts
  .command('add')
  .argument('<provider>', 'Email provider (currently: gmail)')
  .option('--reauthorize <account-id>', 'Reconnect an existing account')
  .description('Connect an account via OAuth (opens a browser consent flow)')
  .action(async (provider: string, opts: { reauthorize?: string }) => {
    if (provider !== 'gmail') {
      console.error(`Provider "${provider}" is not supported yet. Available: gmail`);
      process.exitCode = 1;
      return;
    }
    const ctx = createContext();
    try {
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
          return ctx.registry.addGmailAccount(result.email, result.tokens, result.displayName);
        }
      );
      console.log(`\nConnected ${account.email} (account id: ${account.id})`);
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
    const all = ctx.registry.listAccounts();
    if (!all.length) {
      console.log('No accounts connected. Run "fluxmail accounts add gmail".');
      return;
    }
    for (const a of all) console.log(`${a.id}  ${a.provider}  ${a.email}  [${a.status}]`);
  });

accounts
  .command('remove')
  .argument('<accountId>')
  .description('Disconnect an account and delete its stored tokens')
  .action((accountId: string) => {
    const ctx = createContext();
    ctx.registry.removeAccount(accountId);
    console.log(`Removed ${accountId}`);
  });

const apikey = program.command('apikey').description('Manage API keys for the HTTP MCP endpoint');

apikey
  .command('create')
  .requiredOption('--name <name>', 'Human-readable key name')
  .description('Create an API key (shown once)')
  .action((opts: { name: string }) => {
    const ctx = createContext();
    try {
      const { key, info } = createApiKey(ctx.db, opts.name);
      console.log(`Created API key "${info.name}" (id: ${info.id})\n`);
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
    const keys = listApiKeys(ctx.db);
    if (!keys.length) {
      console.log('No API keys. Run "fluxmail apikey create --name <name>".');
      return;
    }
    for (const k of keys) {
      const lastUsed = k.lastUsedAt ? new Date(k.lastUsedAt).toISOString() : 'never';
      console.log(`${k.id}  ${k.name}  created=${new Date(k.createdAt).toISOString()}  lastUsed=${lastUsed}`);
    }
  });

apikey
  .command('revoke')
  .argument('<keyId>')
  .description('Revoke an API key')
  .action((keyId: string) => {
    const ctx = createContext();
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
    setStoredConfig(dataDir, 'FLUXMAIL_LICENSE_KEY', key);
    const ctx = createContext();
    const result = await refreshLicense(ctx.db, {
      licenseKey: key,
      serverUrl: ctx.config.licenseServerUrl,
      dataDir: ctx.config.dataDir,
    });
    if (result.outcome === 'refreshed') {
      console.log(`License activated: up to ${result.lease.maxAccounts} accounts.`);
      console.log(
        `The lease is valid until ${result.lease.expiresAt} and renews automatically while the server runs.`
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
        const lease = verifyLease(row.token, licensePublicKeys());
        console.log(`Lease valid until ${lease.expiresAt}: up to ${lease.maxAccounts} accounts.`);
      } catch (err) {
        console.log(`Cached lease is not usable (${err instanceof Error ? err.message : String(err)}).`);
      }
    } else {
      console.log('No cached lease.');
    }
    console.log(`Current plan: ${getEntitlements(ctx.db).tier}`);
  });

license
  .command('deactivate')
  .description('Remove the stored license key and cached lease (back to free-tier limits)')
  .action(() => {
    const dataDir = resolveDataDir();
    const removed = unsetStoredConfig(dataDir, 'FLUXMAIL_LICENSE_KEY');
    const ctx = createContext();
    clearLease(ctx.db);
    console.log(
      removed
        ? 'License removed; this instance is back to free-tier limits.'
        : 'No stored license key; cleared any cached lease.'
    );
    if (ctx.config.licenseKey) {
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
  .description('Show accounts, entitlements, and provider availability')
  .action(async () => {
    const ctx = createContext();
    console.log(JSON.stringify(await ctx.service.status(), null, 2));
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
