import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { EmailService } from '../src/service/emailService.js';
import { buildMcpServer, resolveAttachmentSavePath, saveAttachment, toSendRequest } from '../src/mcp/buildServer.js';

describe('resolveAttachmentSavePath', () => {
  it('uses only the basename of an attachment filename for directory saves', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'fluxmail-attachment-'));
    expect(resolveAttachmentSavePath(directory, '../../.ssh/authorized_keys')).toBe(
      path.join(directory, 'authorized_keys')
    );
    expect(resolveAttachmentSavePath(`${directory}${path.sep}`, '..\\..\\config.env')).toBe(
      path.join(directory, 'config.env')
    );
  });

  it('preserves an explicit file path selected by the caller', () => {
    const target = path.join(tmpdir(), 'renamed.pdf');
    expect(resolveAttachmentSavePath(target, '../../report.pdf')).toBe(target);
  });

  it('does not overwrite an explicitly selected file path', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'fluxmail-attachment-'));
    const target = path.join(directory, 'report.pdf');
    writeFileSync(target, 'existing');

    expect(() => saveAttachment(target, 'ignored.pdf', Buffer.from('replacement'))).toThrow(
      /Refusing to overwrite/
    );
    expect(readFileSync(target, 'utf8')).toBe('existing');
  });

  it('does not overwrite an existing file during a directory save', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'fluxmail-attachment-'));
    const target = path.join(directory, 'report.pdf');
    writeFileSync(target, 'existing');

    expect(() => saveAttachment(directory, 'report.pdf', Buffer.from('replacement'))).toThrow(
      /Refusing to overwrite/
    );
    expect(readFileSync(target, 'utf8')).toBe('existing');
  });

  it('does not follow a destination symlink during a directory save', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'fluxmail-attachment-'));
    const victim = path.join(directory, 'victim.txt');
    writeFileSync(victim, 'existing');
    symlinkSync(victim, path.join(directory, 'report.pdf'));

    expect(() => saveAttachment(directory, 'report.pdf', Buffer.from('replacement'))).toThrow(
      /Refusing to overwrite/
    );
    expect(readFileSync(victim, 'utf8')).toBe('existing');
  });

  it('rejects relative save paths', () => {
    expect(() => saveAttachment('downloads', 'report.pdf', Buffer.from('data'))).toThrow(
      /must be absolute/
    );
  });
});

describe('toSendRequest', () => {
  it('uses an existing draft when no replacement content is supplied', () => {
    expect(toSendRequest({ draftId: 'draft_1' })).toEqual({ draftId: 'draft_1' });
  });

  it('rejects content fields combined with an existing draft id', () => {
    expect(() => toSendRequest({ draftId: 'draft_1', bodyText: 'replacement' })).toThrow(
      /update the draft/
    );
  });

  it('rejects replyAll without a reply target', () => {
    expect(() => toSendRequest({ replyAll: true })).toThrow(/requires replyToMessageId/);
  });
});

describe('scheduled send tools', () => {
  async function connect(service: Partial<EmailService>) {
    const server = buildMcpServer(service as EmailService);
    const client = new Client({ name: 'test', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return client;
  }

  it('registers the scheduling tools', async () => {
    const client = await connect({});
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('send_email');
    expect(names).toContain('list_scheduled_emails');
    expect(names).toContain('cancel_scheduled_email');
  });

  it('routes send_email with sendAt to scheduleSend', async () => {
    const scheduleSend = vi.fn().mockResolvedValue({ scheduleId: 'sch_1', status: 'pending' });
    const send = vi.fn();
    const client = await connect({ scheduleSend, send } as Partial<EmailService>);

    const result = await client.callTool({
      name: 'send_email',
      arguments: {
        to: ['bob@example.com'],
        subject: 'Later',
        bodyText: 'hi',
        sendAt: '2026-07-11T09:00:00-07:00',
      },
    });

    expect(result.isError).toBeFalsy();
    expect(send).not.toHaveBeenCalled();
    expect(scheduleSend).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({ subject: 'Later' }),
      '2026-07-11T09:00:00-07:00'
    );
    // sendAt must not leak into the composed message content.
    expect(scheduleSend.mock.calls[0]![1]).not.toHaveProperty('sendAt');
  });

  it('routes send_email without sendAt to send', async () => {
    const scheduleSend = vi.fn();
    const send = vi.fn().mockResolvedValue({ id: 'm1', threadId: 't1' });
    const client = await connect({ scheduleSend, send } as Partial<EmailService>);

    const result = await client.callTool({
      name: 'send_email',
      arguments: { draftId: 'draft_1' },
    });

    expect(result.isError).toBeFalsy();
    expect(scheduleSend).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(undefined, { draftId: 'draft_1' });
  });

  it('rejects a sendAt without a timezone before reaching the service', async () => {
    const scheduleSend = vi.fn();
    const client = await connect({ scheduleSend } as Partial<EmailService>);

    const result = await client.callTool({
      name: 'send_email',
      arguments: { draftId: 'draft_1', sendAt: '2026-07-11T09:00:00' },
    });

    expect(result.isError).toBe(true);
    expect(scheduleSend).not.toHaveBeenCalled();
  });
});
