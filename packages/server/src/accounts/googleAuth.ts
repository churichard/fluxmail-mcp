import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { OAuth2Client, type Credentials } from 'google-auth-library';
import { EmailError } from '@fluxmail/core';
import type { FluxmailConfig } from '../config.js';

/**
 * Full mail scope: the unified API includes permanent delete, which Gmail only
 * allows with https://mail.google.com/ (gmail.modify cannot call messages.delete).
 * Users bring their own OAuth app, so they are consenting to their own credentials.
 */
export const GMAIL_SCOPES = ['https://mail.google.com/', 'openid', 'email', 'profile'];

export function requireGoogleConfig(config: FluxmailConfig): { clientId: string; clientSecret: string } {
  if (!config.google) {
    throw new EmailError(
      'invalid_request',
      'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not set. Create OAuth credentials in Google Cloud ' +
        '(see README "Google setup") and set both environment variables.',
    );
  }
  return config.google;
}

export function createOAuthClient(config: FluxmailConfig, redirectUri: string): OAuth2Client {
  const { clientId, clientSecret } = requireGoogleConfig(config);
  return new OAuth2Client({ clientId, clientSecret, redirectUri });
}

export function buildAuthUrl(client: OAuth2Client, state: string): string {
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: GMAIL_SCOPES,
    state,
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

function oauthListenerError(err: Error, port: number): Error {
  const code = (err as NodeJS.ErrnoException).code;
  if (code !== 'EADDRINUSE') return err;

  return new Error(
    `OAuth callback port ${port} is already in use.\n\n` +
      'If Fluxmail is already running with Docker Compose, connect the account inside the container:\n\n' +
      '  docker compose exec fluxmail fluxmail accounts add gmail --owner <member>\n\n' +
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

export async function exchangeCode(client: OAuth2Client, code: string): Promise<OAuthResult> {
  const { tokens } = await client.getToken(code);
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
export async function runLoopbackFlow<T = OAuthResult>(
  config: FluxmailConfig,
  onAuthUrl: (url: string) => void,
  onAuthorized?: (result: OAuthResult) => T | Promise<T>,
): Promise<T> {
  const redirectUri = `http://localhost:${config.oauthPort}/oauth/callback`;
  const client = createOAuthClient(config, redirectUri);
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
        const result = await exchangeCode(client, code);
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
      onAuthUrl(buildAuthUrl(client, state));
    });
  });
}
