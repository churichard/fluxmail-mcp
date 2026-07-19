# License validation contract

The contract between this repo's license client (`packages/server/src/licensing/`)
and the hosted license server (private repo). The client side of every shape
below is implemented here; the server must match it exactly.

## Endpoints

### `POST /api/v1/licenses/validate`

Request:

```json
{ "licenseKey": "fluxmail_lic_<40 hex>", "instanceId": "<32 hex>" }
```

`instanceId` is a stable random id generated once per install and stored at
`<dataDir>/instance.id`. It is not a secret. **Each license is bound to one
instance**: the server records the first `instanceId` that validates a license
and rejects validation from any other instance with `409` until the binding is
released.

Responses:

| Status        | Body                                                                              | Client behavior                                                                               |
| ------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 200           | `{ "lease": "<token>" }`                                                          | Verify the lease (below) and cache it.                                                        |
| 400           | `{ "error": "invalid_request" }`                                                  | Surface a config error; keep any cached lease.                                                |
| 404           | `{ "error": "license_not_found" }`                                                | Report a bad key; keep any cached lease.                                                      |
| 403           | `{ "error": "license_inactive", "status": "canceled" \| "revoked" \| "expired" }` | Report it; degrade when the cached lease runs out.                                            |
| 409           | `{ "error": "license_in_use" }`                                                   | Report that the license is active on another instance; keep any cached lease.                 |
| anything else | —                                                                                 | Treated as an outage: keep the cached lease, retry (hourly after an outage, otherwise daily). |

### `POST /api/v1/licenses/deactivate`

Request: same body as validate. Releases the instance binding so the key can
be activated elsewhere. Idempotent; any 2xx counts as released. The client
calls this best-effort from `fluxmail license deactivate` and clears its local
state whether or not the call succeeds, so the server should also auto-release
bindings that have not validated for a while (suggested: 30 days) to unstick
instances that were deleted without deactivating.

## Lease token

```
base64url(payloadJSON) + "." + base64url(ed25519 signature)
```

The signature covers the payload bytes exactly as transmitted. The client
verifies before parsing and never re-serializes, so the server must sign the
exact serialized bytes it sends.

### Payload (version 2)

```json
{
  "v": 2,
  "licenseId": "<uuid>",
  "plan": "pro",
  "maxMembers": 1,
  "maxAccounts": 10,
  "issuedAt": "<ISO 8601>",
  "expiresAt": "<ISO 8601, issuedAt + ~7 days>"
}
```

- `v` — must be `2`. Version 1 (which had only `maxAccounts`) was never
  shipped to customers and clients reject it.
- `plan` — lowercase plan name for display ("pro", "team", "enterprise").
  Clients print it verbatim and never branch on it; all enforcement uses the
  numeric caps.
- `maxMembers` — positive integer; people who may use the instance.
- `maxAccounts` — positive integer; mailboxes that may be connected to the
  instance.

Plan caps are whatever the server signs. For reference, the unlicensed default
built into the client (the Personal plan) is 3 mailboxes and 1 member. Prices
are never encoded anywhere in this contract or the client; they live on the
website.

## Signing keys

ed25519, distributed as base64-encoded SPKI DER. Production keys are pinned in
the client (`PINNED_LICENSE_PUBLIC_KEYS` in `lease.ts`); dev and staging add
keys via the `FLUXMAIL_LICENSE_PUBLIC_KEYS` env var, which is ignored under
`NODE_ENV=production`. Rotation: ship a release with the old and new keys
pinned, switch the server's signing key once instances have upgraded, then
drop the old pin.

## Client behavior guarantees

- Revalidates roughly daily while a server runs; the lease lives ~7 days.
- Enforcement is fully offline against the cached lease; no request ever
  blocks on the license server.
- When the lease expires without renewal, paid caps continue through a 7-day
  grace period (`GRACE_PERIOD_MS` in `entitlements.ts`), with renewal warnings
  in the CLI and on MCP tool results.
- After the grace period, the instance drops to Personal-plan caps. If usage
  still exceeds them, MCP tool calls (except `get_status`) fail and scheduled
  sends are held until the license is renewed or usage is trimmed to fit. The
  CLI is never blocked, so recovery is always possible.
- A running instance is never bricked: expired or unverifiable leases only
  ever degrade to the Personal plan.
