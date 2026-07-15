#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { emitKeypressEvents } from 'node:readline';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Command } from 'commander';
import { serve } from '@hono/node-server';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { EmailError, type AccountSharingMode } from '@fluxmail/core';
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
import { runMicrosoftLoopbackFlow } from './accounts/microsoftAuth.js';
import {
  prepareHostedGmailConnection,
  prepareHostedOutlookConnection,
  selectGmailConnectionMode,
  validateAccountConnectionFlags,
} from './accounts/gmailConnection.js';
import {
  createApiKey,
  listApiKeys,
  revokeApiKey,
  updateApiKeyAccounts,
  updateApiKeyPermissions,
} from './storage/apiKeys.js';
import { addMember, findMember, listMembers, removeMember, setMemberRole, type MemberRole } from './storage/members.js';
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
import { loadInstanceId, startLicenseRefresher } from './licensing/refresher.js';
import { VERSION } from './version.js';
import type { FluxmailDb } from './storage/db.js';
import type { ImapCredentials, ImapSecurity } from '@fluxmail/provider-imap';
import {
  customPermissionPolicy,
  FULL_PERMISSION_POLICY,
  isNamedPermissionProfile,
  MCP_CAPABILITIES,
  NAMED_PERMISSION_PROFILES,
  permissionPolicyForProfile,
  type PermissionPolicy,
} from './permissions.js';
import {
  getTelemetry,
  installTelemetryStreamEndHandler,
  isTelemetryEnabled,
  setTelemetryEnabled,
  shutdownTelemetry,
} from './telemetry.js';

interface AddAccountOptions {
  reauthorize?: string;
  owner?: string;
  member?: string;
  shared?: boolean;
  shareWith: string[];
  local?: boolean;
  hosted?: boolean;
  email?: string;
  displayName?: string;
  imapHost?: string;
  imapPort: string;
  imapSecurity: string;
  imapUser?: string;
  imapPasswordEnv?: string;
  smtpHost?: string;
  smtpPort: string;
  smtpSecurity: string;
  smtpUser?: string;
  smtpPasswordEnv?: string;
  sentFolder?: string;
  draftsFolder?: string;
  trashFolder?: string;
  archiveFolder?: string;
  spamFolder?: string;
  saveSent: boolean;
}

interface PermissionOptions {
  profile?: string;
  allow: string[];
}

interface ScopedMcpOptions extends PermissionOptions {
  member: string;
  account: string[];
}

function collectOption(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function accountIdsFromRefs(ctx: ReturnType<typeof createContext>, refs: readonly string[]): string[] | null {
  return refs.length ? [...new Set(refs.map((ref) => ctx.registry.findAccount(ref).id))] : null;
}

function sharingMode(shared: boolean | undefined, sharedMemberIds: readonly string[]): AccountSharingMode {
  if (shared) return 'all';
  if (sharedMemberIds.length) return 'selected';
  return 'private';
}

export function permissionPolicyFromOptions(opts: PermissionOptions, requireSelection = false): PermissionPolicy {
  if (opts.profile && opts.allow.length) {
    throw new Error('--profile cannot be combined with --allow.');
  }
  if (opts.profile) {
    if (!isNamedPermissionProfile(opts.profile)) {
      throw new Error(`Unknown profile "${opts.profile}". Expected one of: ${NAMED_PERMISSION_PROFILES.join(', ')}.`);
    }
    return permissionPolicyForProfile(opts.profile);
  }
  if (opts.allow.length) return customPermissionPolicy(opts.allow);
  if (requireSelection) throw new Error('Choose --profile or at least one --allow capability.');
  return FULL_PERMISSION_POLICY;
}

function connectionPort(value: string, option: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new EmailError('invalid_request', `${option} must be an integer between 1 and 65535.`);
  }
  return port;
}

function connectionSecurity(value: string, option: string): ImapSecurity {
  if (value !== 'tls' && value !== 'starttls') {
    throw new EmailError('invalid_request', `${option} must be "tls" or "starttls".`);
  }
  return value;
}

async function hiddenPrompt(label: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdin.setRawMode) {
    throw new EmailError('invalid_request', `${label} must be supplied through a password environment variable.`);
  }
  emitKeypressEvents(process.stdin);
  const wasRaw = process.stdin.isRaw;
  const wasPaused = process.stdin.isPaused();
  process.stdout.write(`${label}: `);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise<string>((resolve, reject) => {
    let value = '';
    const finish = (error?: Error) => {
      process.stdin.off('keypress', onKeypress);
      process.stdin.setRawMode(wasRaw);
      if (wasPaused) process.stdin.pause();
      process.stdout.write('\n');
      if (error) reject(error);
      else resolve(value);
    };
    const onKeypress = (input: string, key: { name?: string; ctrl?: boolean }) => {
      if (key.ctrl && key.name === 'c') return finish(new Error('Canceled'));
      if (key.name === 'return' || key.name === 'enter') return finish();
      if (key.name === 'backspace') {
        if (value) {
          value = value.slice(0, -1);
          process.stdout.write('\b \b');
        }
        return;
      }
      if (key.ctrl || !input) return;
      value += input;
      process.stdout.write('*'.repeat([...input].length));
    };
    process.stdin.on('keypress', onKeypress);
  });
}

async function accountSecret(envName: string | undefined, label: string): Promise<string> {
  if (!envName) return hiddenPrompt(label);
  const value = process.env[envName];
  if (!value) throw new EmailError('invalid_request', `${envName} is not set or is empty.`);
  return value;
}

function planLine(ent: Entitlements): string {
  const members = `${ent.maxMembers} member${ent.maxMembers === 1 ? '' : 's'}`;
  return `${ent.plan} (up to ${ent.maxAccounts} mailboxes, ${members})`;
}

/** Renewal warning for an expiring or lapsed license; printed by every command that opens the db. */
function warnLicense(db: FluxmailDb, log: (line: string) => void = console.error): void {
  const { warning } = checkLicenseState(db);
  if (warning) log(`Warning: ${warning}`);
}

/** Build the command tree without parsing arguments or running command actions. */
export function createCliProgram(): Command {
  const program = new Command();
  program
    .name('fluxmail')
    .description('Fluxmail, a self-hosted MCP server for your email')
    .version(VERSION, '-v, --version');

  function commandPath(command: Command): string {
    const names: string[] = [];
    for (let current: Command | null = command; current?.parent; current = current.parent)
      names.unshift(current.name());
    return names.join(' ');
  }

  let telemetrySignalHandlersInstalled = false;
  const TELEMETRY_SIGNAL_SHUTDOWN_TIMEOUT_MS = 1_000;

  /** Flush queued telemetry before restoring Node's default signal behavior. */
  function installTelemetrySignalHandlers(): void {
    if (telemetrySignalHandlersInstalled) return;
    telemetrySignalHandlersInstalled = true;

    const shutdownAndResignal = (signal: NodeJS.Signals): void => {
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigterm);
      process.off('SIGHUP', onSighup);
      let resignaled = false;
      const resignal = (): void => {
        if (resignaled) return;
        resignaled = true;
        process.kill(process.pid, signal);
      };
      const timeout = setTimeout(resignal, TELEMETRY_SIGNAL_SHUTDOWN_TIMEOUT_MS);
      void shutdownTelemetry().finally(() => {
        clearTimeout(timeout);
        resignal();
      });
    };
    const onSigint = (): void => shutdownAndResignal('SIGINT');
    const onSigterm = (): void => shutdownAndResignal('SIGTERM');
    const onSighup = (): void => shutdownAndResignal('SIGHUP');

    process.once('SIGINT', onSigint);
    process.once('SIGTERM', onSigterm);
    process.once('SIGHUP', onSighup);
  }

  program.hook('preAction', (_command, actionCommand) => {
    const command = commandPath(actionCommand);
    // Respect the opt-out before creating a telemetry client or recording this command.
    if (command === 'telemetry disable') return;
    const dataDir = resolveDataDir();
    getTelemetry(dataDir).capture('cli command used', {
      product_surface: 'cli',
      command,
    });
  });

  program.hook('postAction', async (_command, actionCommand) => {
    if (actionCommand.name() !== 'serve' && actionCommand.name() !== 'stdio') await shutdownTelemetry();
  });

  program
    .command('serve')
    .description('Run the HTTP server (Streamable HTTP MCP at /mcp)')
    .action(() => {
      installTelemetrySignalHandlers();
      const ctx = createContext();
      const app = createApp(ctx);
      ctx.scheduler.start();
      serve({ fetch: app.fetch, port: ctx.config.port }, () => {
        ctx.telemetry.capture('mcp server started', { product_surface: 'mcp', transport: 'http' });
        console.log(`Fluxmail listening on ${ctx.config.publicUrl}`);
        console.log(`  MCP endpoint:   ${ctx.config.publicUrl}/mcp`);
        console.log(`  Auth mode:      ${ctx.config.authMode}`);
        if (ctx.config.authMode === 'apikey' && listApiKeys(ctx.db).length === 0) {
          console.log(
            '  Note: no API keys exist yet. Run "fluxmail apikey create --name <name> --member <member>" to create one.',
          );
        }
        const accounts = ctx.registry.listAccounts();
        console.log(
          accounts.length
            ? `  Accounts:       ${accounts.map((a) => `${a.email} (${a.status})`).join(', ')}`
            : '  Accounts:       none (run "fluxmail accounts add gmail --owner <member>", "fluxmail accounts add outlook --owner <member>", or the IMAP equivalent)',
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
    .requiredOption('--member <member>', 'Member (id or email) using this MCP process')
    .option('--account <account>', 'Limit access to one mailbox; repeat as needed', collectOption, [])
    .option('--profile <profile>', `Tool profile: ${NAMED_PERMISSION_PROFILES.join(', ')}`)
    .option('--allow <capability>', 'Allow one MCP capability; repeat as needed', collectOption, [])
    .action(async (opts: ScopedMcpOptions) => {
      installTelemetrySignalHandlers();
      installTelemetryStreamEndHandler(process.stdin);
      const ctx = createContext();
      const permissions = permissionPolicyFromOptions(opts);
      const member = findMember(ctx.db, opts.member);
      const accountIds = accountIdsFromRefs(ctx, opts.account);
      const scopedService = ctx.service.withScope({ memberId: member.id, role: member.role, accountIds });
      const server = buildMcpServer(scopedService, {
        permissions,
        maxAttachmentBytes: ctx.config.maxAttachmentBytes,
        telemetry: ctx.telemetry,
        transport: 'stdio',
      });
      ctx.scheduler.start();
      await server.connect(new StdioServerTransport());
      ctx.telemetry.capture('mcp server started', { product_surface: 'mcp', transport: 'stdio' });
      // stdout belongs to the MCP protocol; log to stderr only.
      startLicenseRefresher({
        db: ctx.db,
        config: ctx.config,
        log: console.error,
        onRefreshed: () => ctx.scheduler.wake(),
      });
      console.error('Fluxmail MCP server running on stdio');
      warnLicense(ctx.db);
      const pending = scopedService.listScheduled().filter((send) => send.status === 'pending').length;
      if (pending > 0) console.error(`Scheduled sends pending: ${pending}`);
    });

  const accounts = program.command('accounts').description('Manage connected email accounts');

  accounts
    .command('add')
    .argument('<provider>', 'Email provider: gmail, outlook, or imap')
    .option('--reauthorize <account-id>', 'Reconnect an existing account')
    .option('--owner <member>', 'Member (id or email) who owns the new mailbox')
    .option('--member <member>', 'Deprecated alias for --owner')
    .option('--shared', 'Share the mailbox with every member')
    .option('--share-with <member>', 'Share with one member; repeat as needed', collectOption, [])
    .option('--local', 'Use the local browser callback for OAuth')
    .option('--hosted', 'Use FLUXMAIL_PUBLIC_URL for the OAuth callback')
    .option('--email <address>', 'Mailbox address (required for IMAP)')
    .option('--display-name <name>', 'Sender name for IMAP messages')
    .option('--imap-host <host>', 'IMAP server hostname')
    .option('--imap-port <port>', 'IMAP server port', '993')
    .option('--imap-security <mode>', 'IMAP security: tls or starttls', 'tls')
    .option('--imap-user <user>', 'IMAP username; defaults to the mailbox address')
    .option('--imap-password-env <name>', 'Read the IMAP password from this environment variable')
    .option('--smtp-host <host>', 'SMTP server hostname')
    .option('--smtp-port <port>', 'SMTP server port', '587')
    .option('--smtp-security <mode>', 'SMTP security: tls or starttls', 'starttls')
    .option('--smtp-user <user>', 'SMTP username; defaults to the IMAP username')
    .option('--smtp-password-env <name>', 'Read a separate SMTP password from this environment variable')
    .option('--sent-folder <path>', 'Sent mailbox path')
    .option('--drafts-folder <path>', 'Drafts mailbox path')
    .option('--trash-folder <path>', 'Trash mailbox path')
    .option('--archive-folder <path>', 'Archive mailbox path')
    .option('--spam-folder <path>', 'Spam mailbox path')
    .option('--no-save-sent', 'Do not append SMTP submissions to the Sent folder')
    .description('Connect a Gmail, Outlook, or IMAP account')
    .action(async (providerInput: string, opts: AddAccountOptions, command: Command) => {
      const provider = providerInput === 'microsoft' ? 'outlook' : providerInput;
      if (provider !== 'gmail' && provider !== 'outlook' && provider !== 'imap') {
        console.error(`Provider "${providerInput}" is not supported. Available: gmail, outlook, imap`);
        process.exitCode = 1;
        return;
      }
      const ctx = createContext();
      warnLicense(ctx.db);
      try {
        validateAccountConnectionFlags(provider, opts);
        if (opts.owner && opts.member) {
          throw new EmailError('invalid_request', '--owner and --member cannot be combined. Use --owner.');
        }
        if (opts.shared && opts.shareWith.length) {
          throw new EmailError('invalid_request', '--shared and --share-with cannot be combined.');
        }
        const ownerRef = opts.owner ?? opts.member;
        if (opts.member) console.error('Warning: --member is deprecated; use --owner.');
        if (opts.reauthorize && (ownerRef || opts.shared || opts.shareWith.length)) {
          throw new EmailError(
            'invalid_request',
            'Ownership and sharing options cannot be combined with --reauthorize. Use "fluxmail accounts assign" or "fluxmail accounts access".',
          );
        }
        // Resolve before the OAuth flow so a typo fails fast.
        const owner = ownerRef ? findMember(ctx.db, ownerRef) : undefined;
        const existing = opts.reauthorize ? ctx.registry.getAccount(opts.reauthorize) : undefined;
        if (existing && existing.provider !== provider) {
          throw new EmailError('invalid_request', `Account ${existing.id} uses ${existing.provider}, not ${provider}.`);
        }
        if (!existing) ctx.registry.assertCanAddAccount();
        if (!existing && !owner) {
          throw new EmailError('invalid_request', '--owner <id-or-email> is required when connecting a mailbox.');
        }
        const sharedMemberIds = opts.shareWith.map((ref) => findMember(ctx.db, ref).id);
        const access = {
          sharingMode: sharingMode(opts.shared, sharedMemberIds),
          sharedMemberIds,
        };

        if (provider === 'imap') {
          const previousCredentials = existing ? ctx.registry.loadImapCredentials(existing.id) : undefined;
          const email = opts.email?.trim();
          if (!email || !email.includes('@'))
            throw new EmailError('invalid_request', '--email must be a mailbox address.');
          if (!opts.imapHost) throw new EmailError('invalid_request', '--imap-host is required for IMAP accounts.');
          if (!opts.smtpHost) throw new EmailError('invalid_request', '--smtp-host is required for IMAP accounts.');
          if (existing && existing.email !== email) {
            throw new EmailError(
              'invalid_request',
              `Account ${existing.id} belongs to ${existing.email}, not ${email}.`,
            );
          }
          const imapPassword = await accountSecret(opts.imapPasswordEnv, 'IMAP password');
          const smtpPassword = opts.smtpPasswordEnv
            ? await accountSecret(opts.smtpPasswordEnv, 'SMTP password')
            : imapPassword;
          const imapUser = opts.imapUser ?? email;
          const credentials: ImapCredentials = {
            imap: {
              host: opts.imapHost,
              port: connectionPort(opts.imapPort, '--imap-port'),
              security: connectionSecurity(opts.imapSecurity, '--imap-security'),
              user: imapUser,
              password: imapPassword,
            },
            smtp: {
              host: opts.smtpHost,
              port: connectionPort(opts.smtpPort, '--smtp-port'),
              security: connectionSecurity(opts.smtpSecurity, '--smtp-security'),
              user: opts.smtpUser ?? imapUser,
              password: smtpPassword,
            },
            saveSent:
              previousCredentials && command.getOptionValueSource('saveSent') === 'default'
                ? previousCredentials.saveSent
                : opts.saveSent,
            folderOverrides: {
              ...previousCredentials?.folderOverrides,
              ...(opts.sentFolder ? { sent: opts.sentFolder } : {}),
              ...(opts.draftsFolder ? { drafts: opts.draftsFolder } : {}),
              ...(opts.trashFolder ? { trash: opts.trashFolder } : {}),
              ...(opts.archiveFolder ? { archive: opts.archiveFolder } : {}),
              ...(opts.spamFolder ? { spam: opts.spamFolder } : {}),
            },
          };
          console.log('Checking IMAP and SMTP settings...');
          const warnings = await ctx.registry.testImapCredentials(email, credentials, opts.displayName);
          const account = ctx.registry.addImapAccount(
            email,
            credentials,
            opts.displayName,
            owner?.id,
            opts.reauthorize,
            access,
          );
          console.log(`Connected ${account.email} (account id: ${account.id})`);
          for (const warning of warnings) console.log(`Warning: ${warning.message}.`);
          return;
        }

        if (provider === 'outlook') {
          const connectionMode = selectGmailConnectionMode(ctx.config, opts);
          if (connectionMode === 'hosted') {
            const { connectionUrl } = prepareHostedOutlookConnection(ctx.db, ctx.config, {
              ...(owner ? { memberId: owner.id } : {}),
              ...(existing ? { reauthorizeAccountId: existing.id } : {}),
              ...(!existing ? { sharingMode: access.sharingMode, sharedMemberIds: access.sharedMemberIds } : {}),
            });
            console.log('\nOpen this URL in your browser to connect Outlook:\n');
            console.log(`  ${connectionUrl}\n`);
            console.log('This link expires in 10 minutes and can only be used once.');
            return;
          }

          const account = await runMicrosoftLoopbackFlow(
            ctx.config,
            (url) => {
              console.log('\nOpen this URL in your browser to authorize Microsoft mail access:\n');
              console.log(`  ${url}\n`);
              console.log('Waiting for Microsoft to redirect back...');
            },
            (result) => {
              if (existing && result.email.toLowerCase() !== existing.email.toLowerCase()) {
                throw new EmailError(
                  'invalid_request',
                  `Microsoft authorized ${result.email}, but account ${existing.id} belongs to ${existing.email}. ` +
                    'Try again and choose the matching Microsoft account.',
                );
              }
              return ctx.registry.addOutlookAccount(
                result.email,
                result.credentials,
                result.displayName,
                owner?.id,
                existing?.id,
                access,
              );
            },
          );
          console.log(
            `\nConnected ${account.email} (account id: ${account.id})` +
              (owner && account.ownerId === owner.id ? ` for member ${owner.name}` : ''),
          );
          return;
        }

        const gmailConnectionMode = selectGmailConnectionMode(ctx.config, opts);
        if (gmailConnectionMode === 'hosted') {
          const { connectionUrl } = prepareHostedGmailConnection(ctx.db, ctx.config, {
            ...(owner ? { memberId: owner.id } : {}),
            ...(existing ? { reauthorizeAccountId: existing.id } : {}),
            ...(!existing ? { sharingMode: access.sharingMode, sharedMemberIds: access.sharedMemberIds } : {}),
          });
          console.log('\nOpen this URL in your browser to connect Gmail:\n');
          console.log(`  ${connectionUrl}\n`);
          console.log('This link expires in 10 minutes and can only be used once.');
          return;
        }

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
                  'Try again and choose the matching Google account.',
              );
            }
            return ctx.registry.addGmailAccount(result.email, result.tokens, result.displayName, owner?.id, access);
          },
        );
        console.log(
          `\nConnected ${account.email} (account id: ${account.id})` +
            (owner && account.ownerId === owner.id ? ` for member ${owner.name}` : ''),
        );
        if (owner && account.ownerId !== owner.id) {
          // The mailbox was already connected; re-auth keeps its existing owner.
          console.log(
            `${account.email} was already connected, so its ownership is unchanged. ` +
              `To assign it to ${owner.name}, run "fluxmail accounts assign ${account.id} --owner ${owner.id}".`,
          );
        }
      } catch (err) {
        console.error(`\nError: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    });

  accounts
    .command('configure')
    .argument('<accountId>')
    .option('--sent-folder <path>', 'Sent path, or auto to clear the override')
    .option('--drafts-folder <path>', 'Drafts path, or auto to clear the override')
    .option('--trash-folder <path>', 'Trash path, or auto to clear the override')
    .option('--archive-folder <path>', 'Archive path, or auto to clear the override')
    .option('--spam-folder <path>', 'Spam path, or auto to clear the override')
    .description('Set special folder paths for an IMAP account')
    .action(
      async (
        accountId: string,
        opts: {
          sentFolder?: string;
          draftsFolder?: string;
          trashFolder?: string;
          archiveFolder?: string;
          spamFolder?: string;
        },
      ) => {
        const ctx = createContext();
        warnLicense(ctx.db);
        try {
          const changes = [
            ['sent', opts.sentFolder],
            ['drafts', opts.draftsFolder],
            ['trash', opts.trashFolder],
            ['archive', opts.archiveFolder],
            ['spam', opts.spamFolder],
          ] as const;
          if (!changes.some(([, value]) => value !== undefined)) {
            throw new EmailError('invalid_request', 'Pass at least one folder option.');
          }
          const credentials = ctx.registry.loadImapCredentials(accountId);
          const provider = ctx.registry.getProvider(accountId) as ReturnType<typeof ctx.registry.getProvider> & {
            close?: () => Promise<void>;
          };
          try {
            const existingPaths = new Set((await provider.listFolders()).map((folder) => folder.id));
            const overrides = { ...credentials.folderOverrides };
            for (const [role, value] of changes) {
              if (value === undefined) continue;
              if (value === 'auto') delete overrides[role];
              else {
                if (!existingPaths.has(value)) {
                  throw new EmailError('not_found', `No selectable mailbox named "${value}".`);
                }
                overrides[role] = value;
              }
            }
            credentials.folderOverrides = overrides;
            ctx.registry.saveImapCredentials(accountId, credentials);
            const checked = ctx.registry.getProvider(accountId) as typeof provider & {
              getFolderWarnings?: () => Promise<Array<{ message: string }>>;
            };
            try {
              console.log(`Updated folder settings for ${accountId}.`);
              for (const warning of (await checked.getFolderWarnings?.()) ?? []) {
                console.log(`Warning: ${warning.message}.`);
              }
            } finally {
              await checked.close?.();
            }
          } finally {
            await provider.close?.();
          }
        } catch (err) {
          console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
          process.exitCode = 1;
        }
      },
    );

  accounts
    .command('list')
    .description('List connected accounts')
    .action(() => {
      const ctx = createContext();
      warnLicense(ctx.db);
      const all = ctx.registry.listAccounts();
      if (!all.length) {
        console.log(
          'No accounts connected. Run "fluxmail accounts add gmail --owner <member>", "fluxmail accounts add outlook --owner <member>", or the IMAP equivalent.',
        );
        return;
      }
      const memberNames = new Map(listMembers(ctx.db).map((m) => [m.id, m.name]));
      for (const a of all) {
        const owner = a.ownerId ? (memberNames.get(a.ownerId) ?? a.ownerId) : '-';
        const access =
          a.sharingMode === 'selected'
            ? `selected:${a.sharedMemberIds.map((id) => memberNames.get(id) ?? id).join(',')}`
            : a.sharingMode;
        console.log(`${a.id}  ${a.provider}  ${a.email}  [${a.status}]  owner=${owner}  access=${access}`);
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
    .option('--owner <member>', 'Member (id or email) to own the mailbox')
    .option('--member <member>', 'Deprecated alias for --owner')
    .option('--shared', 'Deprecated alias for sharing with all members')
    .description('Change mailbox ownership')
    .action((accountId: string, opts: { owner?: string; member?: string; shared?: boolean }) => {
      const ctx = createContext();
      warnLicense(ctx.db);
      try {
        if (opts.owner && opts.member) {
          throw new EmailError('invalid_request', '--owner and --member cannot be combined. Use --owner.');
        }
        const ownerRef = opts.owner ?? opts.member;
        if (!ownerRef && !opts.shared) {
          throw new EmailError('invalid_request', 'Pass --owner <member>.');
        }
        if (ownerRef && opts.shared) {
          throw new EmailError('invalid_request', '--owner and --shared cannot be combined.');
        }
        if (opts.member) console.error('Warning: --member is deprecated; use --owner.');
        if (opts.shared) {
          console.error('Warning: "accounts assign --shared" is deprecated; use "accounts access --shared".');
          const account = ctx.registry.setAccountAccess(accountId, { sharingMode: 'all' });
          console.log(`${account.email} is now shared with every member. Its owner is unchanged.`);
          return;
        }
        const owner = findMember(ctx.db, ownerRef!);
        const account = ctx.registry.assignAccountOwner(accountId, owner.id);
        console.log(`${account.email} is now owned by ${owner.name}.`);
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    });

  accounts
    .command('access')
    .argument('<accountId>')
    .option('--owner-only', 'Only the owner can access the mailbox')
    .option('--shared', 'Share the mailbox with every member')
    .option('--share-with <member>', 'Replace selected access with this member; repeat as needed', collectOption, [])
    .description('Set who can access a mailbox')
    .action((accountId: string, opts: { ownerOnly?: boolean; shared?: boolean; shareWith: string[] }) => {
      const ctx = createContext();
      warnLicense(ctx.db);
      try {
        const choices =
          Number(Boolean(opts.ownerOnly)) + Number(Boolean(opts.shared)) + Number(opts.shareWith.length > 0);
        if (choices !== 1) {
          throw new EmailError(
            'invalid_request',
            'Pass exactly one of --owner-only, --shared, or one or more --share-with options.',
          );
        }
        const sharedMemberIds = opts.shareWith.map((ref) => findMember(ctx.db, ref).id);
        const account = ctx.registry.setAccountAccess(accountId, {
          sharingMode: sharingMode(opts.shared, sharedMemberIds),
          sharedMemberIds,
        });
        console.log(`Updated access for ${account.email}: ${account.sharingMode}.`);
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
    .option('--role <role>', 'Member role: admin or member')
    .description('Add a member (subject to the plan seat limit)')
    .action((opts: { name: string; email?: string; role?: string }) => {
      const ctx = createContext();
      warnLicense(ctx.db);
      try {
        if (opts.role && opts.role !== 'admin' && opts.role !== 'member') {
          throw new EmailError('invalid_request', '--role must be "admin" or "member".');
        }
        const member = addMember(ctx.db, {
          name: opts.name,
          ...(opts.email ? { email: opts.email } : {}),
          ...(opts.role ? { role: opts.role as MemberRole } : {}),
        });
        console.log(`Added member ${member.name} (id: ${member.id}, role: ${member.role})`);
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
          `${m.id}  ${m.name}  role=${m.role}  email=${m.email ?? '-'}  mailboxes=${m.accountCount}  keys=${m.apiKeyCount}`,
        );
      }
    });

  membersCmd
    .command('remove')
    .argument('<memberId>')
    .description('Remove a member after reassigning or removing their mailboxes')
    .action((memberId: string) => {
      const ctx = createContext();
      warnLicense(ctx.db);
      try {
        const { name, revokedApiKeys } = removeMember(ctx.db, memberId);
        console.log(`Removed ${name} and revoked ${revokedApiKeys} API key(s).`);
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    });

  membersCmd
    .command('role')
    .argument('<member>', 'Member id or email')
    .argument('<role>', 'admin or member')
    .description('Change a member role')
    .action((memberRef: string, role: string) => {
      const ctx = createContext();
      warnLicense(ctx.db);
      try {
        if (role !== 'admin' && role !== 'member') {
          throw new EmailError('invalid_request', 'Role must be "admin" or "member".');
        }
        const member = setMemberRole(ctx.db, memberRef, role);
        console.log(`${member.name} now has the ${member.role} role.`);
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    });

  const apikey = program.command('apikey').description('Manage API keys for the HTTP MCP endpoint');

  apikey
    .command('capabilities')
    .description('List MCP capabilities for custom permission policies')
    .action(() => {
      for (const capability of MCP_CAPABILITIES) console.log(capability);
    });

  apikey
    .command('create')
    .requiredOption('--name <name>', 'Human-readable key name')
    .requiredOption('--member <member>', 'Member (id or email) the key is issued to')
    .option('--account <account>', 'Limit the key to one mailbox; repeat as needed', collectOption, [])
    .option('--profile <profile>', `Tool profile: ${NAMED_PERMISSION_PROFILES.join(', ')}`)
    .option('--allow <capability>', 'Allow one MCP capability; repeat as needed', collectOption, [])
    .description('Create an API key (shown once)')
    .action((opts: { name: string; member: string; account: string[] } & PermissionOptions) => {
      const ctx = createContext();
      warnLicense(ctx.db);
      try {
        const member = findMember(ctx.db, opts.member);
        const accountIds = accountIdsFromRefs(ctx, opts.account);
        const permissions = permissionPolicyFromOptions(opts);
        const { key, info } = createApiKey(ctx.db, opts.name, member.id, permissions, accountIds);
        console.log(
          `Created API key "${info.name}" (id: ${info.id}, profile: ${info.permissionProfile})` +
            ` for member ${member.name}` +
            '\n',
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
        console.log('No API keys. Run "fluxmail apikey create --name <name> --member <member>".');
        return;
      }
      const memberNames = new Map(listMembers(ctx.db).map((m) => [m.id, m.name]));
      for (const k of keys) {
        const lastUsed = k.lastUsedAt ? new Date(k.lastUsedAt).toISOString() : 'never';
        const member = k.memberId ? (memberNames.get(k.memberId) ?? k.memberId) : 'system';
        const accountScope = k.accountIds === null ? 'all granted' : k.accountIds.join(',') || 'none';
        console.log(
          `${k.id}  ${k.name}  member=${member}  accounts=${accountScope}  profile=${k.permissionProfile}` +
            (k.permissionProfile === 'custom' ? `  allows=${k.capabilities.join(',')}` : '') +
            `  created=${new Date(k.createdAt).toISOString()}  lastUsed=${lastUsed}`,
        );
      }
    });

  apikey
    .command('accounts')
    .argument('<keyId>')
    .option('--account <account>', 'Replace the allowlist with this mailbox; repeat as needed', collectOption, [])
    .option('--all-accounts', 'Clear the allowlist')
    .description('Replace or clear an API key mailbox allowlist')
    .action((keyId: string, opts: { account: string[]; allAccounts?: boolean }) => {
      const ctx = createContext();
      warnLicense(ctx.db);
      try {
        if (Boolean(opts.allAccounts) === Boolean(opts.account.length)) {
          throw new EmailError('invalid_request', 'Pass --all-accounts or at least one --account.');
        }
        const accountIds = opts.allAccounts ? null : accountIdsFromRefs(ctx, opts.account);
        if (!updateApiKeyAccounts(ctx.db, keyId, accountIds)) {
          throw new EmailError('not_found', `No key with id ${keyId}.`);
        }
        console.log(
          accountIds === null
            ? `Cleared the mailbox allowlist for ${keyId}.`
            : `Updated ${keyId} to ${accountIds.length} mailbox(es).`,
        );
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    });

  apikey
    .command('permissions')
    .argument('<keyId>')
    .option('--profile <profile>', `Tool profile: ${NAMED_PERMISSION_PROFILES.join(', ')}`)
    .option('--allow <capability>', 'Allow one MCP capability; repeat as needed', collectOption, [])
    .description('Change the MCP permissions for an API key')
    .action((keyId: string, opts: PermissionOptions) => {
      const ctx = createContext();
      warnLicense(ctx.db);
      try {
        const permissions = permissionPolicyFromOptions(opts, true);
        if (!updateApiKeyPermissions(ctx.db, keyId, permissions)) {
          console.error(`No key with id ${keyId}`);
          process.exitCode = 1;
          return;
        }
        console.log(`Updated ${keyId} to profile ${permissions.profile}`);
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
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
          'That does not look like a Fluxmail license key (expected "fluxmail_lic_" followed by 40 hex characters).',
        );
        process.exitCode = 1;
        return;
      }
      const dataDir = resolveDataDir();
      const overridingKey = process.env.FLUXMAIL_LICENSE_KEY?.trim();
      if (overridingKey && overridingKey !== key) {
        console.error(
          'FLUXMAIL_LICENSE_KEY is already set by the shell or a .env file, which takes precedence over stored settings. Remove it before activating a different key.',
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
            `${lease.maxMembers} member${lease.maxMembers === 1 ? '' : 's'}.`,
        );
        console.log(`The lease is valid until ${lease.expiresAt} and renews automatically while the server runs.`);
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
              `up to ${lease.maxAccounts} mailboxes and ${lease.maxMembers} member${lease.maxMembers === 1 ? '' : 's'}.`,
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
            : 'Could not reach the license server to release this instance; unused bindings are released automatically after a while.',
        );
      }
      const removed = unsetStoredConfig(dataDir, 'FLUXMAIL_LICENSE_KEY');
      clearLease(ctx.db);
      console.log(
        removed
          ? 'License removed; this instance is back to Personal-plan limits.'
          : 'No stored license key; cleared any cached lease.',
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

  const telemetryCmd = program.command('telemetry').description('Manage anonymous usage telemetry');

  telemetryCmd
    .command('disable')
    .description('Stop sending anonymous usage telemetry')
    .action(() => {
      const dataDir = resolveDataDir();
      setTelemetryEnabled(dataDir, false);
      console.log('Telemetry disabled.');
    });

  telemetryCmd
    .command('enable')
    .description('Allow anonymous usage telemetry')
    .action(() => {
      const dataDir = resolveDataDir();
      setTelemetryEnabled(dataDir, true);
      unsetStoredConfig(dataDir, 'FLUXMAIL_TELEMETRY');
      console.log('Telemetry enabled. FLUXMAIL_TELEMETRY=0 or DO_NOT_TRACK=1 can still turn it off.');
    });

  telemetryCmd
    .command('status')
    .description('Show whether anonymous usage telemetry is enabled')
    .action(() => {
      const dataDir = resolveDataDir();
      console.log(`Telemetry is ${isTelemetryEnabled(dataDir) ? 'enabled' : 'disabled'}.`);
    });

  program
    .command('status')
    .description('Show accounts, members, entitlements, and provider availability')
    .action(async () => {
      const ctx = createContext();
      warnLicense(ctx.db);
      console.log(JSON.stringify(await ctx.service.status(), null, 2));
    });

  return program;
}

export async function runCli(argv: readonly string[] = process.argv): Promise<void> {
  try {
    await createCliProgram().parseAsync([...argv]);
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    await shutdownTelemetry();
  }
}

function isEntrypoint(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
  }
}

if (isEntrypoint()) void runCli();
