import {
  assertConversationBelongsToProject,
  parseConversation,
  toIsoTimestamp,
  type Conversation,
  type ConversationId,
  type ConversationListOptions,
  type ConversationStatus,
  type ProjectConversationRepository,
  type ProjectId
} from '../../domain';
import { projectStoragePaths, type ProjectStorageAdapter } from '../storage';
import {
  ConversationRepositoryDataError,
  ConversationRevisionConflictError,
  parseConversationDocument,
  type ConversationDocumentV1
} from './json-conversation-repository';

export class JsonProjectConversationRepository
  implements ProjectConversationRepository {
  constructor(
    private readonly storage: ProjectStorageAdapter,
    readonly projectId: ProjectId,
    private readonly now: () => string = () => new Date().toISOString()
  ) {}

  async get(id: ConversationId): Promise<Conversation | undefined> {
    const document = await this.loadDocument();
    return document.conversations.find((conversation) => conversation.id === id);
  }

  async list(options: ConversationListOptions = {}): Promise<readonly Conversation[]> {
    if (options.projectId !== undefined && options.projectId !== this.projectId) {
      throw new ConversationRepositoryDataError(
        'Project conversation repository cannot read another project'
      );
    }
    const statuses = normalizeStatuses(options.statuses);
    const document = await this.loadDocument();
    return document.conversations
      .filter((conversation) => statuses.has(conversation.status))
      .sort((left, right) =>
        right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id)
      );
  }

  async create(conversation: Conversation): Promise<void> {
    const validated = parseConversation(conversation);
    assertConversationBelongsToProject(validated, this.projectId);
    if (validated.revision !== 0) {
      throw new ConversationRepositoryDataError(
        'A newly created project conversation must have revision 0'
      );
    }
    await this.storage.mutateJsonAtomically(
      projectStoragePaths.entities.conversations,
      (current) => {
        const document = this.parseOrEmpty(current);
        const existing = document.conversations.find((item) => item.id === validated.id);
        if (existing) {
          throw new ConversationRevisionConflictError(
            validated.id,
            null,
            existing.revision
          );
        }
        return {
          schemaVersion: 1,
          revision: document.revision + 1,
          updatedAt: toIsoTimestamp(this.now()),
          conversations: [...document.conversations, validated]
        } satisfies ConversationDocumentV1;
      },
      { backup: true }
    );
  }

  async save(conversation: Conversation, expectedRevision: number): Promise<void> {
    const validated = parseConversation(conversation);
    assertConversationBelongsToProject(validated, this.projectId);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new TypeError('Expected conversation revision is invalid');
    }
    if (validated.revision !== expectedRevision + 1) {
      throw new ConversationRepositoryDataError(
        'Saved project conversation revision must increment exactly once'
      );
    }
    await this.storage.mutateJsonAtomically(
      projectStoragePaths.entities.conversations,
      (current) => {
        const document = this.parseOrEmpty(current);
        const index = document.conversations.findIndex(
          (item) => item.id === validated.id
        );
        const actualRevision = index < 0 ? null : document.conversations[index].revision;
        if (actualRevision !== expectedRevision) {
          throw new ConversationRevisionConflictError(
            validated.id,
            expectedRevision,
            actualRevision
          );
        }
        const conversations = [...document.conversations];
        conversations[index] = validated;
        return {
          schemaVersion: 1,
          revision: document.revision + 1,
          updatedAt: toIsoTimestamp(this.now()),
          conversations
        } satisfies ConversationDocumentV1;
      },
      { backup: true }
    );
  }

  private async loadDocument(): Promise<ConversationDocumentV1> {
    const loaded = await this.storage.readJsonWithBackup(
      projectStoragePaths.entities.conversations,
      (value) => this.parseOrEmpty(value)
    );
    return loaded?.value ?? this.emptyDocument();
  }

  private parseOrEmpty(value: unknown | undefined): ConversationDocumentV1 {
    const document = value === undefined
      ? this.emptyDocument()
      : parseConversationDocument(value);
    for (const conversation of document.conversations) {
      try {
        assertConversationBelongsToProject(conversation, this.projectId);
      } catch (error) {
        throw new ConversationRepositoryDataError(
          'Project conversation document contains a legacy or cross-project conversation',
          error
        );
      }
    }
    return document;
  }

  private emptyDocument(): ConversationDocumentV1 {
    return {
      schemaVersion: 1,
      revision: 0,
      updatedAt: toIsoTimestamp(this.now()),
      conversations: []
    };
  }
}

function normalizeStatuses(
  statuses: readonly ConversationStatus[] | undefined
): ReadonlySet<ConversationStatus> {
  const result = new Set<ConversationStatus>();
  for (const status of statuses ?? ['active']) {
    if (!['active', 'archived', 'deleted'].includes(status)) {
      throw new TypeError(`Conversation status ${status} is invalid`);
    }
    result.add(status);
  }
  return result;
}
