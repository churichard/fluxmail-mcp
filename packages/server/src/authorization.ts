import type { Account } from '@fluxmail/core';
import type { Principal } from './auth.js';
import { hasCapability, type AdminCapability, type Capability } from './permissions.js';

export function canAccessAccount(principal: Principal, account: Account): boolean {
  const granted =
    account.ownerMemberId === principal.memberId ||
    account.sharedWithAll ||
    account.grantedMemberIds.includes(principal.memberId);
  return granted && (principal.accountIds === null || principal.accountIds.includes(account.id));
}

export function canSeeAccountMetadata(principal: Principal, account: Account): boolean {
  if (canAccessAccount(principal, account)) return true;
  return (
    canAdminister(principal, 'admin.accounts') &&
    (principal.accountIds === null || principal.accountIds.includes(account.id))
  );
}

export function allowsCapability(principal: Principal, capability: Capability): boolean {
  return principal.kind === 'session' || hasCapability(principal.permissions, capability);
}

export function canAdminister(principal: Principal, capability: AdminCapability): boolean {
  return (
    principal.role === 'admin' && (principal.kind === 'session' || hasCapability(principal.permissions, capability))
  );
}

export function canManageOwnedAccount(principal: Principal, account: Account): boolean {
  return principal.role === 'admin' || account.ownerMemberId === principal.memberId;
}
