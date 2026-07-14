import { describe, expect, it, vi } from 'vitest';
import { EmailError } from '@fluxmail/core';
import type { FluxmailConfig } from '../src/config.js';
import { createApp, type AppDeps } from '../src/http/app.js';
import { AccountRegistry } from '../src/accounts/registry.js';
import { createApiKey } from '../src/storage/apiKeys.js';
import { openDb } from '../src/storage/db.js';
import { createGmailConnectionGrant } from '../src/storage/gmailConnectionGrants.js';
import { addMember, setMemberRole } from '../src/storage/members.js';
import { exchangeCode } from '../src/accounts/googleAuth.js';
import { VERSION } from '../src/version.js';
import { EmailService } from '../src/service/emailService.js';

vi.mock('../src/accounts/googleAuth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/accounts/googleAuth.js')>()),
  exchangeCode: vi.fn(),
}));

function appDeps(authMode: FluxmailConfig['authMode']): AppDeps {
  const config: FluxmailConfig = {
    dataDir: ':memory:',
    dbPath: ':memory:',
    encryptionKey: Buffer.alloc(32),
    port: 8977,
    publicUrl: 'http://localhost:8977',
    publicUrlConfigured: false,
    oauthPort: 8976,
    oauthHost: '127.0.0.1',
    authMode,
    maxAttachmentBytes: 10 * 1024 * 1024,
    licenseServerUrl: 'https://license.invalid',
    google: { clientId: 'client-id', clientSecret: 'client-secret' },
  };
  const db = openDb(':memory:');
  const registry = new AccountRegistry(db, config);
  return {
    config,
    db,
    registry,
    service: new EmailService(registry, db),
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
    const member = addMember(deps.db, { name: 'Alice' });
    const { key } = createApiKey(deps.db, 'test', member.id);
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
    const member = addMember(deps.db, { name: 'Alice', role: 'member' });
    const { key: memberKey } = createApiKey(deps.db, 'alice-key', member.id);
    const app = createApp(deps);

    const denied = await app.request(`/auth/google?key=${encodeURIComponent(memberKey)}&owner=${member.id}`);
    expect(denied.status).toBe(401);

    setMemberRole(deps.db, member.id, 'admin');
    const allowed = await app.request(`/auth/google?key=${encodeURIComponent(memberKey)}&owner=${member.id}`);
    expect(allowed.status).toBe(302);
  });

  it('requires confirmation before claiming a connection link', async () => {
    const deps = appDeps('apikey');
    deps.config.publicUrl = 'https://mail.example.com';
    deps.config.publicUrlConfigured = true;
    const { token } = createGmailConnectionGrant(deps.db);
    const app = createApp(deps);

    const preview = await app.request(`/auth/google/connect?token=${encodeURIComponent(token)}`, {
      method: 'HEAD',
    });
    expect(preview.status).toBe(204);
    expect(preview.headers.get('cache-control')).toBe('no-store');

    const response = await app.request(`/auth/google/connect?token=${encodeURIComponent(token)}`);
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toContain('Continue with Google');

    const repeatedPreview = await app.request(`/auth/google/connect?token=${encodeURIComponent(token)}`);
    expect(repeatedPreview.status).toBe(200);

    const continued = await app.request(`/auth/google/connect?token=${encodeURIComponent(token)}`, {
      method: 'POST',
    });
    expect(continued.status).toBe(302);
    expect(continued.headers.get('cache-control')).toBe('no-store');
    expect(continued.headers.get('referrer-policy')).toBe('no-referrer');
    const googleUrl = new URL(continued.headers.get('location') ?? '');
    expect(googleUrl.searchParams.get('redirect_uri')).toBe('https://mail.example.com/auth/google/callback');

    const reused = await app.request(`/auth/google/connect?token=${encodeURIComponent(token)}`, {
      method: 'POST',
    });
    expect(reused.status).toBe(410);
    await expect(reused.text()).resolves.toContain('already been used');
  });

  it('shows clear errors for invalid and expired connection links', async () => {
    const deps = appDeps('apikey');
    const app = createApp(deps);

    const invalid = await app.request('/auth/google/connect?token=not-a-token');
    expect(invalid.status).toBe(400);
    await expect(invalid.text()).resolves.toContain('link is invalid');

    const { token } = createGmailConnectionGrant(deps.db, {}, 0);
    const expired = await app.request(`/auth/google/connect?token=${encodeURIComponent(token)}`);
    expect(expired.status).toBe(410);
    await expect(expired.text()).resolves.toContain('link has expired');
  });

  it('does not accept connection tokens as MCP or admin credentials', async () => {
    const deps = appDeps('apikey');
    const { token } = createGmailConnectionGrant(deps.db);
    const app = createApp(deps);

    const mcp = await app.request('/mcp', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(mcp.status).toBe(401);
    expect((await app.request(`/auth/google?key=${encodeURIComponent(token)}`)).status).toBe(401);
  });

  it('connects a Gmail account and refreshes it without creating a duplicate', async () => {
    vi.mocked(exchangeCode)
      .mockResolvedValueOnce({
        email: 'owner@example.com',
        displayName: 'Owner',
        tokens: { refresh_token: 'first', id_token: 'first-id' },
      })
      .mockResolvedValueOnce({
        email: 'owner@example.com',
        displayName: 'Owner Updated',
        tokens: { refresh_token: 'second', id_token: 'second-id' },
      });
    const deps = appDeps('apikey');
    const app = createApp(deps);
    const member = addMember(deps.db, { name: 'Owner' });

    for (const code of ['first-code', 'second-code']) {
      const { token } = createGmailConnectionGrant(deps.db, { memberId: member.id, sharingMode: 'private' });
      const start = await app.request(`/auth/google/connect?token=${encodeURIComponent(token)}`, { method: 'POST' });
      const state = new URL(start.headers.get('location') ?? '').searchParams.get('state');
      const callback = await app.request(`/auth/google/callback?state=${state}&code=${code}`);
      expect(callback.status).toBe(200);
    }

    expect(deps.registry.listAccounts()).toHaveLength(1);
    expect(deps.registry.listAccounts()[0]).toMatchObject({
      email: 'owner@example.com',
      displayName: 'Owner Updated',
    });
  });

  it('preserves member ownership and reauthorization checks through the hosted flow', async () => {
    vi.mocked(exchangeCode).mockResolvedValue({
      email: 'other@example.com',
      tokens: { refresh_token: 'refresh', id_token: 'id' },
    });
    const deps = appDeps('apikey');
    const member = addMember(deps.db, { name: 'Alice' });
    const existing = deps.registry.addGmailAccount(
      'expected@example.com',
      { refresh_token: 'old' },
      undefined,
      member.id,
    );
    const app = createApp(deps);

    const ownedGrant = createGmailConnectionGrant(deps.db, { memberId: member.id });
    const ownedStart = await app.request(`/auth/google/connect?token=${encodeURIComponent(ownedGrant.token)}`, {
      method: 'POST',
    });
    const ownedState = new URL(ownedStart.headers.get('location') ?? '').searchParams.get('state');
    expect((await app.request(`/auth/google/callback?state=${ownedState}&code=owned`)).status).toBe(200);
    expect(deps.registry.listAccounts().find((account) => account.email === 'other@example.com')?.memberId).toBe(
      member.id,
    );

    const reauthGrant = createGmailConnectionGrant(deps.db, { reauthorizeAccountId: existing.id });
    const reauthStart = await app.request(`/auth/google/connect?token=${encodeURIComponent(reauthGrant.token)}`, {
      method: 'POST',
    });
    const reauthState = new URL(reauthStart.headers.get('location') ?? '').searchParams.get('state');
    const mismatch = await app.request(`/auth/google/callback?state=${reauthState}&code=wrong-account`);
    expect(mismatch.status).toBe(400);
    await expect(mismatch.text()).resolves.toContain('belongs to expected@example.com');
  });

  it('enforces the mailbox plan limit when the hosted callback adds an account', async () => {
    vi.mocked(exchangeCode).mockResolvedValue({
      email: 'fourth@example.com',
      tokens: { refresh_token: 'refresh', id_token: 'id' },
    });
    const deps = appDeps('apikey');
    const member = addMember(deps.db, { name: 'Owner' });
    for (const email of ['one@example.com', 'two@example.com', 'three@example.com']) {
      deps.registry.addGmailAccount(email, { refresh_token: email }, undefined, member.id);
    }
    const app = createApp(deps);
    const { token } = createGmailConnectionGrant(deps.db, { memberId: member.id });
    const start = await app.request(`/auth/google/connect?token=${encodeURIComponent(token)}`, { method: 'POST' });
    const state = new URL(start.headers.get('location') ?? '').searchParams.get('state');

    const callback = await app.request(`/auth/google/callback?state=${state}&code=fourth`);
    expect(callback.status).toBe(400);
    await expect(callback.text()).resolves.toContain('mailbox');
    expect(deps.registry.listAccounts()).toHaveLength(3);
  });

  it('reports why the OAuth callback failed instead of a blank 500', async () => {
    vi.mocked(exchangeCode).mockRejectedValue(
      new EmailError('invalid_request', 'Google did not return a refresh token.'),
    );
    const deps = appDeps('none');
    const member = addMember(deps.db, { name: 'Owner' });
    const app = createApp(deps);

    const start = await app.request(`/auth/google?owner=${member.id}`);
    expect(start.status).toBe(302);
    const state = new URL(start.headers.get('location') ?? '').searchParams.get('state');

    const response = await app.request(`/auth/google/callback?state=${state}&code=auth-code`);
    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toContain('Google did not return a refresh token.');
  });
});
