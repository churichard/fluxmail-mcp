import { randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import { isEmailError } from '@fluxmail/core';
import type { HttpBindings } from '@hono/node-server';
import { RESPONSE_ALREADY_SENT } from '@hono/node-server/utils/response';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { FluxmailConfig } from '../config.js';
import type { FluxmailDb } from '../storage/db.js';
import type { AccountRegistry } from '../accounts/registry.js';
import type { AccessScope, EmailService } from '../service/emailService.js';
import { authenticateApiKey } from '../storage/apiKeys.js';
import { buildMcpServer } from '../mcp/buildServer.js';
import { buildAuthUrl, createOAuthClient, exchangeCode } from '../accounts/googleAuth.js';
import { VERSION } from '../version.js';

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

export interface AppDeps {
  config: FluxmailConfig;
  db: FluxmailDb;
  registry: AccountRegistry;
  service: EmailService;
}

export function createApp(deps: AppDeps): Hono<{ Bindings: HttpBindings }> {
  const { config, db, registry, service } = deps;
  const app = new Hono<{ Bindings: HttpBindings }>();
  const oauthStates = new Map<string, number>();

  // Connecting a mailbox is instance administration: only unscoped admin keys
  // qualify; member-scoped keys are confined to mailbox access over MCP.
  const adminAuthorized = (
    c: { req: { header(name: string): string | undefined; query(name: string): string | undefined } },
    allowQueryKey = false,
  ): boolean => {
    if (config.authMode === 'none') return true;
    const bearer = c.req.header('authorization')?.replace(/^Bearer\s+/i, '');
    const key = bearer ?? (allowQueryKey ? c.req.query('key') : undefined);
    if (!key) return false;
    return authenticateApiKey(db, key)?.memberId === null;
  };

  // Authenticate an MCP request and resolve the mailbox scope its key authorizes.
  // A member-scoped key is confined to shared and owned mailboxes; an admin key
  // (or authMode 'none') gets unscoped access.
  const scopeForRequest = (c: { req: { header(name: string): string | undefined } }): AccessScope | null => {
    if (config.authMode === 'none') return { memberId: null };
    const bearer = c.req.header('authorization')?.replace(/^Bearer\s+/i, '');
    return bearer ? authenticateApiKey(db, bearer) : null;
  };

  app.get('/healthz', (c) => c.json({ ok: true, name: 'fluxmail', version: VERSION }));

  // Stateless Streamable HTTP: a fresh server+transport pair per request.
  app.post('/mcp', async (c) => {
    const scope = scopeForRequest(c);
    if (!scope) {
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
    const server = buildMcpServer(service.withScope(scope));
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
    const now = Date.now();
    for (const [state, expiry] of oauthStates) {
      if (expiry < now) oauthStates.delete(state);
    }
    const state = randomBytes(16).toString('hex');
    oauthStates.set(state, now + OAUTH_STATE_TTL_MS);
    const client = createOAuthClient(config, `${config.publicUrl}/auth/google/callback`);
    return c.redirect(buildAuthUrl(client, state));
  });

  app.get('/auth/google/callback', async (c) => {
    const state = c.req.query('state');
    const expiry = state ? oauthStates.get(state) : undefined;
    if (!state || !expiry || expiry < Date.now()) {
      return c.text('Invalid or expired OAuth state. Restart from /auth/google.', 400);
    }
    oauthStates.delete(state);
    const error = c.req.query('error');
    if (error) return c.text(`Google returned an error: ${error}`, 400);
    const code = c.req.query('code');
    if (!code) return c.text('Missing code parameter.', 400);

    const client = createOAuthClient(config, `${config.publicUrl}/auth/google/callback`);
    try {
      const { email, displayName, tokens } = await exchangeCode(client, code);
      const account = registry.addGmailAccount(email, tokens, displayName);
      return c.html(
        `<html><body style="font-family: sans-serif"><h2>${email} is connected to Fluxmail</h2>` +
          `<p>Account id: <code>${account.id}</code>. You can close this tab.</p></body></html>`,
      );
    } catch (err) {
      // Surface why connecting failed (expired code, missing refresh token,
      // account limit) instead of a blank 500 the user cannot act on.
      if (isEmailError(err)) return c.text(`Could not connect the account: ${err.message}`, 400);
      return c.text('Could not connect the account; check the server logs.', 500);
    }
  });

  return app;
}
