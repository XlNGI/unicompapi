import {
  createProjectContextContentSnapshot,
  getProjectContextRevision,
  parseProjectContext,
  parseProjectContextDraft,
  toIsoTimestamp,
  type IsoTimestamp,
  type ProjectContextDraftId,
  type ProjectContextDraftV1,
  type ProjectContextId,
  type ProjectContextRepository,
  type ProjectContextV1,
  type ProjectContextVersionV1,
  type ProjectId
} from '../../domain';
import {
  projectStoragePaths,
  type ProjectRelativePath,
  type ProjectStorageAdapter
} from '../storage';

export type ProjectContextRegistryLoadSource =
  | 'primary'
  | 'backup'
  | 'default';

export interface ProjectContextRegistryDocumentV1 {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly updatedAt: IsoTimestamp;
  readonly drafts: readonly ProjectContextDraftV1[];
  readonly contexts: readonly ProjectContextV1[];
}

export interface ProjectContextRegistryMigration {
  readonly fromVersion: number;
  readonly toVersion: number;
  migrate(value: Readonly<Record<string, unknown>>): unknown;
}

export class ProjectContextRevisionConflictError extends Error {
  constructor(
    readonly entityKind: 'draft' | 'context',
    readonly entityId: string,
    readonly expectedRevision: number | null,
    readonly actualRevision: number | null
  ) {
    super(
      `Project context ${entityKind} revision conflict: expected ${String(expectedRevision)}, actual ${String(actualRevision)}`
    );
    this.name = 'ProjectContextRevisionConflictError';
  }
}

export class ProjectContextRepositoryDataError extends Error {
  constructor(
    readonly storagePath: ProjectRelativePath,
    message: string,
    readonly cause?: unknown
  ) {
    super(`${storagePath}: ${message}`);
    this.name = 'ProjectContextRepositoryDataError';
  }
}

interface RegistryLoadResult {
  readonly document: ProjectContextRegistryDocumentV1;
  readonly source: ProjectContextRegistryLoadSource;
}

export class JsonProjectContextRepository
  implements ProjectContextRepository {
  constructor(
    private readonly storage: ProjectStorageAdapter,
    readonly projectId: ProjectId,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly migrations: readonly ProjectContextRegistryMigration[] = []
  ) {}

  async getDraft(
    id: ProjectContextDraftId
  ): Promise<ProjectContextDraftV1 | undefined> {
    await this.waitForWrites();
    return (await this.readCurrent()).document.drafts.find(
      (draft) => draft.id === id
    );
  }

  async createDraft(draft: ProjectContextDraftV1): Promise<void> {
    const validated = this.validateDraftScope(draft);
    if (validated.revision !== 0) {
      throw new ProjectContextRepositoryDataError(
        projectStoragePaths.entities.projectContexts,
        'new project context draft must have revision 0'
      );
    }
    await this.enqueueWrite(async () => {
      const current = await this.readCurrent();
      const existing = current.document.drafts.find(
        (item) => item.id === validated.id
      );
      if (existing) {
        throw new ProjectContextRevisionConflictError(
          'draft',
          validated.id,
          null,
          existing.revision
        );
      }
      await this.writeDocument({
        ...current.document,
        revision: current.document.revision + 1,
        updatedAt: toIsoTimestamp(this.now()),
        drafts: [...current.document.drafts, validated]
      }, current);
    });
  }

  async saveDraft(
    draft: ProjectContextDraftV1,
    expectedRevision: number
  ): Promise<void> {
    const validated = this.validateDraftScope(draft);
    requireExpectedRevision(expectedRevision);
    if (validated.revision !== expectedRevision + 1) {
      throw new ProjectContextRepositoryDataError(
        projectStoragePaths.entities.projectContexts,
        'saved project context draft revision must increment exactly once'
      );
    }
    await this.enqueueWrite(async () => {
      const current = await this.readCurrent();
      const index = current.document.drafts.findIndex(
        (item) => item.id === validated.id
      );
      const actualRevision = index < 0
        ? null
        : current.document.drafts[index].revision;
      if (actualRevision !== expectedRevision) {
        throw new ProjectContextRevisionConflictError(
          'draft',
          validated.id,
          expectedRevision,
          actualRevision
        );
      }
      const drafts = [...current.document.drafts];
      drafts[index] = validated;
      await this.writeDocument({
        ...current.document,
        revision: current.document.revision + 1,
        updatedAt: toIsoTimestamp(this.now()),
        drafts
      }, current);
    });
  }

  async registerDraft(
    draftId: ProjectContextDraftId,
    expectedDraftRevision: number,
    context: ProjectContextV1
  ): Promise<void> {
    requireExpectedRevision(expectedDraftRevision);
    const validatedContext = this.validateContextScope(context);
    if (validatedContext.currentRevision !== 1) {
      throw new ProjectContextRepositoryDataError(
        projectStoragePaths.entities.projectContexts,
        'registered project context must start at revision 1'
      );
    }
    await this.enqueueWrite(async () => {
      const current = await this.readCurrent();
      const draft = current.document.drafts.find((item) => item.id === draftId);
      if (!draft || draft.revision !== expectedDraftRevision) {
        throw new ProjectContextRevisionConflictError(
          'draft',
          draftId,
          expectedDraftRevision,
          draft?.revision ?? null
        );
      }
      if (current.document.contexts.some((item) => item.id === context.id)) {
        const existing = current.document.contexts.find(
          (item) => item.id === context.id
        );
        throw new ProjectContextRevisionConflictError(
          'context',
          context.id,
          null,
          existing?.currentRevision ?? null
        );
      }
      assertContextMatchesDraft(validatedContext, draft);
      await this.writeDocument({
        ...current.document,
        revision: current.document.revision + 1,
        updatedAt: toIsoTimestamp(this.now()),
        drafts: current.document.drafts.filter((item) => item.id !== draftId),
        contexts: [...current.document.contexts, validatedContext]
      }, current);
    });
  }

  async get(id: ProjectContextId): Promise<ProjectContextV1 | undefined> {
    await this.waitForWrites();
    return (await this.readCurrent()).document.contexts.find(
      (context) => context.id === id
    );
  }

  async getRevision(
    id: ProjectContextId,
    revision: number
  ): Promise<ProjectContextVersionV1 | undefined> {
    if (!Number.isSafeInteger(revision) || revision < 1) {
      throw new TypeError('Project context revision is invalid');
    }
    const context = await this.get(id);
    return context
      ? getProjectContextRevision(context, revision)
      : undefined;
  }

  async list(includeDeleted = false): Promise<readonly ProjectContextV1[]> {
    await this.waitForWrites();
    return (await this.readCurrent()).document.contexts
      .filter((context) => includeDeleted || context.status === 'active')
      .sort((left, right) =>
        right.updatedAt.localeCompare(left.updatedAt) ||
        left.id.localeCompare(right.id)
      );
  }

  async save(
    context: ProjectContextV1,
    expectedRevision: number
  ): Promise<void> {
    const validated = this.validateContextScope(context);
    requireExpectedRevision(expectedRevision);
    if (validated.currentRevision !== expectedRevision + 1) {
      throw new ProjectContextRepositoryDataError(
        projectStoragePaths.entities.projectContexts,
        'saved project context revision must increment exactly once'
      );
    }
    await this.enqueueWrite(async () => {
      const current = await this.readCurrent();
      const index = current.document.contexts.findIndex(
        (item) => item.id === validated.id
      );
      const existing = index < 0 ? undefined : current.document.contexts[index];
      if (!existing || existing.currentRevision !== expectedRevision) {
        throw new ProjectContextRevisionConflictError(
          'context',
          validated.id,
          expectedRevision,
          existing?.currentRevision ?? null
        );
      }
      assertHistoryAppendOnly(existing, validated);
      const contexts = [...current.document.contexts];
      contexts[index] = validated;
      await this.writeDocument({
        ...current.document,
        revision: current.document.revision + 1,
        updatedAt: toIsoTimestamp(this.now()),
        contexts
      }, current);
    });
  }

  private validateDraftScope(
    draft: ProjectContextDraftV1
  ): ProjectContextDraftV1 {
    const validated = parseProjectContextDraft(draft);
    if (validated.projectId !== this.projectId) {
      throw new ProjectContextRepositoryDataError(
        projectStoragePaths.entities.projectContexts,
        'project context draft is outside repository scope'
      );
    }
    return validated;
  }

  private validateContextScope(context: ProjectContextV1): ProjectContextV1 {
    const validated = parseProjectContext(context);
    if (validated.projectId !== this.projectId) {
      throw new ProjectContextRepositoryDataError(
        projectStoragePaths.entities.projectContexts,
        'project context is outside repository scope'
      );
    }
    return validated;
  }

  private async waitForWrites(): Promise<void> {
    await this.storage.withExclusiveAccess(
      [projectStoragePaths.entities.projectContexts],
      async () => undefined
    );
  }

  private async enqueueWrite(operation: () => Promise<void>): Promise<void> {
    await this.storage.withExclusiveAccess(
      [
        projectStoragePaths.entities.projectContexts,
        projectStoragePaths.entities.projectContextsBackup
      ],
      operation
    );
  }

  private async readCurrent(): Promise<RegistryLoadResult> {
    try {
      const primary = await this.storage.readJson<unknown>(
        projectStoragePaths.entities.projectContexts
      );
      if (primary === undefined) return this.readBackupOrDefault();
      return {
        document: migrateProjectContextRegistryDocument(
          primary,
          this.migrations,
          this.projectId
        ),
        source: 'primary'
      };
    } catch (primaryError) {
      try {
        const backup = await this.storage.readJson<unknown>(
          projectStoragePaths.entities.projectContextsBackup
        );
        if (backup === undefined) throw new Error('backup is missing');
        return {
          document: migrateProjectContextRegistryDocument(
            backup,
            this.migrations,
            this.projectId
          ),
          source: 'backup'
        };
      } catch (backupError) {
        throw new ProjectContextRepositoryDataError(
          projectStoragePaths.entities.projectContexts,
          'project context registry is invalid and no valid backup is available',
          { primaryError, backupError }
        );
      }
    }
  }

  private async readBackupOrDefault(): Promise<RegistryLoadResult> {
    try {
      const backup = await this.storage.readJson<unknown>(
        projectStoragePaths.entities.projectContextsBackup
      );
      if (backup !== undefined) {
        return {
          document: migrateProjectContextRegistryDocument(
            backup,
            this.migrations,
            this.projectId
          ),
          source: 'backup'
        };
      }
      return {
        document: {
          schemaVersion: 1,
          revision: 0,
          updatedAt: toIsoTimestamp(this.now()),
          drafts: [],
          contexts: []
        },
        source: 'default'
      };
    } catch (error) {
      throw new ProjectContextRepositoryDataError(
        projectStoragePaths.entities.projectContextsBackup,
        'project context registry backup is invalid',
        error
      );
    }
  }

  private async writeDocument(
    document: ProjectContextRegistryDocumentV1,
    current: RegistryLoadResult
  ): Promise<void> {
    const validated = parseProjectContextRegistryDocument(
      document,
      this.projectId
    );
    if (current.source === 'primary') {
      await this.storage.writeJsonAtomically(
        projectStoragePaths.entities.projectContextsBackup,
        current.document
      );
    }
    await this.storage.writeJsonAtomically(
      projectStoragePaths.entities.projectContexts,
      validated
    );
  }
}

export function migrateProjectContextRegistryDocument(
  value: unknown,
  migrations: readonly ProjectContextRegistryMigration[] = [],
  projectId?: ProjectId
): ProjectContextRegistryDocumentV1 {
  let current = requireRecord(value, 'project context registry document');
  let version = requireSchemaVersion(current.schemaVersion);
  const byVersion = new Map<number, ProjectContextRegistryMigration>();
  for (const migration of migrations) {
    if (
      !Number.isSafeInteger(migration.fromVersion) ||
      migration.fromVersion < 0 ||
      migration.toVersion !== migration.fromVersion + 1 ||
      byVersion.has(migration.fromVersion)
    ) {
      throw new ProjectContextRepositoryDataError(
        projectStoragePaths.entities.projectContexts,
        'project context migration registry is invalid'
      );
    }
    byVersion.set(migration.fromVersion, migration);
  }
  if (version > 1) {
    throw new ProjectContextRepositoryDataError(
      projectStoragePaths.entities.projectContexts,
      `project context schema version ${version} is newer than supported`
    );
  }
  while (version < 1) {
    const migration = byVersion.get(version);
    if (!migration) {
      throw new ProjectContextRepositoryDataError(
        projectStoragePaths.entities.projectContexts,
        `no project context migration exists for version ${version}`
      );
    }
    current = requireRecord(
      migration.migrate(current),
      'migrated project context registry document'
    );
    const nextVersion = requireSchemaVersion(current.schemaVersion);
    if (nextVersion !== migration.toVersion) {
      throw new ProjectContextRepositoryDataError(
        projectStoragePaths.entities.projectContexts,
        'project context migration returned an unexpected version'
      );
    }
    version = nextVersion;
  }
  return parseProjectContextRegistryDocument(current, projectId);
}

export function parseProjectContextRegistryDocument(
  value: unknown,
  projectId?: ProjectId
): ProjectContextRegistryDocumentV1 {
  const item = exactRecord(value, [
    'schemaVersion',
    'revision',
    'updatedAt',
    'drafts',
    'contexts'
  ], 'project context registry document');
  if (item.schemaVersion !== 1) {
    throw dataError('project context registry schema version is unsupported');
  }
  if (!Number.isSafeInteger(item.revision) || Number(item.revision) < 0) {
    throw dataError('project context registry revision is invalid');
  }
  if (!Array.isArray(item.drafts) || !Array.isArray(item.contexts)) {
    throw dataError('project context registry collections must be arrays');
  }
  const draftIds = new Set<string>();
  const drafts = item.drafts.map((value) => {
    try {
      const draft = parseProjectContextDraft(value);
      if (projectId !== undefined && draft.projectId !== projectId) {
        throw new TypeError('draft is outside project scope');
      }
      if (draftIds.has(draft.id)) throw new TypeError('duplicate draft id');
      draftIds.add(draft.id);
      return draft;
    } catch (error) {
      throw dataError('project context registry contains an invalid draft', error);
    }
  });
  const contextIds = new Set<string>();
  const contexts = item.contexts.map((value) => {
    try {
      const context = parseProjectContext(value);
      if (projectId !== undefined && context.projectId !== projectId) {
        throw new TypeError('context is outside project scope');
      }
      if (contextIds.has(context.id)) throw new TypeError('duplicate context id');
      contextIds.add(context.id);
      return context;
    } catch (error) {
      throw dataError('project context registry contains an invalid context', error);
    }
  });
  try {
    const updatedAt = toIsoTimestamp(requireString(item.updatedAt, 'registry.updatedAt'));
    if (
      drafts.some((draft) => draft.updatedAt > updatedAt) ||
      contexts.some((context) => context.updatedAt > updatedAt)
    ) {
      throw new TypeError('registry.updatedAt is older than stored data');
    }
    return {
      schemaVersion: 1,
      revision: Number(item.revision),
      updatedAt,
      drafts,
      contexts
    };
  } catch (error) {
    throw dataError('project context registry metadata is invalid', error);
  }
}

function assertContextMatchesDraft(
  context: ProjectContextV1,
  draft: ProjectContextDraftV1
): void {
  const version = context.versions[0];
  const sourceMatches = draft.sourceKind === 'conversation_selection'
    ? version.sourceKind === 'conversation_selection' &&
      version.sourceConversationId === draft.conversationId &&
      stableJson(version.sourceFragments) === stableJson(draft.fragments) &&
      version.contentSnapshot === createProjectContextContentSnapshot(draft.fragments)
    : version.sourceKind === 'image_analysis' &&
      version.sourceImageDraftId === draft.sourceImageDraftId &&
      version.sourceImageResultRevision === draft.sourceImageResultRevision &&
      version.contentSnapshot === draft.contentSnapshot;
  if (
    context.projectId !== draft.projectId ||
    stableJson(version.labels) !== stableJson(draft.labels) ||
    !sourceMatches
  ) {
    throw dataError('registered project context does not match its draft');
  }
}

function assertHistoryAppendOnly(
  previous: ProjectContextV1,
  next: ProjectContextV1
): void {
  if (
    next.versions.length !== previous.versions.length + 1 ||
    stableJson(next.versions.slice(0, -1)) !== stableJson(previous.versions) ||
    next.createdAt !== previous.createdAt
  ) {
    throw dataError('project context history must be append-only');
  }
}

function requireExpectedRevision(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('Expected project context revision is invalid');
  }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw dataError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  label: string
): Record<string, unknown> {
  const item = requireRecord(value, label);
  const allowed = new Set(keys);
  const actual = Object.keys(item);
  if (actual.length !== allowed.size || actual.some((key) => !allowed.has(key))) {
    throw dataError(`${label} contains unexpected or missing fields`);
  }
  return item;
}

function requireSchemaVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw dataError('project context schema version is invalid');
  }
  return Number(value);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new TypeError(`${field} must be a string`);
  return value;
}

function dataError(
  message: string,
  cause?: unknown
): ProjectContextRepositoryDataError {
  return new ProjectContextRepositoryDataError(
    projectStoragePaths.entities.projectContexts,
    message,
    cause
  );
}

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}
