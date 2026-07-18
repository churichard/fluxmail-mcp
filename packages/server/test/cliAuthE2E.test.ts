import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCliProgram } from '../src/cli.js';
import { resolveInstance, saveRemoteInstance } from '../src/cliInstances.js';

describe('CLI authentication flow', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    process.exitCode = undefined;
  });

  it('sets up, logs out, logs back in, and switches instance profiles', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'fluxmail-cli-auth-'));
    vi.stubEnv('FLUXMAIL_DATA_DIR', dataDir);
    vi.stubEnv('FLUXMAIL_ENCRYPTION_KEY', '22'.repeat(32));
    vi.stubEnv('FLUXMAIL_PASSWORD', 'Granite harbor compass 2026!');
    vi.stubEnv('FLUXMAIL_TELEMETRY', '0');
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await createCliProgram().parseAsync([
      'node',
      'fluxmail',
      'setup',
      '--name',
      'CLI Admin',
      '--email',
      'cli@example.com',
    ]);
    const first = resolveInstance('local');
    expect(first.profile).toEqual({ kind: 'local' });
    expect(first.token).toMatch(/^fms_/);
    expect(output).toHaveBeenCalledWith(expect.stringContaining('Logged in to local'));

    await createCliProgram().parseAsync(['node', 'fluxmail', '--instance', 'local', 'logout']);
    expect(resolveInstance('local').token).toBeUndefined();
    await createCliProgram().parseAsync([
      'node',
      'fluxmail',
      '--instance',
      'local',
      'login',
      '--email',
      'cli@example.com',
    ]);
    expect(resolveInstance('local').token).toMatch(/^fms_/);

    saveRemoteInstance('work', 'https://mail.example.com');
    await createCliProgram().parseAsync(['node', 'fluxmail', 'instances', 'use', 'work']);
    expect(resolveInstance().name).toBe('work');
    await createCliProgram().parseAsync(['node', 'fluxmail', 'instances', 'use', 'local']);
    expect(resolveInstance().name).toBe('local');

    await createCliProgram().parseAsync(['node', 'fluxmail', 'instances', 'remove', 'local']);
    expect(() => resolveInstance('local')).toThrow(/No CLI instance/);
    await createCliProgram().parseAsync([
      'node',
      'fluxmail',
      '--instance',
      'local',
      'login',
      '--email',
      'cli@example.com',
    ]);
    expect(resolveInstance('local')).toMatchObject({
      profile: { kind: 'local' },
      token: expect.stringMatching(/^fms_/),
    });
  });

  it('re-prompts for an invalid interactive setup password and accepts eight characters', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'fluxmail-cli-password-'));
    vi.stubEnv('FLUXMAIL_DATA_DIR', dataDir);
    vi.stubEnv('FLUXMAIL_ENCRYPTION_KEY', '33'.repeat(32));
    vi.stubEnv('FLUXMAIL_TELEMETRY', '0');
    const prompt = vi.fn().mockResolvedValueOnce('short7').mockResolvedValueOnce('River42!');
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await createCliProgram({ passwordPrompt: prompt }).parseAsync([
      'node',
      'fluxmail',
      'setup',
      '--name',
      'CLI Admin',
      '--email',
      'cli@example.com',
    ]);

    expect(prompt).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledWith('Error: Password must contain between 8 and 256 characters.');
    expect(output).toHaveBeenCalledWith(expect.stringContaining('Fluxmail is ready'));
    expect(resolveInstance('local').token).toMatch(/^fms_/);
    expect(process.exitCode).toBeUndefined();
  });
});
