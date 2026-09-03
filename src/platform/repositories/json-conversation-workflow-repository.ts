import {
  parseConversationWorkflow,
  toIsoTimestamp,
  updateConversationWorkflow,
  type ConversationId,
  type ConversationWorkflowId,
  type ConversationWorkflowRepository,
  type ConversationWorkflowV1,
  type ProjectId
} from '../../domain';
import {
  projectStoragePaths,
  type ProjectStorageAdapter
} from '../storage';

export interface ConversationWorkflowDocumentV1 {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly updatedAt: string;
  readonly workflows: readonly ConversationWorkflowV1[];
}

export class ConversationWorkflowRevisionConflictError extends Error {
  constructor(
    readonly workflowId: ConversationWorkflowId,
    readonly expectedRevision: number | null,
    readonly actualRevision: number | null
  ) {
    super(
      `Conversation workflow revision conflict: expected ${String(expectedRevision)}, actual ${String(actualRevision)}`
    );
    this.name = 'ConversationWorkflowRevisionConflictError';
  }
}

export class ConversationWorkflowRepositoryDataError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'ConversationWorkflowRepositoryDataError';
  }
}

export class JsonConversationWorkflowRepository
  implements ConversationWorkflowRepository {
  constructor(
    private readonly storage: ProjectStorageAdapter,
    readonly projectId: ProjectId,
    private readonly now: () => string = () => new Date().toISOString()
  ) {}

  async get(id: ConversationWorkflowId): Promise<ConversationWorkflowV1 | undefined> {
    return (await this.loadDocument()).workflows.find((workflow) => workflow.id === id);
  }

  async list(conversationId?: ConversationId): Promise<readonly ConversationWorkflowV1[]> {
    return (await this.loadDocument()).workflows
      .filter((workflow) => conversationId === undefined || workflow.conversationId === conversationId)
      .sort((left, right) =>
        right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id)
      );
  }

  async create(workflow: ConversationWorkflowV1): Promise<void> {
    await this.createInternal(workflow, false);
  }

  async createSupersedingPending(workflow: ConversationWorkflowV1): Promise<void> {
    await this.createInternal(workflow, true);
  }

  private async createInternal(
    workflow: ConversationWorkflowV1,
    supersedePending: boolean
  ): Promise<void> {
    const validated = this.requireProjectWorkflow(workflow);
    if (validated.revision !== 0) {
      throw new ConversationWorkflowRepositoryDataError(
        'A new conversation workflow must have revision 0'
      );
    }
    await this.storage.mutateJsonAtomically(
      projectStoragePaths.entities.conversationWorkflows,
      (current) => {
        const document = this.parseOrEmpty(current);
        if (document.workflows.some((item) => item.id === validated.id)) {
          const existing = document.workflows.find((item) => item.id === validated.id)!;
          throw new ConversationWorkflowRevisionConflictError(
            validated.id,
            null,
            existing.revision
          );
        }
        const operationTimestamp = [
          toIsoTimestamp(this.now()),
          validated.updatedAt,
          ...document.workflows.map((item) => item.updatedAt)
        ].sort().at(-1)!;
        const workflows = supersedePending
          ? document.workflows.map((item) =>
              item.conversationId === validated.conversationId &&
              ['needs_clarification', 'needs_confirmation', 'ready'].includes(item.status)
                ? updateConversationWorkflow(item, {
                    status: 'cancelled',
                    updatedAt: operationTimestamp
                  })
                : item
            )
          : document.workflows;
        return {
          schemaVersion: 1,
          revision: document.revision + 1,
          updatedAt: operationTimestamp,
          workflows: [...workflows, validated]
        } satisfies ConversationWorkflowDocumentV1;
      },
      { backup: true }
    );
  }

  async save(
    workflow: ConversationWorkflowV1,
    expectedRevision: number
  ): Promise<void> {
    const validated = this.requireProjectWorkflow(workflow);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new TypeError('Expected conversation workflow revision is invalid');
    }
    if (validated.revision !== expectedRevision + 1) {
      throw new ConversationWorkflowRepositoryDataError(
        'Saved conversation workflow revision must increment exactly once'
      );
    }
    await this.storage.mutateJsonAtomically(
      projectStoragePaths.entities.conversationWorkflows,
      (current) => {
        const document = this.parseOrEmpty(current);
        const index = document.workflows.findIndex((item) => item.id === validated.id);
        const actualRevision = index < 0 ? null : document.workflows[index].revision;
        if (actualRevision !== expectedRevision) {
          throw new ConversationWorkflowRevisionConflictError(
            validated.id,
            expectedRevision,
            actualRevision
          );
        }
        const workflows = [...document.workflows];
        workflows[index] = validated;
        return {
          schemaVersion: 1,
          revision: document.revision + 1,
          updatedAt: toIsoTimestamp(this.now()),
          workflows
        } satisfies ConversationWorkflowDocumentV1;
      },
      { backup: true }
    );
  }

  private async loadDocument(): Promise<ConversationWorkflowDocumentV1> {
    const loaded = await this.storage.readJsonWithBackup(
      projectStoragePaths.entities.conversationWorkflows,
      (value) => this.parseOrEmpty(value)
    );
    return loaded?.value ?? this.emptyDocument();
  }

  private parseOrEmpty(value: unknown | undefined): ConversationWorkflowDocumentV1 {
    if (value === undefined) return this.emptyDocument();
    return parseConversationWorkflowDocument(value, this.projectId);
  }

  private requireProjectWorkflow(workflow: ConversationWorkflowV1): ConversationWorkflowV1 {
    const validated = parseConversationWorkflow(workflow);
    if (validated.projectId !== this.projectId) {
      throw new ConversationWorkflowRepositoryDataError(
        'Conversation workflow belongs to another project'
      );
    }
    return validated;
  }

  private emptyDocument(): ConversationWorkflowDocumentV1 {
    return {
      schemaVersion: 1,
      revision: 0,
      updatedAt: toIsoTimestamp(this.now()),
      workflows: []
    };
  }
}

export function parseConversationWorkflowDocument(
  value: unknown,
  projectId?: ProjectId
): ConversationWorkflowDocumentV1 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ConversationWorkflowRepositoryDataError(
      'Conversation workflow document must be an object'
    );
  }
  const item = value as Record<string, unknown>;
  const keys = new Set(['schemaVersion', 'revision', 'updatedAt', 'workflows']);
  if (
    Object.keys(item).length !== keys.size ||
    Object.keys(item).some((key) => !keys.has(key)) ||
    item.schemaVersion !== 1 ||
    !Number.isSafeInteger(item.revision) ||
    Number(item.revision) < 0 ||
    !Array.isArray(item.workflows)
  ) {
    throw new ConversationWorkflowRepositoryDataError(
      'Conversation workflow document metadata is invalid'
    );
  }
  const ids = new Set<string>();
  const workflows = item.workflows.map((value) => {
    const workflow = parseConversationWorkflow(value);
    if (projectId !== undefined && workflow.projectId !== projectId) {
      throw new ConversationWorkflowRepositoryDataError(
        'Conversation workflow document contains another project'
      );
    }
    if (ids.has(workflow.id)) {
      throw new ConversationWorkflowRepositoryDataError(
        'Conversation workflow document contains duplicate IDs'
      );
    }
    ids.add(workflow.id);
    return workflow;
  });
  const updatedAt = toIsoTimestamp(String(item.updatedAt));
  if (workflows.some((workflow) => workflow.updatedAt > updatedAt)) {
    throw new ConversationWorkflowRepositoryDataError(
      'Conversation workflow document timestamp is stale'
    );
  }
  return {
    schemaVersion: 1,
    revision: Number(item.revision),
    updatedAt,
    workflows
  };
}
