import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import type Mail from 'nodemailer/lib/mailer/index.js';
import { EmailError, type DraftInput, type EmailAddress } from '@fluxmail/core';

export interface ThreadingHeaders {
  inReplyTo?: string;
  references?: string;
}

function addresses(values: EmailAddress[] | undefined): Mail.Address[] | undefined {
  return values?.map(({ name, email }) => ({ name: name ?? '', address: email }));
}

function attachmentContent(value: string): Buffer {
  const compact = value.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact) || compact.length % 4 === 1) {
    throw new EmailError('invalid_request', 'Attachment content must be valid base64');
  }
  return Buffer.from(compact, 'base64');
}

export async function composeMessage(
  input: DraftInput,
  from: EmailAddress,
  threading?: ThreadingHeaders,
): Promise<Buffer> {
  const options: Mail.Options = {
    from: { name: from.name ?? '', address: from.email },
    to: addresses(input.to),
    cc: addresses(input.cc),
    bcc: addresses(input.bcc),
    subject: input.subject ?? '',
    text: input.body.text,
    html: input.body.html,
    attachments: input.attachments?.map((attachment) => ({
      filename: attachment.filename,
      content: attachmentContent(attachment.content),
      contentType: attachment.mimeType,
      ...(attachment.contentId ? { cid: attachment.contentId } : {}),
      ...(attachment.disposition ? { contentDisposition: attachment.disposition } : {}),
    })),
    ...(threading?.inReplyTo ? { inReplyTo: threading.inReplyTo } : {}),
    ...(threading?.references ? { references: threading.references } : {}),
  };
  const compiled = new MailComposer(options).compile();
  compiled.keepBcc = true;
  return new Promise((resolve, reject) => {
    compiled.build((error, message) => (error ? reject(error) : resolve(message)));
  });
}

export function stripBccHeader(raw: Buffer): Buffer {
  const source = raw.toString('binary');
  const split = source.indexOf('\r\n\r\n');
  if (split === -1) return raw;
  const headers = source.slice(0, split).split('\r\n');
  const kept: string[] = [];
  let skipping = false;
  for (const line of headers) {
    if (/^[ \t]/.test(line)) {
      if (!skipping) kept.push(line);
      continue;
    }
    skipping = /^bcc:/i.test(line);
    if (!skipping) kept.push(line);
  }
  return Buffer.from(`${kept.join('\r\n')}\r\n\r\n${source.slice(split + 4)}`, 'binary');
}
