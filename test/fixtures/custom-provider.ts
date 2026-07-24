import {
  EmailError,
  type Capabilities,
  type DraftInput,
  type EmailProvider,
  type EmailQuery,
  type Folder,
  type GetAttachmentOpts,
  type GetMessageOpts,
  type Label,
  type Message,
  type ModifyAction,
  type Page,
  type PageOpts,
  type SendResult,
  type Thread,
} from '@fluxmail/core';

const capabilities = {
  labels: false,
  serverThreads: false,
  serverSearch: 'basic',
  search: {
    filters: ['folder', 'text', 'read', 'starred', 'hasAttachment'],
    folderRoles: {
      inbox: 'available',
      sent: 'unknown',
      drafts: 'unknown',
      archive: 'unavailable',
      spam: 'unknown',
      trash: 'unknown',
      all: 'available',
    },
    nativeQuery: null,
  },
  snippets: false,
} satisfies Capabilities;

class CustomProvider implements EmailProvider {
  readonly capabilities = capabilities;

  async testConnection(): Promise<void> {}

  async listMessages(query: EmailQuery, _page?: PageOpts): Promise<Page<Message>> {
    // A listed boolean filter handles both values. The fixture deliberately
    // reads false as a meaningful filter value instead of treating it as absent.
    if (query.read !== undefined || query.starred !== undefined || query.hasAttachment !== undefined) {
      return { items: [] };
    }
    return { items: [] };
  }

  async getMessage(_id: string, _opts?: GetMessageOpts): Promise<Message> {
    throw new EmailError('not_found', 'Fixture message not found.');
  }

  async getThread(_threadId: string): Promise<Thread> {
    throw new EmailError('not_found', 'Fixture thread not found.');
  }

  async listFolders(): Promise<Folder[]> {
    return [];
  }

  async listLabels(): Promise<Label[]> {
    return [];
  }

  async createDraft(_draft: DraftInput): Promise<Message> {
    throw new EmailError('unsupported_capability', 'Fixture drafts are unavailable.');
  }

  async getDraft(_draftId: string): Promise<Message> {
    throw new EmailError('unsupported_capability', 'Fixture drafts are unavailable.');
  }

  async updateDraft(_draftId: string, _draft: DraftInput): Promise<Message> {
    throw new EmailError('unsupported_capability', 'Fixture drafts are unavailable.');
  }

  async deleteDraft(_draftId: string): Promise<void> {
    throw new EmailError('unsupported_capability', 'Fixture drafts are unavailable.');
  }

  async send(_input: DraftInput | { draftId: string }): Promise<SendResult> {
    throw new EmailError('unsupported_capability', 'Fixture sending is unavailable.');
  }

  async modify(_ids: string[], _action: ModifyAction): Promise<void> {
    throw new EmailError('unsupported_capability', 'Fixture modification is unavailable.');
  }

  async getAttachment(_messageId: string, _attachmentId: string, _opts?: GetAttachmentOpts): Promise<never> {
    throw new EmailError('unsupported_capability', 'Fixture attachments are unavailable.');
  }
}

export const customProvider: EmailProvider = new CustomProvider();
