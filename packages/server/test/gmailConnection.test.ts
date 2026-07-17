import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { FluxmailConfig } from '../src/config.js';
import {
  prepareHostedGmailConnection,
  prepareHostedOutlookConnection,
  selectGmailConnectionMode,
  validateAccountConnectionFlags,
} from '../src/accounts/gmailConnection.js';
import { DEFAULT_GOOGLE_CLIENT_ID, DEFAULT_GOOGLE_CLIENT_SECRET } from '../src/accounts/defaultGoogleOAuth.js';
import { gmailConnectionGrants, openDb } from '../src/storage/db.js';

function config(publicUrlConfigured: boolean, publicUrl?: string): FluxmailConfig {
  return {
    dataDir: '/tmp',
    dbPath: ':memory:',
    encryptionKey: randomBytes(32),
    port: 8977,
    publicUrl: publicUrl ?? (publicUrlConfigured ? 'https://mail.example.com' : 'http://localhost:8977'),
    publicUrlConfigured,
    oauthPort: 8976,
    oauthHost: '127.0.0.1',
    authMode: 'apikey',
    maxAttachmentBytes: 10 * 1024 * 1024,
    licenseServerUrl: 'https://license.invalid',
    google: { clientId: 'client-id', clientSecret: 'client-secret' },
    microsoft: { clientId: 'microsoft-client-id', clientSecret: 'microsoft-secret', tenantId: 'common' },
  };
}

describe('Gmail connection mode', () => {
  it('selects hosted for an explicit public URL and local for the default URL', () => {
    expect(selectGmailConnectionMode(config(true), {})).toBe('hosted');
    expect(selectGmailConnectionMode(config(false), {})).toBe('local');
  });

  it.each(['http://localhost:8977', 'http://127.0.0.1:8977', 'http://[::1]:8977'])(
    'keeps an explicitly configured loopback URL on the local flow: %s',
    (publicUrl) => {
      expect(selectGmailConnectionMode(config(true, publicUrl), {})).toBe('local');
    },
  );

  it('honors explicit overrides', () => {
    expect(selectGmailConnectionMode(config(true), { local: true })).toBe('local');
    expect(selectGmailConnectionMode(config(true), { hosted: true })).toBe('hosted');
    expect(selectGmailConnectionMode(config(true, 'http://localhost:8977'), { hosted: true })).toBe('hosted');
  });

  it('rejects incompatible flags and hosted mode without a configured public URL', () => {
    expect(() => selectGmailConnectionMode(config(true), { local: true, hosted: true })).toThrow(
      /cannot be used together/,
    );
    expect(() => selectGmailConnectionMode(config(false), { hosted: true })).toThrow(/requires FLUXMAIL_PUBLIC_URL/);
  });

  it('rejects Gmail connection flags for IMAP', () => {
    expect(() => validateAccountConnectionFlags('imap', { hosted: true })).toThrow(/only available for OAuth/);
    expect(() => validateAccountConnectionFlags('imap', { local: true })).toThrow(/only available for OAuth/);
  });

  it('allows local and hosted Outlook callbacks', () => {
    expect(() => validateAccountConnectionFlags('outlook', { local: true })).not.toThrow();
    expect(() => validateAccountConnectionFlags('outlook', { hosted: true })).not.toThrow();
  });

  it('creates a grant and returns a URL based on FLUXMAIL_PUBLIC_URL', () => {
    const db = openDb(':memory:');
    const prepared = prepareHostedGmailConnection(db, config(true), { memberId: 'member_1' });
    const url = new URL(prepared.connectionUrl);

    expect(`${url.origin}${url.pathname}`).toBe('https://mail.example.com/auth/google/connect');
    const rawToken = url.searchParams.get('token');
    expect(rawToken).toBeTruthy();
    expect(JSON.stringify(db.select().from(gmailConnectionGrants).get())).not.toContain(rawToken);
  });

  it('requires a Web client secret for hosted Gmail', () => {
    const db = openDb(':memory:');
    const publicClientConfig = config(true);
    publicClientConfig.google = { clientId: 'desktop-client-id' } as FluxmailConfig['google'];

    expect(() => prepareHostedGmailConnection(db, publicClientConfig, { memberId: 'member_1' })).toThrow(
      /GOOGLE_CLIENT_SECRET/,
    );
  });

  it('does not use the built-in Desktop client for hosted Gmail', () => {
    const db = openDb(':memory:');
    const desktopConfig = config(true);
    desktopConfig.google = {
      clientId: DEFAULT_GOOGLE_CLIENT_ID,
      clientSecret: DEFAULT_GOOGLE_CLIENT_SECRET,
    };

    expect(() => prepareHostedGmailConnection(db, desktopConfig, { memberId: 'member_1' })).toThrow(
      /custom Google Web application/,
    );
  });

  it('creates a hosted Outlook grant for a confidential Entra app', () => {
    const db = openDb(':memory:');
    const prepared = prepareHostedOutlookConnection(db, config(true), { memberId: 'member_1' });
    const url = new URL(prepared.connectionUrl);

    expect(`${url.origin}${url.pathname}`).toBe('https://mail.example.com/auth/microsoft/connect');
    expect(url.searchParams.get('token')).toBeTruthy();
  });

  it('requires a client secret for hosted Outlook', () => {
    const db = openDb(':memory:');
    const publicClientConfig = config(true);
    publicClientConfig.microsoft = { clientId: 'microsoft-client-id', tenantId: 'common' };

    expect(() => prepareHostedOutlookConnection(db, publicClientConfig, { memberId: 'member_1' })).toThrow(
      /MICROSOFT_CLIENT_SECRET/,
    );
  });
});
