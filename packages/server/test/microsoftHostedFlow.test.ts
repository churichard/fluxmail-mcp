import { afterEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FluxmailConfig } from '../src/config.js';
import { createApp, type AppDeps } from '../src/http/app.js';
import { AccountRegistry } from '../src/accounts/registry.js';
import { createApiKey } from '../src/storage/apiKeys.js';
import { permissionPolicyForProfile } from '../src/permissions.js';
import { accountCredentials, openDb } from '../src/storage/db.js';
import { decryptString } from '../src/storage/crypto.js';
import { addMember } from '../src/storage/members.js';
import { EmailService } from '../src/service/emailService.js';

function hostedDeps(): AppDeps {
  const config: FluxmailConfig = {
    dataDir: ':memory:',
    dbPath: ':memory:',
    encryptionKey: Buffer.alloc(32, 7),
    port: 8977,
    publicUrl: 'https://mail.example.com',
    publicUrlConfigured: true,
    oauthPort: 8976,
    oauthHost: '127.0.0.1',
    maxAttachmentBytes: 10 * 1024 * 1024,
    licenseServerUrl: 'https://license.invalid',
    microsoft: {
      clientId: 'hosted-client-id',
      clientSecret: 'hosted-client-secret',
      tenantId: 'common',
    },
  };
  const db = openDb(':memory:');
  const registry = new AccountRegistry(db, config);
  return { config, db, registry, service: new EmailService(registry, db) };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('hosted Outlook OAuth flow', () => {
  it('connects and refreshes a mailbox through the real auth and storage layers', async () => {
    const tokenBodies: URLSearchParams[] = [];
    const graphRequests: Array<{ url: string; authorization: string | null }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (url === 'https://login.microsoftonline.com/common/oauth2/v2.0/token') {
        const body = new URLSearchParams(String(init?.body));
        tokenBodies.push(body);
        if (body.get('grant_type') === 'authorization_code') {
          return new Response(
            JSON.stringify({
              access_token: 'initial-access-token',
              refresh_token: 'initial-refresh-token',
              expires_in: 1,
              scope: 'User.Read Mail.ReadWrite Mail.Send offline_access',
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        if (body.get('grant_type') === 'refresh_token') {
          return new Response(
            JSON.stringify({
              access_token: 'refreshed-access-token',
              expires_in: 3600,
              scope: 'User.Read Mail.ReadWrite Mail.Send offline_access',
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
      }

      if (url.startsWith('https://graph.microsoft.com/v1.0/')) {
        const authorization = new Headers(init?.headers).get('authorization');
        graphRequests.push({ url, authorization });
        if (url.includes('/me?$select=')) {
          return new Response(
            JSON.stringify({
              mail: 'owner@outlook.com',
              userPrincipalName: 'owner@outlook.com',
              displayName: 'Outlook Owner',
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        if (url.includes('/me/mailFolders/inbox')) {
          return new Response(JSON.stringify({ id: 'inbox-id' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
      }

      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const deps = hostedDeps();
    const owner = addMember(deps.db, { name: 'Owner', email: 'owner@example.com', role: 'admin' });
    const { key } = createApiKey(
      deps.db,
      'product-backend',
      owner.id,
      permissionPolicyForProfile('full', ['admin.accounts']),
    );
    const app = createApp(deps);

    const linkResponse = await app.request('/auth/connections', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'outlook', ownerMemberId: owner.id }),
    });
    expect(linkResponse.status).toBe(201);
    const { connectionUrl } = (await linkResponse.json()) as { connectionUrl: string };
    const connectUrl = new URL(connectionUrl);

    const confirmation = await app.request(`${connectUrl.pathname}${connectUrl.search}`);
    expect(confirmation.status).toBe(200);
    await expect(confirmation.text()).resolves.toContain('Continue with Microsoft');

    const authorizationStart = await app.request(`${connectUrl.pathname}${connectUrl.search}`, { method: 'POST' });
    expect(authorizationStart.status).toBe(302);
    const authorizationUrl = new URL(authorizationStart.headers.get('location') ?? '');
    expect(authorizationUrl.origin).toBe('https://login.microsoftonline.com');
    expect(authorizationUrl.searchParams.get('client_id')).toBe('hosted-client-id');
    expect(authorizationUrl.searchParams.get('redirect_uri')).toBe('https://mail.example.com/auth/microsoft/callback');
    expect(authorizationUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorizationUrl.searchParams.get('code_challenge')).toBeTruthy();

    const state = authorizationUrl.searchParams.get('state');
    expect(state).toBeTruthy();
    const callback = await app.request(`/auth/microsoft/callback?state=${state}&code=microsoft-code`);
    expect(callback.status).toBe(200);
    await expect(callback.text()).resolves.toContain('owner@outlook.com is connected');

    const account = deps.registry.listAccounts()[0]!;
    expect(account).toMatchObject({
      provider: 'outlook',
      email: 'owner@outlook.com',
      displayName: 'Outlook Owner',
      ownerMemberId: owner.id,
      sharedWithAll: false,
    });

    const storedBeforeRefresh = deps.db
      .select()
      .from(accountCredentials)
      .where(eq(accountCredentials.accountId, account.id))
      .get();
    expect(storedBeforeRefresh).toBeDefined();
    expect(storedBeforeRefresh!.encryptedCredentials).not.toContain('initial-refresh-token');
    expect(
      JSON.parse(decryptString(deps.config.encryptionKey, storedBeforeRefresh!.encryptedCredentials)),
    ).toMatchObject({
      accessToken: 'initial-access-token',
      refreshToken: 'initial-refresh-token',
      clientAuth: 'confidential',
    });

    await deps.registry.getProvider(account.id).testConnection();

    const storedAfterRefresh = deps.db
      .select()
      .from(accountCredentials)
      .where(eq(accountCredentials.accountId, account.id))
      .get();
    expect(
      JSON.parse(decryptString(deps.config.encryptionKey, storedAfterRefresh!.encryptedCredentials)),
    ).toMatchObject({
      accessToken: 'refreshed-access-token',
      refreshToken: 'initial-refresh-token',
      clientAuth: 'confidential',
    });

    expect(tokenBodies).toHaveLength(2);
    expect(tokenBodies[0]!.get('grant_type')).toBe('authorization_code');
    expect(tokenBodies[0]!.get('code')).toBe('microsoft-code');
    expect(tokenBodies[0]!.get('code_verifier')).toBeTruthy();
    expect(tokenBodies[0]!.get('client_secret')).toBe('hosted-client-secret');
    expect(tokenBodies[1]!.get('grant_type')).toBe('refresh_token');
    expect(tokenBodies[1]!.get('refresh_token')).toBe('initial-refresh-token');
    expect(tokenBodies[1]!.get('client_secret')).toBe('hosted-client-secret');
    expect(graphRequests.at(-1)).toMatchObject({ authorization: 'Bearer refreshed-access-token' });
  });
});
