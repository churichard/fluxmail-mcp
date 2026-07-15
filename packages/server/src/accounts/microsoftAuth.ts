import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { EmailError } from '@fluxmail/core';
import type { FluxmailConfig } from '../config.js';

export const MICROSOFT_SCOPES = [
  'openid',
  'profile',
  'email',
  'offline_access',
  'User.Read',
  'Mail.ReadWrite',
  'Mail.Send',
];

export interface MicrosoftCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scope?: string;
  /** Hosted callbacks use a confidential client; loopback callbacks use PKCE only. */
  clientAuth?: 'public' | 'confidential';
}

interface MicrosoftTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

export interface MicrosoftOAuthResult {
  email: string;
  displayName?: string;
  credentials: MicrosoftCredentials;
}

export function requireMicrosoftConfig(config: FluxmailConfig): NonNullable<FluxmailConfig['microsoft']> {
  if (!config.microsoft) {
    throw new EmailError(
      'invalid_request',
      'MICROSOFT_CLIENT_ID is not set. Register an app in Microsoft Entra, then set its application client ID. See https://fluxmail.ai/docs/connect-outlook-to-mcp.',
    );
  }
  return config.microsoft;
}

function tenantEndpoint(config: FluxmailConfig, path: 'authorize' | 'token'): string {
  const { tenantId } = requireMicrosoftConfig(config);
  return `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/${path}`;
}

function codeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

export function buildMicrosoftAuthUrl(
  config: FluxmailConfig,
  redirectUri: string,
  state: string,
  verifier: string,
): string {
  const { clientId } = requireMicrosoftConfig(config);
  const url = new URL(tenantEndpoint(config, 'authorize'));
  url.search = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    response_mode: 'query',
    scope: MICROSOFT_SCOPES.join(' '),
    state,
    code_challenge: codeChallenge(verifier),
    code_challenge_method: 'S256',
    prompt: 'select_account',
  }).toString();
  return url.toString();
}

async function tokenRequest(
  config: FluxmailConfig,
  params: Record<string, string>,
  clientAuth: 'public' | 'confidential',
): Promise<MicrosoftTokenResponse> {
  const microsoft = requireMicrosoftConfig(config);
  if (clientAuth === 'confidential' && !microsoft.clientSecret) {
    throw new EmailError('invalid_request', 'MICROSOFT_CLIENT_SECRET is required for hosted Outlook connections.');
  }
  const body = new URLSearchParams({
    client_id: microsoft.clientId,
    ...params,
    ...(clientAuth === 'confidential' ? { client_secret: microsoft.clientSecret! } : {}),
  });
  const response = await fetch(tenantEndpoint(config, 'token'), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  const payload = (await response.json()) as MicrosoftTokenResponse;
  if (!response.ok || payload.error) {
    const detail = payload.error_description ?? payload.error ?? `HTTP ${response.status}`;
    const code = /invalid_grant/i.test(payload.error ?? '') ? 'auth_expired' : 'provider_unavailable';
    throw new EmailError(code, `Microsoft OAuth failed: ${detail}`);
  }
  return payload;
}

function credentialsFromToken(
  payload: MicrosoftTokenResponse,
  clientAuth: 'public' | 'confidential',
  previousRefreshToken?: string,
): MicrosoftCredentials {
  if (!payload.access_token) throw new EmailError('provider_unavailable', 'Microsoft did not return an access token');
  const refreshToken = payload.refresh_token ?? previousRefreshToken;
  if (!refreshToken) {
    throw new EmailError(
      'invalid_request',
      'Microsoft did not return a refresh token. Confirm offline_access consent and try again.',
    );
  }
  return {
    accessToken: payload.access_token,
    refreshToken,
    expiresAt: Date.now() + Math.max(payload.expires_in ?? 3_600, 60) * 1_000,
    clientAuth,
    ...(payload.scope ? { scope: payload.scope } : {}),
  };
}

export async function refreshMicrosoftCredentials(
  config: FluxmailConfig,
  credentials: MicrosoftCredentials,
): Promise<MicrosoftCredentials> {
  const clientAuth =
    credentials.clientAuth ?? (requireMicrosoftConfig(config).clientSecret ? 'confidential' : 'public');
  const payload = await tokenRequest(
    config,
    {
      grant_type: 'refresh_token',
      refresh_token: credentials.refreshToken,
      scope: MICROSOFT_SCOPES.join(' '),
    },
    clientAuth,
  );
  return credentialsFromToken(payload, clientAuth, credentials.refreshToken);
}

async function microsoftIdentity(accessToken: string): Promise<{ email: string; displayName?: string }> {
  const response = await fetch('https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName,displayName', {
    headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
  });
  const payload = (await response.json()) as {
    mail?: string | null;
    userPrincipalName?: string | null;
    displayName?: string | null;
    error?: { message?: string };
  };
  if (!response.ok) {
    throw new EmailError(
      response.status === 401 ? 'auth_expired' : 'provider_unavailable',
      `Microsoft Graph could not read the signed-in account: ${payload.error?.message ?? `HTTP ${response.status}`}`,
    );
  }
  const email = payload.mail?.trim() || payload.userPrincipalName?.trim();
  if (!email) throw new EmailError('provider_unavailable', 'Microsoft Graph returned no mailbox address');
  const displayName = payload.displayName?.trim();
  return { email, ...(displayName ? { displayName } : {}) };
}

async function verifyMicrosoftMailbox(accessToken: string): Promise<void> {
  const response = await fetch('https://graph.microsoft.com/v1.0/me/mailFolders/inbox?$select=id', {
    headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
  });
  let payload: { id?: string | null; error?: { message?: string } } = {};
  try {
    payload = (await response.json()) as typeof payload;
  } catch {
    // Microsoft Graph can return an empty or non-JSON gateway response.
  }
  if (!response.ok) {
    const code =
      response.status === 401 ? 'auth_expired' : response.status === 403 ? 'permission_denied' : 'provider_unavailable';
    throw new EmailError(
      code,
      `Microsoft Graph could not access this account's mailbox: ${payload.error?.message ?? `HTTP ${response.status}`}`,
    );
  }
  if (!payload.id) {
    throw new EmailError('provider_unavailable', "Microsoft Graph could not access this account's mailbox");
  }
}

export async function exchangeMicrosoftCode(
  config: FluxmailConfig,
  code: string,
  redirectUri: string,
  verifier: string,
  clientAuth: 'public' | 'confidential' = 'public',
): Promise<MicrosoftOAuthResult> {
  const payload = await tokenRequest(
    config,
    {
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
      scope: MICROSOFT_SCOPES.join(' '),
    },
    clientAuth,
  );
  const credentials = credentialsFromToken(payload, clientAuth);
  const identity = await microsoftIdentity(credentials.accessToken);
  await verifyMicrosoftMailbox(credentials.accessToken);
  return { ...identity, credentials };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return entities[char]!;
  });
}

function callbackPage(title: string, message: string): string {
  return (
    '<html><body style="font-family: sans-serif">' +
    `<h2>${escapeHtml(title)}</h2><p>${escapeHtml(message)}</p>` +
    '<p>You can close this tab and return to the terminal.</p></body></html>'
  );
}

function listenerError(error: Error, port: number): Error {
  if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') return error;
  return new Error(
    `OAuth callback port ${port} is already in use.\n\n` +
      'If Fluxmail is running with Docker Compose, connect the account inside the container:\n\n' +
      '  docker compose exec fluxmail fluxmail accounts add outlook --owner <member>\n\n' +
      `Otherwise, stop the process using port ${port} and try again.`,
    { cause: error },
  );
}

export async function runMicrosoftLoopbackFlow<T = MicrosoftOAuthResult>(
  config: FluxmailConfig,
  onAuthUrl: (url: string) => void,
  onAuthorized?: (result: MicrosoftOAuthResult) => T | Promise<T>,
): Promise<T> {
  requireMicrosoftConfig(config);
  const redirectUri = `http://localhost:${config.oauthPort}/oauth/microsoft/callback`;
  const state = randomBytes(16).toString('hex');
  const verifier = randomBytes(48).toString('base64url');

  return new Promise<T>((resolve, reject) => {
    const server = createServer(async (request, response) => {
      const finish = (settle: () => void) => {
        response.once('close', () => {
          server.close();
          server.closeAllConnections();
          settle();
        });
      };
      try {
        const url = new URL(request.url ?? '/', redirectUri);
        if (url.pathname !== '/oauth/microsoft/callback') {
          response.writeHead(404).end('Not found');
          return;
        }
        if (url.searchParams.get('state') !== state) {
          response.writeHead(400).end('State mismatch. Restart the flow.');
          return;
        }
        const oauthError = url.searchParams.get('error');
        if (oauthError) {
          const description = url.searchParams.get('error_description') ?? oauthError;
          finish(() => reject(new EmailError('invalid_request', `Microsoft OAuth error: ${description}`)));
          response.writeHead(400).end(`Microsoft returned an error: ${description}. You can close this tab.`);
          return;
        }
        const code = url.searchParams.get('code');
        if (!code) {
          response.writeHead(400).end('Missing code parameter.');
          return;
        }
        const result = await exchangeMicrosoftCode(config, code, redirectUri, verifier);
        const accepted = onAuthorized ? await onAuthorized(result) : (result as T);
        finish(() => resolve(accepted));
        response
          .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
          .end(callbackPage(`${result.email} is connected to Fluxmail`, 'The account is ready to use.'));
      } catch (error) {
        finish(() => reject(error));
        const expected = error instanceof EmailError;
        const message = expected
          ? error.message
          : 'Fluxmail could not finish connecting this account. Check the terminal for details.';
        response
          .writeHead(expected ? 400 : 500, { 'content-type': 'text/html; charset=utf-8' })
          .end(callbackPage('Fluxmail could not connect this account', message));
      }
    });
    server.on('error', (error) => reject(listenerError(error, config.oauthPort)));
    server.listen(config.oauthPort, config.oauthHost, () => {
      onAuthUrl(buildMicrosoftAuthUrl(config, redirectUri, state, verifier));
    });
  });
}
