import type {
  Asset,
  AssetId,
  AssetRepository,
  Draft,
  DraftId,
  DraftRepository,
  Execution,
  ExecutionId,
  ExecutionRepository,
  FileReference,
  FileReferenceId,
  FileReferenceRepository,
  ImageWorkspaceDraft,
  ImageWorkspaceRepository,
  Project,
  ProjectId,
  ProjectRepository,
  Task,
  TaskId,
  TaskRepository,
  VideoEditDraft,
  VideoEditDraftId,
  VideoEditDraftRepository,
  VideoExportPlan,
  VideoExportPlanId,
  VideoExportPlanRepository,
  VideoWorkspaceDraft,
  VideoWorkspaceRepository,
  Work,
  WorkId,
  WorkRepository
} from '../../domain';
import {
  projectStoragePaths,
  type ProjectRelativePath,
  type ProjectStorageAdapter
} from '../storage';
import { RepositoryDataError } from './repository-data-error';
import { hasValidVideoExportPlanHash } from './video-export-plan-integrity';
import {
  isAssetEntity,
  isCanonicalIsoTimestamp,
  isDraftEntity,
  isExecutionEntity,
  isFileReferenceEntity,
  isImageWorkspaceEntity,
  isTaskEntity,
  isVideoEditDraftEntity,
  isVideoExportPlanEntity,
  isVideoWorkspaceEntity,
  isWorkEntity,
  type EntityValidator
} from './entity-validators';

interface PersistedEntity {
  readonly schemaVersion: 1;
  readonly id: string;
}

interface EntityCollection<TEntity> {
  readonly schemaVersion: 2;
  readonly revision: number;
  readonly entities: readonly TEntity[];
}

class JsonEntityCollection<TEntity extends PersistedEntity, TScopeId extends string> {
  constructor(
    private readonly storage: ProjectStorageAdapter,
    private readonly path: ProjectRelativePath,
    private readonly scopeId: TScopeId | undefined,
    private readonly getScopeId: (entity: TEntity) => TScopeId,
    private readonly validateEntity: EntityValidator,
    private readonly exclusiveScope = true
  ) {}

  async get<TId extends string>(id: TId): Promise<TEntity | undefined> {
    const collection = await this.read();
    return collection.entities.find((entity) => entity.id === id);
  }

  async list(scopeId: TScopeId): Promise<readonly TEntity[]> {
    if (this.exclusiveScope) {
      this.assertScope(scopeId);
    }
    const collection = await this.read();
    return this.exclusiveScope
      ? collection.entities
      : collection.entities.filter(
          (entity) => this.getScopeId(entity) === scopeId
        );
  }

  async save(entity: TEntity): Promise<void> {
    if (this.exclusiveScope) {
      this.assertScope(this.getScopeId(entity));
    }

    if (!this.validateEntity(entity as unknown as Record<string, unknown>)) {
      throw new RepositoryDataError(this.path, 'cannot save an invalid entity');
    }

    await this.storage.withExclusiveAccess([this.path], async () => {
      const collection = await this.read();
      const entities = collection.entities.filter(
        (current) => current.id !== entity.id
      );

      await this.storage.writeJsonAtomically<EntityCollection<TEntity>>(
        this.path,
        {
          schemaVersion: 2,
          revision: collection.revision + 1,
          entities: [...entities, entity]
        },
        { backup: true }
      );
    });
  }

  async remove(id: string): Promise<void> {
    await this.storage.withExclusiveAccess([this.path], async () => {
      const collection = await this.read();
      if (!collection.entities.some((entity) => entity.id === id)) {
        return;
      }
      await this.storage.writeJsonAtomically<EntityCollection<TEntity>>(
        this.path,
        {
          schemaVersion: 2,
          revision: collection.revision + 1,
          entities: collection.entities.filter((entity) => entity.id !== id)
        },
        { backup: true }
      );
    });
  }

  private async read(): Promise<EntityCollection<TEntity>> {
    const loaded = await this.storage.readJsonWithBackup(
      this.path,
      (value) => this.parse(value)
    );
    if (!loaded) {
      return { schemaVersion: 2, revision: 0, entities: [] };
    }
    return loaded.value;
  }

  private parse(value: unknown): EntityCollection<TEntity> {
    if (
      !isRecord(value) ||
      ![1, 2].includes(Number(value.schemaVersion)) ||
      !Array.isArray(value.entities) ||
      (value.schemaVersion === 2 &&
        (!Number.isSafeInteger(value.revision) || Number(value.revision) < 0))
    ) {
      throw new RepositoryDataError(
        this.path,
        'expected a supported revisioned entity collection'
      );
    }

    const ids = new Set<string>();

    for (const entity of value.entities) {
      if (
        !isRecord(entity) ||
        entity.schemaVersion !== 1 ||
        typeof entity.id !== 'string' ||
        entity.id.trim().length === 0 ||
        !this.validateEntity(entity)
      ) {
        throw new RepositoryDataError(
          this.path,
          'contains an invalid project-scoped entity'
        );
      }

      const typedEntity = entity as unknown as TEntity;

      if (
        this.exclusiveScope &&
        this.getScopeId(typedEntity) !== this.scopeId
      ) {
        throw new RepositoryDataError(
          this.path,
          'contains an entity outside repository scope'
        );
      }

      if (ids.has(entity.id)) {
        throw new RepositoryDataError(
          this.path,
          `contains duplicate entity id ${entity.id}`
        );
      }

      ids.add(entity.id);
    }

    return {
      schemaVersion: 2,
      revision: value.schemaVersion === 1 ? 0 : Number(value.revision),
      entities: value.entities as readonly TEntity[]
    };
  }

  private assertScope(scopeId: TScopeId): void {
    if (this.scopeId === undefined || scopeId !== this.scopeId) {
      throw new RepositoryDataError(
        this.path,
        `scope ${scopeId} is outside repository scope ${this.scopeId}`
      );
    }
  }
}

export class JsonProjectRepository implements ProjectRepository {
  constructor(
    private readonly storage: ProjectStorageAdapter,
    private readonly projectId: ProjectId
  ) {}

  async load(): Promise<Project | undefined> {
    const loaded = await this.storage.readJsonWithBackup(
      projectStoragePaths.manifest,
      (value) => {
        if (
          !isRecord(value) ||
          value.schemaVersion !== 1 ||
          typeof value.id !== 'string' ||
          value.id.trim().length === 0 ||
          value.id !== this.projectId ||
          typeof value.name !== 'string' ||
          value.name.trim().length === 0 ||
          !isCanonicalIsoTimestamp(value.createdAt) ||
          !isCanonicalIsoTimestamp(value.updatedAt)
        ) {
          throw new RepositoryDataError(
            projectStoragePaths.manifest,
            'expected a valid version 1 project manifest'
          );
        }
        return value as unknown as Project;
      }
    );
    return loaded?.value;
  }

  async save(project: Project): Promise<void> {
    if (project.id !== this.projectId) {
      throw new RepositoryDataError(
        projectStoragePaths.manifest,
        `project ${project.id} is outside repository scope ${this.projectId}`
      );
    }

    await this.storage.writeJsonAtomically(
      projectStoragePaths.manifest,
      project,
      { backup: true }
    );
  }
}

export class JsonDraftRepository implements DraftRepository {
  private readonly collection: JsonEntityCollection<Draft, ProjectId>;

  constructor(storage: ProjectStorageAdapter, projectId: ProjectId) {
    this.collection = new JsonEntityCollection(
      storage,
      projectStoragePaths.entities.drafts,
      projectId,
      (draft) => draft.projectId,
      isDraftEntity
    );
  }

  get(id: DraftId) {
    return this.collection.get(id);
  }

  list(projectId: ProjectId) {
    return this.collection.list(projectId);
  }

  save(draft: Draft) {
    return this.collection.save(draft);
  }
}

export class JsonImageWorkspaceRepository
  implements ImageWorkspaceRepository {
  private readonly collection: JsonEntityCollection<
    ImageWorkspaceDraft,
    ProjectId
  >;

  constructor(storage: ProjectStorageAdapter, projectId: ProjectId) {
    this.collection = new JsonEntityCollection(
      storage,
      projectStoragePaths.entities.imageWorkspaceDrafts,
      projectId,
      (draft) => draft.projectId,
      isImageWorkspaceEntity
    );
  }

  get(id: DraftId) {
    return this.collection.get(id);
  }

  list(projectId: ProjectId) {
    return this.collection.list(projectId);
  }

  save(draft: ImageWorkspaceDraft) {
    return this.collection.save(draft);
  }

  remove(id: DraftId) {
    return this.collection.remove(id);
  }
}

export class JsonVideoWorkspaceRepository
  implements VideoWorkspaceRepository {
  private readonly collection: JsonEntityCollection<
    VideoWorkspaceDraft,
    ProjectId
  >;

  constructor(storage: ProjectStorageAdapter, projectId: ProjectId) {
    this.collection = new JsonEntityCollection(
      storage,
      projectStoragePaths.entities.videoWorkspaceDrafts,
      projectId,
      (draft) => draft.projectId,
      isVideoWorkspaceEntity
    );
  }

  get(id: DraftId) {
    return this.collection.get(id);
  }

  list(projectId: ProjectId) {
    return this.collection.list(projectId);
  }

  save(draft: VideoWorkspaceDraft) {
    return this.collection.save(draft);
  }
}

export class JsonVideoEditDraftRepository
  implements VideoEditDraftRepository {
  private readonly collection: JsonEntityCollection<
    VideoEditDraft,
    ProjectId
  >;

  constructor(storage: ProjectStorageAdapter, projectId: ProjectId) {
    this.collection = new JsonEntityCollection(
      storage,
      projectStoragePaths.entities.videoEditDrafts,
      projectId,
      (draft) => draft.projectId,
      isVideoEditDraftEntity
    );
  }

  get(id: VideoEditDraftId) {
    return this.collection.get(id);
  }

  list(projectId: ProjectId) {
    return this.collection.list(projectId);
  }

  save(draft: VideoEditDraft) {
    return this.collection.save(draft);
  }
}

export class JsonVideoExportPlanRepository
  implements VideoExportPlanRepository {
  private readonly collection: JsonEntityCollection<VideoExportPlan, ProjectId>;

  constructor(storage: ProjectStorageAdapter, projectId: ProjectId) {
    this.collection = new JsonEntityCollection(
      storage,
      projectStoragePaths.entities.videoExportPlans,
      projectId,
      (plan) => plan.projectId,
      isVideoExportPlanEntity
    );
  }

  async get(id: VideoExportPlanId) {
    const plan = await this.collection.get(id);
    if (plan) this.assertIntegrity(plan);
    return plan;
  }

  async list(projectId: ProjectId) {
    const plans = await this.collection.list(projectId);
    plans.forEach((plan) => this.assertIntegrity(plan));
    return plans;
  }

  save(plan: VideoExportPlan) {
    this.assertIntegrity(plan);
    return this.collection.save(plan);
  }

  private assertIntegrity(plan: VideoExportPlan): void {
    if (!hasValidVideoExportPlanHash(plan)) {
      throw new RepositoryDataError(
        projectStoragePaths.entities.videoExportPlans,
        `export plan ${plan.id} failed SHA-256 integrity verification`
      );
    }
  }
}

export class JsonAssetRepository implements AssetRepository {
  private readonly collection: JsonEntityCollection<Asset, ProjectId>;

  constructor(storage: ProjectStorageAdapter, projectId: ProjectId) {
    this.collection = new JsonEntityCollection(
      storage,
      projectStoragePaths.entities.assets,
      projectId,
      (asset) => asset.projectId,
      isAssetEntity
    );
  }

  get(id: AssetId) {
    return this.collection.get(id);
  }

  list(projectId: ProjectId) {
    return this.collection.list(projectId);
  }

  save(asset: Asset) {
    return this.collection.save(asset);
  }
}

export class JsonFileReferenceRepository implements FileReferenceRepository {
  private readonly collection: JsonEntityCollection<FileReference, ProjectId>;

  constructor(storage: ProjectStorageAdapter, projectId: ProjectId) {
    this.collection = new JsonEntityCollection(
      storage,
      projectStoragePaths.entities.fileReferences,
      projectId,
      (file) => file.projectId,
      isFileReferenceEntity
    );
  }

  get(id: FileReferenceId) {
    return this.collection.get(id);
  }

  list(projectId: ProjectId) {
    return this.collection.list(projectId);
  }

  save(file: FileReference) {
    return this.collection.save(file);
  }

  remove(id: FileReferenceId) {
    return this.collection.remove(id);
  }
}

export class JsonTaskRepository implements TaskRepository {
  private readonly collection: JsonEntityCollection<Task, ProjectId>;

  constructor(storage: ProjectStorageAdapter, projectId: ProjectId) {
    this.collection = new JsonEntityCollection(
      storage,
      projectStoragePaths.entities.tasks,
      projectId,
      (task) => task.projectId,
      isTaskEntity
    );
  }

  get(id: TaskId) {
    return this.collection.get(id);
  }

  list(projectId: ProjectId) {
    return this.collection.list(projectId);
  }

  save(task: Task) {
    return this.collection.save(task);
  }
}

export class JsonExecutionRepository implements ExecutionRepository {
  private readonly collection: JsonEntityCollection<Execution, TaskId>;

  constructor(storage: ProjectStorageAdapter) {
    this.collection = new JsonEntityCollection(
      storage,
      projectStoragePaths.entities.executions,
      undefined,
      (execution) => execution.taskId,
      isExecutionEntity,
      false
    );
  }

  get(id: ExecutionId) {
    return this.collection.get(id);
  }

  list(taskId: TaskId) {
    return this.collection.list(taskId);
  }

  save(execution: Execution) {
    return this.collection.save(execution);
  }
}

export class JsonWorkRepository implements WorkRepository {
  private readonly collection: JsonEntityCollection<Work, ProjectId>;

  constructor(storage: ProjectStorageAdapter, projectId: ProjectId) {
    this.collection = new JsonEntityCollection(
      storage,
      projectStoragePaths.entities.works,
      projectId,
      (work) => work.projectId,
      isWorkEntity
    );
  }

  get(id: WorkId) {
    return this.collection.get(id);
  }

  list(projectId: ProjectId) {
    return this.collection.list(projectId);
  }

  save(work: Work) {
    return this.collection.save(work);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
