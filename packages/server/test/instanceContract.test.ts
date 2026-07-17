import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setupInitialAdmin } from '../src/auth.js';
import { InstanceClient } from '../src/cliInstances.js';
import { createContext } from '../src/context.js';
import { createApp } from '../src/http/app.js';

describe('local and remote control-plane contract', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('runs the same authenticated member operations in-process and over HTTP', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'fluxmail-instance-contract-'));
    vi.stubEnv('FLUXMAIL_DATA_DIR', dataDir);
    vi.stubEnv('FLUXMAIL_ENCRYPTION_KEY', '11'.repeat(32));
    vi.stubEnv('FLUXMAIL_TELEMETRY', '0');
    const context = createContext();
    const setup = await setupInitialAdmin(context.db, {
      name: 'Contract Admin',
      email: 'contract@example.com',
      password: 'Granite orchard compass 2026!',
    });
    const app = createApp(context);
    vi.stubGlobal('fetch', async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = new URL(String(input));
      return app.request(`${url.pathname}${url.search}`, init);
    });

    const local = new InstanceClient('local', { kind: 'local' }, setup.session.token);
    const remote = new InstanceClient(
      'remote',
      { kind: 'remote', serverUrl: 'https://mail.example.com' },
      setup.session.token,
    );
    await expect(local.json<{ name: string }>('/api/v1/me')).resolves.toMatchObject({ name: 'Contract Admin' });
    await remote.json('/api/v1/me', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Renamed Remotely' }),
    });
    await expect(local.json<{ name: string }>('/api/v1/me')).resolves.toMatchObject({ name: 'Renamed Remotely' });
    await expect(remote.json<Array<{ id: string }>>('/api/v1/admin/members')).resolves.toEqual([
      expect.objectContaining({ id: setup.member.id }),
    ]);
  });
});
