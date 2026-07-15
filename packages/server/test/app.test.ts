import { describe, expect, it, vi } from 'vitest';
import { EmailError } from '@fluxmail/core';
import type { FluxmailConfig } from '../src/config.js';
import { createApp, type AppDeps } from '../src/http/app.js';
import { AccountRegistry } from '../src/accounts/registry.js';
import { createApiKey } from '../src/storage/apiKeys.js';
import { members, openDb } from '../src/storage/db.js';
import { createGmailConnectionGrant, createOutlookConnectionGrant } from '../src/storage/gmailConnectionGrants.js';
import { addMember, setMemberRole } from '../src/storage/members.js';
import { exchangeCode } from '../src/accounts/googleAuth.js';
import { exchangeMicrosoftCode } from '../src/accounts/microsoftAuth.js';
import type { MicrosoftCredentials } from '../src/accounts/microsoftAuth.js';
import { VERSION } from '../src/version.js';
import { EmailService } from '../src/service/emailService.js';

vi.mock('../src/accounts/googleAuth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/accounts/googleAuth.js')>()),
  exchangeCode: vi.fn(),
}));

vi.mock('../src/accounts/microsoftAuth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/accounts/microsoftAuth.js')>()),
  exchangeMicrosoftCode: vi.fn(),
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
    microsoft: { clientId: 'microsoft-client-id', clientSecret: 'microsoft-secret', tenantId: 'common' },
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

function microsoftCredentials(refreshToken = 'refresh'): MicrosoftCredentials {
  return {
    accessToken: `access-${refreshToken}`,
    refreshToken,
    expiresAt: Date.now() + 3_600_000,
    clientAuth: 'confidential',
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

  it('creates a one-time hosted Outlook link through the management API', async () => {
    const deps = appDeps('apikey');
    deps.config.publicUrl = 'https://mail.example.com';
    deps.config.publicUrlConfigured = true;
    const member = addMember(deps.db, { name: 'Alice', role: 'admin' });
    const { key } = createApiKey(deps.db, 'admin-key', member.id);
    const app = createApp(deps);

    const response = await app.request('/auth/connections', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'outlook', owner: member.id }),
    });

    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const result = (await response.json()) as { provider: string; connectionUrl: string; expiresAt: string };
    expect(result.provider).toBe('outlook');
    expect(result.connectionUrl).toMatch(/^https:\/\/mail\.example\.com\/auth\/microsoft\/connect\?token=/);
    expect(result.connectionUrl).not.toContain(key);
    expect(Date.parse(result.expiresAt)).toBeGreaterThan(Date.now());
  });

  it('completes the hosted Outlook OAuth flow with a confidential client', async () => {
    vi.mocked(exchangeMicrosoftCode).mockResolvedValue({
      email: 'owner@outlook.com',
      displayName: 'Outlook Owner',
      credentials: {
        accessToken: 'access',
        refreshToken: 'refresh',
        expiresAt: Date.now() + 3_600_000,
        clientAuth: 'confidential',
      },
    });
    const deps = appDeps('apikey');
    deps.config.publicUrl = 'https://mail.example.com';
    deps.config.publicUrlConfigured = true;
    const member = addMember(deps.db, { name: 'Owner' });
    const { token } = createOutlookConnectionGrant(deps.db, { memberId: member.id });
    const app = createApp(deps);

    const preview = await app.request(`/auth/microsoft/connect?token=${encodeURIComponent(token)}`);
    expect(preview.status).toBe(200);
    await expect(preview.text()).resolves.toContain('Continue with Microsoft');

    const start = await app.request(`/auth/microsoft/connect?token=${encodeURIComponent(token)}`, { method: 'POST' });
    expect(start.status).toBe(302);
    const microsoftUrl = new URL(start.headers.get('location') ?? '');
    expect(microsoftUrl.searchParams.get('redirect_uri')).toBe('https://mail.example.com/auth/microsoft/callback');
    const state = microsoftUrl.searchParams.get('state');

    const callback = await app.request(`/auth/microsoft/callback?state=${state}&code=authorization-code`);
    expect(callback.status).toBe(200);
    expect(callback.headers.get('cache-control')).toBe('no-store');
    expect(callback.headers.get('referrer-policy')).toBe('no-referrer');
    expect(deps.registry.listAccounts()[0]).toMatchObject({
      provider: 'outlook',
      email: 'owner@outlook.com',
      memberId: member.id,
    });
    expect(exchangeMicrosoftCode).toHaveBeenCalledWith(
      deps.config,
      'authorization-code',
      'https://mail.example.com/auth/microsoft/callback',
      expect.any(String),
      'confidential',
    );
  });

  it('rejects invalid, expired, and reused Outlook connection links', async () => {
    const deps = appDeps('apikey');
    const app = createApp(deps);

    const invalid = await app.request('/auth/microsoft/connect?token=not-a-token');
    expect(invalid.status).toBe(400);
    await expect(invalid.text()).resolves.toContain('Outlook connection link is invalid');

    const expiredGrant = createOutlookConnectionGrant(deps.db, {}, 0);
    const expired = await app.request(`/auth/microsoft/connect?token=${encodeURIComponent(expiredGrant.token)}`);
    expect(expired.status).toBe(410);
    await expect(expired.text()).resolves.toContain('Outlook connection link has expired');

    const activeGrant = createOutlookConnectionGrant(deps.db);
    expect(
      (
        await app.request(`/auth/microsoft/connect?token=${encodeURIComponent(activeGrant.token)}`, {
          method: 'POST',
        })
      ).status,
    ).toBe(302);
    const reused = await app.request(`/auth/microsoft/connect?token=${encodeURIComponent(activeGrant.token)}`, {
      method: 'POST',
    });
    expect(reused.status).toBe(410);
    await expect(reused.text()).resolves.toContain('already been used');
  });

  it('handles Microsoft denial, missing codes, invalid state, and restart state loss', async () => {
    const deps = appDeps('apikey');
    const app = createApp(deps);

    expect((await app.request('/auth/microsoft/callback?state=missing&code=code')).status).toBe(400);

    const deniedGrant = createOutlookConnectionGrant(deps.db);
    const deniedStart = await app.request(`/auth/microsoft/connect?token=${encodeURIComponent(deniedGrant.token)}`, {
      method: 'POST',
    });
    const deniedState = new URL(deniedStart.headers.get('location') ?? '').searchParams.get('state');
    const denied = await app.request(
      `/auth/microsoft/callback?state=${deniedState}&error=access_denied&error_description=User+cancelled`,
    );
    expect(denied.status).toBe(400);
    await expect(denied.text()).resolves.toContain('User cancelled');
    expect((await app.request(`/auth/microsoft/callback?state=${deniedState}&code=late-code`)).status).toBe(400);

    const missingCodeGrant = createOutlookConnectionGrant(deps.db);
    const missingCodeStart = await app.request(
      `/auth/microsoft/connect?token=${encodeURIComponent(missingCodeGrant.token)}`,
      { method: 'POST' },
    );
    const missingCodeState = new URL(missingCodeStart.headers.get('location') ?? '').searchParams.get('state');
    const missingCode = await app.request(`/auth/microsoft/callback?state=${missingCodeState}`);
    expect(missingCode.status).toBe(400);
    await expect(missingCode.text()).resolves.toContain('Missing code');

    const restartGrant = createOutlookConnectionGrant(deps.db);
    const restartStart = await app.request(`/auth/microsoft/connect?token=${encodeURIComponent(restartGrant.token)}`, {
      method: 'POST',
    });
    const restartState = new URL(restartStart.headers.get('location') ?? '').searchParams.get('state');
    const restartedApp = createApp(deps);
    const afterRestart = await restartedApp.request(`/auth/microsoft/callback?state=${restartState}&code=code`);
    expect(afterRestart.status).toBe(400);
    await expect(afterRestart.text()).resolves.toContain('Invalid or expired OAuth state');
  });

  it('reauthorizes the matching Outlook mailbox and rejects a different account', async () => {
    const deps = appDeps('apikey');
    deps.config.publicUrl = 'https://mail.example.com';
    deps.config.publicUrlConfigured = true;
    const member = addMember(deps.db, { name: 'Owner', role: 'admin' });
    const { key } = createApiKey(deps.db, 'admin-key', member.id);
    const existing = deps.registry.addOutlookAccount(
      'expected@outlook.com',
      microsoftCredentials('old-refresh'),
      'Original Name',
      member.id,
    );
    const app = createApp(deps);
    const startReauthorization = async (): Promise<string | null> => {
      const link = await app.request('/auth/connections', {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'outlook', reauthorizeAccountId: existing.id }),
      });
      expect(link.status).toBe(201);
      const { connectionUrl } = (await link.json()) as { connectionUrl: string };
      const connectUrl = new URL(connectionUrl);
      const start = await app.request(`${connectUrl.pathname}${connectUrl.search}`, { method: 'POST' });
      return new URL(start.headers.get('location') ?? '').searchParams.get('state');
    };

    vi.mocked(exchangeMicrosoftCode).mockResolvedValueOnce({
      email: 'EXPECTED@outlook.com',
      displayName: 'Updated Name',
      credentials: microsoftCredentials('new-refresh'),
    });
    const matchingState = await startReauthorization();
    expect((await app.request(`/auth/microsoft/callback?state=${matchingState}&code=matching`)).status).toBe(200);
    expect(deps.registry.listAccounts()).toHaveLength(1);
    expect(deps.registry.getAccount(existing.id)).toMatchObject({ displayName: 'Updated Name', memberId: member.id });

    vi.mocked(exchangeMicrosoftCode).mockResolvedValueOnce({
      email: 'different@outlook.com',
      credentials: microsoftCredentials('wrong-refresh'),
    });
    const mismatchState = await startReauthorization();
    const mismatch = await app.request(`/auth/microsoft/callback?state=${mismatchState}&code=mismatch`);
    expect(mismatch.status).toBe(400);
    await expect(mismatch.text()).resolves.toContain('belongs to expected@outlook.com');
    expect(deps.registry.listAccounts()).toHaveLength(1);
  });

  it('preserves selected sharing through the hosted Outlook management flow', async () => {
    vi.mocked(exchangeMicrosoftCode).mockResolvedValue({
      email: 'shared@outlook.com',
      credentials: microsoftCredentials(),
    });
    const deps = appDeps('apikey');
    deps.config.publicUrl = 'https://mail.example.com';
    deps.config.publicUrlConfigured = true;
    const owner = addMember(deps.db, { name: 'Owner', role: 'admin' });
    deps.db
      .insert(members)
      .values({
        id: 'member_teammate',
        name: 'Teammate',
        email: 'teammate@example.com',
        role: 'member',
        createdAt: Date.now(),
      })
      .run();
    const teammate = { id: 'member_teammate', email: 'teammate@example.com' };
    const { key } = createApiKey(deps.db, 'admin-key', owner.id);
    const app = createApp(deps);

    const created = await app.request('/auth/connections', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        provider: 'outlook',
        owner: owner.id,
        sharingMode: 'selected',
        shareWith: [teammate.email],
      }),
    });
    expect(created.status).toBe(201);
    const { connectionUrl } = (await created.json()) as { connectionUrl: string };
    const start = await app.request(new URL(connectionUrl).pathname + new URL(connectionUrl).search, {
      method: 'POST',
    });
    const state = new URL(start.headers.get('location') ?? '').searchParams.get('state');
    expect((await app.request(`/auth/microsoft/callback?state=${state}&code=shared`)).status).toBe(200);

    expect(deps.registry.listAccounts()[0]).toMatchObject({
      memberId: owner.id,
      sharingMode: 'selected',
      sharedMemberIds: [teammate.id],
    });
  });

  it('enforces admin access, hosted configuration, validation, and mailbox limits for Outlook links', async () => {
    const deps = appDeps('apikey');
    deps.config.publicUrl = 'https://mail.example.com';
    deps.config.publicUrlConfigured = true;
    const member = addMember(deps.db, { name: 'Member', role: 'member' });
    const { key: memberKey } = createApiKey(deps.db, 'member-key', member.id);
    const app = createApp(deps);
    const request = (body: unknown, key = memberKey) =>
      app.request('/auth/connections', {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    expect((await request({ provider: 'outlook', owner: member.id })).status).toBe(401);
    setMemberRole(deps.db, member.id, 'admin');
    expect((await request({ provider: 'exchange', owner: member.id })).status).toBe(400);
    expect((await request({ provider: 'outlook' })).status).toBe(400);
    const malformedShareWith = await request({
      provider: 'outlook',
      owner: member.id,
      shareWith: 'teammate@example.com',
    });
    expect(malformedShareWith.status).toBe(400);
    await expect(malformedShareWith.text()).resolves.toContain('shareWith must be an array');
    expect(
      (
        await request({
          provider: 'outlook',
          owner: member.id,
          sharingMode: 'selected',
          shareWith: [],
        })
      ).status,
    ).toBe(400);

    const secret = deps.config.microsoft?.clientSecret;
    delete deps.config.microsoft?.clientSecret;
    const missingSecret = await request({ provider: 'outlook', owner: member.id });
    expect(missingSecret.status).toBe(400);
    await expect(missingSecret.text()).resolves.toContain('MICROSOFT_CLIENT_SECRET');
    if (deps.config.microsoft && secret) deps.config.microsoft.clientSecret = secret;

    for (const email of ['one@example.com', 'two@example.com', 'three@example.com']) {
      deps.registry.addOutlookAccount(email, microsoftCredentials(email), undefined, member.id);
    }
    const overLimit = await request({ provider: 'outlook', owner: member.id });
    expect(overLimit.status).toBe(400);
    await expect(overLimit.text()).resolves.toContain('mailbox');
  });

  it('rechecks the mailbox limit when a hosted Outlook callback completes', async () => {
    vi.mocked(exchangeMicrosoftCode).mockResolvedValue({
      email: 'fourth@outlook.com',
      credentials: microsoftCredentials('fourth'),
    });
    const deps = appDeps('apikey');
    const owner = addMember(deps.db, { name: 'Owner' });
    const grant = createOutlookConnectionGrant(deps.db, { memberId: owner.id });
    const app = createApp(deps);
    const start = await app.request(`/auth/microsoft/connect?token=${encodeURIComponent(grant.token)}`, {
      method: 'POST',
    });
    const state = new URL(start.headers.get('location') ?? '').searchParams.get('state');
    for (const email of ['one@example.com', 'two@example.com', 'three@example.com']) {
      deps.registry.addOutlookAccount(email, microsoftCredentials(email), undefined, owner.id);
    }

    const callback = await app.request(`/auth/microsoft/callback?state=${state}&code=fourth`);
    expect(callback.status).toBe(400);
    await expect(callback.text()).resolves.toContain('mailbox');
    expect(deps.registry.listAccounts()).toHaveLength(3);
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
