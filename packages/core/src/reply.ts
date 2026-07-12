import type { EmailAddress, Message } from './types.js';

export interface ReplyRecipients {
  to: EmailAddress[];
  cc: EmailAddress[];
}

function sameAddress(a: EmailAddress, b: EmailAddress): boolean {
  return a.email.trim().toLowerCase() === b.email.trim().toLowerCase();
}

function dedupe(addrs: EmailAddress[]): EmailAddress[] {
  const out: EmailAddress[] = [];
  for (const a of addrs) {
    if (!a.email) continue;
    if (!out.some((b) => sameAddress(a, b))) out.push(a);
  }
  return out;
}

/**
 * Compute reply / reply-all recipients from the original message. Provider-agnostic:
 * reply targets Reply-To (falling back to From); reply-all additionally includes the
 * original To/Cc, minus the replying account's own address.
 */
export function computeReplyRecipients(original: Message, ownAddress: string, replyAll: boolean): ReplyRecipients {
  const self: EmailAddress = { email: ownAddress };
  const replyTarget = original.replyTo?.length ? original.replyTo : original.from ? [original.from] : [];

  if (!replyAll) {
    const to = dedupe(replyTarget).filter((a) => !sameAddress(a, self));
    // Replying to yourself (e.g. a note in Sent): fall back to the original To.
    return { to: to.length ? to : dedupe(original.to), cc: [] };
  }

  const to = dedupe([...replyTarget, ...original.to]).filter((a) => !sameAddress(a, self));
  const cc = dedupe(original.cc ?? []).filter((a) => !sameAddress(a, self) && !to.some((b) => sameAddress(a, b)));
  return { to: to.length ? to : [self], cc };
}

/** "Re: subject" without stacking prefixes. */
export function replySubject(subject: string): string {
  return /^\s*re:/i.test(subject) ? subject : `Re: ${subject}`;
}

/** "Fwd: subject" without stacking prefixes. */
export function forwardSubject(subject: string): string {
  return /^\s*fwd?:/i.test(subject) ? subject : `Fwd: ${subject}`;
}

export function formatAddress(a: EmailAddress): string {
  return a.name ? `${a.name} <${a.email}>` : a.email;
}

export function formatAddressList(addrs: EmailAddress[] | undefined): string {
  return (addrs ?? []).map(formatAddress).join(', ');
}
