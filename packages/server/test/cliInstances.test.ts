import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ImapProvider } from '@fluxmail/provider-imap';
import { setupInitialAdmin } from '../src/auth.js';
import {
  InstanceClient,
  credentialPath,
  instanceConfigPath,
  loadInstanceConfig,
  resolveInstance,
  saveLocalInstance,
  saveRemoteInstance,
  saveSessionToken,
  validateRemoteServerUrl,
} from '../src/cliInstances.js';
import { createContext } from '../src/context.js';

function privateMode(filePath: string): number {
  return statSync(filePath).mode & 0o777;
}

describe('CLI instance profiles', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('stores profile metadata separately from owner-readable session credentials', () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'fluxmail-cli-instances-'));
    vi.stubEnv('FLUXMAIL_DATA_DIR', dataDir);
    saveLocalInstance('local');
    saveRemoteInstance('work', 'https://mail.example.com/');
    saveSessionToken('work', 'fms_secret');

    expect(loadInstanceConfig()).toMatchObject({
      active: 'local',
      instances: { local: { kind: 'local' }, work: { kind: 'remote', serverUrl: 'https://mail.example.com' } },
    });
    expect(resolveInstance('work')).toMatchObject({ name: 'work', token: 'fms_secret' });
    expect(instanceConfigPath()).not.toBe(credentialPath());
    expect(privateMode(instanceConfigPath())).toBe(0o600);
    expect(privateMode(credentialPath())).toBe(0o600);
    expect(privateMode(path.dirname(credentialPath()))).toBe(0o700);
  });

  it('requires HTTPS except for loopback servers', () => {
    expect(validateRemoteServerUrl('https://mail.example.com/path/?ignored=yes#hash')).toBe(
      'https://mail.example.com/path',
    );
    expect(validateRemoteServerUrl('http://127.0.0.1:8977')).toBe('http://127.0.0.1:8977');
    expect(() => validateRemoteServerUrl('http://mail.example.com')).toThrow(/require HTTPS/);
    expect(() => validateRemoteServerUrl('https://user:password@mail.example.com')).toThrow(
      /cannot contain credentials/,
    );
  });

  it('refuses to forward a session through a remote redirect', async () => {
    const fetchMock = vi.fn(
      async (_input: URL, _init: RequestInit) =>
        new Response(null, { status: 302, headers: { location: 'https://other.example.com/api/v1/me' } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = new InstanceClient('work', { kind: 'remote', serverUrl: 'https://mail.example.com' }, 'fms_secret');

    await expect(client.request('/api/v1/me')).rejects.toMatchObject({ code: 'permission_denied' });
    expect(fetchMock).toHaveBeenCalledWith(
      new URL('https://mail.example.com/api/v1/me'),
      expect.objectContaining({ redirect: 'manual' }),
    );
    const request = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(new Headers(request.headers).get('authorization')).toBe('Bearer fms_secret');
  });

  it('keeps a configured server path when building remote API URLs', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: { ok: true } })));
    vi.stubGlobal('fetch', fetchMock);
    const client = new InstanceClient(
      'work',
      { kind: 'remote', serverUrl: 'https://mail.example.com/fluxmail' },
      'fms_secret',
    );

    await expect(client.json('/api/v1/me')).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith(
      new URL('https://mail.example.com/fluxmail/api/v1/me'),
      expect.objectContaining({ redirect: 'manual' }),
    );
    await expect(client.request('/https://other.example.com/steal')).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('can retain REST metadata and safe error codes', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: ['message'], meta: { nextPageToken: 'next' }, warnings: ['renew'] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { code: 'idempotency_conflict', message: 'Use a new key.' } }), {
          status: 409,
          headers: { 'content-type': 'application/json' },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const client = new InstanceClient('work', { kind: 'remote', serverUrl: 'https://mail.example.com' }, 'fms_secret');

    await expect(client.jsonEnvelope('/api/v1/messages')).resolves.toEqual({
      data: ['message'],
      meta: { nextPageToken: 'next' },
      warnings: ['renew'],
    });
    await expect(client.jsonEnvelope('/api/v1/send')).rejects.toMatchObject({
      code: 'idempotency_conflict',
      status: 409,
      message: 'Use a new key.',
    });
  });

  it('closes IMAP providers after a local request', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'fluxmail-cli-local-cleanup-'));
    vi.stubEnv('FLUXMAIL_DATA_DIR', dataDir);
    vi.stubEnv('FLUXMAIL_ENCRYPTION_KEY', '66'.repeat(32));
    vi.stubEnv('FLUXMAIL_TELEMETRY', '0');
    const setupContext = createContext();
    const setup = await setupInitialAdmin(setupContext.db, {
      name: 'Local Owner',
      email: 'local@example.com',
      password: 'River42!',
    });
    const account = setupContext.registry.addImapAccount(
      'local@example.com',
      {
        imap: { host: 'imap.example.com', port: 993, security: 'tls', user: 'local', password: 'private' },
        smtp: { host: 'smtp.example.com', port: 465, security: 'tls', user: 'local', password: 'private' },
        saveSent: false,
      },
      undefined,
      setup.member.id,
    );
    (setupContext.db as unknown as { $client: { close(): void } }).$client.close();
    vi.spyOn(ImapProvider.prototype, 'listMessages').mockResolvedValue({ items: [] });
    const close = vi.spyOn(ImapProvider.prototype, 'close').mockResolvedValue();
    const client = new InstanceClient('local', { kind: 'local' }, setup.session.token);

    await expect(
      client.json(`/api/v1/accounts/${encodeURIComponent(account.id)}/messages?folder=inbox&pageSize=100`),
    ).resolves.toEqual([]);

    expect(close).toHaveBeenCalledOnce();
  });
});
