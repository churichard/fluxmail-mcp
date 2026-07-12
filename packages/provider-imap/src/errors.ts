import { EmailError, isEmailError } from '@fluxmail/core';

export function mapImapError(error: unknown): EmailError {
  if (isEmailError(error)) return error;
  const value = error as { code?: string; responseStatus?: string; authenticationFailed?: boolean; message?: string };
  const message = value?.message ?? String(error);
  if (value?.authenticationFailed || value?.code === 'EAUTH' || /auth|credential|login/i.test(message)) {
    return new EmailError('auth_expired', `IMAP/SMTP authentication failed: ${message}`);
  }
  if (value?.code === 'EENVELOPE' || value?.code === 'EMESSAGE') {
    return new EmailError('invalid_request', message);
  }
  return new EmailError('provider_unavailable', `IMAP/SMTP operation failed: ${message}`);
}
