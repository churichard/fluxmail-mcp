export type EmailErrorCode =
  | 'auth_expired'
  | 'rate_limited'
  | 'not_found'
  | 'invalid_request'
  | 'provider_unavailable'
  | 'entitlement_exceeded'
  | 'permission_denied'
  | 'unsupported_capability';

export class EmailError extends Error {
  readonly code: EmailErrorCode;
  /** Machine-readable extras, e.g. { reauthUrl } for auth_expired. */
  readonly data?: Record<string, unknown>;

  constructor(code: EmailErrorCode, message: string, data?: Record<string, unknown>) {
    super(message);
    this.name = 'EmailError';
    this.code = code;
    this.data = data;
  }
}

export function isEmailError(err: unknown): err is EmailError {
  return err instanceof EmailError;
}
