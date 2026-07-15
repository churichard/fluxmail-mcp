import { EmailError } from '@fluxmail/core';

export interface GraphErrorLike {
  status?: number;
  code?: string;
  message?: string;
  retryAfterMs?: number;
}

export class GraphHttpError extends Error implements GraphErrorLike {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'GraphHttpError';
  }
}

export function isRetryableGraphError(err: unknown): boolean {
  const status = (err as GraphErrorLike).status;
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

export function toEmailError(err: unknown): EmailError {
  if (err instanceof EmailError) return err;
  const graph = err as GraphErrorLike;
  const message = graph.message ?? 'Microsoft Graph request failed';
  if (graph.status === 401 || /InvalidAuthenticationToken|invalid_grant/i.test(graph.code ?? message)) {
    return new EmailError('auth_expired', `Microsoft authorization expired or was revoked: ${message}`);
  }
  if (graph.status === 429 || graph.code === 'ErrorQuotaExceeded') {
    return new EmailError('rate_limited', `Microsoft Graph rate limit hit: ${message}`);
  }
  if (graph.status === 403 || graph.code === 'ErrorAccessDenied') {
    return new EmailError('permission_denied', `Microsoft Graph denied this operation: ${message}`);
  }
  if (graph.status === 404 || graph.code === 'ErrorItemNotFound') {
    return new EmailError('not_found', `Not found in Microsoft Graph: ${message}`);
  }
  if (graph.status === 400 || graph.status === 409 || graph.status === 412) {
    return new EmailError('invalid_request', `Microsoft Graph rejected the request: ${message}`);
  }
  return new EmailError('provider_unavailable', `Microsoft Graph unavailable: ${message}`);
}
