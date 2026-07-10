import { createServer } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { OAuth2Client } from 'google-auth-library';
import { EmailError } from '@fluxmail/core';
import type { FluxmailConfig } from '../src/config.js';
import { identityFromIdToken, runLoopbackFlow } from '../src/accounts/googleAuth.js';

function oauthClient(claims: Record<string, unknown>): OAuth2Client {
  return {
    _clientId: 'client-id',
    verifyIdToken: vi.fn().mockResolvedValue({ getPayload: () => claims }),
  } as unknown as OAuth2Client;
}

describe('Google OAuth identity', () => {
  it('verifies the id token against the configured client id', async () => {
    const client = oauthClient({
      email: 'me@example.com',
      email_verified: true,
      name: 'Example User',
    });

    await expect(identityFromIdToken(client, { id_token: 'signed-token' })).resolves.toEqual({
      email: 'me@example.com',
      displayName: 'Example User',
    });
    expect(client.verifyIdToken).toHaveBeenCalledWith({
      idToken: 'signed-token',
      audience: 'client-id',
    });
  });

  it('rejects an unverified email claim', async () => {
    const client = oauthClient({ email: 'me@example.com', email_verified: false });

    await expect(identityFromIdToken(client, { id_token: 'signed-token' })).rejects.toMatchObject({
      code: 'provider_unavailable',
    });
  });

  it('rejects a verified token with no claims payload', async () => {
    const client = oauthClient({});
    vi.mocked(client.verifyIdToken).mockResolvedValue({ getPayload: () => undefined } as never);

    await expect(identityFromIdToken(client, { id_token: 'signed-token' })).rejects.toMatchObject({
      code: 'provider_unavailable',
    });
  });
});

describe('Google OAuth callback listener', () => {
  it('explains how to connect an account when Docker is using the callback port', async () => {
    const existingServer = createServer();
    await new Promise<void>((resolve) => existingServer.listen(0, '127.0.0.1', resolve));
    const address = existingServer.address();
    if (!address || typeof address === 'string') throw new Error('Test server did not bind to a TCP port');

    const config: FluxmailConfig = {
      dataDir: '/tmp/fluxmail-test',
      dbPath: '/tmp/fluxmail-test/fluxmail.db',
      encryptionKey: Buffer.alloc(32),
      port: 8977,
      baseUrl: 'http://127.0.0.1:8977',
      oauthPort: address.port,
      oauthHost: '127.0.0.1',
      authMode: 'apikey',
      google: { clientId: 'client-id', clientSecret: 'client-secret' },
    };

    try {
      await expect(runLoopbackFlow(config, vi.fn())).rejects.toThrow(
        new RegExp(
          `OAuth callback port ${address.port} is already in use[\\s\\S]*` +
            'docker compose exec fluxmail fluxmail accounts add gmail'
        )
      );
    } finally {
      await new Promise<void>((resolve, reject) =>
        existingServer.close((err) => (err ? reject(err) : resolve()))
      );
    }
  });

  it('shows a browser error when the authorized account is rejected', async () => {
    const portProbe = createServer();
    await new Promise<void>((resolve) => portProbe.listen(0, '127.0.0.1', resolve));
    const address = portProbe.address();
    if (!address || typeof address === 'string') throw new Error('Test server did not bind to a TCP port');
    await new Promise<void>((resolve, reject) =>
      portProbe.close((err) => (err ? reject(err) : resolve()))
    );

    const getToken = vi.spyOn(OAuth2Client.prototype, 'getToken').mockResolvedValue({
      tokens: { refresh_token: 'refresh-token', id_token: 'id-token' },
      res: null,
    });
    const verifyIdToken = vi.spyOn(OAuth2Client.prototype, 'verifyIdToken').mockResolvedValue({
      getPayload: () => ({ email: 'other@example.com', email_verified: true }),
    } as never);
    let provideAuthUrl!: (url: string) => void;
    const authUrl = new Promise<string>((resolve) => {
      provideAuthUrl = resolve;
    });
    const config: FluxmailConfig = {
      dataDir: '/tmp/fluxmail-test',
      dbPath: '/tmp/fluxmail-test/fluxmail.db',
      encryptionKey: Buffer.alloc(32),
      port: 8977,
      baseUrl: 'http://127.0.0.1:8977',
      oauthPort: address.port,
      oauthHost: '127.0.0.1',
      authMode: 'apikey',
      google: { clientId: 'client-id', clientSecret: 'client-secret' },
    };

    try {
      const flow = runLoopbackFlow(config, provideAuthUrl, () => {
        throw new EmailError(
          'invalid_request',
          'Google authorized other@example.com, but the stored account belongs to expected@example.com.'
        );
      });
      const flowError = expect(flow).rejects.toThrow(/Google authorized other@example.com/);
      const state = new URL(await authUrl).searchParams.get('state');
      const response = await fetch(
        `http://127.0.0.1:${address.port}/oauth/callback?state=${state}&code=authorization-code`
      );
      const page = await response.text();

      expect(response.status).toBe(400);
      expect(page).toContain('Fluxmail could not connect this account');
      expect(page).toContain('Google authorized other@example.com');
      expect(page).not.toContain('is connected to Fluxmail');
      await flowError;
    } finally {
      getToken.mockRestore();
      verifyIdToken.mockRestore();
    }
  });
});
