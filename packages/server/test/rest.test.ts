import { describe, expect, it, vi } from 'vitest';
import { EmailError, type Message } from '@fluxmail/core';
import type { FluxmailConfig } from '../src/config.js';
import { createRestApi } from '../src/http/rest.js';
import { customPermissionPolicy, permissionPolicyForProfile } from '../src/permissions.js';
import { createApiKey } from '../src/storage/apiKeys.js';
import { openDb } from '../src/storage/db.js';
import { addMember } from '../src/storage/members.js';

const account = {
  id: 'acct_1',
  provider: 'gmail' as const,
  email: 'me@example.com',
  status: 'active' as const,
  capabilities: { labels: true, serverThreads: true, serverSearch: 'rich' as const, snippets: true },
  ownerMemberId: 'member_1',
  sharedWithAll: false,
  grantedMemberIds: [],
};
const message: Message = {
  id: 'msg_1',
  threadId: 'thread_1',
  accountId: account.id,
  from: { name: 'Ann', email: 'ann@example.com' },
  to: [{ email: account.email }],
  subject: 'Hello',
  date: '2026-07-14T12:00:00.000Z',
  body: { text: 'Hello there' },
  attachments: [],
  flags: { read: false, starred: false, draft: false },
};

function fixture() {
  const db = openDb(':memory:');
  const member = addMember(db, { id: 'member_1', name: 'Owner', role: 'admin' });
  const { key, info: keyInfo } = createApiKey(db, 'test', member.id);
  const config: FluxmailConfig = {
    dataDir: ':memory:',
    dbPath: ':memory:',
    encryptionKey: Buffer.alloc(32),
    port: 8977,
    publicUrl: 'http://localhost:8977',
    publicUrlConfigured: false,
    oauthPort: 8976,
    oauthHost: '127.0.0.1',
    maxAttachmentBytes: 1024,
    licenseServerUrl: 'https://license.invalid',
  };
  const scheduled = {
    scheduleId: 'schedule_1',
    accountId: account.id,
    draftId: 'draft_1',
    sendAt: '2026-08-01T12:00:00.000Z',
    status: 'pending' as const,
    attempts: 0,
  };
  const service = {
    withPrincipal: vi.fn(),
    assertAccountAccess: vi.fn(() => undefined),
    enforceQuota: vi.fn(() => undefined),
    status: vi.fn(async () => ({ accounts: [], providersAvailable: ['gmail'], scheduled: { pending: 0 } })),
    listAccounts: vi.fn(() => [account]),
    listFolders: vi.fn(async () => [{ id: 'INBOX', name: 'Inbox', role: 'inbox' as const }]),
    listLabels: vi.fn(async () => [{ id: 'Label_1', name: 'private-project' }]),
    listMessages: vi.fn(async () => ({ items: [message], nextPageToken: 'next_1' })),
    getMessage: vi.fn(async () => message),
    getThread: vi.fn(async () => ({ id: 'thread_1', subject: 'Hello', messages: [message] })),
    createDraft: vi.fn(async () => ({ ...message, draftId: 'draft_1', flags: { ...message.flags, draft: true } })),
    updateDraft: vi.fn(async () => ({ ...message, draftId: 'draft_1', flags: { ...message.flags, draft: true } })),
    deleteDraft: vi.fn(async () => undefined),
    send: vi.fn(async () => ({ id: 'sent_1', threadId: 'thread_1' })),
    scheduleSend: vi.fn(async () => scheduled),
    listScheduled: vi.fn(() => [scheduled]),
    cancelScheduled: vi.fn(() => ({
      scheduleId: scheduled.scheduleId,
      draftId: scheduled.draftId,
      draftKept: true as const,
    })),
    forward: vi.fn(async () => ({ id: 'sent_forward', threadId: 'thread_1' })),
    modify: vi.fn(async () => undefined),
    getAttachment: vi.fn(async () => ({
      meta: { id: 'att_1', filename: 'report.txt', mimeType: 'text/plain', sizeBytes: 5 },
      content: Buffer.from('hello'),
    })),
  };
  service.withPrincipal.mockReturnValue(service);
  const app = createRestApi({ config, db, service: service as never });
  const auth = { authorization: `Bearer ${key}` };
  return { app, auth, config, db, key, keyInfo, member, service, scheduled };
}

const draftBody = {
  to: [{ email: 'ann@example.com', name: 'Ann' }],
  subject: 'Hello',
  body: { text: 'Hi Ann' },
};

function jsonRequest(method: string, body?: unknown, headers: Record<string, string> = {}): RequestInit {
  return {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

describe('REST API discovery and authentication', () => {
  it('serves public discovery and an OpenAPI 3.1 contract', async () => {
    const { app } = fixture();
    const discovery = await app.request('/api/v1');
    expect(discovery.status).toBe(200);
    await expect(discovery.json()).resolves.toMatchObject({
      data: { name: 'fluxmail', openapi: '/api/v1/openapi.json' },
    });

    const response = await app.request('/api/v1/openapi.json');
    expect(response.status).toBe(200);
    const document = (await response.json()) as Record<string, any>;
    expect(document.openapi).toBe('3.1.0');
    expect(document.components.securitySchemes.bearerAuth).toMatchObject({ type: 'http', scheme: 'bearer' });
    expect(document.components.securitySchemes.memberSessionAuth).toMatchObject({
      type: 'http',
      scheme: 'bearer',
    });
    expect(document.paths['/api/v1/me/password'].put.security).toEqual([{ memberSessionAuth: [] }]);
    expect(document.paths['/api/v1/me'].get.security).toEqual([{ bearerAuth: [] }]);
    expect(document.components.schemas.ForwardRequest.properties.includeAttachments).toMatchObject({
      type: 'boolean',
      default: true,
      description: 'Include attachments from the original message. Defaults to true.',
    });
    expect(document.components.schemas.ModifyMessagesRequest.properties.folder.description).toMatch(
      /Required when action is move/,
    );
    expect(document.components.schemas.ModifyMessagesRequest.properties.labels.description).toMatch(
      /Required when action is addLabels or removeLabels/,
    );
    expect(
      document.paths['/api/v1/admin/connections'].post.requestBody.content['application/json'].schema.example,
    ).toEqual({ provider: 'gmail', ownerMemberId: 'you@example.com' });
    expect(
      document.paths['/api/v1/admin/imap/tests'].post.requestBody.content['application/json'].schema.example,
    ).toMatchObject({ imap: { port: 993 }, smtp: { port: 465 } });
    expect(
      document.paths['/api/v1/admin/api-keys'].post.requestBody.content['application/json'].schema.example,
    ).toEqual({ name: 'reporting', member: 'you@example.com', permissionProfile: 'read-only' });
    expect(
      document.paths['/api/v1/admin/api-keys/{keyId}'].patch.requestBody.content['application/json'].schema.example,
    ).toEqual({ permissionProfile: 'read-only' });
    expect(
      document.paths['/api/v1/admin/accounts/{accountId}/imap/folders'].patch.requestBody.content['application/json']
        .schema.example,
    ).toEqual({ sent: 'Sent' });
    expect(document.paths['/api/v1/accounts/{accountId}/send'].post.operationId).toBe('sendMessage');
    expect(document.paths['/api/v1/accounts/{accountId}/send'].post.requestBody.required).toBe(true);
    expect(Object.keys(document.paths)).toEqual(
      expect.arrayContaining([
        '/api/v1/accounts/{accountId}/messages',
        '/api/v1/accounts/{accountId}/labels',
        '/api/v1/accounts/{accountId}/send',
        '/api/v1/accounts/{accountId}/messages/{messageId}/attachments/{attachmentId}',
      ]),
    );
  });

  it('requires bearer authentication and ignores query-string keys', async () => {
    const { app, key, member, service } = fixture();
    const missing = await app.request('/api/v1/status');
    expect(missing.status).toBe(401);
    expect(missing.headers.get('www-authenticate')).toBe('Bearer');
    expect(await missing.json()).toEqual({
      error: { code: 'unauthorized', message: 'Pass a member session or API key as a Bearer token.' },
    });
    expect((await app.request(`/api/v1/status?key=${key}`)).status).toBe(401);

    const authorized = await app.request('/api/v1/status', { headers: { authorization: `Bearer ${key}` } });
    expect(authorized.status).toBe(200);
    expect(service.withPrincipal).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'api_key',
        memberId: member.id,
        role: 'admin',
        accountIds: null,
      }),
    );
  });

  it('never trusts an unauthenticated local network request', async () => {
    const { app, service } = fixture();
    expect((await app.request('/api/v1/status')).status).toBe(401);
    expect((await app.request('/api/v1/accounts/acct_1/folders')).status).toBe(401);
    expect(service.withPrincipal).not.toHaveBeenCalled();
  });
});

describe('REST email operations', () => {
  it('routes the full read, draft, schedule, action, and attachment surface', async () => {
    const { app, auth, service } = fixture();
    expect((await app.request('/api/v1/accounts', { headers: auth })).status).toBe(200);
    expect((await app.request('/api/v1/accounts/acct_1/folders', { headers: auth })).status).toBe(200);
    const labels = await app.request('/api/v1/accounts/acct_1/labels', { headers: auth });
    expect(labels.status).toBe(200);
    await expect(labels.json()).resolves.toEqual({ data: [{ id: 'Label_1', name: 'private-project' }] });
    expect(service.listLabels).toHaveBeenCalledWith('acct_1');

    const listed = await app.request('/api/v1/accounts/acct_1/messages?unreadOnly=true&pageSize=25', { headers: auth });
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({ data: [{ id: 'msg_1' }], meta: { nextPageToken: 'next_1' } });
    expect(service.listMessages).toHaveBeenCalledWith('acct_1', { unreadOnly: true }, { pageSize: 25 });

    expect((await app.request('/api/v1/accounts/acct_1/messages/msg_1', { headers: auth })).status).toBe(200);
    expect((await app.request('/api/v1/accounts/acct_1/threads/thread_1', { headers: auth })).status).toBe(200);

    expect((await app.request('/api/v1/accounts/acct_1/drafts', jsonRequest('POST', draftBody, auth))).status).toBe(
      201,
    );
    expect(
      (await app.request('/api/v1/accounts/acct_1/drafts/draft_1', jsonRequest('PUT', draftBody, auth))).status,
    ).toBe(200);
    expect(
      (await app.request('/api/v1/accounts/acct_1/drafts/draft_1', jsonRequest('DELETE', undefined, auth))).status,
    ).toBe(200);

    expect((await app.request('/api/v1/accounts/acct_1/scheduled-sends', { headers: auth })).status).toBe(200);
    expect(
      (await app.request('/api/v1/accounts/acct_1/scheduled-sends/schedule_1', jsonRequest('DELETE', undefined, auth)))
        .status,
    ).toBe(200);

    const modified = await app.request(
      '/api/v1/accounts/acct_1/messages/actions',
      jsonRequest('POST', { messageIds: ['msg_1'], action: 'markRead' }, auth),
    );
    expect(modified.status).toBe(200);
    expect(service.modify).toHaveBeenCalledWith('acct_1', ['msg_1'], 'markRead');

    const attachment = await app.request('/api/v1/accounts/acct_1/messages/msg_1/attachments/att_1', { headers: auth });
    expect(attachment.status).toBe(200);
    expect(attachment.headers.get('content-type')).toBe('text/plain');
    expect(attachment.headers.get('content-disposition')).toContain('report.txt');
    await expect(attachment.text()).resolves.toBe('hello');
  });

  it('strictly validates query strings and JSON bodies', async () => {
    const { app, auth } = fixture();
    const badBoolean = await app.request('/api/v1/accounts/acct_1/messages?unreadOnly=1', { headers: auth });
    expect(badBoolean.status).toBe(400);
    const unknownQuery = await app.request('/api/v1/accounts/acct_1/messages?typo=true', { headers: auth });
    expect(unknownQuery.status).toBe(400);
    const badDate = await app.request('/api/v1/accounts/acct_1/messages?after=2026-02-30', { headers: auth });
    expect(badDate.status).toBe(400);
    const unknownBody = await app.request(
      '/api/v1/accounts/acct_1/drafts',
      jsonRequest('POST', { ...draftBody, typo: true }, auth),
    );
    expect(unknownBody.status).toBe(400);
    const replyAll = await app.request(
      '/api/v1/accounts/acct_1/drafts',
      jsonRequest('POST', { body: { text: 'Reply' }, replyAll: true }, auth),
    );
    expect(replyAll.status).toBe(400);
    const badAttachment = await app.request(
      '/api/v1/accounts/acct_1/drafts',
      jsonRequest(
        'POST',
        {
          body: { text: 'Attachment' },
          attachments: [{ filename: 'x.txt', mimeType: 'text/plain', content: 'not base64' }],
        },
        auth,
      ),
    );
    expect(badAttachment.status).toBe(400);

    const missingBody = await app.request('/api/v1/accounts/acct_1/drafts', {
      method: 'POST',
      headers: auth,
    });
    expect(missingBody.status).toBe(400);

    const wrongContentType = await app.request('/api/v1/accounts/acct_1/drafts', {
      method: 'POST',
      headers: { ...auth, 'content-type': 'text/plain' },
      body: JSON.stringify(draftBody),
    });
    expect(wrongContentType.status).toBe(400);
  });

  it('maps provider errors without exposing internal failures', async () => {
    const { app, auth, service } = fixture();
    service.getMessage.mockRejectedValueOnce(new EmailError('provider_unavailable', 'Gmail is unavailable.'));
    const unavailable = await app.request('/api/v1/accounts/acct_1/messages/msg_1', { headers: auth });
    expect(unavailable.status).toBe(503);
    await expect(unavailable.json()).resolves.toEqual({
      error: { code: 'provider_unavailable', message: 'Gmail is unavailable.' },
    });

    service.getMessage.mockRejectedValueOnce(new Error('database password leaked'));
    const internal = await app.request('/api/v1/accounts/acct_1/messages/msg_1', { headers: auth });
    expect(internal.status).toBe(500);
    await expect(internal.json()).resolves.toEqual({
      error: { code: 'internal', message: 'The request could not be completed.' },
    });
  });

  it('keeps status available when plan quota blocks other operations', async () => {
    const { app, auth, service } = fixture();
    service.enforceQuota.mockImplementation(() => {
      throw new EmailError('entitlement_exceeded', 'The instance is over its plan limits.');
    });
    expect((await app.request('/api/v1/status', { headers: auth })).status).toBe(200);
    const accounts = await app.request('/api/v1/accounts', { headers: auth });
    expect(accounts.status).toBe(403);
  });

  it('returns JSON errors for malformed bodies and oversized attachments', async () => {
    const { app, auth, service } = fixture();
    const malformed = await app.request('/api/v1/accounts/acct_1/drafts', {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: '{',
    });
    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toMatchObject({ error: { code: 'invalid_request' } });

    service.getAttachment.mockResolvedValueOnce({
      meta: { id: 'att_1', filename: 'large.bin', mimeType: 'application/octet-stream', sizeBytes: 1025 },
      content: Buffer.alloc(1025),
    });
    const attachment = await app.request('/api/v1/accounts/acct_1/messages/msg_1/attachments/att_1', { headers: auth });
    expect(attachment.status).toBe(400);
  });

  it('sanitizes attachment filenames before writing response headers', async () => {
    const { app, auth, service } = fixture();
    service.getAttachment.mockResolvedValueOnce({
      meta: {
        id: 'att_1',
        filename: '../../report"\r\nX-Test: injected.txt',
        mimeType: 'text/plain',
        sizeBytes: 5,
      },
      content: Buffer.from('hello'),
    });
    const response = await app.request('/api/v1/accounts/acct_1/messages/msg_1/attachments/att_1', {
      headers: auth,
    });
    expect(response.status).toBe(200);
    const disposition = response.headers.get('content-disposition') ?? '';
    expect(disposition).not.toContain('../');
    expect(disposition).not.toContain('\r');
    expect(disposition).not.toContain('\n');
  });

  it('records operation telemetry without request data', async () => {
    const { auth, config, db, service } = fixture();
    const capture = vi.fn();
    const app = createRestApi({
      config,
      db,
      service: service as never,
      telemetry: { capture, shutdown: async () => undefined },
    });
    expect((await app.request('/api/v1')).status).toBe(200);
    expect((await app.request('/api/v1/status', { headers: auth })).status).toBe(200);
    expect((await app.request('/api/v1/accounts/acct_1/labels', { headers: auth })).status).toBe(200);
    service.listLabels.mockRejectedValueOnce(new EmailError('permission_denied', 'private-project denied'));
    expect((await app.request('/api/v1/accounts/acct_1/labels', { headers: auth })).status).toBe(403);
    expect(capture).toHaveBeenCalledWith(
      'operation completed',
      expect.objectContaining({ product_surface: 'rest', operation: 'getApiInfo', outcome: 'success' }),
    );
    expect(capture).toHaveBeenCalledWith(
      'operation completed',
      expect.objectContaining({ product_surface: 'rest', operation: 'getStatus', outcome: 'success' }),
    );
    expect(capture).toHaveBeenCalledWith(
      'operation completed',
      expect.objectContaining({ product_surface: 'rest', operation: 'listLabels', outcome: 'success' }),
    );
    expect(capture).toHaveBeenCalledWith(
      'operation completed',
      expect.objectContaining({
        product_surface: 'rest',
        operation: 'listLabels',
        outcome: 'error',
        error_code: 'permission_denied',
      }),
    );
    expect(JSON.stringify(capture.mock.calls)).not.toContain('me@example.com');
    expect(JSON.stringify(capture.mock.calls)).not.toContain('private-project');
  });
});

describe('REST permissions', () => {
  it('enforces permission profiles and reply-derived read access', async () => {
    const { app, db, member } = fixture();
    const { key: readKey } = createApiKey(db, 'reader', member.id, permissionPolicyForProfile('read-only'));
    const readAuth = { authorization: `Bearer ${readKey}` };
    expect((await app.request('/api/v1/accounts', { headers: readAuth })).status).toBe(200);
    const denied = await app.request(
      '/api/v1/accounts/acct_1/send',
      jsonRequest('POST', draftBody, { ...readAuth, 'idempotency-key': 'read-denied' }),
    );
    expect(denied.status).toBe(403);

    const { key: draftsKey } = createApiKey(db, 'drafts-only', member.id, customPermissionPolicy(['mail.drafts']));
    const replyDenied = await app.request(
      '/api/v1/accounts/acct_1/drafts',
      jsonRequest(
        'POST',
        { body: { text: 'Reply' }, replyToMessageId: 'msg_1' },
        { authorization: `Bearer ${draftsKey}` },
      ),
    );
    expect(replyDenied.status).toBe(403);

    const { key: writeKey } = createApiKey(db, 'writer', member.id, permissionPolicyForProfile('read-write'));
    const writeAuth = { authorization: `Bearer ${writeKey}` };
    expect(
      (
        await app.request(
          '/api/v1/accounts/acct_1/drafts',
          jsonRequest('POST', { body: { text: 'Reply' }, replyToMessageId: 'msg_1' }, writeAuth),
        )
      ).status,
    ).toBe(201);
  });

  it('keeps protected folders behind dedicated actions', async () => {
    const { app, auth, service } = fixture();
    const move = await app.request(
      '/api/v1/accounts/acct_1/messages/actions',
      jsonRequest('POST', { messageIds: ['msg_1'], action: 'move', folder: 'Trash' }, auth),
    );
    expect(move.status).toBe(400);
    expect(service.modify).not.toHaveBeenCalled();
  });

  it('defers label-name validation to the provider', async () => {
    const { app, auth, service } = fixture();
    const labels = await app.request(
      '/api/v1/accounts/acct_1/messages/actions',
      jsonRequest('POST', { messageIds: ['msg_1'], action: 'addLabels', labels: ['Important'] }, auth),
    );
    expect(labels.status).toBe(200);
    expect(service.modify).toHaveBeenCalledWith('acct_1', ['msg_1'], { addLabels: ['Important'] });
  });

  it('maps each message action to its own capability', async () => {
    const { app, db, member, service } = fixture();
    const { key } = createApiKey(db, 'trash-only', member.id, customPermissionPolicy(['mail.trash']));
    const headers = { authorization: `Bearer ${key}` };
    const trash = await app.request(
      '/api/v1/accounts/acct_1/messages/actions',
      jsonRequest('POST', { messageIds: ['msg_1'], action: 'trash' }, headers),
    );
    expect(trash.status).toBe(200);
    const archive = await app.request(
      '/api/v1/accounts/acct_1/messages/actions',
      jsonRequest('POST', { messageIds: ['msg_1'], action: 'archive' }, headers),
    );
    expect(archive.status).toBe(403);
    expect(service.modify).toHaveBeenCalledTimes(1);
  });
});

describe('REST send idempotency', () => {
  it('requires a key, replays the same response, and rejects changed payloads', async () => {
    const { app, auth, service } = fixture();
    const missing = await app.request('/api/v1/accounts/acct_1/send', jsonRequest('POST', draftBody, auth));
    expect(missing.status).toBe(400);

    const headers = { ...auth, 'idempotency-key': 'send-1' };
    const first = await app.request('/api/v1/accounts/acct_1/send', jsonRequest('POST', draftBody, headers));
    expect(first.status).toBe(200);
    const replay = await app.request('/api/v1/accounts/acct_1/send', jsonRequest('POST', draftBody, headers));
    expect(replay.status).toBe(200);
    expect(replay.headers.get('idempotency-replayed')).toBe('true');
    expect(service.send).toHaveBeenCalledTimes(1);

    const conflict = await app.request(
      '/api/v1/accounts/acct_1/send',
      jsonRequest('POST', { ...draftBody, subject: 'Changed' }, headers),
    );
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({ error: { code: 'idempotency_conflict' } });
  });

  it('rechecks mailbox scope before reserving or replaying a response', async () => {
    const { app, auth, service } = fixture();
    const replayHeaders = { ...auth, 'idempotency-key': 'scope-replay' };
    expect(
      (await app.request('/api/v1/accounts/acct_1/send', jsonRequest('POST', draftBody, replayHeaders))).status,
    ).toBe(200);

    service.assertAccountAccess.mockImplementationOnce(() => {
      throw new EmailError('not_found', 'No account with id "acct_1"');
    });
    const deniedReplay = await app.request(
      '/api/v1/accounts/acct_1/send',
      jsonRequest('POST', draftBody, replayHeaders),
    );
    expect(deniedReplay.status).toBe(404);
    expect(deniedReplay.headers.get('idempotency-replayed')).toBeNull();
    expect(service.send).toHaveBeenCalledTimes(1);

    const grantHeaders = { ...auth, 'idempotency-key': 'scope-grant' };
    service.assertAccountAccess.mockImplementationOnce(() => {
      throw new EmailError('not_found', 'No account with id "acct_1"');
    });
    expect(
      (await app.request('/api/v1/accounts/acct_1/send', jsonRequest('POST', draftBody, grantHeaders))).status,
    ).toBe(404);
    const granted = await app.request('/api/v1/accounts/acct_1/send', jsonRequest('POST', draftBody, grantHeaders));
    expect(granted.status).toBe(200);
    expect(granted.headers.get('idempotency-replayed')).toBeNull();
    expect(service.send).toHaveBeenCalledTimes(2);
  });

  it('prevents concurrent attempts and replays terminal failures', async () => {
    const { app, auth, service } = fixture();
    let resolveSend!: (value: { id: string; threadId: string }) => void;
    service.send.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSend = resolve;
        }),
    );
    const headers = { ...auth, 'idempotency-key': 'concurrent-send' };
    const firstPromise = app.request('/api/v1/accounts/acct_1/send', jsonRequest('POST', draftBody, headers));
    await vi.waitFor(() => expect(service.send).toHaveBeenCalledTimes(1));
    const concurrent = await app.request('/api/v1/accounts/acct_1/send', jsonRequest('POST', draftBody, headers));
    expect(concurrent.status).toBe(409);
    expect(concurrent.headers.get('retry-after')).toBe('1');
    resolveSend({ id: 'sent_1', threadId: 'thread_1' });
    expect((await firstPromise).status).toBe(200);

    service.send.mockRejectedValueOnce(new EmailError('rate_limited', 'Try later.'));
    const failureHeaders = { ...auth, 'idempotency-key': 'failed-send' };
    const failure = await app.request('/api/v1/accounts/acct_1/send', jsonRequest('POST', draftBody, failureHeaders));
    expect(failure.status).toBe(429);
    const replay = await app.request('/api/v1/accounts/acct_1/send', jsonRequest('POST', draftBody, failureHeaders));
    expect(replay.status).toBe(429);
    expect(replay.headers.get('idempotency-replayed')).toBe('true');
  });

  it('separates keys by API-key principal and persists completed responses', async () => {
    const { app, auth, db, member, config, service } = fixture();
    const { key: secondKey } = createApiKey(db, 'second', member.id);
    const idempotencyKey = 'shared-client-key';
    expect(
      (
        await app.request(
          '/api/v1/accounts/acct_1/send',
          jsonRequest('POST', draftBody, { ...auth, 'idempotency-key': idempotencyKey }),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await app.request(
          '/api/v1/accounts/acct_1/send',
          jsonRequest('POST', draftBody, {
            authorization: `Bearer ${secondKey}`,
            'idempotency-key': idempotencyKey,
          }),
        )
      ).status,
    ).toBe(200);
    expect(service.send).toHaveBeenCalledTimes(2);

    const restartedService = { ...service, send: vi.fn() };
    restartedService.withPrincipal = vi.fn(() => restartedService);
    const restarted = createRestApi({ config, db, service: restartedService as never });
    const replay = await restarted.request(
      '/api/v1/accounts/acct_1/send',
      jsonRequest('POST', draftBody, { ...auth, 'idempotency-key': idempotencyKey }),
    );
    expect(replay.status).toBe(200);
    expect(replay.headers.get('idempotency-replayed')).toBe('true');
    expect(restartedService.send).not.toHaveBeenCalled();
  });

  it('protects scheduled sends and forwards with the same mechanism', async () => {
    const { app, auth, service } = fixture();
    const sendAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const scheduled = await app.request(
      '/api/v1/accounts/acct_1/send',
      jsonRequest('POST', { ...draftBody, sendAt }, { ...auth, 'idempotency-key': 'scheduled-1' }),
    );
    expect(scheduled.status).toBe(202);
    expect(service.scheduleSend).toHaveBeenCalledTimes(1);

    const forwarded = await app.request(
      '/api/v1/accounts/acct_1/messages/msg_1/forward',
      jsonRequest('POST', { to: [{ email: 'bob@example.com' }] }, { ...auth, 'idempotency-key': 'forward-1' }),
    );
    expect(forwarded.status).toBe(200);
    expect(service.forward).toHaveBeenCalledTimes(1);
  });
});
