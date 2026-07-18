import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { EmailError } from '@fluxmail/core';
import type { EmailService } from '../src/service/emailService.js';
import { buildMcpServer, toSendRequest, type McpServerOptions } from '../src/mcp/buildServer.js';
import { customPermissionPolicy, permissionPolicyForProfile } from '../src/permissions.js';
import type { Telemetry } from '../src/telemetry.js';

async function connectMcp(service: Partial<EmailService>, options?: McpServerOptions) {
  const server = buildMcpServer(service as EmailService, options);
  const client = new Client({ name: 'test', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function telemetrySpy(): {
  telemetry: Telemetry;
  capture: ReturnType<typeof vi.fn>;
  beginActivity: ReturnType<typeof vi.fn>;
  finishActivity: ReturnType<typeof vi.fn>;
} {
  const capture = vi.fn();
  const finishActivity = vi.fn();
  const beginActivity = vi.fn(() => finishActivity);
  return {
    capture,
    beginActivity,
    finishActivity,
    telemetry: { capture, beginActivity, shutdown: vi.fn().mockResolvedValue(undefined) },
  };
}

describe('toSendRequest', () => {
  it('uses an existing draft when no replacement content is supplied', () => {
    expect(toSendRequest({ draftId: 'draft_1' })).toEqual({ draftId: 'draft_1' });
  });

  it('rejects content fields combined with an existing draft id', () => {
    expect(() => toSendRequest({ draftId: 'draft_1', bodyText: 'replacement' })).toThrow(/update the draft/);
  });

  it('rejects replyAll without a reply target', () => {
    expect(() => toSendRequest({ replyAll: true })).toThrow(/requires replyToMessageId/);
  });
});

describe('MCP permissions', () => {
  const readTools = [
    'download_attachment',
    'get_email',
    'get_status',
    'get_thread',
    'list_accounts',
    'list_emails',
    'list_folders',
    'list_labels',
    'list_scheduled_emails',
    'search_emails',
  ];

  async function toolNames(options: McpServerOptions): Promise<string[]> {
    const client = await connectMcp({ enforceQuota: () => undefined }, options);
    return (await client.listTools()).tools.map((tool) => tool.name).sort();
  }

  it('advertises only read tools for the read-only profile', async () => {
    await expect(toolNames({ permissions: permissionPolicyForProfile('read-only') })).resolves.toEqual(readTools);
  });

  it('uses mail.read for every read tool', async () => {
    await expect(toolNames({ permissions: customPermissionPolicy(['mail.read']) })).resolves.toEqual(readTools);
  });

  it('adds safe write tools but not send tools for the read-write profile', async () => {
    const names = await toolNames({ permissions: permissionPolicyForProfile('read-write') });
    expect(names).toEqual(
      [...readTools, 'cancel_scheduled_email', 'create_draft', 'delete_draft', 'modify_emails', 'update_draft'].sort(),
    );
    expect(names).not.toContain('send_email');
    expect(names).not.toContain('forward_email');
  });

  it('uses one capability for trash and untrash but keeps permanent delete separate', async () => {
    const modify = vi.fn().mockResolvedValue(undefined);
    const client = await connectMcp({ enforceQuota: () => undefined, modify } as Partial<EmailService>, {
      permissions: customPermissionPolicy(['mail.trash']),
    });
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(['modify_emails']);

    const trashed = await client.callTool({
      name: 'modify_emails',
      arguments: { messageIds: ['m1'], action: 'trash' },
    });
    expect(trashed.isError).toBeFalsy();
    expect(modify).toHaveBeenCalledWith(undefined, ['m1'], 'trash');

    const restored = await client.callTool({
      name: 'modify_emails',
      arguments: { messageIds: ['m1'], action: 'untrash' },
    });
    expect(restored.isError).toBeFalsy();
    expect(modify).toHaveBeenCalledWith(undefined, ['m1'], 'untrash');

    const deleted = await client.callTool({
      name: 'modify_emails',
      arguments: { messageIds: ['m1'], action: 'delete' },
    });
    expect(deleted.isError).toBe(true);
    expect(modify).toHaveBeenCalledTimes(2);
  });

  it('uses mail.organize for reversible message organization', async () => {
    const modify = vi.fn().mockResolvedValue(undefined);
    const client = await connectMcp({ enforceQuota: () => undefined, modify } as Partial<EmailService>, {
      permissions: customPermissionPolicy(['mail.organize']),
    });

    const tools = await client.listTools();
    const modifyTool = tools.tools.find((tool) => tool.name === 'modify_emails');
    expect(modifyTool?.inputSchema.properties?.action).toMatchObject({
      enum: ['markRead', 'markUnread', 'star', 'unstar', 'archive', 'move', 'addLabels', 'removeLabels'],
    });

    for (const action of ['markRead', 'markUnread', 'star', 'unstar']) {
      const result = await client.callTool({
        name: 'modify_emails',
        arguments: { messageIds: ['m1'], action },
      });
      expect(result.isError).toBeFalsy();
      expect(modify).toHaveBeenCalledWith(undefined, ['m1'], action);
    }
  });

  it('does not let generic move permissions change protected folders', async () => {
    const modify = vi.fn().mockResolvedValue(undefined);
    const client = await connectMcp({ enforceQuota: () => undefined, modify } as Partial<EmailService>, {
      permissions: customPermissionPolicy(['mail.organize']),
    });

    for (const arguments_ of [
      { messageIds: ['m1'], action: 'move', folder: 'Trash' },
      { messageIds: ['m1'], action: 'move', folder: 'Archive' },
    ]) {
      const result = await client.callTool({ name: 'modify_emails', arguments: arguments_ });
      expect(result.isError).toBe(true);
    }
    expect(modify).not.toHaveBeenCalled();
  });

  it('defers label-name validation to the provider', async () => {
    const modify = vi.fn().mockResolvedValue(undefined);
    const client = await connectMcp({ enforceQuota: () => undefined, modify } as Partial<EmailService>, {
      permissions: customPermissionPolicy(['mail.organize']),
    });

    const result = await client.callTool({
      name: 'modify_emails',
      arguments: { messageIds: ['m1'], action: 'addLabels', labels: ['Important'] },
    });

    expect(result.isError).toBeFalsy();
    expect(modify).toHaveBeenCalledWith(undefined, ['m1'], { addLabels: ['Important'] });
  });

  it('requires read access to expose forwarding', async () => {
    await expect(toolNames({ permissions: customPermissionPolicy(['mail.send']) })).resolves.not.toContain(
      'forward_email',
    );

    const forward = vi.fn().mockResolvedValue({ id: 'm2', threadId: 't2' });
    const client = await connectMcp({ enforceQuota: () => undefined, forward } as Partial<EmailService>, {
      permissions: customPermissionPolicy(['mail.send', 'mail.read']),
    });
    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain('forward_email');

    const withAttachments = await client.callTool({
      name: 'forward_email',
      arguments: { messageId: 'm1', to: ['recipient@example.com'] },
    });
    expect(withAttachments.isError).toBeFalsy();
    expect(forward).toHaveBeenCalledOnce();

    const withoutAttachments = await client.callTool({
      name: 'forward_email',
      arguments: { messageId: 'm1', to: ['recipient@example.com'], includeAttachments: false },
    });
    expect(withoutAttachments.isError).toBeFalsy();
    expect(forward).toHaveBeenCalledTimes(2);
  });
});

describe('attachment tool', () => {
  it('returns an embedded binary resource and passes the size limit to the service', async () => {
    const getAttachment = vi.fn().mockResolvedValue({
      meta: { id: 'a1', filename: 'report.pdf', mimeType: 'application/pdf', sizeBytes: 3 },
      content: Buffer.from('pdf'),
    });
    const client = await connectMcp({ enforceQuota: () => undefined, getAttachment } as Partial<EmailService>, {
      permissions: permissionPolicyForProfile('read-only'),
      maxAttachmentBytes: 3,
    });

    const result = await client.callTool({
      name: 'download_attachment',
      arguments: { accountId: 'acct_1', messageId: 'm1', attachmentId: 'a1' },
    });

    expect(result.isError).toBeFalsy();
    expect(getAttachment).toHaveBeenCalledWith('acct_1', 'm1', 'a1', 3);
    expect(result.content).toContainEqual({
      type: 'resource',
      resource: expect.objectContaining({
        mimeType: 'application/pdf',
        blob: Buffer.from('pdf').toString('base64'),
      }),
    });
  });

  it('checks the final decoded size even when a provider ignores the limit', async () => {
    const getAttachment = vi.fn().mockResolvedValue({
      meta: { id: 'a1', filename: 'large.bin', mimeType: 'application/octet-stream', sizeBytes: 4 },
      content: Buffer.alloc(4),
    });
    const client = await connectMcp({ enforceQuota: () => undefined, getAttachment } as Partial<EmailService>, {
      permissions: permissionPolicyForProfile('read-only'),
      maxAttachmentBytes: 3,
    });

    const result = await client.callTool({
      name: 'download_attachment',
      arguments: { messageId: 'm1', attachmentId: 'a1' },
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('maxBytes');
  });
});

describe('scheduled send tools', () => {
  function connect(service: Partial<EmailService>) {
    return connectMcp({ enforceQuota: () => undefined, ...service });
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
      '2026-07-11T09:00:00-07:00',
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

  it('uses mail.send for immediate and scheduled delivery', async () => {
    const send = vi.fn().mockResolvedValue({ id: 'm1', threadId: 't1' });
    const scheduleSend = vi.fn().mockResolvedValue({ scheduleId: 'sch_1', status: 'pending' });
    const client = await connectMcp({ enforceQuota: () => undefined, send, scheduleSend } as Partial<EmailService>, {
      permissions: customPermissionPolicy(['mail.send']),
    });

    const direct = await client.callTool({
      name: 'send_email',
      arguments: { to: ['bob@example.com'], subject: 'Hello', bodyText: 'Hi' },
    });
    expect(direct.isError).toBeFalsy();

    const reply = await client.callTool({
      name: 'send_email',
      arguments: { replyToMessageId: 'm1', bodyText: 'Hi' },
    });
    expect(reply.isError).toBe(true);

    const draft = await client.callTool({
      name: 'send_email',
      arguments: { draftId: 'draft_1' },
    });
    expect(draft.isError).toBeFalsy();

    const scheduled = await client.callTool({
      name: 'send_email',
      arguments: {
        to: ['bob@example.com'],
        subject: 'Later',
        bodyText: 'Hi',
        sendAt: '2026-07-11T09:00:00-07:00',
      },
    });
    expect(scheduled.isError).toBeFalsy();
    expect(send).toHaveBeenCalledTimes(2);
    expect(scheduleSend).toHaveBeenCalledOnce();
  });

  it('uses mail.send plus read access for replies', async () => {
    const send = vi.fn().mockResolvedValue({ id: 'm2', threadId: 't1' });
    const client = await connectMcp({ enforceQuota: () => undefined, send } as Partial<EmailService>, {
      permissions: customPermissionPolicy(['mail.send', 'mail.read']),
    });

    const reply = await client.callTool({
      name: 'send_email',
      arguments: { replyToMessageId: 'm1', bodyText: 'Hi' },
    });
    expect(reply.isError).toBeFalsy();
    expect(send).toHaveBeenCalledOnce();
  });
});

describe('reply permissions', () => {
  it('requires read access for reply drafts', async () => {
    const createDraft = vi.fn();
    const client = await connectMcp({ enforceQuota: () => undefined, createDraft } as Partial<EmailService>, {
      permissions: customPermissionPolicy(['mail.drafts']),
    });

    const result = await client.callTool({
      name: 'create_draft',
      arguments: { replyToMessageId: 'm1', bodyText: 'Reply' },
    });
    expect(result.isError).toBe(true);
    expect(createDraft).not.toHaveBeenCalled();
  });

  it('uses the normal create and update capabilities for reply drafts', async () => {
    const createDraft = vi.fn().mockResolvedValue({ id: 'd1' });
    const updateDraft = vi.fn().mockResolvedValue({ id: 'd1' });
    const client = await connectMcp(
      { enforceQuota: () => undefined, createDraft, updateDraft } as Partial<EmailService>,
      { permissions: customPermissionPolicy(['mail.drafts', 'mail.read']) },
    );

    const created = await client.callTool({
      name: 'create_draft',
      arguments: { replyToMessageId: 'm1', bodyText: 'Reply' },
    });
    const updated = await client.callTool({
      name: 'update_draft',
      arguments: { draftId: 'd1', replyToMessageId: 'm1', bodyText: 'Updated reply' },
    });

    expect(created.isError).toBeFalsy();
    expect(updated.isError).toBeFalsy();
    expect(createDraft).toHaveBeenCalledOnce();
    expect(updateDraft).toHaveBeenCalledOnce();
  });
});

describe('tool telemetry', () => {
  it('lists labels and records sanitized success telemetry', async () => {
    const { telemetry, capture } = telemetrySpy();
    const listLabels = vi.fn().mockResolvedValue([{ id: 'private-id', name: 'private-project' }]);
    const client = await connectMcp({ enforceQuota: () => undefined, listLabels } as Partial<EmailService>, {
      telemetry,
      transport: 'http',
    });

    const result = await client.callTool({ name: 'list_labels', arguments: { accountId: 'private-account' } });

    expect(result.isError).toBeFalsy();
    expect(listLabels).toHaveBeenCalledWith('private-account');
    expect(capture).toHaveBeenCalledWith(
      'operation completed',
      expect.objectContaining({
        product_surface: 'mcp',
        operation: 'list_labels',
        transport: 'http',
        outcome: 'success',
      }),
    );
    expect(JSON.stringify(capture.mock.calls)).not.toContain('private-account');
    expect(JSON.stringify(capture.mock.calls)).not.toContain('private-project');
  });

  it('captures the tool, transport, outcome, and allowlisted feature properties', async () => {
    const { telemetry, capture, beginActivity, finishActivity } = telemetrySpy();
    const service = {
      enforceQuota: () => undefined,
      scheduleSend: vi.fn().mockResolvedValue({ scheduleId: 'sch_1', status: 'pending' }),
    } as Partial<EmailService>;
    const client = await connectMcp(service, { telemetry, transport: 'http' });

    await client.callTool({
      name: 'send_email',
      arguments: {
        to: ['private@example.com'],
        subject: 'private subject',
        bodyText: 'private body',
        sendAt: '2026-07-11T09:00:00-07:00',
      },
    });

    expect(capture).toHaveBeenCalledWith('operation completed', {
      product_surface: 'mcp',
      operation: 'send_email',
      transport: 'http',
      outcome: 'success',
      duration_ms: expect.any(Number),
      mode: 'direct',
      scheduled: true,
      reply_all: false,
    });
    expect(JSON.stringify(capture.mock.calls)).not.toContain('private@example.com');
    expect(JSON.stringify(capture.mock.calls)).not.toContain('private subject');
    expect(JSON.stringify(capture.mock.calls)).not.toContain('private body');
    expect(beginActivity).toHaveBeenCalledOnce();
    expect(finishActivity).toHaveBeenCalledOnce();
  });

  it('captures a safe label error code without the error message', async () => {
    const { telemetry, capture } = telemetrySpy();
    const service = {
      enforceQuota: () => undefined,
      listLabels: vi.fn(() => {
        throw new EmailError('provider_unavailable', 'private provider response');
      }),
    } as Partial<EmailService>;
    const client = await connectMcp(service, { telemetry, transport: 'stdio' });

    await client.callTool({ name: 'list_labels', arguments: {} });

    expect(capture).toHaveBeenCalledWith(
      'operation completed',
      expect.objectContaining({
        product_surface: 'mcp',
        operation: 'list_labels',
        transport: 'stdio',
        outcome: 'error',
        error_code: 'provider_unavailable',
      }),
    );
    expect(JSON.stringify(capture.mock.calls)).not.toContain('private provider response');
  });
});

describe('plan quota gate', () => {
  it('blocks tool calls while over quota but keeps get_status available', async () => {
    const listAccounts = vi.fn().mockReturnValue([]);
    const status = vi.fn().mockResolvedValue({ accounts: [] });
    const enforceQuota = vi.fn(() => {
      throw new EmailError('entitlement_exceeded', 'Renew the license or remove mailboxes/members');
    });
    const client = await connectMcp({ listAccounts, status, enforceQuota } as Partial<EmailService>);

    const blocked = await client.callTool({ name: 'list_accounts', arguments: {} });
    expect(blocked.isError).toBe(true);
    expect(JSON.stringify(blocked.content)).toContain('entitlement_exceeded');
    expect(listAccounts).not.toHaveBeenCalled();

    const diagnostics = await client.callTool({ name: 'get_status', arguments: {} });
    expect(diagnostics.isError).toBeFalsy();
    expect(status).toHaveBeenCalled();
  });

  it('appends the renewal warning to tool results while the license is in grace', async () => {
    const listAccounts = vi.fn().mockReturnValue([]);
    const enforceQuota = vi.fn().mockReturnValue('The Fluxmail license expired yesterday');
    const client = await connectMcp({ listAccounts, enforceQuota } as Partial<EmailService>);

    const result = await client.callTool({ name: 'list_accounts', arguments: {} });
    expect(result.isError).toBeFalsy();
    const texts = (result.content as Array<{ text: string }>).map((c) => c.text);
    expect(texts).toHaveLength(2);
    expect(texts[1]).toBe('Note: The Fluxmail license expired yesterday');
  });
});
