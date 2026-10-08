import {
  parseConversationResponseDraft,
  toIsoTimestamp,
  type ConversationId,
  type ConversationResponseDraftId,
  type ConversationResponseDraftRepository,
  type ConversationResponseDraftV1,
  type ProjectId
} from '../../domain';
import { JsonStorageDataError, projectStoragePaths, type ProjectStorageAdapter } from '../storage';

export interface ConversationResponseDraftDocumentV1 {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly updatedAt: string;
  readonly drafts: readonly ConversationResponseDraftV1[];
}

export class ConversationResponseDraftRevisionConflictError extends Error {
  constructor(
    readonly draftId: ConversationResponseDraftId,
    readonly expectedRevision: number | null,
    readonly actualRevision: number | null
  ) {
    super(
      `Conversation response draft revision conflict: expected ${String(expectedRevision)}, actual ${String(actualRevision)}`
    );
    this.name = 'ConversationResponseDraftRevisionConflictError';
  }
}

export class ConversationResponseDraftRepositoryDataError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'ConversationResponseDraftRepositoryDataError';
  }
}

export class JsonConversationResponseDraftRepository
  implements ConversationResponseDraftRepository {
  constructor(
    private readonly storage: ProjectStorageAdapter,
    readonly projectId: ProjectId,
    private readonly now: () => string = () => new Date().toISOString()
  ) {}

  async get(
    id: ConversationResponseDraftId
  ): Promise<ConversationResponseDraftV1 | undefined> {
    return (await this.loadDocument()).drafts.find((draft) => draft.id === id);
  }

  async list(
    conversationId?: ConversationId
  ): Promise<readonly ConversationResponseDraftV1[]> {
    const document = await this.loadDocument();
    return document.drafts
      .filter((draft) => conversationId === undefined || draft.conversationId === conversationId)
      .sort((left, right) =>
        right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id)
      );
  }

  async create(draft: ConversationResponseDraftV1): Promise<void> {
    const validated = this.requireProjectDraft(draft);
    if (validated.revision !== 0) {
      throw new ConversationResponseDraftRepositoryDataError(
        'A new conversation response draft must have revision 0'
      );
    }
    await withStoredDraftErrors(() => this.storage.mutateJsonAtomically(
      projectStoragePaths.entities.conversationResponseDrafts,
      (current) => {
        const document = this.parseOrEmpty(current);
        const existing = document.drafts.find((item) => item.id === validated.id);
        if (existing) {
          throw new ConversationResponseDraftRevisionConflictError(
            validated.id,
            null,
            existing.revision
          );
        }
        return {
          schemaVersion: 1,
          revision: document.revision + 1,
          updatedAt: toIsoTimestamp(this.now()),
          drafts: [...document.drafts, validated]
        } satisfies ConversationResponseDraftDocumentV1;
      },
      { backup: true }
    ));
  }

  async save(
    draft: ConversationResponseDraftV1,
    expectedRevision: number
  ): Promise<void> {
    const validated = this.requireProjectDraft(draft);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new TypeError('Expected response draft revision is invalid');
    }
    if (validated.revision !== expectedRevision + 1) {
      throw new ConversationResponseDraftRepositoryDataError(
        'Saved response draft revision must increment exactly once'
      );
    }
    await withStoredDraftErrors(() => this.storage.mutateJsonAtomically(
      projectStoragePaths.entities.conversationResponseDrafts,
      (current) => {
        const document = this.parseOrEmpty(current);
        const index = document.drafts.findIndex((item) => item.id === validated.id);
        const actualRevision = index < 0 ? null : document.drafts[index].revision;
        if (actualRevision !== expectedRevision) {
          throw new ConversationResponseDraftRevisionConflictError(
            validated.id,
            expectedRevision,
            actualRevision
          );
        }
        const drafts = [...document.drafts];
        drafts[index] = validated;
        return {
          schemaVersion: 1,
          revision: document.revision + 1,
          updatedAt: toIsoTimestamp(this.now()),
          drafts
        } satisfies ConversationResponseDraftDocumentV1;
      },
      { backup: true }
    ));
  }

  private async loadDocument(): Promise<ConversationResponseDraftDocumentV1> {
    const loaded = await withStoredDraftErrors(() => this.storage.readJsonWithBackup(
      projectStoragePaths.entities.conversationResponseDrafts,
      (value) => this.parseOrEmpty(value)
    ));
    return loaded?.value ?? this.emptyDocument();
  }

  private parseOrEmpty(
    value: unknown | undefined
  ): ConversationResponseDraftDocumentV1 {
    if (value === undefined) return this.emptyDocument();
    return parseConversationResponseDraftDocument(value, this.projectId);
  }

  private requireProjectDraft(
    draft: ConversationResponseDraftV1
  ): ConversationResponseDraftV1 {
    const validated = parseConversationResponseDraft(draft);
    if (validated.projectId !== this.projectId) {
      throw new ConversationResponseDraftRepositoryDataError(
        'Conversation response draft belongs to another project'
      );
    }
    return validated;
  }

  private emptyDocument(): ConversationResponseDraftDocumentV1 {
    return {
      schemaVersion: 1,
      revision: 0,
      updatedAt: toIsoTimestamp(this.now()),
      drafts: []
    };
  }
}

export function parseConversationResponseDraftDocument(
  value: unknown,
  projectId?: ProjectId
): ConversationResponseDraftDocumentV1 {
  try {
    return parseStoredDocument(value, projectId);
  } catch (error) {
    if (error instanceof ConversationResponseDraftRepositoryDataError) throw error;
    throw new ConversationResponseDraftRepositoryDataError('Stored conversation response drafts are invalid', error);
  }
}

async function withStoredDraftErrors<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof JsonStorageDataError) {
      throw new ConversationResponseDraftRepositoryDataError('Stored conversation response drafts could not be decoded', error);
    }
    throw error;
  }
}

function parseStoredDraft(value: unknown): ConversationResponseDraftV1 {
  if (typeof value === 'object' && value !== null && !Array.isArray(value) &&
      Object.prototype.hasOwnProperty.call(value, 'promptMode')) {
    const { promptMode, ...current } = value as Record<string, unknown>;
    if (current.schemaVersion !== 1 || (promptMode !== 'conversation' && promptMode !== 'document_revision')) {
      throw new ConversationResponseDraftRepositoryDataError('Stored conversation response draft mode is unsupported');
    }
    // These obsolete routing labels are not permissions. Validate every remaining
    // field using the current domain contract; new domain inputs stay strict.
    return parseConversationResponseDraft(current);
  }
  return parseConversationResponseDraft(value);
}

function parseStoredDocument(value: unknown, projectId?: ProjectId): ConversationResponseDraftDocumentV1 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ConversationResponseDraftRepositoryDataError(
      'Conversation response draft document must be an object'
    );
  }
  const item = value as Record<string, unknown>;
  const keys = new Set(['schemaVersion', 'revision', 'updatedAt', 'drafts']);
  if (
    Object.keys(item).length !== keys.size ||
    Object.keys(item).some((key) => !keys.has(key)) ||
    item.schemaVersion !== 1 ||
    !Number.isSafeInteger(item.revision) ||
    Number(item.revision) < 0 ||
    !Array.isArray(item.drafts)
  ) {
    throw new ConversationResponseDraftRepositoryDataError(
      'Conversation response draft document metadata is invalid'
    );
  }
  const ids = new Set<string>();
  const drafts = item.drafts.map((draft) => {
    const parsed = parseStoredDraft(draft);
    if (projectId !== undefined && parsed.projectId !== projectId) {
      throw new ConversationResponseDraftRepositoryDataError(
        'Conversation response draft document contains another project'
      );
    }
    if (ids.has(parsed.id)) {
      throw new ConversationResponseDraftRepositoryDataError(
        'Conversation response draft document contains duplicate IDs'
      );
    }
    ids.add(parsed.id);
    return parsed;
  });
  const updatedAt = toIsoTimestamp(String(item.updatedAt));
  if (drafts.some((draft) => draft.updatedAt > updatedAt)) {
    throw new ConversationResponseDraftRepositoryDataError(
      'Conversation response draft document timestamp is stale'
    );
  }
  return {
    schemaVersion: 1,
    revision: Number(item.revision),
    updatedAt,
    drafts
  };
}
