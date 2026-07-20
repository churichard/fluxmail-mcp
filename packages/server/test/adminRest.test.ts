import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HttpBindings } from '@hono/node-server';
import { ConfigurationService, type DeploymentConfig } from '../src/config.js';
import { AccountRegistry } from '../src/accounts/registry.js';
import { EmailService } from '../src/service/emailService.js';
import { createApp } from '../src/http/app.js';
import { permissionPolicyForProfile } from '../src/permissions.js';
import { createApiKey } from '../src/storage/apiKeys.js';
import { adminAuditEvents, instanceSettings, members, openDb } from '../src/storage/db.js';
import { addMember, setMemberRole } from '../src/storage/members.js';
import { recordAdminAuditEvent } from '../src/storage/adminAudit.js';
import { administrationUsesHttps, requestClientAddress } from '../src/http/admin.js';
import type { Telemetry } from '../src/telemetry.js';

function fixture(telemetry?: Telemetry, environment: NodeJS.ProcessEnv = {}) {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'fluxmail-admin-rest-'));
  const deployment: DeploymentConfig = {
    dataDir,
    dbPath: ':memory:',
    encryptionKey: Buffer.alloc(32, 9),
    port: 8977,
    publicUrl: 'http://localhost:8977',
    publicUrlConfigured: false,
    oauthPort: 8976,
    oauthHost: '127.0.0.1',
    maxAttachmentBytes: 1024,
    licenseServerUrl: 'https://license.invalid',
    configFile: path.join(dataDir, 'config.toml'),
    environment,
    sources: {
      dataDir: 'environment',
      dbPath: 'default',
      encryptionKey: 'environment',
      port: 'default',
      publicUrl: 'default',
      trustProxy: 'default',
      oauthPort: 'default',
      oauthHost: 'default',
      maxAttachmentBytes: 'default',
      licenseServerUrl: 'default',
    },
  };
  const db = openDb(':memory:');
  const configuration = new ConfigurationService(deployment, db);
  if (!environment.GOOGLE_CLIENT_ID) {
    configuration.setGoogle({ clientId: 'google-client', clientSecret: 'google-secret' });
  }
  if (!environment.MICROSOFT_CLIENT_ID) {
    configuration.setMicrosoft({
      clientId: 'microsoft-client',
      clientSecret: 'microsoft-secret',
      tenantId: 'common',
    });
  }
  const config = configuration.config;
  const member = addMember(db, { name: 'Admin', role: 'admin' });
  const root = createApiKey(
    db,
    'root',
    member.id,
    permissionPolicyForProfile('full', ['admin.accounts', 'admin.api_keys', 'admin.license']),
  );
  const registry = new AccountRegistry(db, config);
  const app = createApp({ config, configuration, db, registry, service: new EmailService(registry, db), telemetry });
  const auth = { authorization: `Bearer ${root.key}` };
  return { app, auth, config, configuration, db, member, registry, root };
}

function jsonRequest(method: string, body: unknown, headers: Record<string, string> = {}): RequestInit {
  return {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  };
}

describe('administrative REST API', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('allows plaintext administration only for an actual loopback peer', () => {
    const request = new Request('http://localhost:8977/api/v1/admin/api-keys');
    expect(administrationUsesHttps(request, { remoteAddress: '127.0.0.1' })).toBe(true);
    expect(administrationUsesHttps(request, { remoteAddress: '::ffff:127.0.0.1' })).toBe(true);
    expect(administrationUsesHttps(request, { remoteAddress: '203.0.113.10' })).toBe(false);
    expect(administrationUsesHttps(request, { remoteAddress: '203.0.113.10', encrypted: true })).toBe(true);
    expect(administrationUsesHttps(new Request('https://mail.example.com/api/v1/admin/api-keys'))).toBe(true);
  });

  it('records successful and failed admin operations without request data', async () => {
    const capture = vi.fn();
    const telemetry = { capture, shutdown: vi.fn().mockResolvedValue(undefined) };
    const { app, auth } = fixture(telemetry);

    expect((await app.request('/api/v1/admin/api-keys', { headers: auth })).status).toBe(200);
    const privateKeyId = 'private@example.com';
    expect(
      (
        await app.request(`/api/v1/admin/api-keys/${privateKeyId}`, {
          method: 'DELETE',
          headers: auth,
        })
      ).status,
    ).toBe(404);

    expect(capture).toHaveBeenCalledWith(
      'operation completed',
      expect.objectContaining({
        product_surface: 'rest',
        operation: 'listAdministrativeApiKeys',
        outcome: 'success',
      }),
    );
    expect(capture).toHaveBeenCalledWith(
      'operation completed',
      expect.objectContaining({
        product_surface: 'rest',
        operation: 'revokeAdministrativeApiKey',
        outcome: 'error',
        error_code: 'not_found',
      }),
    );
    expect(JSON.stringify(capture.mock.calls)).not.toContain(privateKeyId);
  });

  it('records license deactivation as an administrative operation', async () => {
    const capture = vi.fn();
    const telemetry = { capture, shutdown: vi.fn().mockResolvedValue(undefined) };
    const { app, auth } = fixture(telemetry);

    expect((await app.request('/api/v1/admin/license', { method: 'DELETE', headers: auth })).status).toBe(200);
    expect(capture).toHaveBeenCalledWith(
      'operation completed',
      expect.objectContaining({
        product_surface: 'rest',
        operation: 'deactivateAdministrativeLicense',
        outcome: 'success',
      }),
    );
  });

  it('configures and resets OAuth applications without exposing secrets to responses, telemetry, or audit', async () => {
    const capture = vi.fn();
    const telemetry = { capture, shutdown: vi.fn().mockResolvedValue(undefined) };
    const { app, auth, config, db } = fixture(telemetry);
    const privateSecret = 'rest-private-client-secret';

    const initial = await app.request('/api/v1/admin/oauth-apps', { headers: auth });
    expect(initial.status).toBe(200);

    const updated = await app.request(
      '/api/v1/admin/oauth-apps/google',
      jsonRequest('PUT', { clientId: 'rest-google-id', clientSecret: privateSecret }, auth),
    );
    expect(updated.status).toBe(200);
    const body = await updated.text();
    expect(body).toContain('rest-google-id');
    expect(body).not.toContain(privateSecret);
    expect(config.google).toEqual({ clientId: 'rest-google-id', clientSecret: privateSecret });
    expect(JSON.stringify(db.select().from(instanceSettings).all())).not.toContain(privateSecret);

    const reset = await app.request('/api/v1/admin/oauth-apps/google', { method: 'DELETE', headers: auth });
    expect(reset.status).toBe(200);
    expect(config.google?.clientId).not.toBe('rest-google-id');
    expect(capture).toHaveBeenCalledWith(
      'operation completed',
      expect.objectContaining({
        product_surface: 'rest',
        operation: 'getAdministrativeOAuthApps',
        outcome: 'success',
      }),
    );
    expect(capture).toHaveBeenCalledWith(
      'operation completed',
      expect.objectContaining({
        product_surface: 'rest',
        operation: 'putAdministrativeOAuthApp',
        outcome: 'success',
      }),
    );
    expect(JSON.stringify(capture.mock.calls)).not.toContain(privateSecret);
    const audits = db.select().from(adminAuditEvents).all();
    expect(audits.map((event) => event.operation)).toContain('put /api/v1/admin/oauth-apps/:provider');
    expect(JSON.stringify(audits)).not.toContain(privateSecret);
  });

  it('rejects REST changes to environment-controlled OAuth applications', async () => {
    const capture = vi.fn();
    const telemetry = { capture, shutdown: vi.fn().mockResolvedValue(undefined) };
    const { app, auth } = fixture(telemetry, {
      GOOGLE_CLIENT_ID: 'environment-google-id',
      GOOGLE_CLIENT_SECRET: 'environment-google-secret',
    });
    const privateSecret = 'replacement-secret';
    const response = await app.request(
      '/api/v1/admin/oauth-apps/google',
      jsonRequest('PUT', { clientId: 'replacement-id', clientSecret: privateSecret }, auth),
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'oauth_from_environment' } });
    expect(capture).toHaveBeenCalledWith(
      'operation completed',
      expect.objectContaining({
        product_surface: 'rest',
        operation: 'putAdministrativeOAuthApp',
        outcome: 'error',
        error_code: 'oauth_from_environment',
      }),
    );
    expect(JSON.stringify(capture.mock.calls)).not.toContain(privateSecret);
  });

  it('does not attribute unmatched admin paths to an OpenAPI operation', async () => {
    const capture = vi.fn();
    const telemetry = { capture, shutdown: vi.fn().mockResolvedValue(undefined) };
    const { app, auth } = fixture(telemetry);

    expect((await app.request('/api/v1/admin/api-keys/', { headers: auth })).status).toBe(404);
    expect(capture).not.toHaveBeenCalled();
  });

  it('records admin failures that occur before route handlers run', async () => {
    const capture = vi.fn();
    const telemetry = { capture, shutdown: vi.fn().mockResolvedValue(undefined) };
    const { app, auth } = fixture(telemetry);

    expect((await app.request('/api/v1/admin/api-keys')).status).toBe(401);
    expect(
      (
        await app.request('/api/v1/admin/api-keys', {
          method: 'POST',
          headers: auth,
        })
      ).status,
    ).toBe(415);
    const privateName = 'private api key name';
    expect((await app.request('/api/v1/admin/api-keys', jsonRequest('POST', { name: privateName }, auth))).status).toBe(
      400,
    );

    expect(capture).toHaveBeenCalledWith(
      'operation completed',
      expect.objectContaining({
        product_surface: 'rest',
        operation: 'listAdministrativeApiKeys',
        outcome: 'error',
        error_code: 'unauthorized',
      }),
    );
    expect(capture).toHaveBeenCalledWith(
      'operation completed',
      expect.objectContaining({
        product_surface: 'rest',
        operation: 'createAdministrativeApiKey',
        outcome: 'error',
        error_code: 'unsupported_media_type',
      }),
    );
    expect(capture).toHaveBeenCalledWith(
      'operation completed',
      expect.objectContaining({
        product_surface: 'rest',
        operation: 'createAdministrativeApiKey',
        outcome: 'error',
        error_code: 'invalid_request',
      }),
    );
    expect(JSON.stringify(capture.mock.calls)).not.toContain(privateName);
  });

  it('uses forwarded protocol and client addresses only when proxy trust is enabled', () => {
    const request = new Request('http://fluxmail:8977/api/v1/admin/api-keys', {
      headers: {
        forwarded: 'for=198.51.100.42;proto=https',
        'x-forwarded-for': '203.0.113.25',
        'x-forwarded-proto': 'http',
      },
    });
    const connection = { remoteAddress: '172.18.0.2' };

    expect(administrationUsesHttps(request, connection)).toBe(false);
    expect(requestClientAddress(request, connection)).toBe('172.18.0.2');
    expect(administrationUsesHttps(request, connection, true)).toBe(true);
    expect(requestClientAddress(request, connection, true)).toBe('198.51.100.42');
  });

  it('registers admin routes in OpenAPI and requires a real credential', async () => {
    const { app, auth, root } = fixture();
    const document = (await (await app.request('/api/v1/openapi.json', { headers: auth })).json()) as {
      paths: Record<string, unknown>;
      components: { schemas: Record<string, unknown> };
    };
    expect(document.paths).toHaveProperty('/api/v1/admin/connections');
    expect(document.paths).toHaveProperty('/api/v1/admin/api-keys/{keyId}');
    expect(document.paths).toHaveProperty('/api/v1/admin/license/activate');
    expect(JSON.stringify(document.components.schemas.AdminRestError)).toContain('"data"');

    expect((await app.request('/api/v1/status')).status).toBe(401);
    expect((await app.request('/api/v1/admin/api-keys')).status).toBe(401);
    expect(
      (
        await app.request(
          '/auth/connections',
          jsonRequest('POST', { provider: 'gmail', ownerMemberId: 'member_admin' }),
        )
      ).status,
    ).toBe(401);
    expect((await app.request(`/api/v1/admin/api-keys?key=${encodeURIComponent(root.key)}`)).status).toBe(401);
    expect((await app.request('/api/v1/admin/api-keys', { headers: auth })).status).toBe(200);
  });

  it('enforces role and route capabilities using the member role at request time', async () => {
    const { app, auth, db, member } = fixture();
    expect((await app.request('/api/v1/admin/api-keys', { headers: auth })).status).toBe(200);

    db.insert(members)
      .values({
        id: 'member_backup_admin',
        name: 'Backup Admin',
        role: 'admin',
        status: 'active',
        createdAt: Date.now(),
      })
      .run();
    setMemberRole(db, member.id, 'member');
    const demoted = await app.request('/api/v1/admin/api-keys', { headers: auth });
    expect(demoted.status).toBe(403);
    await expect(demoted.json()).resolves.toMatchObject({ error: { code: 'permission_denied' } });

    setMemberRole(db, member.id, 'admin');
    const accountOnly = createApiKey(
      db,
      'account-admin',
      member.id,
      permissionPolicyForProfile('read-only', ['admin.accounts']),
    );
    const denied = await app.request('/api/v1/admin/api-keys', {
      headers: { authorization: `Bearer ${accountOnly.key}` },
    });
    expect(denied.status).toBe(403);
    await expect(denied.json()).resolves.toMatchObject({ error: { code: 'permission_denied' } });
  });

  it('applies strict JSON, body limit, security headers, and no CORS', async () => {
    const { app, auth, config, db } = fixture();
    const wrongType = await app.request('/api/v1/admin/api-keys', {
      method: 'POST',
      headers: { ...auth, 'content-type': 'text/plain' },
      body: '{}',
    });
    expect(wrongType.status).toBe(415);
    expect(db.select().from(adminAuditEvents).all().at(-1)).toMatchObject({
      outcome: 'error',
      errorCode: 'unsupported_media_type',
    });

    const oversized = await app.request(
      '/api/v1/admin/api-keys',
      jsonRequest('POST', { name: 'x'.repeat(70_000) }, auth),
    );
    expect(oversized.status).toBe(413);

    let pulls = 0;
    const streamedBody = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(16 * 1024));
        if (pulls === 1_000) controller.close();
      },
    });
    const streamed = await app.request(
      new Request('http://localhost/api/v1/admin/api-keys', {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: streamedBody,
        duplex: 'half',
      } as RequestInit & { duplex: 'half' }),
    );
    expect(streamed.status).toBe(413);
    expect(pulls).toBeLessThan(20);

    const response = await app.request('/api/v1/admin/api-keys', {
      headers: { ...auth, origin: 'https://example.com' },
    });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('access-control-allow-origin')).toBeNull();

    const insecure = await app.request('/api/v1/admin/api-keys', { headers: auth }, {
      incoming: { socket: { remoteAddress: '203.0.113.10' } },
    } as unknown as HttpBindings);
    expect(insecure.status).toBe(400);
    await expect(insecure.json()).resolves.toMatchObject({ error: { code: 'https_required' } });

    config.trustProxy = true;
    const trustedProxy = await app.request(
      '/api/v1/admin/api-keys',
      { headers: { ...auth, 'x-forwarded-for': '198.51.100.42', 'x-forwarded-proto': 'https' } },
      {
        incoming: { socket: { remoteAddress: '172.18.0.2' } },
      } as unknown as HttpBindings,
    );
    expect(trustedProxy.status).toBe(200);
  });

  it('creates, scopes, updates, and revokes keys while sessions remain the recovery authority', async () => {
    const { app, auth, db, member, root } = fixture();
    const createdResponse = await app.request(
      '/api/v1/admin/api-keys',
      jsonRequest(
        'POST',
        {
          name: 'reader',
          member: member.id,
          permissionProfile: 'read-only',
          supplementalCapabilities: [],
          accounts: null,
        },
        auth,
      ),
    );
    expect(createdResponse.status).toBe(201);
    const created = (await createdResponse.json()) as { data: { id: string; key: string; capabilities: string[] } };
    expect(created.data.key).toMatch(/^fmk_/);
    expect(created.data.capabilities).toEqual(['mail.read']);

    const updated = await app.request(
      `/api/v1/admin/api-keys/${created.data.id}`,
      jsonRequest(
        'PATCH',
        { permissionProfile: 'full', supplementalCapabilities: ['admin.api_keys'], accounts: [] },
        auth,
      ),
    );
    expect(updated.status).toBe(200);
    await expect(updated.json()).resolves.toMatchObject({
      data: { accountIds: [], supplementalCapabilities: ['admin.api_keys'] },
    });

    const revokeLastRoot = await app.request(`/api/v1/admin/api-keys/${root.info.id}`, {
      method: 'DELETE',
      headers: auth,
    });
    expect(revokeLastRoot.status).toBe(200);
    expect(
      (await app.request('/api/v1/admin/api-keys', { headers: { authorization: `Bearer ${created.data.key}` } }))
        .status,
    ).toBe(200);

    const reduced = await app.request(
      `/api/v1/admin/api-keys/${created.data.id}`,
      jsonRequest('PATCH', { supplementalCapabilities: [] }, { authorization: `Bearer ${created.data.key}` }),
    );
    expect(reduced.status).toBe(200);
    expect(
      (await app.request('/api/v1/admin/api-keys', { headers: { authorization: `Bearer ${created.data.key}` } }))
        .status,
    ).toBe(403);
    expect(db.select().from(adminAuditEvents).all().length).toBeGreaterThanOrEqual(4);
  });

  it('prepares OAuth connections through the new route and records sanitized audit rows', async () => {
    const { app, auth, db, member } = fixture();
    const response = await app.request(
      '/api/v1/admin/connections',
      jsonRequest('POST', { provider: 'gmail', ownerMemberId: member.id }, auth),
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as { data: { connectionUrl: string } };
    expect(body.data.connectionUrl).toContain('/auth/google/connect?token=');

    const audit = db.select().from(adminAuditEvents).all().at(-1);
    expect(audit).toMatchObject({ outcome: 'success', actorMemberId: member.id });
    expect(JSON.stringify(audit)).not.toContain(body.data.connectionUrl);
    expect(JSON.stringify(audit)).not.toContain('gmail');

    const invalidKeyId = 'person@example.com';
    const missing = await app.request(`/api/v1/admin/api-keys/${invalidKeyId}`, {
      method: 'DELETE',
      headers: auth,
    });
    expect(missing.status).toBe(404);
    const sanitized = db.select().from(adminAuditEvents).all().at(-1);
    expect(sanitized?.operation).toBe('delete /api/v1/admin/api-keys/:id');
    expect(JSON.stringify(sanitized)).not.toContain(invalidKeyId);

    const unknownPath = 'private@example.com';
    expect(
      (
        await app.request(`/api/v1/admin/${unknownPath}`, {
          method: 'DELETE',
          headers: auth,
        })
      ).status,
    ).toBe(404);
    const unknownAudit = db.select().from(adminAuditEvents).all().at(-1);
    expect(unknownAudit?.operation).toBe('delete /api/v1/admin/*');
    expect(JSON.stringify(unknownAudit)).not.toContain(unknownPath);
  });

  it('applies an admin API key mailbox allowlist to metadata management', async () => {
    const { app, db, member, registry } = fixture();
    const account = registry.addGmailAccount('private@example.com', {}, undefined, member.id, {
      sharedWithAll: false,
    });
    const restricted = createApiKey(
      db,
      'restricted-admin',
      member.id,
      permissionPolicyForProfile('read-only', ['admin.accounts']),
      [],
    );
    const restrictedAuth = { authorization: `Bearer ${restricted.key}` };

    const list = await app.request('/api/v1/admin/accounts', { headers: restrictedAuth });
    expect(list.status).toBe(200);
    await expect(list.json()).resolves.toEqual({ data: [] });
    expect(
      (
        await app.request(`/api/v1/admin/accounts/${account.id}`, {
          method: 'DELETE',
          headers: restrictedAuth,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await app.request(
          '/api/v1/admin/connections',
          jsonRequest('POST', { provider: 'gmail', ownerMemberId: member.id }, restrictedAuth),
        )
      ).status,
    ).toBe(403);
  });

  it('tests and saves IMAP settings without returning secrets, and validates folder patches atomically', async () => {
    const { app, auth, member, registry } = fixture();
    const test = vi.spyOn(registry, 'testImapCredentials').mockResolvedValue([]);
    const settings = {
      provider: 'imap' as const,
      ownerMemberId: member.id,
      email: 'admin@example.com',
      imap: {
        host: 'imap.example.com',
        port: 993,
        security: 'tls' as const,
        user: 'admin@example.com',
        password: 'imap-secret',
      },
      smtp: {
        host: 'smtp.example.com',
        port: 587,
        security: 'starttls' as const,
        user: 'admin@example.com',
        password: 'smtp-secret',
      },
      saveSent: false,
      folderOverrides: { sent: 'Sent Items' },
    };
    const connected = await app.request('/api/v1/admin/connections', jsonRequest('POST', settings, auth));
    expect(connected.status).toBe(201);
    const body = await connected.text();
    expect(body).not.toContain('imap-secret');
    expect(body).not.toContain('smtp-secret');
    const accountId = (JSON.parse(body) as { data: { account: { id: string } } }).data.account.id;
    expect(registry.loadImapCredentials(accountId)).toMatchObject({
      saveSent: false,
      folderOverrides: { sent: 'Sent Items' },
    });

    const reauthorized = await app.request(
      '/api/v1/admin/connections',
      jsonRequest(
        'POST',
        {
          ...settings,
          ownerMemberId: undefined,
          reauthorizeAccountId: accountId,
          imap: { ...settings.imap, password: 'new-imap-secret' },
          smtp: { ...settings.smtp, password: 'new-smtp-secret' },
          saveSent: undefined,
          folderOverrides: undefined,
        },
        auth,
      ),
    );
    expect(reauthorized.status).toBe(201);
    expect(registry.loadImapCredentials(accountId)).toMatchObject({
      saveSent: false,
      folderOverrides: { sent: 'Sent Items' },
      imap: { password: 'new-imap-secret' },
    });

    const folderTest = vi.spyOn(registry, 'testImapFolderOverrides').mockResolvedValueOnce([]);
    const validPatch = await app.request(
      `/api/v1/admin/accounts/${accountId}/imap/folders`,
      jsonRequest('PATCH', { drafts: 'Drafts' }, auth),
    );
    expect(validPatch.status).toBe(200);
    expect(test).toHaveBeenCalledTimes(2);

    folderTest.mockResolvedValueOnce([
      { role: 'trash', reason: 'stale_override', message: 'trash folder override does not exist' },
    ]);
    const invalidPatch = await app.request(
      `/api/v1/admin/accounts/${accountId}/imap/folders`,
      jsonRequest('PATCH', { trash: 'Missing Trash' }, auth),
    );
    expect(invalidPatch.status).toBe(400);
    expect(registry.loadImapCredentials(accountId).folderOverrides).toEqual({ sent: 'Sent Items', drafts: 'Drafts' });
  });

  it('appends sanitized audit events without changing earlier rows', () => {
    const { db, member, root } = fixture();
    db.insert(adminAuditEvents)
      .values({
        timestamp: 1,
        operation: 'test',
        outcome: 'success',
        actorKeyId: root.info.id,
        actorMemberId: member.id,
      })
      .run();
    recordAdminAuditEvent(db, {
      operation: 'post /api/v1/admin/api-keys',
      outcome: 'error',
      actorKeyId: root.info.id,
      actorMemberId: member.id,
      errorCode: 'invalid_request',
    });
    const rows = db.select().from(adminAuditEvents).all();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ timestamp: 1, operation: 'test', outcome: 'success' });
    expect(rows.at(-1)).toMatchObject({ errorCode: 'invalid_request' });
    expect(() => db.update(adminAuditEvents).set({ outcome: 'error' }).run()).toThrow(/append-only/);
    expect(() => db.delete(adminAuditEvents).run()).toThrow(/append-only/);
  });

  it('returns license status without the key and maps activation outcomes', async () => {
    const { app, auth } = fixture();
    const status = await app.request('/api/v1/admin/license', { headers: auth });
    expect(status.status).toBe(200);
    expect(JSON.stringify(await status.json())).not.toContain('fluxmail_lic_');

    const licenseKey = `fluxmail_lic_${'a'.repeat(40)}`;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'down' }), { status: 503 })),
    );
    const saved = await app.request('/api/v1/admin/license/activate', jsonRequest('POST', { licenseKey }, auth));
    expect(saved.status).toBe(202);
    await expect(saved.json()).resolves.toEqual({ data: { outcome: 'saved_for_retry' } });

    const invalid = await app.request(
      '/api/v1/admin/license/activate',
      jsonRequest('POST', { licenseKey: 'bad' }, auth),
    );
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toMatchObject({ error: { code: 'invalid_license_key' } });

    const deactivated = await app.request('/api/v1/admin/license', { method: 'DELETE', headers: auth });
    expect(deactivated.status).toBe(200);
    await expect(deactivated.json()).resolves.toEqual({
      data: { deactivated: true, released: false, removedStoredKey: true },
    });
  });
});
