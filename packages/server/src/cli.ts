#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { emitKeypressEvents } from 'node:readline';
import { createInterface } from 'node:readline/promises';
import { hostname } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Command } from 'commander';
import { serve } from '@hono/node-server';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { EmailError, isEmailError } from '@fluxmail/core';
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
import { listApiKeys, type ApiKeyInfo } from './storage/apiKeys.js';
import { findMember } from './storage/members.js';
import { LICENSE_KEY_PATTERN } from './licensing/client.js';
import { checkLicenseState, getEntitlements, type Entitlements } from './licensing/entitlements.js';
import { VERSION } from './version.js';
import type { FluxmailDb } from './storage/db.js';
import type { ImapSecurity } from '@fluxmail/provider-imap';
import {
  customPermissionPolicy,
  ADMIN_CAPABILITIES,
  FULL_PERMISSION_POLICY,
  isNamedPermissionProfile,
  MCP_CAPABILITIES,
  NAMED_PERMISSION_PROFILES,
  permissionPolicyForProfile,
  type PermissionPolicy,
} from './permissions.js';
import {
  captureOperation,
  getTelemetry,
  installTelemetryStreamEndHandler,
  isTelemetryEnabled,
  setTelemetryEnabled,
  shutdownTelemetry,
  type Telemetry,
} from './telemetry.js';
import {
  clearSessionToken,
  instanceClient,
  loadInstanceConfig,
  removeInstance,
  resolveInstance,
  saveLocalInstance,
  saveRemoteInstance,
  saveSessionToken,
  useInstance,
} from './cliInstances.js';
import { authenticateBearer, recoverAdminPassword, setupInitialAdmin } from './auth.js';
import { recordAdminAuditEvent } from './storage/adminAudit.js';
import { canManageOwnedAccount } from './authorization.js';
import { createCliUpdateNotifier, type CliUpdateNotifier, type CliUpdateNotifierFactory } from './updateNotifier.js';
import { registerMailCommands } from './cliMail.js';

interface AddAccountOptions {
  reauthorize?: string;
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
  admin?: string[];
}

interface ScopedMcpOptions extends PermissionOptions {
  account: string[];
}

function collectOption(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function accountIdsFromRefs(ctx: ReturnType<typeof createContext>, refs: readonly string[]): string[] | null {
  return refs.length ? [...new Set(refs.map((ref) => ctx.registry.findAccount(ref).id))] : null;
}

export function permissionPolicyFromOptions(opts: PermissionOptions, requireSelection = false): PermissionPolicy {
  const supplemental = opts.admin ?? [];
  if (opts.profile && opts.allow.length) {
    throw new Error('--profile cannot be combined with --allow.');
  }
  if (opts.allow.length && supplemental.length) {
    throw new Error(
      '--admin can only be combined with a named --profile. Put admin capabilities in --allow for a custom policy.',
    );
  }
  if (opts.profile) {
    if (!isNamedPermissionProfile(opts.profile)) {
      throw new Error(`Unknown profile "${opts.profile}". Expected one of: ${NAMED_PERMISSION_PROFILES.join(', ')}.`);
    }
    return permissionPolicyForProfile(opts.profile, supplemental);
  }
  if (opts.allow.length) return customPermissionPolicy(opts.allow);
  if (supplemental.length) return permissionPolicyForProfile('full', supplemental);
  if (requireSelection) throw new Error('Choose --profile or at least one --allow capability.');
  return FULL_PERMISSION_POLICY;
}

export function permissionPolicyForUpdate(
  opts: PermissionOptions,
  existing: Pick<ApiKeyInfo, 'permissionProfile'>,
): PermissionPolicy {
  const supplemental = opts.admin ?? [];
  if (opts.profile || opts.allow.length) return permissionPolicyFromOptions(opts, true);
  if (!supplemental.length) throw new Error('Choose --profile, --admin, or at least one --allow capability.');
  if (existing.permissionProfile === 'custom') {
    throw new Error('This key uses a custom policy. Pass every capability with --allow.');
  }
  return permissionPolicyForProfile(existing.permissionProfile, supplemental);
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

async function textPrompt(label: string): Promise<string> {
  if (!process.stdin.isTTY) throw new EmailError('invalid_request', `${label} must be supplied as an option.`);
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await prompt.question(`${label}: `)).trim();
  } finally {
    prompt.close();
  }
}

async function loginPassword(label = 'Password'): Promise<string> {
  return process.env.FLUXMAIL_PASSWORD ?? hiddenPrompt(label);
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

export interface CliProgramOptions {
  telemetry?: Telemetry;
  updateNotifierFactory?: CliUpdateNotifierFactory;
}

interface ActiveCliOperation {
  telemetry: Telemetry;
  operation: string;
  startedAt: number;
  initialExitCode: number | string | null | undefined;
}

const activeCliOperations = new WeakMap<Command, ActiveCliOperation>();
const activeUpdateNotifiers = new WeakMap<Command, CliUpdateNotifier>();

function finishCliOperation(program: Command, outcome: 'success' | 'error', errorCode?: string): void {
  const active = activeCliOperations.get(program);
  if (!active) return;
  activeCliOperations.delete(program);
  captureOperation(active.telemetry, {
    productSurface: 'cli',
    operation: active.operation,
    outcome,
    durationMs: performance.now() - active.startedAt,
    errorCode,
  });
}

export function waitForServerListening(server: ReturnType<typeof serve>): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
  });
}

/** Build the command tree without parsing arguments or running command actions. */
export function createCliProgram(options: CliProgramOptions = {}): Command {
  const program = new Command();
  program
    .name('fluxmail')
    .description('Fluxmail, a self-hosted email API with MCP, REST, and CLI access')
    .option('--instance <name>', 'Use a named local or remote instance')
    .option('-a, --account <id-or-email>', 'Use an email account by ID or address')
    .option('--no-update-notifier', 'Skip the automatic update check for this command')
    .version(VERSION, '-v, --version');

  const selectedInstance = (): string | undefined => program.opts<{ instance?: string }>().instance;
  const selectedAccount = (): string | undefined => program.opts<{ account?: string }>().account;

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
    const updateNotifierEnabled = program.opts<{ updateNotifier: boolean }>().updateNotifier;
    if (updateNotifierEnabled && actionCommand.name() !== 'stdio') {
      try {
        const notifier = options.updateNotifierFactory?.();
        if (notifier) activeUpdateNotifiers.set(program, notifier);
      } catch {
        // Update checks must not affect command execution.
      }
    }
    // Respect the opt-out before creating a telemetry client or recording this command.
    if (command === 'telemetry disable') return;
    activeCliOperations.set(program, {
      telemetry: options.telemetry ?? getTelemetry(resolveDataDir()),
      operation: command,
      startedAt: performance.now(),
      initialExitCode: process.exitCode,
    });
  });

  program.hook('postAction', async (_command, actionCommand) => {
    const active = activeCliOperations.get(program);
    const failed =
      active !== undefined &&
      process.exitCode !== active.initialExitCode &&
      process.exitCode !== undefined &&
      process.exitCode !== 0;
    finishCliOperation(program, failed ? 'error' : 'success', failed ? 'command_failed' : undefined);
    try {
      if (!options.telemetry && actionCommand.name() !== 'serve' && actionCommand.name() !== 'stdio') {
        await shutdownTelemetry();
      }
    } finally {
      const notifier = activeUpdateNotifiers.get(program);
      activeUpdateNotifiers.delete(program);
      try {
        notifier?.notify();
      } catch {
        // Update notices must not affect the command outcome.
      }
    }
  });

  program
    .command('setup')
    .description('Create the first local administrator or claim a migrated administrator')
    .option('--name <name>', 'Administrator name')
    .option('--email <email>', 'Administrator email')
    .option('--existing-admin <member>', 'Existing administrator id or email for a migrated instance')
    .action(async (opts: { name?: string; email?: string; existingAdmin?: string }) => {
      try {
        const name = opts.name ?? (opts.existingAdmin ? undefined : await textPrompt('Administrator name'));
        const email = opts.email ?? (await textPrompt('Administrator email'));
        const password = await loginPassword('New password');
        const context = createContext();
        const result = await setupInitialAdmin(context.db, {
          ...(name ? { name } : {}),
          email,
          password,
          ...(opts.existingAdmin ? { existingAdmin: opts.existingAdmin } : {}),
          deviceName: `CLI on ${hostname()}`,
        });
        saveLocalInstance('local');
        saveSessionToken('local', result.session.token);
        recordAdminAuditEvent(context.db, {
          operation: 'auth.setup',
          outcome: 'success',
          actorMemberId: result.member.id,
          actorSessionId: result.session.info.id,
        });
        console.log(`Fluxmail is ready. Logged in to local as ${result.member.name}.`);
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    });

  program
    .command('login')
    .description('Log in to a local or remote instance')
    .option('--server <url>', 'Add or update a remote instance')
    .option('--email <email>', 'Member email')
    .option('--enroll', 'Use a one-time enrollment code')
    .option('--reset', 'Use a one-time password reset code')
    .action(async (opts: { server?: string; email?: string; enroll?: boolean; reset?: boolean }) => {
      try {
        if (opts.enroll && opts.reset) {
          throw new EmailError('invalid_request', '--enroll and --reset cannot be used together.');
        }
        const requestedInstance = selectedInstance();
        if (!opts.server && requestedInstance === 'local' && !loadInstanceConfig().instances.local) {
          saveLocalInstance('local');
        }
        const instanceName = requestedInstance ?? (opts.server ? 'remote' : resolveInstance().name);
        if (opts.server) saveRemoteInstance(instanceName, opts.server);
        const client = instanceClient(instanceName, false);
        const deviceName = `CLI on ${hostname()}`;
        const result =
          opts.enroll || opts.reset
            ? await client.json<{ token: string; member: { name: string } }>(
                opts.reset ? '/api/v1/auth/password-reset' : '/api/v1/auth/enroll',
                {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({
                    token:
                      (opts.reset ? process.env.FLUXMAIL_RESET_CODE : process.env.FLUXMAIL_INVITE_CODE) ??
                      (await hiddenPrompt(opts.reset ? 'Password reset code' : 'Enrollment code')),
                    password: await loginPassword('New password'),
                    deviceName,
                  }),
                },
                false,
              )
            : await client.json<{ token: string; member: { name: string } }>(
                '/api/v1/auth/login',
                {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({
                    email: opts.email ?? (await textPrompt('Email')),
                    password: await loginPassword(),
                    deviceName,
                  }),
                },
                false,
              );
        saveSessionToken(instanceName, result.token);
        useInstance(instanceName);
        console.log(`Logged in to ${instanceName} as ${result.member.name}.`);
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    });

  program
    .command('logout')
    .description('Revoke the current CLI session')
    .action(async () => {
      try {
        const selected = resolveInstance(selectedInstance());
        const response = await instanceClient(selected.name).request('/api/v1/auth/logout', { method: 'POST' });
        if (!response.ok && response.status !== 401) {
          throw new EmailError('invalid_request', `Logout failed with HTTP ${response.status}.`);
        }
        clearSessionToken(selected.name);
        console.log(`Logged out of ${selected.name}.`);
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    });

  const instances = program.command('instances').description('Manage local and remote CLI instances');
  instances
    .command('list')
    .description('List configured instances')
    .action(() => {
      const config = loadInstanceConfig();
      for (const [name, profile] of Object.entries(config.instances)) {
        console.log(
          `${name}${config.active === name ? ' *' : ''}  ${profile.kind}${profile.kind === 'remote' ? `  ${profile.serverUrl}` : ''}`,
        );
      }
    });
  instances
    .command('use')
    .argument('<name>')
    .description('Select the default instance')
    .action((name: string) => {
      try {
        useInstance(name);
        console.log(`Using ${name}.`);
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    });
  instances
    .command('remove')
    .argument('<name>')
    .description('Remove a CLI profile and its local session')
    .action((name: string) => {
      try {
        removeInstance(name);
        console.log(`Removed CLI instance ${name}. Server data was not changed.`);
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    });

  const authCommand = program.command('auth').description('Manage interactive authentication');
  authCommand
    .command('recover-admin')
    .argument('<member>', 'Administrator id or email')
    .description('Reset an administrator password using local filesystem access')
    .action(async (memberRef: string) => {
      try {
        const selected = resolveInstance(selectedInstance());
        if (selected.profile.kind !== 'local') {
          throw new EmailError(
            'invalid_request',
            'Administrator recovery is only available on the local instance host.',
          );
        }
        const password = await loginPassword('New password');
        const context = createContext();
        const member = await recoverAdminPassword(context.db, memberRef, password);
        recordAdminAuditEvent(context.db, {
          operation: 'auth.recover_admin',
          outcome: 'success',
          actorMemberId: member.id,
          resourceType: 'member',
          resourceId: member.id,
        });
        console.log(`Reset ${member.name}'s password and revoked existing sessions.`);
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    });
  authCommand
    .command('sessions')
    .description('List sessions for the current member')
    .action(async () => {
      try {
        const sessions =
          await instanceClient(selectedInstance()).json<
            Array<{ id: string; deviceName: string; createdAt: number; expiresAt: number; current: boolean }>
          >('/api/v1/me/sessions');
        for (const session of sessions) {
          console.log(
            `${session.id}${session.current ? ' *' : ''}  ${session.deviceName}  created=${new Date(session.createdAt).toISOString()}  expires=${new Date(session.expiresAt).toISOString()}`,
          );
        }
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    });
  authCommand
    .command('revoke-session')
    .argument('<sessionId>')
    .description("Revoke one of the current member's sessions")
    .action(async (sessionId: string) => {
      try {
        await instanceClient(selectedInstance()).json(`/api/v1/me/sessions/${encodeURIComponent(sessionId)}`, {
          method: 'DELETE',
        });
        console.log(`Revoked ${sessionId}.`);
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    });

  program
    .command('serve')
    .description('Run the HTTP server (MCP at /mcp and REST at /api/v1)')
    .action(async () => {
      installTelemetrySignalHandlers();
      const ctx = createContext();
      const app = createApp(ctx);
      ctx.scheduler.start();
      const server = serve({ fetch: app.fetch, port: ctx.config.port }, () => {
        ctx.telemetry.capture('mcp server started', { product_surface: 'mcp', transport: 'http' });
        console.log(`Fluxmail listening on ${ctx.config.publicUrl}`);
        console.log(`  MCP endpoint:   ${ctx.config.publicUrl}/mcp`);
        console.log(`  REST API:       ${ctx.config.publicUrl}/api/v1`);
        console.log(`  OpenAPI:        ${ctx.config.publicUrl}/api/v1/openapi.json`);
        if (listApiKeys(ctx.db).length === 0) {
          console.log('  Note: no API keys exist yet. Run "fluxmail apikey create --name <name>" to create one.');
        }
        try {
          const accounts = ctx.registry.listAccounts();
          console.log(
            accounts.length
              ? `  Accounts:       ${accounts.map((a) => `${a.email} (${a.status})`).join(', ')}`
              : '  Accounts:       none (run "fluxmail accounts add gmail", "fluxmail accounts add outlook", or the IMAP equivalent)',
          );
        } catch {
          console.log('  Accounts:       unavailable until an existing administrator claims this instance');
        }
        console.log(`  Plan:           ${planLine(getEntitlements(ctx.db))}`);
        warnLicense(ctx.db, console.log);
        ctx.licenseController.start(console.log);
      });
      await waitForServerListening(server);
    });

  program
    .command('stdio')
    .description('Run as a stdio MCP server (for Claude Desktop / Claude Code local config)')
    .option('--account <account>', 'Limit access to one mailbox; repeat as needed', collectOption, [])
    .option('--profile <profile>', `Tool profile: ${NAMED_PERMISSION_PROFILES.join(', ')}`)
    .option('--allow <capability>', 'Allow one MCP capability; repeat as needed', collectOption, [])
    .action(async (opts: ScopedMcpOptions) => {
      installTelemetrySignalHandlers();
      installTelemetryStreamEndHandler(process.stdin);
      const ctx = createContext();
      const permissions = permissionPolicyFromOptions(opts);
      const selected = resolveInstance(selectedInstance());
      if (selected.profile.kind !== 'local') {
        throw new EmailError(
          'invalid_request',
          'Stdio MCP only supports the local instance. Use the remote HTTP MCP endpoint with an API key.',
        );
      }
      if (!selected.token)
        throw new EmailError('permission_denied', 'Log in to the local instance before starting stdio MCP.');
      const principal = authenticateBearer(ctx.db, selected.token);
      if (!principal || principal.kind !== 'session')
        throw new EmailError(
          'permission_denied',
          'The local CLI session has expired. Run "fluxmail login --instance local".',
        );
      const accountIds = accountIdsFromRefs(ctx, opts.account);
      const scopedService = ctx.service.withPrincipal({ ...principal, accountIds });
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
      ctx.licenseController.start(console.error);
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
        finishCliOperation(program, 'error', 'invalid_request');
        console.error(`Provider "${providerInput}" is not supported. Available: gmail, outlook, imap`);
        process.exitCode = 1;
        return;
      }
      const selected = resolveInstance(selectedInstance());
      if (!selected.token) {
        console.error(`Error: Log in to instance "${selected.name}" before connecting a mailbox.`);
        process.exitCode = 1;
        return;
      }
      try {
        validateAccountConnectionFlags(provider, opts);
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
        return;
      }
      let useControlPlane = selected.profile.kind === 'remote' || provider === 'imap';
      if (selected.profile.kind === 'local' && provider !== 'imap') {
        try {
          useControlPlane = selectGmailConnectionMode(createContext().config, opts) === 'hosted';
        } catch (err) {
          console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
          process.exitCode = 1;
          return;
        }
      }
      if (useControlPlane) {
        try {
          if (selected.profile.kind === 'remote' && opts.local) {
            throw new EmailError('invalid_request', '--local is only available for the local instance.');
          }
          let request: Record<string, unknown> = {
            provider,
            ...(opts.reauthorize ? { reauthorizeAccountId: opts.reauthorize } : {}),
          };
          if (provider === 'imap') {
            const email = opts.email?.trim();
            if (!email || !email.includes('@'))
              throw new EmailError('invalid_request', '--email must be a mailbox address.');
            if (!opts.imapHost) throw new EmailError('invalid_request', '--imap-host is required for IMAP accounts.');
            if (!opts.smtpHost) throw new EmailError('invalid_request', '--smtp-host is required for IMAP accounts.');
            const imapPassword = await accountSecret(opts.imapPasswordEnv, 'IMAP password');
            const smtpPassword = opts.smtpPasswordEnv
              ? await accountSecret(opts.smtpPasswordEnv, 'SMTP password')
              : imapPassword;
            const imapUser = opts.imapUser ?? email;
            request = {
              ...request,
              email,
              ...(opts.displayName ? { displayName: opts.displayName } : {}),
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
              ...(command.getOptionValueSource('saveSent') !== 'default' ? { saveSent: opts.saveSent } : {}),
              folderOverrides: {
                ...(opts.sentFolder ? { sent: opts.sentFolder } : {}),
                ...(opts.draftsFolder ? { drafts: opts.draftsFolder } : {}),
                ...(opts.trashFolder ? { trash: opts.trashFolder } : {}),
                ...(opts.archiveFolder ? { archive: opts.archiveFolder } : {}),
                ...(opts.spamFolder ? { spam: opts.spamFolder } : {}),
              },
            };
          }
          const result = await instanceClient(selected.name).json<{
            connectionUrl?: string;
            account?: { id: string; email: string };
            warnings?: Array<{ message: string }>;
          }>('/api/v1/accounts/connections', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(request),
          });
          if (result.connectionUrl) console.log(`Open this URL in your browser:\n\n  ${result.connectionUrl}\n`);
          if (result.account) {
            console.log(`Connected ${result.account.email} (account id: ${result.account.id})`);
            for (const warning of result.warnings ?? []) console.log(`Warning: ${warning.message}.`);
          }
        } catch (err) {
          console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
          process.exitCode = 1;
        }
        return;
      }
      const ctx = createContext();
      warnLicense(ctx.db);
      try {
        const principal = authenticateBearer(ctx.db, selected.token);
        if (!principal || principal.kind !== 'session') {
          throw new EmailError(
            'permission_denied',
            'The local CLI session has expired. Run "fluxmail login --instance local".',
          );
        }
        const owner = findMember(ctx.db, principal.memberId);
        const existing = opts.reauthorize ? ctx.registry.getAccount(opts.reauthorize) : undefined;
        if (existing && !canManageOwnedAccount(principal, existing)) {
          throw new EmailError('permission_denied', 'Only the mailbox owner or an administrator can reauthorize it.');
        }
        if (existing && existing.provider !== provider) {
          throw new EmailError('invalid_request', `Account ${existing.id} uses ${existing.provider}, not ${provider}.`);
        }
        if (!existing) ctx.registry.assertCanAddAccount();
        const access = { sharedWithAll: false, grantedMemberIds: [] };
        const auditConnection = (operation: string, accountId?: string): void => {
          try {
            recordAdminAuditEvent(ctx.db, {
              operation,
              outcome: 'success',
              actorMemberId: principal.memberId,
              actorSessionId: principal.sessionId,
              ...(accountId ? { resourceType: 'account', resourceId: accountId } : {}),
            });
          } catch {
            // Audit storage must not replace the connection result.
          }
        };

        if (provider === 'outlook') {
          const connectionMode = selectGmailConnectionMode(ctx.config, opts);
          if (connectionMode === 'hosted') {
            const { connectionUrl } = prepareHostedOutlookConnection(ctx.db, ctx.config, {
              ownerMemberId: owner.id,
              ...(existing ? { reauthorizeAccountId: existing.id } : {}),
              ...(!existing ? access : {}),
            });
            auditConnection('account.connection.prepare', existing?.id);
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
              const duplicate = ctx.registry
                .listAccounts()
                .find((candidate) => candidate.email.toLowerCase() === result.email.toLowerCase());
              if (duplicate && !canManageOwnedAccount(principal, duplicate)) {
                throw new EmailError(
                  'permission_denied',
                  'Only the mailbox owner or an administrator can reauthorize it.',
                );
              }
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
                owner.id,
                existing?.id,
                access,
              );
            },
          );
          auditConnection('account.connection.complete', account.id);
          console.log(
            `\nConnected ${account.email} (account id: ${account.id})` +
              (account.ownerMemberId === owner.id ? ` for member ${owner.name}` : ''),
          );
          return;
        }

        const gmailConnectionMode = selectGmailConnectionMode(ctx.config, opts);
        if (gmailConnectionMode === 'hosted') {
          const { connectionUrl } = prepareHostedGmailConnection(ctx.db, ctx.config, {
            ownerMemberId: owner.id,
            ...(existing ? { reauthorizeAccountId: existing.id } : {}),
            ...(!existing ? access : {}),
          });
          auditConnection('account.connection.prepare', existing?.id);
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
            const duplicate = ctx.registry
              .listAccounts()
              .find((candidate) => candidate.email.toLowerCase() === result.email.toLowerCase());
            if (duplicate && !canManageOwnedAccount(principal, duplicate)) {
              throw new EmailError(
                'permission_denied',
                'Only the mailbox owner or an administrator can reauthorize it.',
              );
            }
            if (existing && result.email !== existing.email) {
              throw new EmailError(
                'invalid_request',
                `Google authorized ${result.email}, but account ${existing.id} belongs to ${existing.email}. ` +
                  'Try again and choose the matching Google account.',
              );
            }
            return ctx.registry.addGmailAccount(result.email, result.tokens, result.displayName, owner.id, access);
          },
        );
        auditConnection('account.connection.complete', account.id);
        console.log(
          `\nConnected ${account.email} (account id: ${account.id})` +
            (account.ownerMemberId === owner.id ? ` for member ${owner.name}` : ''),
        );
        if (account.ownerMemberId !== owner.id) {
          // The mailbox was already connected; re-auth keeps its existing owner.
          console.log(
            `${account.email} was already connected, so its ownership is unchanged. ` +
              `To assign it to ${owner.name}, run "fluxmail accounts assign ${account.id} --owner ${owner.id}".`,
          );
        }
      } catch (err) {
        finishCliOperation(program, 'error', isEmailError(err) ? err.code : 'internal');
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
          const patch: Record<string, string | null> = {};
          for (const [role, value] of changes) {
            if (value !== undefined) patch[role] = value === 'auto' ? null : value;
          }
          const result = await instanceClient(selectedInstance()).json<{
            warnings: Array<{ message: string }>;
          }>(`/api/v1/accounts/${encodeURIComponent(accountId)}/imap/folders`, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(patch),
          });
          console.log(`Updated folder settings for ${accountId}.`);
          for (const warning of result.warnings) console.log(`Warning: ${warning.message}.`);
        } catch (err) {
          console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
          process.exitCode = 1;
        }
      },
    );

  accounts
    .command('list')
    .description('List connected accounts')
    .action(async () => {
      try {
        const all = await instanceClient(selectedInstance()).json<
          Array<{
            id: string;
            provider: string;
            email: string;
            status: string;
            ownerMemberId: string;
            sharedWithAll: boolean;
            grantedMemberIds: string[];
          }>
        >('/api/v1/accounts');
        if (!all.length) {
          console.log('No accounts connected. Run "fluxmail accounts add <provider>".');
          return;
        }
        for (const a of all) {
          const access = a.sharedWithAll
            ? 'all'
            : a.grantedMemberIds.length
              ? `selected:${a.grantedMemberIds.join(',')}`
              : 'owner-only';
          console.log(`${a.id}  ${a.provider}  ${a.email}  [${a.status}]  owner=${a.ownerMemberId}  access=${access}`);
        }
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    });

  accounts
    .command('remove')
    .argument('<accountId>')
    .description('Disconnect an account and delete its stored tokens')
    .action(async (accountId: string) => {
      try {
        await instanceClient(selectedInstance()).json(`/api/v1/accounts/${encodeURIComponent(accountId)}/connection`, {
          method: 'DELETE',
        });
        console.log(`Removed ${accountId}`);
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    });

  accounts
    .command('assign')
    .argument('<accountId>')
    .requiredOption('--owner <member>', 'Member id or email to own the mailbox')
    .description('Change mailbox ownership')
    .action(async (accountId: string, opts: { owner: string }) => {
      try {
        const account = await instanceClient(selectedInstance()).json<{ email: string; ownerMemberId: string }>(
          `/api/v1/admin/accounts/${encodeURIComponent(accountId)}`,
          {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ownerMemberId: opts.owner }),
          },
        );
        console.log(`${account.email} is now owned by ${account.ownerMemberId}.`);
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
    .action(async (accountId: string, opts: { ownerOnly?: boolean; shared?: boolean; shareWith: string[] }) => {
      try {
        const choices =
          Number(Boolean(opts.ownerOnly)) + Number(Boolean(opts.shared)) + Number(opts.shareWith.length > 0);
        if (choices !== 1) {
          throw new EmailError(
            'invalid_request',
            'Pass exactly one of --owner-only, --shared, or one or more --share-with options.',
          );
        }
        const account = await instanceClient(selectedInstance()).json<{
          email: string;
          sharedWithAll: boolean;
          grantedMemberIds: string[];
        }>(`/api/v1/admin/accounts/${encodeURIComponent(accountId)}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sharedWithAll: opts.shared === true, grantedMemberIds: opts.shareWith }),
        });
        console.log(
          `Updated access for ${account.email}: ${account.sharedWithAll ? 'all members' : `${account.grantedMemberIds.length} explicit grant(s)`}.`,
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
    .requiredOption('--email <email>', 'Member login email')
    .option('--role <role>', 'Member role: admin or member')
    .description('Add a member (subject to the plan seat limit)')
    .action(async (opts: { name: string; email: string; role?: string }) => {
      try {
        if (opts.role && opts.role !== 'admin' && opts.role !== 'member') {
          throw new EmailError('invalid_request', '--role must be "admin" or "member".');
        }
        const member = await instanceClient(selectedInstance()).json<{
          id: string;
          name: string;
          role: string;
          invitation: { token: string; expiresAt: number };
        }>('/api/v1/admin/members', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: opts.name, email: opts.email, role: opts.role ?? 'member' }),
        });
        console.log(`Added ${member.name} (id: ${member.id}, role: ${member.role}).`);
        console.log(`Enrollment code (shown once): ${member.invitation.token}`);
        console.log(`Expires: ${new Date(member.invitation.expiresAt).toISOString()}`);
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    });

  membersCmd
    .command('list')
    .description('List members with their mailbox and API key counts')
    .action(async () => {
      try {
        const all = await instanceClient(selectedInstance()).json<
          Array<{
            id: string;
            name: string;
            role: string;
            status: string;
            email: string | null;
            accountCount: number;
            apiKeyCount: number;
          }>
        >('/api/v1/admin/members');
        if (!all.length) {
          console.log('No members. Run "fluxmail members add --name <name>".');
          return;
        }
        for (const m of all) {
          console.log(
            `${m.id}  ${m.name}  role=${m.role}  status=${m.status}  email=${m.email ?? '-'}  mailboxes=${m.accountCount}  keys=${m.apiKeyCount}`,
          );
        }
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    });

  membersCmd
    .command('remove')
    .argument('<memberId>')
    .description('Remove a member after reassigning or removing their mailboxes')
    .action(async (memberId: string) => {
      try {
        await instanceClient(selectedInstance()).json(`/api/v1/admin/members/${encodeURIComponent(memberId)}`, {
          method: 'DELETE',
        });
        console.log(`Removed ${memberId}.`);
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
    .action(async (memberRef: string, role: string) => {
      try {
        if (role !== 'admin' && role !== 'member') {
          throw new EmailError('invalid_request', 'Role must be "admin" or "member".');
        }
        const member = await instanceClient(selectedInstance()).json<{ name: string; role: string }>(
          `/api/v1/admin/members/${encodeURIComponent(memberRef)}`,
          {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ role }),
          },
        );
        console.log(`${member.name} now has the ${member.role} role.`);
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    });

  membersCmd
    .command('status')
    .argument('<member>', 'Member id or email')
    .argument('<status>', 'active or suspended')
    .description('Activate or suspend a member')
    .action(async (memberRef: string, status: string) => {
      try {
        if (status !== 'active' && status !== 'suspended') {
          throw new EmailError('invalid_request', 'Status must be "active" or "suspended".');
        }
        const member = await instanceClient(selectedInstance()).json<{ name: string; status: string }>(
          `/api/v1/admin/members/${encodeURIComponent(memberRef)}`,
          {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ status }),
          },
        );
        console.log(`${member.name} is now ${member.status}.`);
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    });

  for (const [commandName, endpoint, label] of [
    ['invite', 'invitation', 'Enrollment code'],
    ['password-reset', 'password-reset', 'Password reset code'],
  ] as const) {
    membersCmd
      .command(commandName)
      .argument('<member>', 'Member id or email')
      .description(commandName === 'invite' ? 'Issue a new enrollment code' : 'Issue a password reset code')
      .action(async (memberRef: string) => {
        try {
          const token = await instanceClient(selectedInstance()).json<{ token: string; expiresAt: number }>(
            `/api/v1/admin/members/${encodeURIComponent(memberRef)}/${endpoint}`,
            { method: 'POST' },
          );
          console.log(`${label} (shown once): ${token.token}`);
          console.log(`Expires: ${new Date(token.expiresAt).toISOString()}`);
        } catch (err) {
          console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
          process.exitCode = 1;
        }
      });
  }

  membersCmd
    .command('sessions')
    .argument('<member>', 'Member id or email')
    .description('List sessions for a member')
    .action(async (memberRef: string) => {
      try {
        const sessions = await instanceClient(selectedInstance()).json<
          Array<{ id: string; deviceName: string; expiresAt: number }>
        >(`/api/v1/admin/members/${encodeURIComponent(memberRef)}/sessions`);
        for (const session of sessions) {
          console.log(`${session.id}  ${session.deviceName}  expires=${new Date(session.expiresAt).toISOString()}`);
        }
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    });

  membersCmd
    .command('revoke-session')
    .argument('<member>', 'Member id or email')
    .argument('<sessionId>')
    .description('Revoke a member session')
    .action(async (memberRef: string, sessionId: string) => {
      try {
        await instanceClient(selectedInstance()).json(
          `/api/v1/admin/members/${encodeURIComponent(memberRef)}/sessions/${encodeURIComponent(sessionId)}`,
          { method: 'DELETE' },
        );
        console.log(`Revoked ${sessionId}.`);
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    });

  const apikey = program.command('apikey').description('Manage API keys for the HTTP MCP and REST APIs');

  apikey
    .command('capabilities')
    .description('List capabilities for API key permission policies')
    .action(() => {
      for (const capability of [...MCP_CAPABILITIES, ...ADMIN_CAPABILITIES]) console.log(capability);
    });

  apikey
    .command('create')
    .requiredOption('--name <name>', 'Human-readable key name')
    .option('--member <member>', 'Admin only: issue the key to another member')
    .option('--account <account>', 'Limit the key to one mailbox; repeat as needed', collectOption, [])
    .option('--profile <profile>', `Tool profile: ${NAMED_PERMISSION_PROFILES.join(', ')}`)
    .option('--allow <capability>', 'Allow one capability in a custom policy; repeat as needed', collectOption, [])
    .option('--admin <capability>', 'Add one admin capability to a named profile; repeat as needed', collectOption, [])
    .description('Create an API key (shown once)')
    .action(async (opts: { name: string; member?: string; account: string[] } & PermissionOptions) => {
      try {
        const permissions = permissionPolicyFromOptions(opts);
        const body = {
          name: opts.name,
          ...(opts.member ? { member: opts.member } : {}),
          accounts: opts.account.length ? opts.account : null,
          ...(permissions.profile === 'custom'
            ? { customCapabilities: permissions.capabilities }
            : {
                permissionProfile: permissions.profile,
                supplementalCapabilities: permissions.supplementalCapabilities,
              }),
        };
        const created = await instanceClient(selectedInstance()).json<{
          id: string;
          name: string;
          permissionProfile: string;
          key: string;
        }>(opts.member ? '/api/v1/admin/api-keys' : '/api/v1/me/api-keys', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(
            opts.member
              ? body
              : {
                  name: body.name,
                  accountIds: body.accounts,
                  ...(permissions.profile === 'custom'
                    ? { capabilities: permissions.capabilities }
                    : {
                        permissionProfile: permissions.profile,
                        supplementalCapabilities: permissions.supplementalCapabilities,
                      }),
                },
          ),
        });
        console.log(`Created API key "${created.name}" (id: ${created.id}, profile: ${created.permissionProfile}).\n`);
        console.log(`  ${created.key}\n`);
        console.log('Store it now; it cannot be shown again.');
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    });

  apikey
    .command('list')
    .description('List API keys')
    .action(async () => {
      try {
        const client = instanceClient(selectedInstance());
        const me = await client.json<{ role: string }>('/api/v1/me');
        const keys = await client.json<ApiKeyInfo[]>(
          me.role === 'admin' ? '/api/v1/admin/api-keys' : '/api/v1/me/api-keys',
        );
        if (!keys.length) {
          console.log('No API keys. Run "fluxmail apikey create --name <name>".');
          return;
        }
        for (const k of keys) {
          const lastUsed = k.lastUsedAt ? new Date(k.lastUsedAt).toISOString() : 'never';
          const accountScope = k.accountIds === null ? 'all granted' : k.accountIds.join(',') || 'none';
          console.log(
            `${k.id}  ${k.name}  member=${k.memberId}  accounts=${accountScope}  profile=${k.permissionProfile}` +
              (k.permissionProfile === 'custom' ? `  allows=${k.capabilities.join(',')}` : '') +
              (k.supplementalCapabilities.length ? `  admin=${k.supplementalCapabilities.join(',')}` : '') +
              `  created=${new Date(k.createdAt).toISOString()}  lastUsed=${lastUsed}`,
          );
        }
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    });

  apikey
    .command('accounts')
    .argument('<keyId>')
    .option('--account <account>', 'Replace the allowlist with this mailbox; repeat as needed', collectOption, [])
    .option('--all-accounts', 'Clear the allowlist')
    .description('Replace or clear an API key mailbox allowlist')
    .action(async (keyId: string, opts: { account: string[]; allAccounts?: boolean }) => {
      try {
        if (Boolean(opts.allAccounts) === Boolean(opts.account.length)) {
          throw new EmailError('invalid_request', 'Pass --all-accounts or at least one --account.');
        }
        const accountIds = opts.allAccounts ? null : opts.account;
        await instanceClient(selectedInstance()).json(`/api/v1/admin/api-keys/${encodeURIComponent(keyId)}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ accounts: accountIds }),
        });
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
    .option('--allow <capability>', 'Allow one capability in a custom policy; repeat as needed', collectOption, [])
    .option('--admin <capability>', 'Add one admin capability to a named profile; repeat as needed', collectOption, [])
    .description('Change the permissions for an API key')
    .action(async (keyId: string, opts: PermissionOptions) => {
      try {
        const client = instanceClient(selectedInstance());
        const existing = (await client.json<ApiKeyInfo[]>('/api/v1/admin/api-keys')).find((key) => key.id === keyId);
        if (!existing) {
          console.error(`No key with id ${keyId}`);
          process.exitCode = 1;
          return;
        }
        const permissions = permissionPolicyForUpdate(opts, existing);
        await client.json(`/api/v1/admin/api-keys/${encodeURIComponent(keyId)}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(
            permissions.profile === 'custom'
              ? { customCapabilities: permissions.capabilities }
              : {
                  permissionProfile: permissions.profile,
                  supplementalCapabilities: permissions.supplementalCapabilities,
                },
          ),
        });
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
    .action(async (keyId: string) => {
      try {
        const client = instanceClient(selectedInstance());
        const me = await client.json<{ role: string }>('/api/v1/me');
        const path =
          me.role === 'admin'
            ? `/api/v1/admin/api-keys/${encodeURIComponent(keyId)}`
            : `/api/v1/me/api-keys/${encodeURIComponent(keyId)}`;
        await client.json(path, { method: 'DELETE' });
        console.log(`Revoked ${keyId}`);
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
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
      try {
        const result = await instanceClient(selectedInstance()).json<{
          outcome: 'activated' | 'saved_for_retry';
          lease?: { plan: string; maxAccounts: number; maxMembers: number; expiresAt: string };
        }>('/api/v1/admin/license/activate', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ licenseKey: key }),
        });
        if (result.lease) {
          console.log(
            `License activated: ${result.lease.plan} plan, up to ${result.lease.maxAccounts} mailboxes and ` +
              `${result.lease.maxMembers} member${result.lease.maxMembers === 1 ? '' : 's'}.`,
          );
          console.log(
            `The lease is valid until ${result.lease.expiresAt} and renews automatically while the server runs.`,
          );
        } else {
          console.log(
            'The license key was saved. Validation will retry when the instance can reach the license server.',
          );
        }
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    });

  license
    .command('status')
    .description('Show the configured license and cached lease')
    .action(async () => {
      try {
        const status = await instanceClient(selectedInstance()).json<{
          configured: boolean;
          source: 'environment' | 'stored' | null;
          entitlements: Entitlements;
          usage: { accounts: number; members: number; overQuota: boolean };
          lastValidatedAt: string | null;
          warning: string | null;
        }>('/api/v1/admin/license');
        console.log(
          status.configured
            ? `License configured from ${status.source}.`
            : 'No license key configured. Run "fluxmail license activate <key>" after purchasing one.',
        );
        console.log(`Current plan: ${planLine(status.entitlements)}`);
        console.log(
          `Usage: ${status.usage.accounts} mailbox(es), ${status.usage.members} member(s)` +
            (status.usage.overQuota ? ' (over plan limits)' : ''),
        );
        if (status.lastValidatedAt) console.log(`Last validated: ${status.lastValidatedAt}`);
        if (status.warning) console.log(`Warning: ${status.warning}`);
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    });

  license
    .command('deactivate')
    .description('Release the license from this instance and remove the stored key and cached lease')
    .action(async () => {
      try {
        const result = await instanceClient(selectedInstance()).json<{
          released: boolean;
          removedStoredKey: boolean;
        }>('/api/v1/admin/license', { method: 'DELETE' });
        console.log(
          result.released
            ? 'Released the license from this instance.'
            : 'The local license was removed. The remote binding, if any, will expire automatically.',
        );
        console.log('This instance is back to Personal plan limits.');
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
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

  registerMailCommands(program, {
    selectedInstance,
    selectedAccount,
    reportError: (error, code) => {
      finishCliOperation(program, 'error', code);
      console.error(`Error [${code}]: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    },
  });

  program
    .command('status')
    .description('Show mailbox and provider status for the selected instance')
    .action(async () => {
      try {
        const status = await instanceClient(selectedInstance()).json('/api/v1/status');
        console.log(JSON.stringify(status, null, 2));
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    });

  return program;
}

export async function runCli(argv: readonly string[] = process.argv): Promise<void> {
  const program = createCliProgram({ updateNotifierFactory: createCliUpdateNotifier });
  try {
    await program.parseAsync([...argv]);
  } catch (err) {
    finishCliOperation(program, 'error', isEmailError(err) ? err.code : 'internal');
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
