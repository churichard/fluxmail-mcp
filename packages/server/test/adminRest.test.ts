import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HttpBindings } from '@hono/node-server';
import type { FluxmailConfig } from '../src/config.js';
import { AccountRegistry } from '../src/accounts/registry.js';
import { EmailService } from '../src/service/emailService.js';
import { createApp } from '../src/http/app.js';
import { permissionPolicyForProfile } from '../src/permissions.js';
import { createApiKey } from '../src/storage/apiKeys.js';
import { adminAuditEvents, openDb } from '../src/storage/db.js';
import { addMember, setMemberRole } from '../src/storage/members.js';
import { ADMIN_AUDIT_RETENTION, recordAdminAuditEvent } from '../src/storage/adminAudit.js';
import { administrationUsesHttps } from '../src/http/admin.js';
import type { Telemetry } from '../src/telemetry.js';

function fixture(authMode: FluxmailConfig['authMode'] = 'apikey', telemetry?: Telemetry) {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'fluxmail-admin-rest-'));
  const config: FluxmailConfig = {
    dataDir,
    dbPath: ':memory:',
    encryptionKey: Buffer.alloc(32, 9),
    port: 8977,
    publicUrl: 'http://localhost:8977',
    publicUrlConfigured: false,
    oauthPort: 8976,
    oauthHost: '127.0.0.1',
    authMode,
    maxAttachmentBytes: 1024,
    licenseServerUrl: 'https://license.invalid',
    google: { clientId: 'google-client', clientSecret: 'google-secret' },
    microsoft: { clientId: 'microsoft-client', clientSecret: 'microsoft-secret', tenantId: 'common' },
  };
  const db = openDb(':memory:');
  const member = addMember(db, { name: 'Admin', role: 'admin' });
  const root = createApiKey(
    db,
    'root',
    member.id,
    permissionPolicyForProfile('full', ['admin.accounts', 'admin.api_keys', 'admin.license']),
  );
  const registry = new AccountRegistry(db, config);
  const app = createApp({ config, db, registry, service: new EmailService(registry, db), telemetry });
  const auth = { authorization: `Bearer ${root.key}` };
  return { app, auth, config, db, member, registry, root };
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
    const { app, auth } = fixture('apikey', telemetry);

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

  it('does not attribute unmatched admin paths to an OpenAPI operation', async () => {
    const capture = vi.fn();
    const telemetry = { capture, shutdown: vi.fn().mockResolvedValue(undefined) };
    const { app, auth } = fixture('apikey', telemetry);

    expect((await app.request('/api/v1/admin/api-keys/', { headers: auth })).status).toBe(404);
    expect(capture).not.toHaveBeenCalled();
  });

  it('records admin failures that occur before route handlers run', async () => {
    const capture = vi.fn();
    const telemetry = { capture, shutdown: vi.fn().mockResolvedValue(undefined) };
    const { app, auth } = fixture('apikey', telemetry);

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

  it('registers admin routes in OpenAPI and requires a real key even when mail auth is disabled', async () => {
    const { app, auth, root } = fixture('none');
    const document = (await (await app.request('/api/v1/openapi.json')).json()) as {
      paths: Record<string, unknown>;
      components: { schemas: Record<string, unknown> };
    };
    expect(document.paths).toHaveProperty('/api/v1/admin/connections');
    expect(document.paths).toHaveProperty('/api/v1/admin/api-keys/{keyId}');
    expect(document.paths).toHaveProperty('/api/v1/admin/license/activate');
    expect(JSON.stringify(document.components.schemas.AdminRestError)).toContain('"data"');

    expect((await app.request('/api/v1/status')).status).toBe(200);
    expect((await app.request('/api/v1/admin/api-keys')).status).toBe(401);
    expect(
      (await app.request('/auth/connections', jsonRequest('POST', { provider: 'gmail', owner: 'member_admin' })))
        .status,
    ).toBe(401);
    expect((await app.request(`/api/v1/admin/api-keys?key=${encodeURIComponent(root.key)}`)).status).toBe(401);
    expect((await app.request('/api/v1/admin/api-keys', { headers: auth })).status).toBe(200);
  });

  it('enforces role and route capabilities using the member role at request time', async () => {
    const { app, auth, db, member } = fixture();
    expect((await app.request('/api/v1/admin/api-keys', { headers: auth })).status).toBe(200);

    setMemberRole(db, member.id, 'member');
    const demoted = await app.request('/api/v1/admin/api-keys', { headers: auth });
    expect(demoted.status).toBe(403);
    await expect(demoted.json()).resolves.toMatchObject({ error: { code: 'admin_role_required' } });

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
    const { app, auth, db } = fixture();
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
  });

  it('creates, scopes, updates, and revokes keys while preserving a usable root', async () => {
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

    const blocked = await app.request(
      `/api/v1/admin/api-keys/${created.data.id}`,
      jsonRequest('PATCH', { supplementalCapabilities: [] }, { authorization: `Bearer ${created.data.key}` }),
    );
    expect(blocked.status).toBe(409);
    await expect(blocked.json()).resolves.toMatchObject({ error: { code: 'last_root_key' } });
    expect(db.select().from(adminAuditEvents).all().length).toBeGreaterThanOrEqual(4);
  });

  it('prepares OAuth connections through the new route and records sanitized audit rows', async () => {
    const { app, auth, db, member } = fixture();
    const response = await app.request(
      '/api/v1/admin/connections',
      jsonRequest('POST', { provider: 'gmail', owner: member.id }, auth),
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

  it('tests and saves IMAP settings without returning secrets, and validates folder patches atomically', async () => {
    const { app, auth, member, registry } = fixture();
    const test = vi.spyOn(registry, 'testImapCredentials').mockResolvedValue([]);
    const settings = {
      provider: 'imap' as const,
      owner: member.id,
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
          owner: undefined,
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

  it('retains only the newest 10,000 sanitized audit events', () => {
    const { db, member, root } = fixture();
    for (let offset = 0; offset < ADMIN_AUDIT_RETENTION; offset += 100) {
      db.insert(adminAuditEvents)
        .values(
          Array.from({ length: 100 }, (_, index) => ({
            timestamp: offset + index,
            operation: 'test',
            outcome: 'success',
            actorKeyId: root.info.id,
            actorMemberId: member.id,
          })),
        )
        .run();
    }
    recordAdminAuditEvent(db, {
      operation: 'post /api/v1/admin/api-keys',
      outcome: 'error',
      actorKeyId: root.info.id,
      actorMemberId: member.id,
      errorCode: 'invalid_request',
    });
    const rows = db.select().from(adminAuditEvents).all();
    expect(rows).toHaveLength(ADMIN_AUDIT_RETENTION);
    expect(rows.some((row) => row.timestamp === 0)).toBe(false);
    expect(rows.at(-1)).toMatchObject({ errorCode: 'invalid_request' });
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
  });
});
