import { stat } from 'node:fs/promises';
import type { Execution, Task } from '../../domain';
import { toTaskId, toWorkId } from '../../domain';
import type {
  StorageIpcResult,
  StorageReadModelIssueDto,
  StorageReadModelListDto,
  StorageTaskDetailsDto,
  StorageTaskSummaryDto,
  StorageCallRecordListDto,
  StorageCallRecordSummaryDto,
  StorageWorkDetailsDto,
  StorageWorkSummaryDto
} from '../../shared/storage-ipc';
import {
  JsonExecutionRepository,
  JsonFileReferenceRepository,
  JsonTaskRepository,
  JsonWorkRepository
} from '../repositories';
import { NodeProjectStorage } from '../storage';
import type { ProjectCatalogEntry, ProjectCatalogService } from './project-catalog';

interface TaskCallProjectionPort {
  listCallRecords(request?: unknown): Promise<StorageIpcResult<StorageCallRecordListDto>>;
}

export class GlobalReadModelController {
  constructor(
    private readonly catalog: ProjectCatalogService,
    private readonly calls?: TaskCallProjectionPort
  ) {}

  async listTasks(): Promise<
    StorageIpcResult<StorageReadModelListDto<StorageTaskSummaryDto>>
  > {
    try {
      const items: StorageTaskSummaryDto[] = [];
      const issues: StorageReadModelIssueDto[] = [];
      const callRecords = await loadCallRecords(this.calls);
      const callsByTask = callRecords
        ? groupBy(
            callRecords.filter((item) => item.taskId),
            (item) => `${item.projectId}\u0000${item.taskId}`
          )
        : new Map<string, readonly StorageCallRecordSummaryDto[]>();

      for (const entry of await this.catalog.getEntries()) {
        if (!(await isAvailable(entry))) {
          issues.push(toIssue(entry, 'unavailable'));
          continue;
        }

        try {
          const context = createContext(entry);
          const tasks = await context.tasks.list(entry.projectId);
          for (const task of tasks) {
            const executions = filterLinkedExecutions(
              task,
              await context.executions.list(task.id)
            );
            items.push(toTaskSummary(
              entry,
              task,
              executions,
              callsByTask.get(`${entry.projectId}\u0000${task.id}`) ?? []
            ));
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
      const callRecords = await loadCallRecords(this.calls);
      for (const entry of await this.catalog.getEntries()) {
        if (!(await isAvailable(entry))) continue;
        try {
          const context = createContext(entry);
          const task = await context.tasks.get(toTaskId(taskId));
          if (!task) continue;
          const executions = filterLinkedExecutions(
            task,
            await context.executions.list(task.id)
          );
          return {
            ok: true,
            value: toTaskDetails(
              entry,
              task,
              executions,
              callRecords?.filter((item) =>
                item.projectId === entry.projectId && item.taskId === taskId
              ) ?? []
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
          const context = createContext(entry);
          const works = await context.works.list(entry.projectId);
          for (const work of works) {
            const execution = await context.executions.get(work.sourceExecutionId);
            if (!execution || execution.state !== 'completed') continue;
            const file = await context.files.get(work.fileId);
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
          const context = createContext(entry);
          const work = await context.works.get(toWorkId(workId));
          if (!work) continue;
          const execution = await context.executions.get(work.sourceExecutionId);
          if (!execution || execution.state !== 'completed') {
            return { ok: true, value: undefined };
          }
          const file = await context.files.get(work.fileId);
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
}

function createContext(entry: ProjectCatalogEntry) {
  const storage = new NodeProjectStorage(entry.rootDirectory);
  return {
    tasks: new JsonTaskRepository(storage, entry.projectId),
    executions: new JsonExecutionRepository(storage),
    works: new JsonWorkRepository(storage, entry.projectId),
    files: new JsonFileReferenceRepository(storage, entry.projectId)
  };
}

function toTaskSummary(
  entry: ProjectCatalogEntry,
  task: Task,
  executions: readonly Execution[],
  calls: readonly StorageCallRecordSummaryDto[]
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
    retryability: latest?.failure?.retryability,
    routeSummary: summarizeRoute(calls),
    usageSummary: summarizeUsage(task, calls)
  };
}

function toTaskDetails(
  entry: ProjectCatalogEntry,
  task: Task,
  executions: readonly Execution[],
  calls: readonly StorageCallRecordSummaryDto[]
): StorageTaskDetailsDto {
  const summary = toTaskSummary(entry, task, executions, calls);
  return {
    ...summary,
    callRecords: calls,
    sourceDraftId: task.sourceDraftId,
    originalInput: task.submission.kind === 'video_editing'
      ? task.submission.videoEditing.title
      : task.submission.prompt.originalInput,
    finalPrompt: task.submission.kind === 'video_editing'
      ? `本地视频导出，草稿版本 ${task.submission.videoEditing.draftRevision}`
      : task.submission.prompt.finalPrompt
  };
}

function summarizeRoute(
  calls: readonly StorageCallRecordSummaryDto[]
): StorageTaskSummaryDto['routeSummary'] {
  if (calls.length === 0) return { state: 'unavailable' };
  const routes = new Set(calls.map((call) =>
    `${call.providerId}\u0000${call.connectionId}\u0000${call.modelId}`
  ));
  if (routes.size !== 1) return { state: 'mixed' };
  const route = calls[0];
  return {
    state: 'single',
    ...(route.providerName ? { providerName: route.providerName } : {}),
    ...(route.connectionName ? { connectionName: route.connectionName } : {}),
    ...(route.modelName ? { modelName: route.modelName } : {})
  };
}

function summarizeUsage(
  task: Task,
  calls: readonly StorageCallRecordSummaryDto[]
): StorageTaskSummaryDto['usageSummary'] {
  if (task.submission.kind === 'video_editing') {
    return usageSummary('not_applicable', []);
  }
  if (calls.length === 0) {
    return usageSummary('not_collected_legacy', []);
  }
  if (calls.some((call) => call.usageAvailability === 'invalid_response')) {
    return usageSummary('invalid_response', []);
  }
  if (calls.some((call) => call.usageAvailability === 'unknown_outcome')) {
    return usageSummary('unknown_outcome', []);
  }

  const factsByMetricAndUnit = groupBy(
    calls.flatMap((call) => call.usageFacts),
    (fact) => `${fact.metricId}\u0000${fact.unit}`
  );
  let invalidQuantity = false;
  const facts = [...factsByMetricAndUnit.values()].flatMap((metricFacts) => {
    const quantity = sumDecimalStrings(metricFacts.map((fact) => fact.quantity));
    if (quantity === undefined) {
      invalidQuantity = true;
      return [];
    }
    return [{
      metricId: metricFacts[0].metricId,
      quantity,
      unit: metricFacts[0].unit
    }];
  }).sort((left, right) => left.metricId.localeCompare(right.metricId));

  if (facts.length === 0) {
    if (calls.every((call) => call.usageAvailability === 'not_reported')) {
      return usageSummary('not_reported', []);
    }
    if (calls.every((call) => call.usageAvailability === 'not_applicable')) {
      return usageSummary('not_applicable', []);
    }
    if (calls.every((call) => call.usageAvailability === 'not_collected_legacy')) {
      return usageSummary('not_collected_legacy', []);
    }
  }
  const executionsWithCalls = new Set(calls.map((call) => call.executionId));
  const complete = !invalidQuantity &&
    task.executionIds.every((executionId) => executionsWithCalls.has(executionId)) &&
    calls.every((call) => call.usageAvailability === 'reported_complete');
  return usageSummary(complete ? 'reported_complete' : 'reported_partial', facts);
}

function usageSummary(
  availability: StorageTaskSummaryDto['usageSummary']['availability'],
  facts: StorageTaskSummaryDto['usageSummary']['facts']
): StorageTaskSummaryDto['usageSummary'] {
  return {
    availability,
    display: facts.length > 0
      ? facts.map((fact) => `${fact.quantity} ${fact.unit}`).join(' · ')
      : availability,
    facts
  };
}

function sumDecimalStrings(values: readonly string[]): string | undefined {
  if (values.length === 0 || values.some((value) => !/^\d+(?:\.\d+)?$/.test(value))) {
    return undefined;
  }
  const scale = Math.max(...values.map((value) => value.split('.')[1]?.length ?? 0));
  const total = values.reduce((sum, value) => {
    const [whole, fraction = ''] = value.split('.');
    return sum + BigInt(`${whole}${fraction.padEnd(scale, '0')}`);
  }, 0n);
  const digits = total.toString().padStart(scale + 1, '0');
  if (scale === 0) return digits;
  const whole = digits.slice(0, -scale);
  const fraction = digits.slice(-scale).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}

function groupBy<T>(
  values: readonly T[],
  key: (value: T) => string
): Map<string, readonly T[]> {
  const grouped = new Map<string, T[]>();
  for (const value of values) {
    const id = key(value);
    grouped.set(id, [...(grouped.get(id) ?? []), value]);
  }
  return grouped;
}

async function loadCallRecords(
  calls: TaskCallProjectionPort | undefined
): Promise<readonly StorageCallRecordSummaryDto[] | undefined> {
  if (!calls) return undefined;
  const items: StorageCallRecordSummaryDto[] = [];
  for (let offset = 0; ; offset += 200) {
    const result = await calls.listCallRecords({ offset, limit: 200 });
    if (!result.ok) return undefined;
    items.push(...result.value.items);
    if (items.length >= result.value.total) return items;
  }
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
