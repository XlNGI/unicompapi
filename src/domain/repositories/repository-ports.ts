import type { Asset } from '../entities/asset';
import type { Draft } from '../entities/draft';
import type { Execution } from '../entities/execution';
import type { FileReference } from '../entities/file-reference';
import type { Project } from '../entities/project';
import type { Task } from '../entities/task';
import type { Work } from '../entities/work';
import type {
  AssetId,
  DraftId,
  ExecutionId,
  FileReferenceId,
  ProjectId,
  TaskId,
  WorkId
} from '../ids';

export interface ProjectRepository {
  load(): Promise<Project | undefined>;
  save(project: Project): Promise<void>;
}

export interface DraftRepository {
  get(id: DraftId): Promise<Draft | undefined>;
  list(projectId: ProjectId): Promise<readonly Draft[]>;
  save(draft: Draft): Promise<void>;
}

export interface AssetRepository {
  get(id: AssetId): Promise<Asset | undefined>;
  list(projectId: ProjectId): Promise<readonly Asset[]>;
  save(asset: Asset): Promise<void>;
}

export interface FileReferenceRepository {
  get(id: FileReferenceId): Promise<FileReference | undefined>;
  list(projectId: ProjectId): Promise<readonly FileReference[]>;
  save(file: FileReference): Promise<void>;
}

export interface TaskRepository {
  get(id: TaskId): Promise<Task | undefined>;
  list(projectId: ProjectId): Promise<readonly Task[]>;
  save(task: Task): Promise<void>;
}

export interface ExecutionRepository {
  get(id: ExecutionId): Promise<Execution | undefined>;
  list(taskId: TaskId): Promise<readonly Execution[]>;
  save(execution: Execution): Promise<void>;
}

export interface WorkRepository {
  get(id: WorkId): Promise<Work | undefined>;
  list(projectId: ProjectId): Promise<readonly Work[]>;
  save(work: Work): Promise<void>;
}
