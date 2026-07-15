import { EmailError } from '@fluxmail/core';
import type { FluxmailConfig } from '../config.js';
import type { FluxmailDb } from '../storage/db.js';
import {
  createGmailConnectionGrant,
  createOutlookConnectionGrant,
  type GmailConnectionIntent,
} from '../storage/gmailConnectionGrants.js';
import { requireGoogleConfig } from './googleAuth.js';
import { requireMicrosoftConfig } from './microsoftAuth.js';

export type GmailConnectionMode = 'local' | 'hosted';

function isLoopbackPublicUrl(publicUrl: string): boolean {
  const hostname = new URL(publicUrl).hostname;
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

export function validateAccountConnectionFlags(
  provider: 'gmail' | 'outlook' | 'imap',
  options: { local?: boolean; hosted?: boolean },
): void {
  if (provider === 'imap' && (options.local || options.hosted)) {
    throw new EmailError('invalid_request', '--local and --hosted are only available for OAuth accounts.');
  }
}

export function selectGmailConnectionMode(
  config: FluxmailConfig,
  options: { local?: boolean; hosted?: boolean },
): GmailConnectionMode {
  if (options.local && options.hosted) {
    throw new EmailError('invalid_request', '--local and --hosted cannot be used together.');
  }
  if (options.hosted && !config.publicUrlConfigured) {
    throw new EmailError('invalid_request', '--hosted requires FLUXMAIL_PUBLIC_URL to be set.');
  }
  return options.hosted || (config.publicUrlConfigured && !options.local && !isLoopbackPublicUrl(config.publicUrl))
    ? 'hosted'
    : 'local';
}

export function prepareHostedGmailConnection(
  db: FluxmailDb,
  config: FluxmailConfig,
  intent: GmailConnectionIntent,
): { connectionUrl: string; expiresAt: number } {
  requireGoogleConfig(config);
  const { token, expiresAt } = createGmailConnectionGrant(db, intent);
  return {
    connectionUrl: `${config.publicUrl}/auth/google/connect?token=${encodeURIComponent(token)}`,
    expiresAt,
  };
}

export function prepareHostedOutlookConnection(
  db: FluxmailDb,
  config: FluxmailConfig,
  intent: GmailConnectionIntent,
): { connectionUrl: string; expiresAt: number } {
  const microsoft = requireMicrosoftConfig(config);
  if (!microsoft.clientSecret) {
    throw new EmailError(
      'invalid_request',
      'MICROSOFT_CLIENT_SECRET is required for hosted Outlook connections. Add a Web redirect URI and client secret to the Entra app.',
    );
  }
  const { token, expiresAt } = createOutlookConnectionGrant(db, intent);
  return {
    connectionUrl: `${config.publicUrl}/auth/microsoft/connect?token=${encodeURIComponent(token)}`,
    expiresAt,
  };
}
