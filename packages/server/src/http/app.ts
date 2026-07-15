import { randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import { EmailError, isEmailError } from '@fluxmail/core';
import type { HttpBindings } from '@hono/node-server';
import { RESPONSE_ALREADY_SENT } from '@hono/node-server/utils/response';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { FluxmailConfig } from '../config.js';
import type { FluxmailDb } from '../storage/db.js';
import type { AccountRegistry } from '../accounts/registry.js';
import type { AccessScope, EmailService } from '../service/emailService.js';
import { authenticateApiKey, type ApiKeyAuth } from '../storage/apiKeys.js';
import { buildMcpServer } from '../mcp/buildServer.js';
import { FULL_PERMISSION_POLICY } from '../permissions.js';
import { buildAuthUrl, createOAuthClient, exchangeCode } from '../accounts/googleAuth.js';
import {
  claimGmailConnectionGrant,
  claimOutlookConnectionGrant,
  inspectGmailConnectionGrant,
  inspectOutlookConnectionGrant,
  type GmailConnectionGrantStatus,
  type GmailConnectionIntent,
} from '../storage/gmailConnectionGrants.js';
import { buildMicrosoftAuthUrl, exchangeMicrosoftCode, requireMicrosoftConfig } from '../accounts/microsoftAuth.js';
import { prepareHostedGmailConnection, prepareHostedOutlookConnection } from '../accounts/gmailConnection.js';
import { VERSION } from '../version.js';
import type { Telemetry } from '../telemetry.js';
import { findMember } from '../storage/members.js';
import { createRestApi } from './rest.js';

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

export interface AppDeps {
  config: FluxmailConfig;
  db: FluxmailDb;
  registry: AccountRegistry;
  service: EmailService;
  telemetry?: Telemetry;
}

export function createApp(deps: AppDeps): Hono<{ Bindings: HttpBindings }> {
  const { config, db, registry, service, telemetry } = deps;
  const app = new Hono<{ Bindings: HttpBindings }>();
  const googleOauthStates = new Map<string, { expiresAt: number; intent?: GmailConnectionIntent }>();
  const microsoftOauthStates = new Map<
    string,
    { expiresAt: number; verifier: string; intent?: GmailConnectionIntent }
  >();

  const escapeHtml = (value: string): string =>
    value.replace(/[&<>"']/g, (char) => {
      const entities: Record<string, string> = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      };
      return entities[char]!;
    });

  const connectionLinkPage = (title: string, message: string): string =>
    `<html><body style="font-family: sans-serif"><h2>${title}</h2><p>${message}</p></body></html>`;

  const connectionLinkError = (
    status: Exclude<GmailConnectionGrantStatus, 'available'>,
    providerName: 'Gmail' | 'Outlook',
    providerCommand: 'gmail' | 'outlook',
  ): { html: string; status: 400 | 410 } => {
    if (status === 'expired') {
      return {
        html: connectionLinkPage(
          `This ${providerName} connection link has expired`,
          'Run the Fluxmail command again to get a new link.',
        ),
        status: 410,
      };
    }
    if (status === 'used') {
      return {
        html: connectionLinkPage(
          `This ${providerName} connection link has already been used`,
          `Run "fluxmail accounts add ${providerCommand}" again if you still need to connect ${providerName}.`,
        ),
        status: 410,
      };
    }
    return {
      html: connectionLinkPage(
        `This ${providerName} connection link is invalid`,
        'Run the Fluxmail command again to get a new link.',
      ),
      status: 400,
    };
  };

  const connectionConfirmationPage = (
    providerName: 'Gmail' | 'Outlook',
    identityProvider: 'Google' | 'Microsoft',
  ): string =>
    `<html><body style="font-family: sans-serif"><h2>Connect ${providerName} to Fluxmail</h2>` +
    `<p>Continue to ${identityProvider} to choose the account you want to connect.</p>` +
    '<form method="post">' +
    `<button type="submit">Continue with ${identityProvider}</button></form></body></html>`;

  const beginGoogleOAuth = (intent?: GmailConnectionIntent): string => {
    const now = Date.now();
    for (const [state, pending] of googleOauthStates) {
      if (pending.expiresAt < now) googleOauthStates.delete(state);
    }
    const state = randomBytes(16).toString('hex');
    googleOauthStates.set(state, { expiresAt: now + OAUTH_STATE_TTL_MS, ...(intent ? { intent } : {}) });
    const client = createOAuthClient(config, `${config.publicUrl}/auth/google/callback`);
    return buildAuthUrl(client, state);
  };

  const beginMicrosoftOAuth = (intent?: GmailConnectionIntent): string => {
    const microsoft = requireMicrosoftConfig(config);
    if (!microsoft.clientSecret) {
      throw new EmailError('invalid_request', 'MICROSOFT_CLIENT_SECRET is required for hosted Outlook connections.');
    }
    const now = Date.now();
    for (const [state, pending] of microsoftOauthStates) {
      if (pending.expiresAt < now) microsoftOauthStates.delete(state);
    }
    const state = randomBytes(16).toString('hex');
    const verifier = randomBytes(32).toString('base64url');
    microsoftOauthStates.set(state, {
      expiresAt: now + OAUTH_STATE_TTL_MS,
      verifier,
      ...(intent ? { intent } : {}),
    });
    return buildMicrosoftAuthUrl(config, `${config.publicUrl}/auth/microsoft/callback`, state, verifier);
  };

  // Connecting a mailbox requires an admin member or a migrated management key.
  const adminAuthorized = (
    c: { req: { header(name: string): string | undefined; query(name: string): string | undefined } },
    allowQueryKey = false,
  ): boolean => {
    if (config.authMode === 'none') return true;
    const bearer = c.req.header('authorization')?.replace(/^Bearer\s+/i, '');
    const key = bearer ?? (allowQueryKey ? c.req.query('key') : undefined);
    if (!key) return false;
    const auth = authenticateApiKey(db, key);
    return auth !== null && (auth.memberId === null || auth.role === 'admin');
  };

  // Authenticate an MCP request. The service applies member grants and the key's
  // optional mailbox allowlist before any provider call.
  const authForRequest = (c: { req: { header(name: string): string | undefined } }): ApiKeyAuth | null => {
    if (config.authMode === 'none') {
      return { keyId: 'auth:none', memberId: null, role: null, permissions: FULL_PERMISSION_POLICY, accountIds: null };
    }
    const bearer = c.req.header('authorization')?.replace(/^Bearer\s+/i, '');
    return bearer ? authenticateApiKey(db, bearer) : null;
  };

  app.post('/auth/connections', async (c) => {
    c.header('cache-control', 'no-store');
    if (!adminAuthorized(c)) return c.json({ error: 'An admin API key is required.' }, 401);

    let input: {
      provider?: unknown;
      owner?: unknown;
      reauthorizeAccountId?: unknown;
      sharingMode?: unknown;
      shareWith?: unknown;
    };
    try {
      input = await c.req.json();
    } catch {
      return c.json({ error: 'Request body must be valid JSON.' }, 400);
    }

    try {
      if (input.provider !== 'gmail' && input.provider !== 'outlook') {
        throw new EmailError('invalid_request', 'provider must be "gmail" or "outlook".');
      }
      const reauthorizeAccountId =
        typeof input.reauthorizeAccountId === 'string' ? input.reauthorizeAccountId.trim() : undefined;
      const ownerRef = typeof input.owner === 'string' ? input.owner.trim() : undefined;
      if (input.shareWith !== undefined && !Array.isArray(input.shareWith)) {
        throw new EmailError('invalid_request', 'shareWith must be an array of member ids or email addresses.');
      }
      const shareWith = (input.shareWith ?? []).map((value) => {
        if (typeof value !== 'string' || !value.trim()) {
          throw new EmailError('invalid_request', 'shareWith must contain member ids or email addresses.');
        }
        return value.trim();
      });

      if (reauthorizeAccountId && (ownerRef || input.sharingMode !== undefined || shareWith.length)) {
        throw new EmailError(
          'invalid_request',
          'owner and sharing settings cannot be combined with reauthorizeAccountId.',
        );
      }

      let intent: GmailConnectionIntent;
      if (reauthorizeAccountId) {
        const existing = registry.getAccount(reauthorizeAccountId);
        if (existing.provider !== input.provider) {
          throw new EmailError(
            'invalid_request',
            `Account ${existing.id} uses ${existing.provider}, not ${input.provider}.`,
          );
        }
        intent = { reauthorizeAccountId: existing.id };
      } else {
        if (!ownerRef) throw new EmailError('invalid_request', 'owner is required for a new mailbox.');
        registry.assertCanAddAccount();
        const owner = findMember(db, ownerRef);
        const sharingMode = input.sharingMode ?? (shareWith.length ? 'selected' : 'private');
        if (sharingMode !== 'private' && sharingMode !== 'selected' && sharingMode !== 'all') {
          throw new EmailError('invalid_request', 'sharingMode must be "private", "selected", or "all".');
        }
        if (sharingMode === 'selected' && shareWith.length === 0) {
          throw new EmailError('invalid_request', 'shareWith is required when sharingMode is "selected".');
        }
        if (sharingMode !== 'selected' && shareWith.length > 0) {
          throw new EmailError('invalid_request', 'shareWith can only be used with sharingMode "selected".');
        }
        intent = {
          memberId: owner.id,
          sharingMode,
          sharedMemberIds: shareWith.map((ref) => findMember(db, ref).id),
        };
      }

      const prepared =
        input.provider === 'gmail'
          ? prepareHostedGmailConnection(db, config, intent)
          : prepareHostedOutlookConnection(db, config, intent);
      return c.json(
        {
          provider: input.provider,
          connectionUrl: prepared.connectionUrl,
          expiresAt: new Date(prepared.expiresAt).toISOString(),
        },
        201,
      );
    } catch (err) {
      if (isEmailError(err)) return c.json({ error: err.message }, 400);
      return c.json({ error: 'Could not create the connection link.' }, 500);
    }
  });

  app.get('/healthz', (c) => c.json({ ok: true, name: 'fluxmail', version: VERSION }));

  // Stateless Streamable HTTP: a fresh server+transport pair per request.
  app.post('/mcp', async (c) => {
    const auth = authForRequest(c);
    if (!auth) {
      return c.json(
        {
          jsonrpc: '2.0',
          error: { code: -32001, message: 'Unauthorized: pass an API key as a Bearer token' },
          id: null,
        },
        401,
      );
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null }, 400);
    }
    const scope: AccessScope =
      config.authMode === 'none'
        ? { memberId: null }
        : { memberId: auth.memberId, role: auth.role, accountIds: auth.accountIds };
    const server = buildMcpServer(service.withScope(scope), {
      permissions: auth.permissions,
      maxAttachmentBytes: config.maxAttachmentBytes,
      telemetry,
      transport: 'http',
    });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    c.env.outgoing.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(c.env.incoming, c.env.outgoing, body);
    return RESPONSE_ALREADY_SENT;
  });

  const methodNotAllowed = (c: { json: (o: unknown, s: 405) => Response }) =>
    c.json(
      {
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Method not allowed: this server runs in stateless mode' },
        id: null,
      },
      405,
    );
  app.get('/mcp', methodNotAllowed);
  app.delete('/mcp', methodNotAllowed);

  // Server-hosted OAuth flow (for remote deployments; the CLI uses a loopback flow instead).
  app.get('/auth/google', (c) => {
    if (!adminAuthorized(c, true)) {
      return c.text('Unauthorized: append ?key=<an admin API key>', 401);
    }
    const ownerRef = c.req.query('owner');
    if (!ownerRef) {
      return c.text(
        'Missing owner. Start the hosted connection with "fluxmail accounts add gmail --owner <member>".',
        400,
      );
    }
    try {
      const owner = findMember(db, ownerRef);
      return c.redirect(beginGoogleOAuth({ memberId: owner.id, sharingMode: 'private' }));
    } catch (err) {
      return c.text(err instanceof Error ? err.message : String(err), 400);
    }
  });

  // Hono falls back to GET handlers for HEAD requests. Handle HEAD explicitly
  // so link previews and security scanners cannot consume a one-time grant.
  app.use('/auth/google/connect', async (c, next) => {
    c.header('cache-control', 'no-store');
    c.header('referrer-policy', 'no-referrer');
    return c.req.method === 'HEAD' ? c.body(null, 204) : next();
  });

  app.get('/auth/google/connect', (c) => {
    const token = c.req.query('token');
    if (!token) {
      const error = connectionLinkError('invalid', 'Gmail', 'gmail');
      return c.html(error.html, error.status);
    }
    const status = inspectGmailConnectionGrant(db, token);
    if (status !== 'available') {
      const error = connectionLinkError(status, 'Gmail', 'gmail');
      return c.html(error.html, error.status);
    }
    return c.html(connectionConfirmationPage('Gmail', 'Google'));
  });

  app.post('/auth/google/connect', (c) => {
    const token = c.req.query('token');
    if (!token) {
      const error = connectionLinkError('invalid', 'Gmail', 'gmail');
      return c.html(error.html, error.status);
    }
    const claim = claimGmailConnectionGrant(db, token);
    if (claim.status !== 'claimed') {
      const error = connectionLinkError(claim.status, 'Gmail', 'gmail');
      return c.html(error.html, error.status);
    }
    return c.redirect(beginGoogleOAuth(claim.grant));
  });

  app.get('/auth/google/callback', async (c) => {
    c.header('cache-control', 'no-store');
    c.header('referrer-policy', 'no-referrer');
    const state = c.req.query('state');
    const pending = state ? googleOauthStates.get(state) : undefined;
    if (!state || !pending || pending.expiresAt < Date.now()) {
      return c.text('Invalid or expired OAuth state. Start the Gmail connection flow again.', 400);
    }
    googleOauthStates.delete(state);
    const error = c.req.query('error');
    if (error) return c.text(`Google returned an error: ${error}`, 400);
    const code = c.req.query('code');
    if (!code) return c.text('Missing code parameter.', 400);

    const client = createOAuthClient(config, `${config.publicUrl}/auth/google/callback`);
    try {
      const { email, displayName, tokens } = await exchangeCode(client, code);
      const reauthorizeAccount = pending.intent?.reauthorizeAccountId
        ? registry.getAccount(pending.intent.reauthorizeAccountId)
        : undefined;
      if (reauthorizeAccount?.provider !== undefined && reauthorizeAccount.provider !== 'gmail') {
        throw new EmailError('invalid_request', `Account ${reauthorizeAccount.id} does not use Gmail.`);
      }
      if (reauthorizeAccount && reauthorizeAccount.email !== email) {
        throw new EmailError(
          'invalid_request',
          `Google authorized ${email}, but account ${reauthorizeAccount.id} belongs to ${reauthorizeAccount.email}. ` +
            'Try again and choose the matching Google account.',
        );
      }
      const account = registry.addGmailAccount(email, tokens, displayName, pending.intent?.memberId, {
        sharingMode: pending.intent?.sharingMode ?? 'private',
        sharedMemberIds: pending.intent?.sharedMemberIds ?? [],
      });
      return c.html(
        `<html><body style="font-family: sans-serif"><h2>${escapeHtml(email)} is connected to Fluxmail</h2>` +
          `<p>Account id: <code>${escapeHtml(account.id)}</code>. You can close this tab.</p></body></html>`,
      );
    } catch (err) {
      // Surface why connecting failed (expired code, missing refresh token,
      // account limit) instead of a blank 500 the user cannot act on.
      if (isEmailError(err)) return c.text(`Could not connect the account: ${err.message}`, 400);
      return c.text('Could not connect the account; check the server logs.', 500);
    }
  });

  app.get('/auth/microsoft', (c) => {
    c.header('referrer-policy', 'no-referrer');
    if (!adminAuthorized(c, true)) {
      return c.text('Unauthorized: append ?key=<an admin API key>', 401);
    }
    const ownerRef = c.req.query('owner');
    if (!ownerRef) {
      return c.text(
        'Missing owner. Start the hosted connection with "fluxmail accounts add outlook --owner <member>".',
        400,
      );
    }
    try {
      const owner = findMember(db, ownerRef);
      return c.redirect(beginMicrosoftOAuth({ memberId: owner.id, sharingMode: 'private' }));
    } catch (err) {
      return c.text(err instanceof Error ? err.message : String(err), 400);
    }
  });

  app.use('/auth/microsoft/connect', async (c, next) => {
    c.header('cache-control', 'no-store');
    c.header('referrer-policy', 'no-referrer');
    return c.req.method === 'HEAD' ? c.body(null, 204) : next();
  });

  app.get('/auth/microsoft/connect', (c) => {
    const token = c.req.query('token');
    if (!token) {
      const error = connectionLinkError('invalid', 'Outlook', 'outlook');
      return c.html(error.html, error.status);
    }
    const status = inspectOutlookConnectionGrant(db, token);
    if (status !== 'available') {
      const error = connectionLinkError(status, 'Outlook', 'outlook');
      return c.html(error.html, error.status);
    }
    return c.html(connectionConfirmationPage('Outlook', 'Microsoft'));
  });

  app.post('/auth/microsoft/connect', (c) => {
    const token = c.req.query('token');
    if (!token) {
      const error = connectionLinkError('invalid', 'Outlook', 'outlook');
      return c.html(error.html, error.status);
    }
    const claim = claimOutlookConnectionGrant(db, token);
    if (claim.status !== 'claimed') {
      const error = connectionLinkError(claim.status, 'Outlook', 'outlook');
      return c.html(error.html, error.status);
    }
    return c.redirect(beginMicrosoftOAuth(claim.grant));
  });

  app.get('/auth/microsoft/callback', async (c) => {
    c.header('cache-control', 'no-store');
    c.header('referrer-policy', 'no-referrer');
    const state = c.req.query('state');
    const pending = state ? microsoftOauthStates.get(state) : undefined;
    if (!state || !pending || pending.expiresAt < Date.now()) {
      return c.text('Invalid or expired OAuth state. Start the Outlook connection flow again.', 400);
    }
    microsoftOauthStates.delete(state);
    const error = c.req.query('error');
    if (error) {
      return c.text(`Microsoft returned an error: ${c.req.query('error_description') ?? error}`, 400);
    }
    const code = c.req.query('code');
    if (!code) return c.text('Missing code parameter.', 400);

    try {
      const { email, displayName, credentials } = await exchangeMicrosoftCode(
        config,
        code,
        `${config.publicUrl}/auth/microsoft/callback`,
        pending.verifier,
        'confidential',
      );
      const reauthorizeAccount = pending.intent?.reauthorizeAccountId
        ? registry.getAccount(pending.intent.reauthorizeAccountId)
        : undefined;
      if (reauthorizeAccount?.provider !== undefined && reauthorizeAccount.provider !== 'outlook') {
        throw new EmailError('invalid_request', `Account ${reauthorizeAccount.id} does not use Outlook.`);
      }
      if (reauthorizeAccount && reauthorizeAccount.email.toLowerCase() !== email.toLowerCase()) {
        throw new EmailError(
          'invalid_request',
          `Microsoft authorized ${email}, but account ${reauthorizeAccount.id} belongs to ${reauthorizeAccount.email}. ` +
            'Try again and choose the matching Microsoft account.',
        );
      }
      const account = registry.addOutlookAccount(
        email,
        credentials,
        displayName,
        pending.intent?.memberId,
        pending.intent?.reauthorizeAccountId,
        {
          sharingMode: pending.intent?.sharingMode ?? 'private',
          sharedMemberIds: pending.intent?.sharedMemberIds ?? [],
        },
      );
      return c.html(
        `<html><body style="font-family: sans-serif"><h2>${escapeHtml(email)} is connected to Fluxmail</h2>` +
          `<p>Account id: <code>${escapeHtml(account.id)}</code>. You can close this tab.</p></body></html>`,
      );
    } catch (err) {
      if (isEmailError(err)) return c.text(`Could not connect the account: ${err.message}`, 400);
      return c.text('Could not connect the account; check the server logs.', 500);
    }
  });

  app.route('/', createRestApi({ config, db, service, telemetry }));

  return app;
}
