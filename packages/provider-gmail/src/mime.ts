import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import type Mail from 'nodemailer/lib/mailer/index.js';
import { EmailError, type DraftInput, type EmailAddress } from '@fluxmail/core';

export interface ThreadingHeaders {
  inReplyTo?: string;
  references?: string;
}

function toMailAddresses(addrs: EmailAddress[] | undefined): Mail.Address[] | undefined {
  if (!addrs?.length) return undefined;
  return addrs.map((a) => ({ name: a.name ?? '', address: a.email }));
}

function decodeAttachmentContent(rawContent: string): Buffer {
  // RFC 2045 base64 may be wrapped in whitespace (e.g. `base64` CLI output).
  const content = rawContent.replace(/\s+/g, '');
  if (content === '') return Buffer.alloc(0);
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(content) || content.length % 4 === 1) {
    throw new EmailError('invalid_request', 'Attachment content must be valid base64');
  }
  const unpadded = content.replace(/=+$/, '');
  const padded = unpadded + '='.repeat((4 - (unpadded.length % 4)) % 4);
  const decoded = Buffer.from(padded, 'base64');
  if (decoded.toString('base64').replace(/=+$/, '') !== unpadded) {
    throw new EmailError('invalid_request', 'Attachment content must be valid base64');
  }
  return decoded;
}

/** Build a raw RFC 5322 message from a DraftInput. */
export async function buildRawMessage(
  draft: DraftInput,
  from: EmailAddress,
  threading?: ThreadingHeaders,
): Promise<Buffer> {
  const options: Mail.Options = {
    from: { name: from.name ?? '', address: from.email },
    to: toMailAddresses(draft.to),
    cc: toMailAddresses(draft.cc),
    bcc: toMailAddresses(draft.bcc),
    subject: draft.subject ?? '',
    text: draft.body.text,
    html: draft.body.html,
    attachments: draft.attachments?.map((a) => ({
      filename: a.filename,
      content: decodeAttachmentContent(a.content),
      contentType: a.mimeType,
      ...(a.contentId ? { cid: a.contentId } : {}),
      ...(a.disposition ? { contentDisposition: a.disposition } : {}),
    })),
  };
  if (threading?.inReplyTo) options.inReplyTo = threading.inReplyTo;
  if (threading?.references) options.references = threading.references;

  const composer = new MailComposer(options);
  const compiled = composer.compile();
  // Gmail derives recipients from the raw headers; without this the Bcc header
  // (which MailComposer strips by default) never reaches Gmail and bcc
  // recipients silently get nothing. Gmail removes it before delivery.
  compiled.keepBcc = true;
  return new Promise<Buffer>((resolve, reject) => {
    compiled.build((err, message) => {
      if (err) reject(err);
      else resolve(message);
    });
  });
}
