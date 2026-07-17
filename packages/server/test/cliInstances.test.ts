import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
});
