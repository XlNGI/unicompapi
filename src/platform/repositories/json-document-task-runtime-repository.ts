import {
  assertDocumentTaskRuntimeUpdate,
  parseDocumentTaskRuntime,
  type ConversationId,
  type DocumentTaskRuntime,
  type DocumentTaskRuntimeId,
  type DocumentTaskRuntimeRepository,
  type ProjectId
} from '../../domain';
import { projectStoragePaths, type ProjectStorageAdapter } from '../storage';

export interface DocumentTaskRuntimeDocumentV1 {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly updatedAt: string;
  readonly runtimes: readonly DocumentTaskRuntime[];
}

export class DocumentTaskRuntimeRevisionConflictError extends Error {
  constructor(
    readonly runtimeId: DocumentTaskRuntimeId,
    readonly expectedRevision: number | null,
    readonly actualRevision: number | null
  ) {
    super(`Document task runtime revision conflict: expected ${String(expectedRevision)}, actual ${String(actualRevision)}`);
    this.name = 'DocumentTaskRuntimeRevisionConflictError';
  }
}

export class DocumentTaskRuntimeRepositoryDataError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'DocumentTaskRuntimeRepositoryDataError';
  }
}

export class JsonDocumentTaskRuntimeRepository implements DocumentTaskRuntimeRepository {
  constructor(
    private readonly storage: ProjectStorageAdapter,
    readonly projectId: ProjectId,
    private readonly now: () => string = () => new Date().toISOString()
  ) {}

  async get(id: DocumentTaskRuntimeId): Promise<DocumentTaskRuntime | undefined> {
    return (await this.read()).runtimes.find((runtime) => runtime.id === id);
  }

  async list(conversationId?: ConversationId): Promise<readonly DocumentTaskRuntime[]> {
    return (await this.read()).runtimes
      .filter((runtime) => conversationId === undefined || runtime.conversationId === conversationId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id));
  }

  async create(runtime: DocumentTaskRuntime): Promise<void> {
    const validated = this.requireProjectRuntime(runtime);
    if (validated.revision !== 0 || validated.status !== 'planning' || validated.toolCalls.length !== 0 ||
        validated.checkpoint.stage !== 'planning') throw new DocumentTaskRuntimeRepositoryDataError('A new runtime must be an empty planning checkpoint');
    await this.storage.mutateJsonAtomically(
      projectStoragePaths.entities.documentTaskRuntimes,
      (current) => {
        const document = parseOrEmpty(current, this.projectId, this.now);
        if (document.runtimes.some((item) => item.id === validated.id)) {
          const existing = document.runtimes.find((item) => item.id === validated.id)!;
          throw new DocumentTaskRuntimeRevisionConflictError(validated.id, null, existing.revision);
        }
        return {
          schemaVersion: 1,
          revision: document.revision + 1,
          updatedAt: maxTimestamp(this.now(), validated.updatedAt, ...document.runtimes.map((item) => item.updatedAt)),
          runtimes: [...document.runtimes, validated]
        } satisfies DocumentTaskRuntimeDocumentV1;
      },
      { backup: true }
    );
  }

  async save(runtime: DocumentTaskRuntime, expectedRevision: number): Promise<void> {
    const validated = this.requireProjectRuntime(runtime);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new TypeError('Expected document task runtime revision is invalid');
    if (validated.revision !== expectedRevision + 1) throw new DocumentTaskRuntimeRepositoryDataError('Saved document task runtime revision must increment exactly once');
    await this.storage.mutateJsonAtomically(
      projectStoragePaths.entities.documentTaskRuntimes,
      (current) => {
        const document = parseOrEmpty(current, this.projectId, this.now);
        const index = document.runtimes.findIndex((item) => item.id === validated.id);
        const actualRevision = index < 0 ? null : document.runtimes[index].revision;
        if (actualRevision !== expectedRevision) throw new DocumentTaskRuntimeRevisionConflictError(validated.id, expectedRevision, actualRevision);
        assertDocumentTaskRuntimeUpdate(document.runtimes[index], validated);
        const runtimes = [...document.runtimes];
        runtimes[index] = validated;
        return {
          schemaVersion: 1,
          revision: document.revision + 1,
          updatedAt: maxTimestamp(this.now(), validated.updatedAt, ...runtimes.map((item) => item.updatedAt)),
          runtimes
        } satisfies DocumentTaskRuntimeDocumentV1;
      },
      { backup: true }
    );
  }

  private async read(): Promise<DocumentTaskRuntimeDocumentV1> {
    const loaded = await this.storage.readJsonWithBackup(
      projectStoragePaths.entities.documentTaskRuntimes,
      (value) => parseOrEmpty(value, this.projectId, this.now)
    );
    // A backup may predate a side effect. Never authorize execution from it.
    if (loaded?.source === 'backup') throw new DocumentTaskRuntimeRepositoryDataError('Runtime backup requires explicit reconciliation');
    return loaded?.value ?? emptyDocument(this.now);
  }

  private requireProjectRuntime(runtime: DocumentTaskRuntime): DocumentTaskRuntime {
    const validated = parseDocumentTaskRuntime(runtime);
    if (validated.projectId !== this.projectId) throw new DocumentTaskRuntimeRepositoryDataError('Document task runtime belongs to another project');
    return validated;
  }
}

export function parseDocumentTaskRuntimeDocument(
  value: unknown,
  projectId?: ProjectId,
  now: () => string = () => new Date().toISOString()
): DocumentTaskRuntimeDocumentV1 {
  return parseOrEmpty(value, projectId, now);
}

function parseOrEmpty(value: unknown | undefined, projectId: ProjectId | undefined, now: () => string): DocumentTaskRuntimeDocumentV1 {
  if (value === undefined) return emptyDocument(now);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new DocumentTaskRuntimeRepositoryDataError('Document task runtime document must be an object');
  const item = value as Record<string, unknown>;
  const keys = new Set(['schemaVersion', 'revision', 'updatedAt', 'runtimes']);
  if (Object.keys(item).length !== keys.size || Object.keys(item).some((key) => !keys.has(key)) || item.schemaVersion !== 1 || !Number.isSafeInteger(item.revision) || Number(item.revision) < 0 || !Array.isArray(item.runtimes)) {
    throw new DocumentTaskRuntimeRepositoryDataError('Document task runtime document metadata is invalid');
  }
  const ids = new Set<string>();
  const runtimes = item.runtimes.map((raw) => {
    const runtime = parseDocumentTaskRuntime(raw);
    if (projectId !== undefined && runtime.projectId !== projectId) throw new DocumentTaskRuntimeRepositoryDataError('Document task runtime document contains another project');
    if (ids.has(runtime.id)) throw new DocumentTaskRuntimeRepositoryDataError('Document task runtime document contains duplicate IDs');
    ids.add(runtime.id);
    return runtime;
  });
  const updatedAt = toCanonicalTimestamp(item.updatedAt);
  if (runtimes.some((runtime) => runtime.updatedAt > updatedAt)) throw new DocumentTaskRuntimeRepositoryDataError('Document task runtime document timestamp is stale');
  return { schemaVersion: 1, revision: Number(item.revision), updatedAt, runtimes };
}

function emptyDocument(now: () => string): DocumentTaskRuntimeDocumentV1 {
  return { schemaVersion: 1, revision: 0, updatedAt: toCanonicalTimestamp(now()), runtimes: [] };
}

function toCanonicalTimestamp(value: unknown): string {
  if (typeof value !== 'string' || Number.isNaN(new Date(value).getTime()) || new Date(value).toISOString() !== value) throw new DocumentTaskRuntimeRepositoryDataError('Document task runtime document timestamp is invalid');
  return value;
}

function maxTimestamp(...values: string[]): string {
  return values.map(toCanonicalTimestamp).sort().at(-1)!;
}
