import { OAuth2Client } from 'googleapis-common';
import { describe, expect, it, vi } from 'vitest';
import { GmailProvider } from '../src/gmailProvider.js';

interface ProviderInternals {
  gmail: {
    users: {
      settings: {
        sendAs: {
          list: () => Promise<{ data: { sendAs?: Array<{ isPrimary?: boolean; displayName?: string }> } }>;
        };
      };
    };
  };
  resolveSenderName: () => Promise<string | null>;
}

function providerWith(
  auth: OAuth2Client,
  sendAs: Array<{ isPrimary?: boolean; displayName?: string }>,
  displayName?: string,
): ProviderInternals {
  const provider = new GmailProvider({
    accountId: 'acct_1',
    email: 'me@example.com',
    ...(displayName ? { displayName } : {}),
    auth,
  });
  const internals = provider as unknown as ProviderInternals;
  internals.gmail = {
    users: {
      settings: {
        sendAs: { list: vi.fn().mockResolvedValue({ data: { sendAs } }) },
      },
    },
  };
  return internals;
}

describe('GmailProvider list hydration', () => {
  function providerWithMessages(getMessage: ReturnType<typeof vi.fn>) {
    const provider = new GmailProvider({
      accountId: 'acct_1',
      email: 'me@example.com',
      auth: new OAuth2Client(),
    });
    const internals = provider as unknown as {
      gmail: {
        users: {
          labels: { list: () => Promise<{ data: { labels: never[] } }> };
          messages: {
            list: () => Promise<{ data: { messages: Array<{ id: string }> } }>;
            get: typeof getMessage;
          };
        };
      };
    };
    internals.gmail = {
      users: {
        labels: { list: vi.fn().mockResolvedValue({ data: { labels: [] } }) },
        messages: {
          list: vi.fn().mockResolvedValue({
            data: { messages: [{ id: 'live' }, { id: 'deleted' }] },
          }),
          get: getMessage,
        },
      },
    };
    return provider;
  }

  it('skips a message deleted after the list response', async () => {
    const getMessage = vi.fn().mockImplementation(({ id }: { id: string }) => {
      if (id === 'deleted') {
        return Promise.reject(Object.assign(new Error('not found'), { code: 404 }));
      }
      return Promise.resolve({
        data: {
          id,
          threadId: 'thread_1',
          internalDate: '1751976000000',
          payload: { headers: [{ name: 'Subject', value: 'Still here' }] },
        },
      });
    });
    const provider = providerWithMessages(getMessage);

    await expect(provider.listMessages({})).resolves.toMatchObject({
      items: [{ id: 'live', subject: 'Still here' }],
    });
  });

  it('still surfaces non-404 hydration failures', async () => {
    const getMessage = vi.fn().mockRejectedValue(Object.assign(new Error('backend error'), { code: 400 }));
    const provider = providerWithMessages(getMessage);

    await expect(provider.listMessages({})).rejects.toMatchObject({ code: 'invalid_request' });
  });
});

describe('GmailProvider getDraft', () => {
  function providerWithDraftsGet(draftsGet: ReturnType<typeof vi.fn>) {
    const provider = new GmailProvider({
      accountId: 'acct_1',
      email: 'me@example.com',
      auth: new OAuth2Client(),
    });
    const internals = provider as unknown as {
      gmail: {
        users: {
          labels: { list: () => Promise<{ data: { labels: never[] } }> };
          drafts: { get: typeof draftsGet };
          messages: { get: ReturnType<typeof vi.fn> };
        };
      };
    };
    internals.gmail = {
      users: {
        labels: { list: vi.fn().mockResolvedValue({ data: { labels: [] } }) },
        drafts: { get: draftsGet },
        messages: {
          get: vi.fn().mockResolvedValue({
            data: {
              id: 'msg_1',
              threadId: 'thread_1',
              internalDate: '1751976000000',
              payload: { headers: [{ name: 'Subject', value: 'Later' }] },
            },
          }),
        },
      },
    };
    return provider;
  }

  it('fetches a draft and stamps the draft id on the message', async () => {
    const draftsGet = vi.fn().mockResolvedValue({ data: { id: 'draft_1', message: { id: 'msg_1' } } });
    const provider = providerWithDraftsGet(draftsGet);

    await expect(provider.getDraft('draft_1')).resolves.toMatchObject({
      id: 'msg_1',
      draftId: 'draft_1',
      subject: 'Later',
    });
    expect(draftsGet).toHaveBeenCalledWith({ userId: 'me', id: 'draft_1' });
  });

  it('maps a missing draft to not_found', async () => {
    const draftsGet = vi.fn().mockRejectedValue(Object.assign(new Error('not found'), { code: 404 }));
    const provider = providerWithDraftsGet(draftsGet);

    await expect(provider.getDraft('gone')).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('GmailProvider sender name', () => {
  it('uses the primary Gmail send-as display name when configured', async () => {
    const auth = new OAuth2Client();
    const request = vi.spyOn(auth, 'request');
    const provider = providerWith(auth, [{ isPrimary: true, displayName: 'Gmail Name' }], 'Stored Name');

    await expect(provider.resolveSenderName()).resolves.toBe('Gmail Name');
    expect(request).not.toHaveBeenCalled();
  });

  it('falls back to the current Google profile name for existing accounts without a stored name', async () => {
    const auth = new OAuth2Client();
    vi.spyOn(auth, 'request').mockResolvedValue({ data: { name: 'Richard Chu' } } as never);
    const provider = providerWith(auth, [{ isPrimary: true, displayName: '' }]);

    await expect(provider.resolveSenderName()).resolves.toBe('Richard Chu');
  });

  it('uses the stored name when profile lookup fails', async () => {
    const auth = new OAuth2Client();
    vi.spyOn(auth, 'request').mockRejectedValue(new Error('userinfo unavailable'));
    const provider = providerWith(auth, [], 'Stored Name');

    await expect(provider.resolveSenderName()).resolves.toBe('Stored Name');
  });

  it('does not cache the fallback name across a transient lookup failure', async () => {
    const auth = new OAuth2Client();
    vi.spyOn(auth, 'request').mockRejectedValue(new Error('userinfo unavailable'));
    const provider = providerWith(auth, [{ isPrimary: true, displayName: 'Gmail Name' }], 'Stored Name');
    const sendAsList = provider.gmail.users.settings.sendAs.list as ReturnType<typeof vi.fn>;
    sendAsList.mockRejectedValueOnce(Object.assign(new Error('backend error'), { code: 400 }));

    await expect(provider.resolveSenderName()).resolves.toBe('Stored Name');
    await expect(provider.resolveSenderName()).resolves.toBe('Gmail Name');
  });
});

describe('GmailProvider modify', () => {
  function providerWithBatchModify() {
    const provider = new GmailProvider({
      accountId: 'acct_1',
      email: 'me@example.com',
      auth: new OAuth2Client(),
    });
    const batchModify = vi.fn().mockResolvedValue({ data: {} });
    const internals = provider as unknown as {
      gmail: {
        users: {
          labels: { list: () => Promise<{ data: { labels: never[] } }> };
          messages: { batchModify: typeof batchModify };
        };
      };
    };
    internals.gmail = {
      users: {
        labels: { list: vi.fn().mockResolvedValue({ data: { labels: [] } }) },
        messages: { batchModify },
      },
    };
    return { provider, batchModify };
  }

  it('moving to the inbox removes Spam without also removing Inbox', async () => {
    const { provider, batchModify } = providerWithBatchModify();
    await provider.modify(['m1'], { move: 'inbox' });
    expect(batchModify).toHaveBeenCalledWith({
      userId: 'me',
      requestBody: { ids: ['m1'], addLabelIds: ['INBOX'], removeLabelIds: ['SPAM'] },
    });
  });

  it('moving to archive removes Inbox and Spam instead of creating an "archive" label', async () => {
    const { provider, batchModify } = providerWithBatchModify();
    await provider.modify(['m1'], { move: 'archive' });
    expect(batchModify).toHaveBeenCalledWith({
      userId: 'me',
      requestBody: { ids: ['m1'], removeLabelIds: ['INBOX', 'SPAM'] },
    });
  });

  it('moving to Spam adds Spam and removes Inbox', async () => {
    const { provider, batchModify } = providerWithBatchModify();
    await provider.modify(['m1'], { move: 'spam' });
    expect(batchModify).toHaveBeenCalledWith({
      userId: 'me',
      requestBody: { ids: ['m1'], addLabelIds: ['SPAM'], removeLabelIds: ['INBOX'] },
    });
  });

  it('rejects moving to "all"', async () => {
    const { provider, batchModify } = providerWithBatchModify();
    await expect(provider.modify(['m1'], { move: 'all' })).rejects.toMatchObject({
      code: 'invalid_request',
    });
    expect(batchModify).not.toHaveBeenCalled();
  });

  it.each(['sent', 'drafts', 'starred', 'trash'])('rejects moving to the reserved system role "%s"', async (role) => {
    const { provider, batchModify } = providerWithBatchModify();
    await expect(provider.modify(['m1'], { move: role })).rejects.toMatchObject({
      code: 'invalid_request',
    });
    expect(batchModify).not.toHaveBeenCalled();
  });

  it.each(['inbox', 'sent', 'draft', 'drafts', 'trash', 'spam', 'starred'])(
    'rejects manually changing the system "%s" label',
    async (label) => {
      const { provider, batchModify } = providerWithBatchModify();
      await expect(provider.modify(['m1'], { addLabels: [label] })).rejects.toMatchObject({
        code: 'invalid_request',
      });
      expect(batchModify).not.toHaveBeenCalled();
    },
  );

  it("chunks label modifications at Gmail's 1000-message limit", async () => {
    const { provider, batchModify } = providerWithBatchModify();
    const ids = Array.from({ length: 1001 }, (_, index) => `m${index}`);

    await provider.modify(ids, 'markRead');

    expect(batchModify).toHaveBeenCalledTimes(2);
    expect(batchModify.mock.calls[0]?.[0].requestBody.ids).toHaveLength(1000);
    expect(batchModify.mock.calls[1]?.[0].requestBody.ids).toEqual(['m1000']);
  });

  it('rejects modifications with more than 100 distinct labels', async () => {
    const { provider, batchModify } = providerWithBatchModify();
    const labels = Array.from({ length: 101 }, (_, index) => `label-${index}`);

    await expect(provider.modify(['m1'], { addLabels: labels })).rejects.toMatchObject({
      code: 'invalid_request',
    });
    expect(batchModify).not.toHaveBeenCalled();
  });
});

describe('GmailProvider send', () => {
  function providerWithSend(send: ReturnType<typeof vi.fn>) {
    const provider = new GmailProvider({
      accountId: 'acct_1',
      email: 'me@example.com',
      auth: new OAuth2Client(),
    });
    const internals = provider as unknown as {
      senderName: string | null;
      gmail: { users: { messages: { send: typeof send } } };
    };
    internals.senderName = null;
    internals.gmail = { users: { messages: { send } } };
    return provider;
  }

  it('does not retry a send that fails with a 5xx (Gmail may have already delivered it)', async () => {
    const send = vi.fn().mockRejectedValue(Object.assign(new Error('backend error'), { code: 500 }));
    const provider = providerWithSend(send);

    await expect(
      provider.send({ to: [{ email: 'bob@example.com' }], subject: 'Hi', body: { text: 'hello' } }),
    ).rejects.toMatchObject({ code: 'provider_unavailable' });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('retries a send rejected with 429 before processing', async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('rate limit'), { code: 429 }))
      .mockResolvedValue({ data: { id: 'sent_1', threadId: 'thread_1' } });
    const provider = providerWithSend(send);

    await expect(
      provider.send({ to: [{ email: 'bob@example.com' }], subject: 'Hi', body: { text: 'hello' } }),
    ).resolves.toEqual({ id: 'sent_1', threadId: 'thread_1' });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('allows a message addressed only through Bcc', async () => {
    const send = vi.fn().mockResolvedValue({ data: { id: 'sent_1', threadId: 'thread_1' } });
    const provider = providerWithSend(send);

    await expect(
      provider.send({ bcc: [{ email: 'hidden@example.com' }], subject: 'Hi', body: { text: 'hello' } }),
    ).resolves.toEqual({ id: 'sent_1', threadId: 'thread_1' });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('rejects a message with no recipients in any header', async () => {
    const send = vi.fn();
    const provider = providerWithSend(send);

    await expect(provider.send({ subject: 'Hi', body: { text: 'hello' } })).rejects.toMatchObject({
      code: 'invalid_request',
    });
    expect(send).not.toHaveBeenCalled();
  });
});

describe('GmailProvider draft creation', () => {
  it('does not retry a create that fails with a 5xx', async () => {
    const provider = new GmailProvider({
      accountId: 'acct_1',
      email: 'me@example.com',
      auth: new OAuth2Client(),
    });
    const create = vi.fn().mockRejectedValue(Object.assign(new Error('backend error'), { code: 500 }));
    const internals = provider as unknown as {
      senderName: string | null;
      gmail: { users: { drafts: { create: typeof create } } };
    };
    internals.senderName = null;
    internals.gmail = { users: { drafts: { create } } };

    await expect(
      provider.createDraft({ to: [{ email: 'bob@example.com' }], subject: 'Hi', body: { text: 'hello' } }),
    ).rejects.toMatchObject({ code: 'provider_unavailable' });
    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe('GmailProvider draft updates', () => {
  it('keeps a reply draft on its thread when the update omits replyToMessageId', async () => {
    const provider = new GmailProvider({
      accountId: 'acct_1',
      email: 'me@example.com',
      auth: new OAuth2Client(),
    });
    const update = vi.fn().mockResolvedValue({ data: { id: 'draft_1', message: { id: 'msg_2' } } });
    const internals = provider as unknown as {
      senderName: string | null;
      gmail: {
        users: {
          drafts: {
            get: ReturnType<typeof vi.fn>;
            update: typeof update;
            list: ReturnType<typeof vi.fn>;
          };
          messages: { get: ReturnType<typeof vi.fn> };
          labels: { list: ReturnType<typeof vi.fn> };
        };
      };
    };
    internals.senderName = null;
    internals.gmail = {
      users: {
        drafts: {
          get: vi.fn().mockResolvedValue({
            data: {
              id: 'draft_1',
              message: {
                id: 'msg_1',
                threadId: 'thread_9',
                payload: {
                  headers: [
                    { name: 'In-Reply-To', value: '<orig@mail.example.com>' },
                    { name: 'References', value: '<root@mail.example.com> <orig@mail.example.com>' },
                  ],
                },
              },
            },
          }),
          update,
          list: vi.fn().mockResolvedValue({
            data: { drafts: [{ id: 'draft_1', message: { id: 'msg_2' } }] },
          }),
        },
        messages: {
          get: vi.fn().mockResolvedValue({
            data: {
              id: 'msg_2',
              threadId: 'thread_9',
              labelIds: ['DRAFT'],
              internalDate: '1751976000000',
              payload: { headers: [{ name: 'Subject', value: 'Updated' }] },
            },
          }),
        },
        labels: { list: vi.fn().mockResolvedValue({ data: { labels: [] } }) },
      },
    };

    await provider.updateDraft('draft_1', {
      to: [{ email: 'ann@example.com' }],
      subject: 'Updated',
      body: { text: 'new body' },
    });

    expect(internals.gmail.users.drafts.get).toHaveBeenCalledWith({
      userId: 'me',
      id: 'draft_1',
      format: 'metadata',
    });
    const request = update.mock.calls[0]?.[0];
    expect(request.requestBody.message.threadId).toBe('thread_9');
    const raw = Buffer.from(request.requestBody.message.raw, 'base64url').toString();
    expect(raw).toContain('In-Reply-To: <orig@mail.example.com>');
    expect(raw).toContain('References: <root@mail.example.com> <orig@mail.example.com>');
  });
});

describe('GmailProvider external body data', () => {
  it('hydrates a text body returned through an attachment id', async () => {
    const provider = new GmailProvider({
      accountId: 'acct_1',
      email: 'me@example.com',
      auth: new OAuth2Client(),
    });
    const getAttachment = vi.fn().mockResolvedValue({
      data: { data: Buffer.from('large message body').toString('base64url') },
    });
    const internals = provider as unknown as {
      gmail: {
        users: {
          messages: {
            get: () => Promise<{ data: object }>;
            attachments: { get: typeof getAttachment };
          };
          labels: { list: () => Promise<{ data: { labels: never[] } }> };
        };
      };
    };
    internals.gmail = {
      users: {
        messages: {
          get: vi.fn().mockResolvedValue({
            data: {
              id: 'msg_1',
              threadId: 'thread_1',
              internalDate: '1751976000000',
              payload: {
                headers: [{ name: 'Subject', value: 'Large body' }],
                mimeType: 'text/plain',
                body: { attachmentId: 'body-attachment-1', size: 50_000 },
              },
            },
          }),
          attachments: { get: getAttachment },
        },
        labels: { list: vi.fn().mockResolvedValue({ data: { labels: [] } }) },
      },
    };

    await expect(provider.getMessage('msg_1')).resolves.toMatchObject({
      body: { text: 'large message body' },
    });
    expect(getAttachment).toHaveBeenCalledWith({
      userId: 'me',
      messageId: 'msg_1',
      id: 'body-attachment-1',
    });
  });
});

describe('GmailProvider attachment limits', () => {
  it('rejects oversized attachment metadata before downloading content', async () => {
    const provider = new GmailProvider({
      accountId: 'acct_1',
      email: 'me@example.com',
      auth: new OAuth2Client(),
    });
    const download = vi.fn();
    const internals = provider as unknown as {
      gmail: {
        users: {
          messages: {
            get: ReturnType<typeof vi.fn>;
            attachments: { get: typeof download };
          };
        };
      };
    };
    internals.gmail = {
      users: {
        messages: {
          get: vi.fn().mockResolvedValue({
            data: {
              payload: {
                parts: [
                  {
                    partId: '1',
                    filename: 'large.bin',
                    mimeType: 'application/octet-stream',
                    body: { attachmentId: 'a1', size: 11 },
                  },
                ],
              },
            },
          }),
          attachments: { get: download },
        },
      },
    };

    await expect(provider.getAttachment('m1', 'part:1', { maxBytes: 10 })).rejects.toMatchObject({
      code: 'invalid_request',
      data: { sizeBytes: 11, maxBytes: 10 },
    });
    expect(download).not.toHaveBeenCalled();
  });

  it('resolves a stable MIME part id to Gmail current opaque attachment id', async () => {
    const provider = new GmailProvider({
      accountId: 'acct_1',
      email: 'me@example.com',
      auth: new OAuth2Client(),
    });
    const download = vi.fn().mockResolvedValue({
      data: { data: Buffer.from('current attachment').toString('base64url') },
    });
    const internals = provider as unknown as {
      gmail: {
        users: {
          messages: {
            get: ReturnType<typeof vi.fn>;
            attachments: { get: typeof download };
          };
        };
      };
    };
    internals.gmail = {
      users: {
        messages: {
          get: vi.fn().mockResolvedValue({
            data: {
              payload: {
                parts: [
                  {
                    partId: '2',
                    filename: 'report.pdf',
                    mimeType: 'application/pdf',
                    body: { attachmentId: 'fresh-opaque-id', size: 18 },
                  },
                ],
              },
            },
          }),
          attachments: { get: download },
        },
      },
    };

    await expect(provider.getAttachment('m1', 'part:2')).resolves.toMatchObject({
      meta: { id: 'part:2', filename: 'report.pdf' },
      content: Buffer.from('current attachment'),
    });
    expect(download).toHaveBeenCalledWith({
      userId: 'me',
      messageId: 'm1',
      id: 'fresh-opaque-id',
    });
  });
});

describe('GmailProvider draft ids', () => {
  it('maps a draft message id to the id required by draft operations', async () => {
    const provider = new GmailProvider({
      accountId: 'acct_1',
      email: 'me@example.com',
      auth: new OAuth2Client(),
    });
    const internals = provider as unknown as {
      gmail: {
        users: {
          messages: { get: () => Promise<{ data: object }> };
          labels: { list: () => Promise<{ data: { labels: never[] } }> };
          drafts: { list: () => Promise<{ data: { drafts: object[] } }> };
        };
      };
    };
    internals.gmail = {
      users: {
        messages: {
          get: vi.fn().mockResolvedValue({
            data: {
              id: 'msg_1',
              threadId: 'thread_1',
              labelIds: ['DRAFT'],
              internalDate: '1751976000000',
              payload: { headers: [{ name: 'Subject', value: 'Saved draft' }] },
            },
          }),
        },
        labels: { list: vi.fn().mockResolvedValue({ data: { labels: [] } }) },
        drafts: {
          list: vi.fn().mockResolvedValue({
            data: { drafts: [{ id: 'draft_1', message: { id: 'msg_1', threadId: 'thread_1' } }] },
          }),
        },
      },
    };

    await expect(provider.getMessage('msg_1')).resolves.toMatchObject({
      id: 'msg_1',
      draftId: 'draft_1',
      flags: { draft: true },
    });
  });
});
