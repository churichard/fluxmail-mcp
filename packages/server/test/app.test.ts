import { describe, expect, it, vi } from 'vitest';
import { EmailError } from '@fluxmail/core';
import type { FluxmailConfig } from '../src/config.js';
import { createApp, type AppDeps } from '../src/http/app.js';
import { createApiKey } from '../src/storage/apiKeys.js';
import { openDb } from '../src/storage/db.js';
import { addMember } from '../src/storage/members.js';
import { exchangeCode } from '../src/accounts/googleAuth.js';
import { VERSION } from '../src/version.js';

vi.mock('../src/accounts/googleAuth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/accounts/googleAuth.js')>()),
  exchangeCode: vi.fn(),
}));

function appDeps(authMode: FluxmailConfig['authMode']): AppDeps {
  return {
    config: {
      dataDir: ':memory:',
      dbPath: ':memory:',
      encryptionKey: Buffer.alloc(32),
      port: 8977,
      baseUrl: 'http://localhost:8977',
      oauthPort: 8976,
      oauthHost: '127.0.0.1',
      authMode,
      licenseServerUrl: 'https://license.invalid',
      google: { clientId: 'client-id', clientSecret: 'client-secret' },
    },
    db: openDb(':memory:'),
    registry: {} as AppDeps['registry'],
    service: {} as AppDeps['service'],
  };
}

describe('HTTP app', () => {
  it('reports the package version on the health endpoint', async () => {
    const response = await createApp(appDeps('none')).request('/healthz');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      name: 'fluxmail',
      version: VERSION,
    });
  });

  it('rejects query-string API keys on the MCP endpoint', async () => {
    const deps = appDeps('apikey');
    const { key } = createApiKey(deps.db, 'test');
    const response = await createApp(deps).request(`/mcp?key=${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });

    expect(response.status).toBe(401);
  });

  it('returns a JSON-RPC parse error for malformed request JSON', async () => {
    const deps = appDeps('none');
    const response = await createApp(deps).request('/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      jsonrpc: '2.0',
      error: { code: -32700, message: 'Parse error' },
      id: null,
    });
  });

  it('only lets admin keys start the server-hosted OAuth flow', async () => {
    const deps = appDeps('apikey');
    const member = addMember(deps.db, { name: 'Alice' });
    const { key: memberKey } = createApiKey(deps.db, 'alice-key', member.id);
    const { key: adminKey } = createApiKey(deps.db, 'admin-key');
    const app = createApp(deps);

    const denied = await app.request(`/auth/google?key=${encodeURIComponent(memberKey)}`);
    expect(denied.status).toBe(401);

    const allowed = await app.request(`/auth/google?key=${encodeURIComponent(adminKey)}`);
    expect(allowed.status).toBe(302);
  });

  it('reports why the OAuth callback failed instead of a blank 500', async () => {
    vi.mocked(exchangeCode).mockRejectedValue(
      new EmailError('invalid_request', 'Google did not return a refresh token.')
    );
    const app = createApp(appDeps('none'));

    const start = await app.request('/auth/google');
    expect(start.status).toBe(302);
    const state = new URL(start.headers.get('location') ?? '').searchParams.get('state');

    const response = await app.request(`/auth/google/callback?state=${state}&code=auth-code`);
    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toContain('Google did not return a refresh token.');
  });
});
