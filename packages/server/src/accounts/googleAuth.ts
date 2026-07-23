import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { CodeChallengeMethod, OAuth2Client, type Credentials } from 'google-auth-library';
import { EmailError } from '@fluxmail/core';
import type { FluxmailConfig } from '../config.js';
import type { StoredGoogleOAuthApp } from '../instanceConfig.js';
import { DEFAULT_GOOGLE_CLIENT_ID } from './defaultGoogleOAuth.js';

const GOOGLE_IDENTITY_SCOPES = ['openid', 'email', 'profile'];

/** The built-in app uses Fluxmail's approved Gmail permission. */
export const GMAIL_SCOPES = ['https://www.googleapis.com/auth/gmail.modify', ...GOOGLE_IDENTITY_SCOPES];

/** Custom OAuth apps retain full Gmail support, including permanent deletion. */
export const CUSTOM_GMAIL_SCOPES = ['https://mail.google.com/', ...GOOGLE_IDENTITY_SCOPES];

export function requireGoogleConfig(config: FluxmailConfig): { clientId: string; clientSecret: string } {
  if (!config.google) {
    throw new EmailError(
      'invalid_request',
      'Google OAuth is not configured. Set GOOGLE_CLIENT_ID to use a custom OAuth app.',
    );
  }
  return config.google;
}

export function requireHostedGoogleConfig(config: FluxmailConfig): { clientId: string; clientSecret: string } {
  const google = requireGoogleConfig(config);
  if (google.clientId === DEFAULT_GOOGLE_CLIENT_ID || !google.clientSecret) {
    throw new EmailError(
      'invalid_request',
      'Hosted Gmail connections require a custom Google Web application. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.',
    );
  }
  return { clientId: google.clientId, clientSecret: google.clientSecret };
}

export function createOAuthClient(
  config: FluxmailConfig,
  redirectUri: string,
  oauthClient: StoredGoogleOAuthApp = requireGoogleConfig(config),
): OAuth2Client {
  const { clientId, clientSecret } = oauthClient;
  return new OAuth2Client({ clientId, clientSecret, redirectUri });
}

export function gmailScopes(
  config: FluxmailConfig,
  oauthClient: StoredGoogleOAuthApp = requireGoogleConfig(config),
): string[] {
  return oauthClient.clientId === DEFAULT_GOOGLE_CLIENT_ID ? GMAIL_SCOPES : CUSTOM_GMAIL_SCOPES;
}

export function buildAuthUrl(client: OAuth2Client, state: string, scopes: string[], codeChallenge?: string): string {
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: scopes,
    state,
    ...(codeChallenge ? { code_challenge: codeChallenge, code_challenge_method: CodeChallengeMethod.S256 } : {}),
  });
}

/** Verify the OAuth id_token and extract the authenticated Google identity. */
export async function identityFromIdToken(
  client: OAuth2Client,
  tokens: Credentials,
): Promise<{ email: string; displayName?: string }> {
  const idToken = tokens.id_token;
  if (!idToken) throw new EmailError('provider_unavailable', 'Google did not return an id_token');
  if (!client._clientId) throw new EmailError('provider_unavailable', 'Google OAuth client has no client id');
  const ticket = await client.verifyIdToken({ idToken, audience: client._clientId });
  const claims = ticket.getPayload();
  if (!claims) throw new EmailError('provider_unavailable', 'Google id_token has no claims');
  if (!claims.email) throw new EmailError('provider_unavailable', 'Google id_token has no email claim');
  if (!claims.email_verified) {
    throw new EmailError('provider_unavailable', 'Google did not verify the account email address');
  }
  return { email: claims.email, ...(claims.name ? { displayName: claims.name } : {}) };
}

export interface OAuthResult {
  email: string;
  displayName?: string;
  tokens: Credentials;
}

export interface AuthorizedOAuthResult extends OAuthResult {
  oauthClient: StoredGoogleOAuthApp;
}

function oauthErrorText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, 300) : undefined;
}

function googleTokenError(err: unknown): EmailError {
  const data = (err as { response?: { data?: unknown } } | undefined)?.response?.data;
  const payload = data && typeof data === 'object' ? (data as Record<string, unknown>) : undefined;
  const code = oauthErrorText(payload?.error);
  const description = oauthErrorText(payload?.error_description);
  const detail =
    description ?? code ?? oauthErrorText(err instanceof Error ? err.message : undefined) ?? 'unknown error';
  return new EmailError('provider_unavailable', `Google OAuth token exchange failed: ${detail}`);
}

function oauthListenerError(err: Error, port: number): Error {
  const code = (err as NodeJS.ErrnoException).code;
  if (code !== 'EADDRINUSE') return err;

  return new Error(
    `OAuth callback port ${port} is already in use.\n\n` +
      'If Fluxmail is already running with Docker Compose, connect the account inside the container:\n\n' +
      '  docker compose exec fluxmail fluxmail accounts add gmail\n\n' +
      `Otherwise, stop the process using port ${port} and try again.`,
    { cause: err },
  );
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

export async function exchangeCode(client: OAuth2Client, code: string, codeVerifier?: string): Promise<OAuthResult> {
  let tokens: Credentials;
  try {
    ({ tokens } = await client.getToken({ code, ...(codeVerifier ? { codeVerifier } : {}) }));
  } catch (err) {
    throw googleTokenError(err);
  }
  if (!tokens.refresh_token) {
    throw new EmailError(
      'invalid_request',
      "Google did not return a refresh token. Remove Fluxmail from the account's third-party access " +
        '(myaccount.google.com/permissions) and try again.',
    );
  }
  return { ...(await identityFromIdToken(client, tokens)), tokens };
}

/**
 * Loopback OAuth flow for the CLI: listens once on config.oauthPort, prints the
 * consent URL, and resolves when Google redirects back with a code.
 */
export async function runLoopbackFlow<T = AuthorizedOAuthResult>(
  config: FluxmailConfig,
  onAuthUrl: (url: string) => void,
  onAuthorized?: (result: AuthorizedOAuthResult) => T | Promise<T>,
): Promise<T> {
  const oauthClient = { ...requireGoogleConfig(config) };
  const redirectUri = `http://127.0.0.1:${config.oauthPort}/oauth/callback`;
  const client = createOAuthClient(config, redirectUri, oauthClient);
  const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
  const state = randomBytes(16).toString('hex');

  return new Promise<T>((resolve, reject) => {
    const server = createServer(async (req, res) => {
      // Close the listener and destroy lingering keep-alive sockets (the browser
      // holds its connection open after loading the page); otherwise the CLI
      // process never exits.
      const finish = (settle: () => void) => {
        res.once('close', () => {
          server.close();
          server.closeAllConnections();
          settle();
        });
      };
      try {
        const url = new URL(req.url ?? '/', redirectUri);
        if (url.pathname !== '/oauth/callback') {
          res.writeHead(404).end('Not found');
          return;
        }
        if (url.searchParams.get('state') !== state) {
          res.writeHead(400).end('State mismatch. Restart the flow.');
          return;
        }
        const error = url.searchParams.get('error');
        if (error) {
          finish(() => reject(new EmailError('invalid_request', `Google OAuth error: ${error}`)));
          res.writeHead(400).end(`Google returned an error: ${error}. You can close this tab.`);
          return;
        }
        const code = url.searchParams.get('code');
        if (!code) {
          res.writeHead(400).end('Missing code parameter.');
          return;
        }
        const result = { ...(await exchangeCode(client, code, codeVerifier)), oauthClient };
        const accepted = onAuthorized ? await onAuthorized(result) : (result as T);
        finish(() => resolve(accepted));
        res
          .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
          .end(callbackPage(`${result.email} is connected to Fluxmail`, 'The account is ready to use.'));
      } catch (err) {
        finish(() => reject(err));
        const expected = err instanceof EmailError;
        const message = expected
          ? err.message
          : 'Fluxmail could not finish connecting this account. Check the terminal for details.';
        res
          .writeHead(expected ? 400 : 500, { 'content-type': 'text/html; charset=utf-8' })
          .end(callbackPage('Fluxmail could not connect this account', message));
      }
    });
    server.on('error', (err) => reject(oauthListenerError(err, config.oauthPort)));
    server.listen(config.oauthPort, config.oauthHost, () => {
      onAuthUrl(buildAuthUrl(client, state, gmailScopes(config, oauthClient), codeChallenge));
    });
  });
}
