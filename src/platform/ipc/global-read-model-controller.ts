import { stat, statfs } from 'node:fs/promises';
import type { Execution, FileReference, Task, Work } from '../../domain';
import { toTaskId, toWorkId } from '../../domain';
import type {
  StorageIpcResult,
  StorageReadModelIssueDto,
  StorageReadModelListDto,
  StorageLocalStorageSummaryDto,
  StorageTaskDetailsDto,
  StorageTaskSummaryDto,
  StorageWorkDetailsDto,
  StorageWorkSummaryDto
} from '../../shared/storage-ipc';
import {
  JsonExecutionRepository,
  JsonFileReferenceRepository,
  JsonProviderOperationRepository,
  JsonTaskRepository,
  JsonWorkRepository
} from '../repositories';
import { NodeProjectStorage } from '../storage';
import { scanDirectoryUsage } from '../settings';
import type { ProjectCatalogEntry, ProjectCatalogService } from './project-catalog';

interface CurrentProjectStorageSession {
  readonly projectId: string;
  readonly projectName: string;
  readonly rootDirectory: string;
}

export class GlobalReadModelController {
  private projectUsageCache: StorageLocalStorageSummaryDto['projectUsage'] | undefined;
  private projectUsageRevision = 0;
  private readonly taskSnapshots = new Map<string, Promise<readonly Task[]>>();
  private readonly executionSnapshots = new Map<string, Promise<readonly Execution[]>>();
  private readonly workSnapshots = new Map<string, Promise<readonly Work[]>>();
  private readonly fileSnapshots = new Map<string, Promise<readonly FileReference[]>>();

  constructor(
    private readonly catalog: ProjectCatalogService,
    private readonly getCurrentProject: () => CurrentProjectStorageSession | undefined = () => undefined
  ) {}

  invalidateLocalStorageSummary(): void {
    this.projectUsageRevision += 1;
    this.projectUsageCache = undefined;
  }

  invalidate(): void {
    this.invalidateLocalStorageSummary();
    this.taskSnapshots.clear();
    this.executionSnapshots.clear();
    this.workSnapshots.clear();
    this.fileSnapshots.clear();
  }

  async getLocalStorageSummary(): Promise<
    StorageIpcResult<StorageLocalStorageSummaryDto>
  > {
    try {
      const projectUsage = await this.getProjectUsage();
      const current = this.getCurrentProject();
      return {
        ok: true,
        value: {
          projectUsage,
          ...(current ? {
            currentProject: {
              projectId: current.projectId,
              projectName: current.projectName,
              diskFreeBytes: await availableBytes(current.rootDirectory)
            }
          } : {})
        }
      };
    } catch {
      return readFailure();
    }
  }

  async listTasks(): Promise<
    StorageIpcResult<StorageReadModelListDto<StorageTaskSummaryDto>>
  > {
    try {
      const items: StorageTaskSummaryDto[] = [];
      const issues: StorageReadModelIssueDto[] = [];

      for (const entry of await this.catalog.getEntries()) {
        if (!(await isAvailable(entry))) {
          issues.push(toIssue(entry, 'unavailable'));
          continue;
        }

        try {
          const [tasks, executions] = await Promise.all([
            this.loadTasks(entry),
            this.loadExecutions(entry)
          ]);
          const executionsByTaskId = groupExecutionsByTaskId(executions);
          for (const task of tasks) {
            const executions = filterLinkedExecutions(
              task,
              executionsByTaskId.get(task.id) ?? []
            );
            items.push(toTaskSummary(entry, task, executions));
          }
        } catch {
          issues.push(toIssue(entry, 'invalid_data'));
        }
      }

      return {
        ok: true,
        value: {
          items: items.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
          issues
        }
      };
    } catch {
      return readFailure();
    }
  }

  async getTaskDetails(
    request: unknown
  ): Promise<StorageIpcResult<StorageTaskDetailsDto | undefined>> {
    try {
      const taskId = parseId(request, 'taskId');
      for (const entry of await this.catalog.getEntries()) {
        if (!(await isAvailable(entry))) continue;
        try {
          const context = createContext(entry);
          const task = (await this.loadTasks(entry)).find(
            (candidate) => candidate.id === toTaskId(taskId)
          );
          if (!task) continue;
          const executions = filterLinkedExecutions(
            task,
            (await this.loadExecutions(entry)).filter(
              (execution) => execution.taskId === task.id
            )
          );
          const latest = [...executions].sort((a, b) =>
            b.updatedAt.localeCompare(a.updatedAt)
          )[0];
          const hasRegisteredImageWork = latest
            ? (await this.loadWorks(entry)).some(
                (work) => work.sourceExecutionId === latest.id
              )
            : false;
          let hasRecoverableImageOperation = false;
          if (latest?.providerOperationRecordId) {
            try {
              const operation = await context.operations.get(
                latest.providerOperationRecordId
              );
              hasRecoverableImageOperation = Boolean(
                operation &&
                operation.taskId === task.id &&
                operation.executionId === latest.id &&
                operation.mediaKind === 'image' &&
                operation.outcome.kind === 'completed_sync'
              );
            } catch {
              // A missing or damaged result reference disables recovery only.
            }
          }
          return {
            ok: true,
            value: toTaskDetails(
              entry,
              task,
              executions,
              this.getCurrentProject()?.projectId,
              hasRecoverableImageOperation,
              hasRegisteredImageWork
            )
          };
        } catch {
          continue;
        }
      }
      return { ok: true, value: undefined };
    } catch {
      return readFailure();
    }
  }

  async listWorks(): Promise<
    StorageIpcResult<StorageReadModelListDto<StorageWorkSummaryDto>>
  > {
    try {
      const items: StorageWorkSummaryDto[] = [];
      const issues: StorageReadModelIssueDto[] = [];

      for (const entry of await this.catalog.getEntries()) {
        if (!(await isAvailable(entry))) {
          issues.push(toIssue(entry, 'unavailable'));
          continue;
        }

        try {
          const [works, executions, files] = await Promise.all([
            this.loadWorks(entry),
            this.loadExecutions(entry),
            this.loadFiles(entry)
          ]);
          const executionById = new Map(executions.map((execution) => [execution.id, execution]));
          const fileById = new Map(files.map((file) => [file.id, file]));
          for (const work of works) {
            const execution = executionById.get(work.sourceExecutionId);
            if (!execution || execution.state !== 'completed') continue;
            const file = fileById.get(work.fileId);
            if (!file) throw new TypeError('Work references a missing file record');
            items.push({
              workId: work.id,
              projectId: entry.projectId,
              projectName: entry.projectName,
              name: work.name,
              mediaKind: work.mediaKind,
              fileId: work.fileId,
              fileState: file.state,
              createdAt: work.createdAt,
              parentWorkId: work.parentWorkId
            });
          }
        } catch {
          issues.push(toIssue(entry, 'invalid_data'));
        }
      }

      return {
        ok: true,
        value: {
          items: items.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
          issues
        }
      };
    } catch {
      return readFailure();
    }
  }

  async getWorkDetails(
    request: unknown
  ): Promise<StorageIpcResult<StorageWorkDetailsDto | undefined>> {
    try {
      const workId = parseId(request, 'workId');
      for (const entry of await this.catalog.getEntries()) {
        if (!(await isAvailable(entry))) continue;
        try {
          const work = (await this.loadWorks(entry)).find(
            (candidate) => candidate.id === toWorkId(workId)
          );
          if (!work) continue;
          const execution = (await this.loadExecutions(entry)).find(
            (candidate) => candidate.id === work.sourceExecutionId
          );
          if (!execution || execution.state !== 'completed') {
            return { ok: true, value: undefined };
          }
          const file = (await this.loadFiles(entry)).find(
            (candidate) => candidate.id === work.fileId
          );
          if (!file) return { ok: true, value: undefined };
          return {
            ok: true,
            value: {
              workId: work.id,
              projectId: entry.projectId,
              projectName: entry.projectName,
              name: work.name,
              mediaKind: work.mediaKind,
              fileId: work.fileId,
              fileState: file.state,
              createdAt: work.createdAt,
              parentWorkId: work.parentWorkId,
              sourceTaskId: work.sourceTaskId,
              sourceExecutionId: work.sourceExecutionId,
              sizeBytes: file.sizeBytes,
              verifiedAt: file.lastVerification?.verifiedAt
            }
          };
        } catch {
          continue;
        }
      }
      return { ok: true, value: undefined };
    } catch {
      return readFailure();
    }
  }

  private async getProjectUsage(): Promise<StorageLocalStorageSummaryDto['projectUsage']> {
    if (this.projectUsageCache) return this.projectUsageCache;
    const revision = this.projectUsageRevision;
    const entries = await this.catalog.getEntries();
    let totalBytes = 0;
    let measuredProjectCount = 0;
    let unavailableProjectCount = 0;
    let truncated = false;

    for (const entry of entries) {
      try {
        if (!(await isAvailable(entry))) {
          unavailableProjectCount += 1;
          continue;
        }
        const usage = await scanDirectoryUsage(entry.rootDirectory);
        totalBytes += usage.totalBytes;
        measuredProjectCount += 1;
        truncated ||= usage.truncated;
      } catch {
        unavailableProjectCount += 1;
      }
    }

    const usage = {
      totalBytes,
      projectCount: entries.length,
      measuredProjectCount,
      unavailableProjectCount,
      truncated
    };
    if (revision === this.projectUsageRevision) this.projectUsageCache = usage;
    return usage;
  }

  private loadTasks(entry: ProjectCatalogEntry): Promise<readonly Task[]> {
    return loadSnapshot(
      this.taskSnapshots,
      snapshotKey(entry),
      () => createContext(entry).tasks.list(entry.projectId)
    );
  }

  private loadExecutions(entry: ProjectCatalogEntry): Promise<readonly Execution[]> {
    return loadSnapshot(
      this.executionSnapshots,
      snapshotKey(entry),
      () => createContext(entry).executions.listAll()
    );
  }

  private loadWorks(entry: ProjectCatalogEntry): Promise<readonly Work[]> {
    return loadSnapshot(
      this.workSnapshots,
      snapshotKey(entry),
      () => createContext(entry).works.list(entry.projectId)
    );
  }

  private loadFiles(entry: ProjectCatalogEntry): Promise<readonly FileReference[]> {
    return loadSnapshot(
      this.fileSnapshots,
      snapshotKey(entry),
      () => createContext(entry).files.list(entry.projectId)
    );
  }
}

const MAX_PROJECT_SNAPSHOTS = 64;

function snapshotKey(entry: ProjectCatalogEntry): string {
  return `${entry.projectId}\u0000${entry.rootDirectory}`;
}

function loadSnapshot<T>(
  cache: Map<string, Promise<readonly T[]>>,
  key: string,
  load: () => Promise<readonly T[]>
): Promise<readonly T[]> {
  const cached = cache.get(key);
  if (cached) return cached;
  const pending = load().catch((error: unknown) => {
    cache.delete(key);
    throw error;
  });
  cache.set(key, pending);
  while (cache.size > MAX_PROJECT_SNAPSHOTS) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return pending;
}

function groupExecutionsByTaskId(
  executions: readonly Execution[]
): ReadonlyMap<string, readonly Execution[]> {
  const grouped = new Map<string, Execution[]>();
  for (const execution of executions) {
    const current = grouped.get(execution.taskId) ?? [];
    current.push(execution);
    grouped.set(execution.taskId, current);
  }
  return grouped;
}

function createContext(entry: ProjectCatalogEntry) {
  const storage = new NodeProjectStorage(entry.rootDirectory);
  return {
    tasks: new JsonTaskRepository(storage, entry.projectId),
    executions: new JsonExecutionRepository(storage),
    operations: new JsonProviderOperationRepository(storage),
    works: new JsonWorkRepository(storage, entry.projectId),
    files: new JsonFileReferenceRepository(storage, entry.projectId)
  };
}

function toTaskSummary(
  entry: ProjectCatalogEntry,
  task: Task,
  executions: readonly Execution[]
): StorageTaskSummaryDto {
  const latest = [...executions].sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt)
  )[0];
  return {
    taskId: task.id,
    projectId: entry.projectId,
    projectName: entry.projectName,
    kind: task.submission.kind,
    createdAt: task.createdAt,
    executionCount: executions.length,
    latestExecutionState: latest?.state,
    latestExecutionUpdatedAt: latest?.updatedAt,
    retryability: latest?.failure?.retryability
  };
}

function toTaskDetails(
  entry: ProjectCatalogEntry,
  task: Task,
  executions: readonly Execution[],
  currentProjectId?: string,
  hasRecoverableImageOperation = false,
  hasRegisteredImageWork = false
): StorageTaskDetailsDto {
  const summary = toTaskSummary(entry, task, executions);
  const latest = [...executions].sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt)
  )[0];
  return {
    ...summary,
    sourceDraftId: task.sourceDraftId,
    originalInput: task.submission.kind === 'video_editing'
      ? task.submission.videoEditing.title
      : task.submission.kind === 'document_generation'
        ? task.submission.document.title
        : task.submission.prompt.originalInput,
    finalPrompt: task.submission.kind === 'video_editing'
      ? `本地视频导出，草稿版本 ${task.submission.videoEditing.draftRevision}`
      : task.submission.kind === 'document_generation'
        ? `本地文档生成，草稿版本 ${task.submission.document.draftRevision}`
        : task.submission.prompt.finalPrompt,
    canRecoverImageResult:
      entry.projectId === currentProjectId &&
      task.submission.kind === 'image_generation' &&
      !hasRegisteredImageWork &&
      canRecoverImageLocalReceipt(latest) &&
      latest?.submissionOutcome === 'completed_sync' &&
      Boolean(latest?.providerOperationRecordId) &&
      hasRecoverableImageOperation,
    canRecoverVideoResult:
      entry.projectId === currentProjectId &&
      task.submission.kind === 'video_generation' &&
      summary.latestExecutionState === 'failed' &&
      summary.retryability === 'retryable' &&
      latest?.failure?.stage === 'downloading'
  };
}

function canRecoverImageLocalReceipt(execution: Execution | undefined): boolean {
  if (!execution) return false;
  if (execution.state === 'remote_completed') return true;
  return execution.state === 'failed' &&
    ['downloading', 'writing'].includes(execution.failure?.stage ?? '') &&
    execution.failure?.retryability !== 'not_retryable';
}

function filterLinkedExecutions(
  task: Task,
  executions: readonly Execution[]
): readonly Execution[] {
  return executions.filter((execution) => task.executionIds.includes(execution.id));
}

async function isAvailable(entry: ProjectCatalogEntry): Promise<boolean> {
  try {
    return (await stat(entry.rootDirectory)).isDirectory();
  } catch {
    return false;
  }
}

async function availableBytes(directory: string): Promise<number | null> {
  try {
    const facts = await statfs(directory, { bigint: true });
    const bytes = facts.bavail * facts.bsize;
    return bytes > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(bytes);
  } catch {
    return null;
  }
}

function toIssue(
  entry: ProjectCatalogEntry,
  reason: StorageReadModelIssueDto['reason']
): StorageReadModelIssueDto {
  return {
    projectId: entry.projectId,
    projectName: entry.projectName,
    reason
  };
}

function parseId(request: unknown, key: 'taskId' | 'workId'): string {
  const record = request as Record<string, unknown>;
  if (
    typeof request !== 'object' ||
    request === null ||
    !(key in request) ||
    typeof record[key] !== 'string' ||
    record[key].trim().length === 0
  ) {
    throw new TypeError(`A valid ${key} is required`);
  }
  return record[key].trim();
}

function readFailure<T>(): StorageIpcResult<T> {
  return {
    ok: false,
    error: {
      code: 'read_model_failed',
      message: 'The local read model could not be loaded'
    }
  };
}
