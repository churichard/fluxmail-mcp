---
title: 'Teams & plans'
description: 'Add members, share mailboxes across a team, and unlock paid-plan limits with a license key on the self-hosted Fluxmail MCP server.'
updated: '2026-07-15'
---

## Members and shared mailboxes

Every Fluxmail instance has at least one **member**. A personal instance uses one member to identify its owner. Team and Enterprise instances can add more people and decide which mailboxes each person can reach.

```bash
# The first member becomes an administrator
fluxmail members add --name "Ada Lovelace" --email ada@example.com
fluxmail members add --name "Grace Hopper" --email grace@example.com
fluxmail members list

# Connect a mailbox and set its owner in one step
fluxmail accounts add gmail --owner ada@example.com

# Reassign an existing mailbox
fluxmail accounts assign <account-id> --owner grace@example.com

# Choose who else can reach it
fluxmail accounts access <account-id> --owner-only
fluxmail accounts access <account-id> --shared
fluxmail accounts access <account-id> --share-with ada@example.com
```

`--owner-only` makes a mailbox private to its owner. `--shared` makes it available to every member. Repeat `--share-with` to give selected members access. Assigning the administrator role lets a member manage the instance, but it does not let them read another member's private mail.

Every MCP connection also names the member it acts for. You can limit a connection to selected mailboxes that the member can already reach:

```bash
# Local connection for Ada, limited to one mailbox
fluxmail stdio --member ada@example.com --account <account-id>

# HTTP connection for Ada, limited to one mailbox and read-only actions
fluxmail apikey create \
  --name "ada laptop" \
  --member ada@example.com \
  --account <account-id> \
  --profile read-only
```

Update an HTTP key's mailbox allowlist without replacing the key:

```bash
fluxmail apikey accounts <key-id> --account <account-id>
fluxmail apikey accounts <key-id> --all-accounts
```

Member and account scope control which mailboxes a connection can reach. Its [permission profile](/docs/permissions) separately controls which email actions the client can take. Use one key per client so you can change its scope, change its permissions, or revoke it without interrupting other connections.

## Plans and licensing

Self-hosting is free on the **Personal** plan: 3 connected mailboxes and 1 member. Pro raises the mailbox limit for one person. Team and Enterprise add members and more mailboxes. On Team and Enterprise, each person connects their own mailboxes, and a mailbox can also be shared. See [pricing](/pricing) for current limits.

You can buy Pro or Team from the pricing page. Stripe returns you to Fluxmail after payment and shows your license key. Copy it then, and keep it private.

Use **Manage subscription** on the pricing page or license screen to update your card, view invoices, change plans, or cancel. Stripe asks for the email used at checkout and sends a one-time passcode before opening billing details. Stripe billing emails also include the same portal link.

Unlock a paid plan with your license key:

```bash
fluxmail license activate <key>
fluxmail license status
```

An administrative REST client can read the same status from `GET /api/v1/admin/license` and activate a key with `POST /api/v1/admin/license/activate`. The API key needs `admin.license`. The status response never includes the configured license key. If `FLUXMAIL_LICENSE_KEY` supplies the key, REST cannot replace it.

One license activates one instance, and enforcement keeps working offline. If you schedule a cancellation, the paid plan works until the end of the billing period. After the subscription ends or a payment fails, the instance drops back to Personal limits. Deactivating, downgrading, or lapsing never deletes accounts or data.

## Software license

Fluxmail MCP is proprietary, source-available software. You can inspect, test, and privately modify the source. Production use must stay within your Fluxmail entitlement, including the built-in Personal plan. The license does not permit redistribution, hosted resale, competing use, or bypassing plan controls. Read the [full license terms](https://github.com/churichard/fluxmail/blob/main/LICENSE.md) before using or modifying the software.
