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
import {
  isAssetEntity,
  isCanonicalIsoTimestamp,
  isDraftEntity,
  isExecutionEntity,
  isFileReferenceEntity,
  isImageWorkspaceEntity,
  isTaskEntity,
  isWorkEntity,
  type EntityValidator
} from './entity-validators';

interface PersistedEntity {
  readonly schemaVersion: 1;
  readonly id: string;
}

interface EntityCollection<TEntity> {
  readonly schemaVersion: 1;
  readonly entities: readonly TEntity[];
}

class JsonEntityCollection<TEntity extends PersistedEntity, TScopeId extends string> {
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly storage: ProjectStorageAdapter,
    private readonly path: ProjectRelativePath,
    private readonly scopeId: TScopeId | undefined,
    private readonly getScopeId: (entity: TEntity) => TScopeId,
    private readonly validateEntity: EntityValidator,
    private readonly exclusiveScope = true
  ) {}

  async get<TId extends string>(id: TId): Promise<TEntity | undefined> {
    await this.writeQueue;
    const collection = await this.read();
    return collection.entities.find((entity) => entity.id === id);
  }

  async list(scopeId: TScopeId): Promise<readonly TEntity[]> {
    if (this.exclusiveScope) {
      this.assertScope(scopeId);
    }
    await this.writeQueue;
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

    const operation = this.writeQueue.then(async () => {
      const collection = await this.read();
      const entities = collection.entities.filter(
        (current) => current.id !== entity.id
      );

      await this.storage.writeJsonAtomically<EntityCollection<TEntity>>(
        this.path,
        {
          schemaVersion: 1,
          entities: [...entities, entity]
        }
      );
    });

    this.writeQueue = operation.catch(() => undefined);
    await operation;
  }

  private async read(): Promise<EntityCollection<TEntity>> {
    const value = await this.storage.readJson<unknown>(this.path);

    if (value === undefined) {
      return { schemaVersion: 1, entities: [] };
    }

    if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.entities)) {
      throw new RepositoryDataError(
        this.path,
        'expected a version 1 entity collection'
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

    return value as unknown as EntityCollection<TEntity>;
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
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly storage: ProjectStorageAdapter,
    private readonly projectId: ProjectId
  ) {}

  async load(): Promise<Project | undefined> {
    await this.writeQueue;
    const value = await this.storage.readJson<unknown>(projectStoragePaths.manifest);

    if (value === undefined) {
      return undefined;
    }

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

  async save(project: Project): Promise<void> {
    if (project.id !== this.projectId) {
      throw new RepositoryDataError(
        projectStoragePaths.manifest,
        `project ${project.id} is outside repository scope ${this.projectId}`
      );
    }

    const operation = this.writeQueue.then(() =>
      this.storage.writeJsonAtomically(projectStoragePaths.manifest, project)
    );

    this.writeQueue = operation.catch(() => undefined);
    await operation;
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
