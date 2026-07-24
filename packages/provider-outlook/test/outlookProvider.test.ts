import { describe, expect, it, vi } from 'vitest';
import { OutlookProvider } from '../src/outlookProvider.js';

function json(value: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', ...Object.fromEntries(new Headers(headers)) },
  });
}

const folders = [
  { id: 'folder-inbox', displayName: 'Inbox', childFolderCount: 1, unreadItemCount: 2 },
  { id: 'folder-drafts', displayName: 'Drafts', childFolderCount: 0, unreadItemCount: 0 },
  { id: 'folder-sent', displayName: 'Sent Items', childFolderCount: 0, unreadItemCount: 0 },
  { id: 'folder-trash', displayName: 'Deleted Items', childFolderCount: 1, unreadItemCount: 0 },
  { id: 'folder-spam', displayName: 'Junk Email', childFolderCount: 0, unreadItemCount: 0 },
  { id: 'folder-archive', displayName: 'Archive', childFolderCount: 0, unreadItemCount: 0 },
];

function folderResponse(url: URL): Response | undefined {
  if (url.pathname === '/v1.0/me/mailFolders' && url.searchParams.has('includeHiddenFolders')) {
    return json({ value: folders });
  }
  if (url.pathname === '/v1.0/me/mailFolders/folder-inbox/childFolders') {
    return json({
      value: [{ id: 'folder-projects', displayName: 'Projects', childFolderCount: 0, unreadItemCount: 1 }],
    });
  }
  if (url.pathname === '/v1.0/me/mailFolders/folder-trash/childFolders') {
    return json({
      value: [{ id: 'folder-trash-child', displayName: 'Deleted Project', childFolderCount: 0, unreadItemCount: 1 }],
    });
  }
  const known: Record<string, string> = {
    inbox: 'folder-inbox',
    sentitems: 'folder-sent',
    drafts: 'folder-drafts',
    deleteditems: 'folder-trash',
    junkemail: 'folder-spam',
    archive: 'folder-archive',
  };
  const match = url.pathname.match(/^\/v1\.0\/me\/mailFolders\/([^/]+)$/);
  if (match?.[1] && known[match[1]]) return json({ id: known[match[1]] });
  return undefined;
}

function provider(fetchImpl: typeof fetch) {
  return new OutlookProvider({
    accountId: 'acct-1',
    tokenProvider: { getAccessToken: vi.fn().mockResolvedValue('access-token') },
    fetch: fetchImpl,
  });
}

describe('OutlookProvider', () => {
  it('lists Outlook categories and exposes their preset colors', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === '/v1.0/me/outlook/masterCategories') {
        return json({
          value: [
            { id: 'category-1', displayName: 'Customer', color: 'preset7' },
            { id: null, displayName: 'Ignored', color: 'preset0' },
          ],
        });
      }
      return json({ error: { code: 'ErrorItemNotFound', message: 'missing' } }, 404);
    }) as unknown as typeof fetch;

    await expect(provider(fetchMock).listLabels()).resolves.toEqual([
      { id: 'category-1', name: 'Customer', color: { preset: 'preset7' } },
    ]);
  });

  it('asks for reauthorization when category permission is missing', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        json({ error: { code: 'ErrorAccessDenied', message: 'insufficient privileges' } }, 403),
      ) as unknown as typeof fetch;

    await expect(provider(fetchMock).listLabels()).rejects.toMatchObject({
      code: 'permission_denied',
      message: expect.stringContaining('Reauthorize'),
    });
  });

  it('lists nested folders with well-known roles and virtual views', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const response = folderResponse(new URL(String(input)));
      return response ?? json({ error: { code: 'ErrorItemNotFound', message: 'missing' } }, 404);
    }) as unknown as typeof fetch;

    const outlook = provider(fetchMock);
    expect(outlook.capabilities.search.folderRoles.archive).toBe('unknown');
    const result = await outlook.listFolders();

    expect(result).toContainEqual({ id: 'folder-inbox', name: 'Inbox', role: 'inbox', unreadCount: 2 });
    expect(result).toContainEqual({ id: 'folder-projects', name: 'Inbox/Projects', unreadCount: 1 });
    expect(result).toContainEqual({ id: 'starred', name: 'Flagged', role: 'starred' });
    expect(outlook.capabilities.search.folderRoles).toMatchObject({
      inbox: 'available',
      archive: 'available',
      all: 'available',
    });
    for (const call of vi.mocked(fetchMock).mock.calls) {
      const headers = new Headers(call[1]?.headers);
      expect(headers.get('authorization')).toBe('Bearer access-token');
      expect(headers.get('prefer')).toBe('IdType="ImmutableId"');
    }
  });

  it('lists folder messages, translates search, and returns an opaque next-page token', async () => {
    const nextLink = 'https://graph.microsoft.com/v1.0/me/mailFolders/folder-inbox/messages?$skip=25';
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const folder = folderResponse(url);
      if (folder) return folder;
      if (url.pathname === '/v1.0/me/mailFolders/folder-inbox/messages') {
        if (url.searchParams.get('$skip') === '25') {
          return json({
            value: [
              {
                id: 'message-2',
                conversationId: 'thread-2',
                parentFolderId: 'folder-inbox',
                subject: 'Read report',
                receivedDateTime: '2026-07-14T13:00:00Z',
                isRead: true,
              },
              {
                id: 'message-3',
                conversationId: 'thread-3',
                parentFolderId: 'folder-inbox',
                subject: 'Unread report',
                receivedDateTime: '2026-07-14T14:00:00Z',
                isRead: false,
              },
            ],
          });
        }
        return json({
          value: [
            {
              id: 'message-read',
              conversationId: 'thread-read',
              parentFolderId: 'folder-inbox',
              subject: 'Old report',
              receivedDateTime: '2026-07-14T11:00:00Z',
              isRead: true,
            },
            {
              id: 'message-1',
              conversationId: 'thread-1',
              parentFolderId: 'folder-inbox',
              from: { emailAddress: { address: 'alex@example.com' } },
              toRecipients: [{ emailAddress: { address: 'me@example.com' } }],
              subject: 'Report',
              receivedDateTime: '2026-07-14T12:00:00Z',
              bodyPreview: 'Preview',
              isRead: false,
              isDraft: false,
              flag: { flagStatus: 'notFlagged' },
              categories: ['Customer'],
            },
          ],
          '@odata.nextLink': nextLink,
        });
      }
      return json({ error: { code: 'ErrorItemNotFound', message: 'missing' } }, 404);
    }) as unknown as typeof fetch;
    const outlook = provider(fetchMock);

    const first = await outlook.listMessages(
      { folder: 'inbox', text: 'quarterly report', from: 'alex@example.com', read: false },
      { pageSize: 25 },
    );
    expect(first.items[0]).toMatchObject({
      id: 'message-1',
      folder: { role: 'inbox' },
      snippet: 'Preview',
      flags: { read: false },
      labels: ['Customer'],
    });
    expect(first.items.map((item) => item.id)).toEqual(['message-1', 'message-3']);
    expect(first.nextPageToken).toBeUndefined();

    const listCall = vi
      .mocked(fetchMock)
      .mock.calls.map(([input]) => new URL(String(input)))
      .find((url) => url.pathname.endsWith('/messages'))!;
    expect(listCall.searchParams.get('$search')).toContain('\\"quarterly\\" AND \\"report\\"');
    expect(listCall.searchParams.get('$search')).toContain('from:');
    expect(listCall.searchParams.get('$filter')).toBeNull();

    expect(vi.mocked(fetchMock).mock.calls.some(([input]) => String(input) === nextLink)).toBe(true);
  });

  it('replays an opaque Graph page when a Fluxmail page stops partway through it', async () => {
    const nextLink =
      'https://graph.microsoft.com/v1.0/me/mailFolders/folder-inbox/messages?$skip=2&$top=2&opaque=a%2Bb';
    const messageRequests: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const requestUrl = String(input);
      const url = new URL(requestUrl);
      const folder = folderResponse(url);
      if (folder) return folder;
      if (url.pathname === '/v1.0/me/mailFolders/folder-inbox/messages') {
        messageRequests.push(requestUrl);
        if (url.searchParams.get('$skip') === '2') {
          return json({
            value: [
              {
                id: 'message-2',
                conversationId: 'thread-2',
                parentFolderId: 'folder-inbox',
                subject: 'Second match',
                receivedDateTime: '2026-07-14T13:00:00Z',
                isRead: false,
              },
              {
                id: 'message-3',
                conversationId: 'thread-3',
                parentFolderId: 'folder-inbox',
                subject: 'Third match',
                receivedDateTime: '2026-07-14T14:00:00Z',
                isRead: false,
              },
            ],
          });
        }
        return json({
          value: [
            {
              id: 'message-1',
              conversationId: 'thread-1',
              parentFolderId: 'folder-inbox',
              subject: 'First match',
              receivedDateTime: '2026-07-14T11:00:00Z',
              isRead: false,
            },
            {
              id: 'message-read',
              conversationId: 'thread-read',
              parentFolderId: 'folder-inbox',
              subject: 'Filtered',
              receivedDateTime: '2026-07-14T12:00:00Z',
              isRead: true,
            },
          ],
          '@odata.nextLink': nextLink,
        });
      }
      return json({ error: { code: 'ErrorItemNotFound', message: 'missing' } }, 404);
    }) as unknown as typeof fetch;
    const outlook = provider(fetchMock);

    const first = await outlook.listMessages({ folder: 'inbox', read: false }, { pageSize: 2 });
    const second = await outlook.listMessages(
      { folder: 'inbox', read: false },
      { pageSize: 2, pageToken: first.nextPageToken },
    );

    expect(first.items.map((message) => message.id)).toEqual(['message-1', 'message-2']);
    expect(first.nextPageToken).toBeTruthy();
    expect(second.items.map((message) => message.id)).toEqual(['message-3']);
    expect(second.nextPageToken).toBeUndefined();
    expect(messageRequests.filter((request) => request === nextLink)).toHaveLength(2);
  });

  it('applies attachment and UTC date filters locally when Graph search is active', async () => {
    const attachmentRequests: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const folder = folderResponse(url);
      if (folder) return folder;
      if (url.pathname === '/v1.0/me/messages') {
        return json({
          value: [
            {
              id: 'message-old',
              conversationId: 'thread-old',
              parentFolderId: 'folder-inbox',
              subject: 'Old report',
              receivedDateTime: '2025-12-31T23:59:59.999Z',
            },
            {
              id: 'message-inline',
              conversationId: 'thread-inline',
              parentFolderId: 'folder-inbox',
              subject: 'Inline report',
              receivedDateTime: '2026-01-02T12:00:00.000Z',
            },
            {
              id: 'message-boundary',
              conversationId: 'thread-boundary',
              parentFolderId: 'folder-inbox',
              subject: 'Boundary report',
              receivedDateTime: '2026-01-03T00:00:00.000Z',
            },
            {
              id: 'message-file',
              conversationId: 'thread-file',
              parentFolderId: 'folder-inbox',
              subject: 'File report',
              receivedDateTime: '2026-01-02T13:00:00.000Z',
            },
          ],
        });
      }
      const attachment = url.pathname.match(/^\/v1\.0\/me\/messages\/([^/]+)\/attachments$/)?.[1];
      if (attachment) {
        attachmentRequests.push(attachment);
        return json({
          value: [{ id: `attachment-${attachment}`, isInline: attachment === 'message-inline' }],
        });
      }
      return json({ error: { code: 'ErrorItemNotFound', message: 'missing' } }, 404);
    }) as unknown as typeof fetch;
    const outlook = provider(fetchMock);

    const page = await outlook.listMessages({
      text: 'report',
      hasAttachment: true,
      after: '2026-01-01',
      before: '2026-01-03',
    });

    expect(page.items.map((message) => message.id)).toEqual(['message-file']);
    expect(page.inspectedCandidates).toBe(4);
    expect(attachmentRequests).toEqual(['message-inline', 'message-file']);
    const messageRequest = vi
      .mocked(fetchMock)
      .mock.calls.map(([input]) => new URL(String(input)))
      .find((url) => url.pathname === '/v1.0/me/messages')!;
    expect(messageRequest.searchParams.get('$search')).toBeTruthy();
    expect(messageRequest.searchParams.get('$filter')).toBeNull();
  });

  it('continues after filtered Outlook results reach the scan limit', async () => {
    const candidates = Array.from({ length: 1_001 }, (_, index) => ({
      id: `message-${index + 1}`,
      conversationId: `thread-${index + 1}`,
      parentFolderId: 'folder-inbox',
      subject: `Report ${index + 1}`,
      receivedDateTime: '2026-01-02T12:00:00.000Z',
      isRead: index < 1_000,
    }));
    let messageRequests = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const folder = folderResponse(url);
      if (folder) return folder;
      if (url.pathname === '/v1.0/me/messages') {
        messageRequests += 1;
        return json({ value: candidates });
      }
      return json({ error: { code: 'ErrorItemNotFound', message: 'missing' } }, 404);
    }) as unknown as typeof fetch;
    const outlook = provider(fetchMock);
    const query = { text: 'report', read: false };

    const first = await outlook.listMessages(query, { pageSize: 1 });
    const second = await outlook.listMessages(query, { pageSize: 1, pageToken: first.nextPageToken });

    expect(first).toMatchObject({
      items: [],
      incomplete: true,
      incompleteReason: 'scan_limit',
      inspectedCandidates: 1_000,
    });
    expect(first.nextPageToken).toBeTruthy();
    expect(second.items.map((message) => message.id)).toEqual(['message-1001']);
    expect(second.nextPageToken).toBeUndefined();
    expect(second.incomplete).toBeUndefined();
    expect(second.inspectedCandidates).toBe(1);
    expect(messageRequests).toBe(2);
  });

  it('reports a terminal Outlook provider limit without a continuation token', async () => {
    const candidates = Array.from({ length: 1_000 }, (_, index) => ({
      id: `message-${index + 1}`,
      conversationId: `thread-${index + 1}`,
      parentFolderId: 'folder-inbox',
      subject: `Report ${index + 1}`,
      receivedDateTime: '2026-01-02T12:00:00.000Z',
      isRead: true,
    }));
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const folder = folderResponse(url);
      if (folder) return folder;
      if (url.pathname === '/v1.0/me/messages') return json({ value: candidates });
      return json({ error: { code: 'ErrorItemNotFound', message: 'missing' } }, 404);
    }) as unknown as typeof fetch;

    const page = await provider(fetchMock).listMessages({ text: 'report', read: false }, { pageSize: 1 });

    expect(page).toMatchObject({
      items: [],
      incomplete: true,
      incompleteReason: 'provider_limit',
      inspectedCandidates: 1_000,
    });
    expect(page.nextPageToken).toBeUndefined();
  });

  it('accepts virtual folder display names without treating them as Graph folder ids', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const folder = folderResponse(url);
      if (folder) return folder;
      if (url.pathname === '/v1.0/me/messages') {
        return json({
          value: [
            {
              id: 'message-inbox',
              conversationId: 'thread-inbox',
              parentFolderId: 'folder-inbox',
              subject: 'Inbox report',
              receivedDateTime: '2026-07-14T12:00:00Z',
              isRead: false,
            },
            {
              id: 'message-trash-child',
              conversationId: 'thread-trash-child',
              parentFolderId: 'folder-trash-child',
              subject: 'Deleted report',
              receivedDateTime: '2026-07-14T13:00:00Z',
              isRead: false,
            },
          ],
        });
      }
      return json({ error: { code: 'ErrorItemNotFound', message: 'missing' } }, 404);
    }) as unknown as typeof fetch;
    const outlook = provider(fetchMock);

    await outlook.listMessages({ folder: 'Flagged' });
    const allMail = await outlook.listMessages({ folder: 'All mail' });
    const omittedFolder = await outlook.listMessages({});

    expect(allMail.items.map((message) => message.id)).toEqual(['message-inbox']);
    expect(omittedFolder.items.map((message) => message.id)).toEqual(['message-inbox']);

    const messageRequests = vi
      .mocked(fetchMock)
      .mock.calls.map(([input]) => new URL(String(input)))
      .filter((url) => url.pathname.endsWith('/messages'));
    expect(messageRequests).toHaveLength(3);
    expect(messageRequests[0]?.pathname).toBe('/v1.0/me/messages');
    expect(messageRequests[0]?.searchParams.get('$filter')).toContain("flag/flagStatus eq 'flagged'");
    expect(messageRequests[0]?.searchParams.get('$filter')).toContain("parentFolderId ne 'folder-trash'");
    expect(messageRequests[0]?.searchParams.get('$filter')).toContain("parentFolderId ne 'folder-spam'");
    expect(messageRequests[1]?.pathname).toBe('/v1.0/me/messages');
    expect(messageRequests[1]?.searchParams.get('$filter')).toContain("parentFolderId ne 'folder-trash'");
    expect(messageRequests[1]?.searchParams.get('$filter')).toContain("parentFolderId ne 'folder-spam'");
    expect(messageRequests[1]?.searchParams.get('$filter')).not.toContain('folder-trash-child');
    expect(messageRequests[2]?.searchParams.get('$filter')).toBe(messageRequests[1]?.searchParams.get('$filter'));
  });

  it('excludes junk and deleted messages from mailbox-wide search pages', async () => {
    const nextLink = 'https://graph.microsoft.com/v1.0/me/messages?$skip=25';
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const folder = folderResponse(url);
      if (folder) return folder;
      if (url.pathname === '/v1.0/me/messages') {
        if (url.searchParams.get('$skip') === '25') {
          return json({
            value: [
              {
                id: 'message-trash-child',
                conversationId: 'thread-trash-child',
                parentFolderId: 'folder-trash-child',
                subject: 'Deleted report',
                receivedDateTime: '2026-07-14T14:00:00Z',
                isRead: false,
              },
            ],
          });
        }
        return json({
          value: [
            {
              id: 'message-inbox',
              conversationId: 'thread-inbox',
              parentFolderId: 'folder-inbox',
              subject: 'Inbox report',
              receivedDateTime: '2026-07-14T12:00:00Z',
              isRead: false,
            },
            {
              id: 'message-spam',
              conversationId: 'thread-spam',
              parentFolderId: 'folder-spam',
              subject: 'Spam report',
              receivedDateTime: '2026-07-14T13:00:00Z',
              isRead: false,
            },
          ],
          '@odata.nextLink': nextLink,
        });
      }
      return json({ error: { code: 'ErrorItemNotFound', message: 'missing' } }, 404);
    }) as unknown as typeof fetch;
    const outlook = provider(fetchMock);

    const first = await outlook.listMessages({ text: 'report', read: false });
    expect(first.items.map((message) => message.id)).toEqual(['message-inbox']);
    expect(first.nextPageToken).toBeUndefined();
    expect(first.inspectedCandidates).toBe(3);
  });

  it('refreshes once after a 401 response', async () => {
    const getAccessToken = vi.fn().mockResolvedValueOnce('old-token').mockResolvedValueOnce('new-token');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ error: { code: 'InvalidAuthenticationToken', message: 'expired' } }, 401))
      .mockResolvedValueOnce(json({ id: 'me' })) as unknown as typeof fetch;
    const outlook = new OutlookProvider({
      accountId: 'acct-1',
      tokenProvider: { getAccessToken },
      fetch: fetchMock,
    });

    await outlook.testConnection();

    expect(getAccessToken).toHaveBeenNthCalledWith(1, false);
    expect(getAccessToken).toHaveBeenNthCalledWith(2, true);
    expect(new URL(String(vi.mocked(fetchMock).mock.calls[0]![0])).pathname).toBe('/v1.0/me/mailFolders/inbox');
  });

  it('returns not_found for an unknown conversation', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ value: [] })) as unknown as typeof fetch;

    await expect(provider(fetchMock).getThread('missing-thread')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('rejects a recipient-free message before creating a draft', async () => {
    const fetchMock = vi.fn() as unknown as typeof fetch;

    await expect(provider(fetchMock).send({ subject: 'No recipient', body: { text: 'Hello' } })).rejects.toMatchObject({
      code: 'invalid_request',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('creates and sends a draft with a file attachment', async () => {
    let attachmentAdded = false;
    const calls: Array<{ url: URL; method: string; body?: unknown }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      calls.push({
        url,
        method,
        ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) } : {}),
      });
      const folder = folderResponse(url);
      if (folder) return folder;
      if (url.pathname === '/v1.0/me/messages' && method === 'POST') return json({ id: 'draft-1' }, 201);
      if (url.pathname === '/v1.0/me/messages/draft-1/attachments' && method === 'POST') {
        attachmentAdded = true;
        return json({ id: 'attachment-1' }, 201);
      }
      if (url.pathname === '/v1.0/me/messages/draft-1' && method === 'GET') {
        return json({
          id: 'draft-1',
          conversationId: 'thread-1',
          parentFolderId: 'folder-drafts',
          toRecipients: [{ emailAddress: { address: 'alex@example.com' } }],
          subject: 'Status',
          createdDateTime: '2026-07-14T12:00:00Z',
          body: { contentType: 'text', content: 'Hello' },
          isDraft: true,
          isRead: true,
          attachments: attachmentAdded
            ? [{ id: 'attachment-1', name: 'note.txt', contentType: 'text/plain', size: 5, isInline: false }]
            : [],
        });
      }
      if (url.pathname === '/v1.0/me/messages/draft-1/send' && method === 'POST')
        return new Response(null, { status: 202 });
      return json({ error: { code: 'ErrorItemNotFound', message: `${method} ${url.pathname}` } }, 404);
    }) as unknown as typeof fetch;
    const outlook = provider(fetchMock);

    const result = await outlook.send({
      to: [{ email: 'alex@example.com' }],
      subject: 'Status',
      body: { text: 'Hello' },
      attachments: [{ filename: 'note.txt', mimeType: 'text/plain', content: Buffer.from('hello').toString('base64') }],
    });

    expect(result).toEqual({ id: 'draft-1', threadId: 'thread-1' });
    expect(
      calls.find((call) => call.url.pathname === '/v1.0/me/messages' && call.method === 'POST')?.body,
    ).toMatchObject({
      subject: 'Status',
      body: { contentType: 'Text', content: 'Hello' },
      toRecipients: [{ emailAddress: { address: 'alex@example.com' } }],
    });
    expect(calls.find((call) => call.url.pathname.endsWith('/attachments'))?.body).toMatchObject({
      '@odata.type': '#microsoft.graph.fileAttachment',
      name: 'note.txt',
    });
  });

  it('derives the subject when replacing a reply draft', async () => {
    let patchedBody: Record<string, unknown> | undefined;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      const folder = folderResponse(url);
      if (folder) return folder;
      if (url.pathname === '/v1.0/me/messages/draft-1' && method === 'GET') {
        return json({
          id: 'draft-1',
          conversationId: 'thread-1',
          parentFolderId: 'folder-drafts',
          subject: 'Re: Original subject',
          createdDateTime: '2026-07-14T12:00:00Z',
          body: { contentType: 'text', content: 'Updated reply' },
          isDraft: true,
        });
      }
      if (url.pathname === '/v1.0/me/messages/original-1' && method === 'GET') {
        return json({
          id: 'original-1',
          conversationId: 'thread-1',
          parentFolderId: 'folder-inbox',
          subject: 'Original subject',
          receivedDateTime: '2026-07-14T11:00:00Z',
          isDraft: false,
        });
      }
      if (url.pathname === '/v1.0/me/messages/draft-1' && method === 'PATCH') {
        patchedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return json({ id: 'draft-1' });
      }
      if (url.pathname === '/v1.0/me/messages/draft-1/attachments') return json({ value: [] });
      return json({ error: { code: 'ErrorItemNotFound', message: `${method} ${url.pathname}` } }, 404);
    }) as unknown as typeof fetch;

    await provider(fetchMock).updateDraft('draft-1', {
      replyToMessageId: 'original-1',
      to: [{ email: 'alex@example.com' }],
      body: { text: 'Updated reply' },
    });

    expect(patchedBody).toMatchObject({
      subject: 'Re: Original subject',
      body: { contentType: 'Text', content: 'Updated reply' },
      toRecipients: [{ emailAddress: { address: 'alex@example.com' } }],
      ccRecipients: [],
      bccRecipients: [],
    });
  });

  it('updates flags, moves messages, permanently deletes, and downloads attachments', async () => {
    const calls: Array<{ path: string; method: string; body?: unknown }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      calls.push({
        path: url.pathname,
        method,
        ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) } : {}),
      });
      const folder = folderResponse(url);
      if (folder) return folder;
      if (url.pathname === '/v1.0/me/messages/message-1' && url.searchParams.get('$select') === 'parentFolderId') {
        return json({ id: 'message-1', parentFolderId: 'folder-inbox' });
      }
      if (url.pathname.endsWith('/attachments/attachment-1')) {
        if (url.searchParams.has('$select')) {
          return json({
            '@odata.type': '#microsoft.graph.fileAttachment',
            id: 'attachment-1',
            name: 'note.txt',
            contentType: 'text/plain',
            size: 5,
          });
        }
        return json({
          '@odata.type': '#microsoft.graph.fileAttachment',
          id: 'attachment-1',
          name: 'note.txt',
          contentType: 'text/plain',
          size: 5,
          contentBytes: Buffer.from('hello').toString('base64'),
        });
      }
      if (method === 'PATCH') return json({ id: 'message-1' });
      if (url.pathname.endsWith('/move')) return json({ id: 'message-1' }, 201);
      if (url.pathname.endsWith('/permanentDelete')) return new Response(null, { status: 204 });
      return json({ error: { code: 'ErrorItemNotFound', message: 'missing' } }, 404);
    }) as unknown as typeof fetch;
    const outlook = provider(fetchMock);

    await outlook.modify(['message-1'], 'markRead');
    await outlook.modify(['message-1'], 'star');
    await outlook.modify(['message-1'], 'archive');
    await outlook.modify(['message-1'], 'trash');
    await outlook.modify(['message-1'], 'delete');
    for (const destination of ['trash', 'deleteditems', 'Deleted Items', 'folder-trash', 'archive', 'folder-archive']) {
      await expect(outlook.modify(['message-1'], { move: destination })).rejects.toMatchObject({
        code: 'invalid_request',
      });
    }
    const attachment = await outlook.getAttachment('message-1', 'attachment-1', { maxBytes: 10 });

    expect(attachment.content.toString()).toBe('hello');
    expect(calls).toContainEqual({ path: '/v1.0/me/messages/message-1', method: 'PATCH', body: { isRead: true } });
    expect(calls).toContainEqual({
      path: '/v1.0/me/messages/message-1',
      method: 'PATCH',
      body: { flag: { flagStatus: 'flagged' } },
    });
    expect(calls).toContainEqual({
      path: '/v1.0/me/messages/message-1/move',
      method: 'POST',
      body: { destinationId: 'folder-archive' },
    });
    expect(calls).toContainEqual({
      path: '/v1.0/me/messages/message-1/move',
      method: 'POST',
      body: { destinationId: 'deleteditems' },
    });
    expect(calls).toContainEqual({ path: '/v1.0/me/messages/message-1/permanentDelete', method: 'POST' });
    expect(calls.filter((call) => call.path.endsWith('/move'))).toHaveLength(2);
    await expect(outlook.getAttachment('message-1', 'attachment-1', { maxBytes: 4 })).rejects.toMatchObject({
      code: 'invalid_request',
    });
    await expect(outlook.getAttachment('message-1', 'attachment-1')).resolves.toMatchObject({
      content: Buffer.from('hello'),
    });
    const attachmentRequests = vi
      .mocked(fetchMock)
      .mock.calls.map(([input]) => new URL(String(input)))
      .filter((url) => url.pathname.endsWith('/attachments/attachment-1'));
    expect(attachmentRequests).toHaveLength(4);
    expect(attachmentRequests[0]?.searchParams.get('$select')).toBe('id,name,contentType,size,isInline');
    expect(attachmentRequests[1]?.search).toBe('');
    expect(attachmentRequests[2]?.searchParams.get('$select')).toBe('id,name,contentType,size,isInline');
    expect(attachmentRequests[3]?.search).toBe('');
  });

  it('adds and removes categories without replacing unrelated categories', async () => {
    const patches: Array<{ id: string; categories: string[] }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      if (url.pathname === '/v1.0/me/outlook/masterCategories') {
        return json({ value: [{ id: 'category-1', displayName: 'Customer', color: 'preset7' }] });
      }
      const match = url.pathname.match(/^\/v1\.0\/me\/messages\/([^/]+)$/);
      if (match && method === 'GET' && url.searchParams.get('$select') === 'categories') {
        const categories =
          match[1] === 'message-1'
            ? ['Existing']
            : match[1] === 'message-2'
              ? ['Existing', 'Customer']
              : ['Existing', 'Orphaned'];
        return json({ categories });
      }
      if (match && method === 'PATCH') {
        patches.push({
          id: match[1]!,
          categories: (JSON.parse(String(init?.body)) as { categories: string[] }).categories,
        });
        return json({ id: match[1] });
      }
      return json({ error: { code: 'ErrorItemNotFound', message: 'missing' } }, 404);
    }) as unknown as typeof fetch;
    const outlook = provider(fetchMock);

    await outlook.modify(['message-1'], { addLabels: ['category-1', 'New category'] });
    await outlook.modify(['message-2'], { removeLabels: ['Customer', 'missing'] });
    await outlook.modify(['message-3'], { removeLabels: ['Orphaned'] });

    expect(patches).toEqual([
      { id: 'message-1', categories: ['Existing', 'Customer', 'New category'] },
      { id: 'message-2', categories: ['Existing'] },
      { id: 'message-3', categories: ['Existing'] },
    ]);
    expect(
      vi
        .mocked(fetchMock)
        .mock.calls.filter(([input]) => new URL(String(input)).pathname === '/v1.0/me/outlook/masterCategories'),
    ).toHaveLength(3);
  });

  it('rejects archive and generic moves through Trash and its descendants', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const folder = folderResponse(url);
      if (folder) return folder;
      if (url.pathname === '/v1.0/me/messages/message-trash' && url.searchParams.get('$select') === 'parentFolderId') {
        return json({ id: 'message-trash', parentFolderId: 'folder-trash' });
      }
      if (
        url.pathname === '/v1.0/me/messages/message-trash-child' &&
        url.searchParams.get('$select') === 'parentFolderId'
      ) {
        return json({ id: 'message-trash-child', parentFolderId: 'folder-trash-child' });
      }
      if (url.pathname.endsWith('/move')) return json({ id: 'message-trash' }, 201);
      return json({ error: { code: 'ErrorItemNotFound', message: 'missing' } }, 404);
    }) as unknown as typeof fetch;
    const outlook = provider(fetchMock);

    for (const id of ['message-trash', 'message-trash-child']) {
      for (const action of ['archive', { move: 'inbox' }] as const) {
        await expect(outlook.modify([id], action)).rejects.toMatchObject({
          code: 'invalid_request',
        });
      }
    }
    await expect(outlook.modify(['message-inbox'], { move: 'folder-trash-child' })).rejects.toMatchObject({
      code: 'invalid_request',
    });

    expect(vi.mocked(fetchMock).mock.calls.some(([input]) => new URL(String(input)).pathname.endsWith('/move'))).toBe(
      false,
    );
  });
});
