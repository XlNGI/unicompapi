import {
  parseConversationAgentRun,
  toIsoTimestamp,
  type ConversationAgentRunRepository,
  type ConversationAgentRunV1,
  type ConversationAgentRunId,
  type ConversationId,
  type ConversationResponseExecutionId,
  type ProjectId
} from '../../domain';
import { projectStoragePaths, type ProjectStorageAdapter } from '../storage';

interface ConversationAgentRunDocumentV1 {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly updatedAt: string;
  readonly runs: readonly ConversationAgentRunV1[];
}

export class ConversationAgentRunRevisionConflictError extends Error {
  constructor(
    readonly runId: ConversationAgentRunId,
    readonly expectedRevision: number | null,
    readonly actualRevision: number | null
  ) {
    super(`Conversation agent run revision conflict: expected ${String(expectedRevision)}, actual ${String(actualRevision)}`);
    this.name = 'ConversationAgentRunRevisionConflictError';
  }
}

export class JsonConversationAgentRunRepository implements ConversationAgentRunRepository {
  constructor(
    private readonly storage: ProjectStorageAdapter,
    readonly projectId: ProjectId,
    private readonly now: () => string = () => new Date().toISOString()
  ) {}

  async get(id: ConversationAgentRunId): Promise<ConversationAgentRunV1 | undefined> {
    return (await this.load()).runs.find(run => run.id === id);
  }

  async list(conversationId?: ConversationId): Promise<readonly ConversationAgentRunV1[]> {
    return (await this.load()).runs
      .filter(run => conversationId === undefined || run.conversationId === conversationId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id));
  }

  async findByResponseExecutionId(responseExecutionId: ConversationResponseExecutionId): Promise<ConversationAgentRunV1 | undefined> {
    return (await this.load()).runs.find(run => run.responseExecutionId === responseExecutionId);
  }

  async create(run: ConversationAgentRunV1): Promise<void> {
    const validated = this.requireProjectRun(run);
    if (validated.revision !== 0) throw new TypeError('A new conversation agent run must have revision 0');
    await this.storage.mutateJsonAtomically(projectStoragePaths.entities.conversationAgentRuns, current => {
      const document = this.parseOrEmpty(current);
      const existing = document.runs.find(item => item.id === validated.id);
      if (existing) throw new ConversationAgentRunRevisionConflictError(validated.id, null, existing.revision);
      return {
        schemaVersion: 1,
        revision: document.revision + 1,
        updatedAt: toIsoTimestamp(this.now()),
        runs: [...document.runs, validated]
      } satisfies ConversationAgentRunDocumentV1;
    }, { backup: true });
  }

  async save(run: ConversationAgentRunV1, expectedRevision: number): Promise<void> {
    const validated = this.requireProjectRun(run);
    if (validated.revision !== expectedRevision + 1) throw new TypeError('Saved conversation agent run revision must increment exactly once');
    await this.storage.mutateJsonAtomically(projectStoragePaths.entities.conversationAgentRuns, current => {
      const document = this.parseOrEmpty(current);
      const index = document.runs.findIndex(item => item.id === validated.id);
      const actualRevision = index < 0 ? null : document.runs[index].revision;
      if (actualRevision !== expectedRevision) throw new ConversationAgentRunRevisionConflictError(validated.id, expectedRevision, actualRevision);
      const runs = [...document.runs];
      runs[index] = validated;
      return {
        schemaVersion: 1,
        revision: document.revision + 1,
        updatedAt: toIsoTimestamp(this.now()),
        runs
      } satisfies ConversationAgentRunDocumentV1;
    }, { backup: true });
  }

  private async load(): Promise<ConversationAgentRunDocumentV1> {
    const loaded = await this.storage.readJsonWithBackup(
      projectStoragePaths.entities.conversationAgentRuns,
      value => this.parseOrEmpty(value)
    );
    return loaded?.value ?? this.empty();
  }

  private parseOrEmpty(value: unknown | undefined): ConversationAgentRunDocumentV1 {
    if (value === undefined) return this.empty();
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('Conversation agent run document is invalid');
    const item = value as Record<string, unknown>;
    if (item.schemaVersion !== 1 || !Number.isSafeInteger(item.revision) || Number(item.revision) < 0 || !Array.isArray(item.runs)) {
      throw new TypeError('Conversation agent run document is invalid');
    }
    const runs = item.runs.map(parseConversationAgentRun);
    if (new Set(runs.map(run => run.id)).size !== runs.length || runs.some(run => run.projectId !== this.projectId)) {
      throw new TypeError('Conversation agent run document contains invalid runs');
    }
    const updatedAt = toIsoTimestamp(String(item.updatedAt));
    if (runs.some(run => run.updatedAt > updatedAt)) throw new TypeError('Conversation agent run document timestamp is stale');
    return { schemaVersion: 1, revision: Number(item.revision), updatedAt, runs };
  }

  private requireProjectRun(run: ConversationAgentRunV1): ConversationAgentRunV1 {
    const validated = parseConversationAgentRun(run);
    if (validated.projectId !== this.projectId) throw new TypeError('Conversation agent run belongs to another project');
    return validated;
  }

  private empty(): ConversationAgentRunDocumentV1 {
    return { schemaVersion: 1, revision: 0, updatedAt: toIsoTimestamp(this.now()), runs: [] };
  }
}
