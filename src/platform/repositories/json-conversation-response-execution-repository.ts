import {
  parseConversationResponseExecution,
  parseConversationResponseStreamEvent,
  projectConversationResponseExecution,
  projectConversationResponseExecutionState,
  type ConversationId,
  type ConversationResponseExecutionId,
  type ConversationResponseExecutionRepository,
  type ConversationResponseExecutionV1,
  type ConversationResponseStreamEventId,
  type ConversationResponseStreamEventV1,
  type ProjectId
} from '../../domain';
import { projectStoragePaths, type ProjectStorageAdapter } from '../storage';

interface ConversationResponseExecutionDocumentV1 {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly executions: readonly ConversationResponseExecutionV1[];
  readonly events: readonly ConversationResponseStreamEventV1[];
}

export class ConversationResponseExecutionRepositoryDataError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'ConversationResponseExecutionRepositoryDataError';
  }
}

export class JsonConversationResponseExecutionRepository
  implements ConversationResponseExecutionRepository {
  constructor(
    private readonly storage: ProjectStorageAdapter,
    readonly projectId: ProjectId
  ) {}

  async get(
    id: ConversationResponseExecutionId
  ): Promise<ConversationResponseExecutionV1 | undefined> {
    return (await this.read()).executions.find((execution) => execution.id === id);
  }

  async list(
    conversationId?: ConversationId
  ): Promise<readonly ConversationResponseExecutionV1[]> {
    return (await this.read()).executions
      .filter((execution) =>
        conversationId === undefined || execution.snapshot.conversationId === conversationId
      )
      .sort((left, right) =>
        right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id)
      );
  }

  async listEvents(
    executionId: ConversationResponseExecutionId
  ): Promise<readonly ConversationResponseStreamEventV1[]> {
    return (await this.read()).events
      .filter((event) => event.responseExecutionId === executionId)
      .sort((left, right) => left.sequence - right.sequence);
  }

  async getEvent(
    id: ConversationResponseStreamEventId
  ): Promise<ConversationResponseStreamEventV1 | undefined> {
    return (await this.read()).events.find((event) => event.id === id);
  }

  async create(
    execution: ConversationResponseExecutionV1,
    initialEvent: ConversationResponseStreamEventV1
  ): Promise<void> {
    const validatedExecution = this.requireProjectExecution(execution);
    const validatedEvent = parseConversationResponseStreamEvent(initialEvent);
    if (
      validatedExecution.state !== 'pending' ||
      validatedEvent.responseExecutionId !== validatedExecution.id ||
      validatedEvent.sequence !== 1 ||
      validatedEvent.type !== 'execution_created' ||
      projectConversationResponseExecutionState(validatedExecution, [validatedEvent]) !== 'pending'
    ) {
      throw new ConversationResponseExecutionRepositoryDataError(
        'Conversation response execution must start with execution_created'
      );
    }
    await this.storage.mutateJsonAtomically(
      projectStoragePaths.entities.conversationResponseExecutions,
      (current) => {
        const document = parseConversationResponseExecutionDocument(current, this.projectId);
        const existing = document.executions.find(
          (item) => item.id === validatedExecution.id
        );
        if (existing) {
          if (
            sameJson(existing, validatedExecution) &&
            document.events.some((event) => sameJson(event, validatedEvent))
          ) {
            return document;
          }
          throw new ConversationResponseExecutionRepositoryDataError(
            'Conversation response execution identity already exists with different content'
          );
        }
        if (
          document.events.some((event) => event.id === validatedEvent.id) ||
          document.executions.some((item) =>
            item.providerInvocationAttemptId === validatedExecution.providerInvocationAttemptId ||
            item.snapshot.assistantMessageId === validatedExecution.snapshot.assistantMessageId
          )
        ) {
          throw new ConversationResponseExecutionRepositoryDataError(
            'Conversation response execution contains a reused identity'
          );
        }
        assertRetry(document.executions, validatedExecution);
        return {
          schemaVersion: 1,
          revision: document.revision + 1,
          executions: [...document.executions, validatedExecution],
          events: [...document.events, validatedEvent]
        } satisfies ConversationResponseExecutionDocumentV1;
      },
      { backup: true }
    );
  }

  async appendEvent(event: ConversationResponseStreamEventV1): Promise<void> {
    const validatedEvent = parseConversationResponseStreamEvent(event);
    await this.storage.mutateJsonAtomically(
      projectStoragePaths.entities.conversationResponseExecutions,
      (current) => {
        const document = parseConversationResponseExecutionDocument(current, this.projectId);
        const executionIndex = document.executions.findIndex(
          (execution) => execution.id === validatedEvent.responseExecutionId
        );
        if (executionIndex < 0) {
          throw new ConversationResponseExecutionRepositoryDataError(
            'Conversation response event references an unknown execution'
          );
        }
        const duplicateId = document.events.find((item) => item.id === validatedEvent.id);
        if (duplicateId) {
          if (sameJson(duplicateId, validatedEvent)) return document;
          throw new ConversationResponseExecutionRepositoryDataError(
            'Conversation response event ID conflict'
          );
        }
        const executionEvents = document.events
          .filter((item) => item.responseExecutionId === validatedEvent.responseExecutionId)
          .sort((left, right) => left.sequence - right.sequence);
        const duplicateSequence = executionEvents.find(
          (item) => item.sequence === validatedEvent.sequence
        );
        if (duplicateSequence) {
          if (sameJson(duplicateSequence, validatedEvent)) return document;
          throw new ConversationResponseExecutionRepositoryDataError(
            'Conversation response event sequence conflict'
          );
        }
        if (validatedEvent.sequence !== executionEvents.length + 1) {
          throw new ConversationResponseExecutionRepositoryDataError(
            'Conversation response event sequence must be contiguous'
          );
        }
        const currentExecution = document.executions[executionIndex];
        const state = projectConversationResponseExecutionState(
          currentExecution,
          [...executionEvents, validatedEvent]
        );
        const executions = [...document.executions];
        executions[executionIndex] = { ...currentExecution, state };
        return {
          schemaVersion: 1,
          revision: document.revision + 1,
          executions,
          events: [...document.events, validatedEvent]
        } satisfies ConversationResponseExecutionDocumentV1;
      },
      { backup: true }
    );
  }

  private async read(): Promise<ConversationResponseExecutionDocumentV1> {
    const loaded = await this.storage.readJsonWithBackup(
      projectStoragePaths.entities.conversationResponseExecutions,
      (value) => parseConversationResponseExecutionDocument(value, this.projectId)
    );
    return loaded?.value ?? emptyDocument();
  }

  private requireProjectExecution(
    execution: ConversationResponseExecutionV1
  ): ConversationResponseExecutionV1 {
    const validated = parseConversationResponseExecution(execution);
    if (validated.projectId !== this.projectId) {
      throw new ConversationResponseExecutionRepositoryDataError(
        'Conversation response execution belongs to another project'
      );
    }
    return validated;
  }
}

export function parseConversationResponseExecutionDocument(
  value: unknown | undefined,
  projectId?: ProjectId
): ConversationResponseExecutionDocumentV1 {
  if (value === undefined) return emptyDocument();
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalidDocument();
  }
  const item = value as Record<string, unknown>;
  const keys = new Set(['schemaVersion', 'revision', 'executions', 'events']);
  if (
    Object.keys(item).length !== keys.size ||
    Object.keys(item).some((key) => !keys.has(key)) ||
    item.schemaVersion !== 1 ||
    !Number.isSafeInteger(item.revision) ||
    Number(item.revision) < 0 ||
    !Array.isArray(item.executions) ||
    !Array.isArray(item.events)
  ) {
    throw invalidDocument();
  }
  const executions = item.executions.map(parseConversationResponseExecution);
  const events = item.events.map(parseConversationResponseStreamEvent);
  if (
    new Set(executions.map((execution) => execution.id)).size !== executions.length ||
    new Set(executions.map((execution) => execution.providerInvocationAttemptId)).size !==
      executions.length ||
    new Set(executions.map((execution) => execution.snapshot.assistantMessageId)).size !==
      executions.length ||
    new Set(events.map((event) => event.id)).size !== events.length ||
    (projectId !== undefined && executions.some((execution) => execution.projectId !== projectId))
  ) {
    throw invalidDocument();
  }
  for (const execution of executions) {
    const timeline = events
      .filter((event) => event.responseExecutionId === execution.id)
      .sort((left, right) => left.sequence - right.sequence);
    projectConversationResponseExecution({ execution, events: timeline });
    assertRetry(executions, execution);
  }
  if (
    events.some((event) =>
      !executions.some((execution) => execution.id === event.responseExecutionId)
    )
  ) {
    throw invalidDocument();
  }
  return {
    schemaVersion: 1,
    revision: Number(item.revision),
    executions,
    events
  };
}

function assertRetry(
  executions: readonly ConversationResponseExecutionV1[],
  execution: ConversationResponseExecutionV1
): void {
  if (!execution.retryOfExecutionId) return;
  const previous = executions.find((item) => item.id === execution.retryOfExecutionId);
  if (
    !previous ||
    !['failed', 'cancelled', 'interrupted'].includes(previous.state) ||
    previous.projectId !== execution.projectId ||
    previous.snapshot.conversationId !== execution.snapshot.conversationId ||
    previous.snapshot.userMessageId !== execution.snapshot.userMessageId ||
    previous.snapshot.productFeature !== execution.snapshot.productFeature
  ) {
    throw new ConversationResponseExecutionRepositoryDataError(
      'Conversation response retry must reference a retryable execution for the same subject'
    );
  }
}

function emptyDocument(): ConversationResponseExecutionDocumentV1 {
  return { schemaVersion: 1, revision: 0, executions: [], events: [] };
}

function invalidDocument(): ConversationResponseExecutionRepositoryDataError {
  return new ConversationResponseExecutionRepositoryDataError(
    'Conversation response execution document is invalid'
  );
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
