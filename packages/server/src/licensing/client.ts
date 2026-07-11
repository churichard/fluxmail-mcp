/**
 * HTTP client for the hosted license server's validate and deactivate
 * endpoints. The contract of record is docs/license-validation-contract.md in
 * this repo, implemented by the private license-server repo; request/response
 * shapes here must match it.
 */

export const DEFAULT_LICENSE_SERVER_URL = 'https://fluxmail.ai';

export const LICENSE_KEY_PATTERN = /^fluxmail_lic_[0-9a-f]{40}$/;

export type ValidateOutcome =
  /** 200: `lease` is the signed token; verify it before trusting anything in it. */
  | { kind: 'valid'; lease: string }
  /** 400: the server considered the request malformed — a config error to surface. */
  | { kind: 'invalid_request' }
  /** 404: key doesn't exist (typo or deleted). Keep any cached lease until it expires. */
  | { kind: 'license_not_found' }
  /** 403: subscription ended ("canceled" | "revoked" | "expired"). Degrade when the cached lease runs out. */
  | { kind: 'license_inactive'; status: string }
  /** 409: the license is bound to a different instance; deactivate it there first. */
  | { kind: 'license_in_use' }
  /** 5xx, network failure, or an unintelligible response: keep the cached lease and retry later. */
  | { kind: 'outage'; detail: string };

export interface ValidateOptions {
  serverUrl: string;
  licenseKey: string;
  /** Stable random id per install; the server binds each license to one instance. */
  instanceId: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export async function validateLicense(opts: ValidateOptions): Promise<ValidateOutcome> {
  const doFetch = opts.fetchImpl ?? fetch;
  const url = `${opts.serverUrl.replace(/\/+$/, '')}/api/v1/licenses/validate`;
  let response: Response;
  try {
    response = await doFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ licenseKey: opts.licenseKey, instanceId: opts.instanceId }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
    });
  } catch (err) {
    return { kind: 'outage', detail: err instanceof Error ? err.message : String(err) };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  const field = (name: string): unknown =>
    typeof body === 'object' && body !== null ? (body as Record<string, unknown>)[name] : undefined;

  switch (response.status) {
    case 200: {
      const lease = field('lease');
      if (typeof lease !== 'string' || !lease) {
        return { kind: 'outage', detail: 'validation response is missing the lease token' };
      }
      return { kind: 'valid', lease };
    }
    case 400:
      return { kind: 'invalid_request' };
    case 404:
      return { kind: 'license_not_found' };
    case 403: {
      const status = field('status');
      return { kind: 'license_inactive', status: typeof status === 'string' ? status : 'inactive' };
    }
    case 409:
      return { kind: 'license_in_use' };
    default:
      return { kind: 'outage', detail: `license server returned HTTP ${response.status}` };
  }
}

/**
 * Best-effort release of this instance's license binding, so the key can be
 * activated elsewhere. Returns false when the server could not be reached or
 * declined; callers proceed with local deactivation either way.
 */
export async function releaseLicense(opts: ValidateOptions): Promise<boolean> {
  const doFetch = opts.fetchImpl ?? fetch;
  const url = `${opts.serverUrl.replace(/\/+$/, '')}/api/v1/licenses/deactivate`;
  try {
    const response = await doFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ licenseKey: opts.licenseKey, instanceId: opts.instanceId }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}
