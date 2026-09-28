import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  toDraftId,
  toExecutionId,
  toFileReferenceId,
  toIsoTimestamp,
  toProjectId,
  toTaskId,
  toWorkId,
  type Execution,
  type FileReference,
  type ProjectId,
  type Task,
  type Work
} from '../../src/domain';
import {
  GlobalReadModelController,
  InMemoryProjectCatalogStore,
  NodeProjectStorage,
  ProjectCatalogService,
  projectStoragePaths,
  type ProjectRelativePath
} from '../../src/platform';

const roots: string[] = [];
const createdAt = toIsoTimestamp('2026-08-28T00:00:00.000Z');
const updatedAt = toIsoTimestamp('2026-08-28T00:01:00.000Z');
const checksum = 'a'.repeat(64);

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('read-model I/O performance gate', () => {
  it('uses attempt order, preserves cancelled tasks and rejects mismatched or unverified works', async () => {
    const root = await createProjectFixture(0, 3, true);
    const storage = new NodeProjectStorage(root);
    const projectId = toProjectId('project-performance-0');
    const catalog = new ProjectCatalogService(new InMemoryProjectCatalogStore());
    await catalog.remember({ projectId, projectName: 'History boundary', rootDirectory: root });
    const tasks = (await storage.readJsonWithBackup(projectStoragePaths.entities.tasks, v => v as { entities: Task[] }))!.value.entities;
    const executions = (await storage.readJsonWithBackup(projectStoragePaths.entities.executions, v => v as { entities: Execution[] }))!.value.entities;
    const files = (await storage.readJsonWithBackup(projectStoragePaths.entities.fileReferences, v => v as { entities: FileReference[] }))!.value.entities;
    const retry = { ...executions[0]!, id: toExecutionId('retry'), attempt: 2, state: 'failed' as const, updatedAt: createdAt };
    await writeCollection(storage, projectStoragePaths.entities.tasks, tasks.map((t, i) => i === 0 ? { ...t, executionIds: [...t.executionIds, retry.id] } : t));
    await writeCollection(storage, projectStoragePaths.entities.executions, [...executions.map((e, i) => i === 2 ? { ...e, state: 'cancelled' } : e), retry]);
    await writeCollection(storage, projectStoragePaths.entities.fileReferences, files.map((f, i) => i === 1 ? { ...f, lastVerification: { ...f.lastVerification!, matchesExpected: false } } : f));
    const extra = work(projectId, tasks[0]!.id, executions[1]!.id, files[0]!.id, 'mismatched');
    const works = (await storage.readJsonWithBackup(projectStoragePaths.entities.works, v => v as { entities: Work[] }))!.value.entities;
    await writeCollection(storage, projectStoragePaths.entities.works, [...works, extra]);
    const result = await new GlobalReadModelController(catalog).listGenerationHistory({ projectId, draftId: 'draft-performance-shared-0', mediaKind: 'image' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.issues).toEqual([]);
    expect(result.value.activeItems).toEqual([]);
    expect(result.value.items).toHaveLength(3);
    expect(result.value.items.find(t => t.taskId === tasks[0]!.id)).toMatchObject({ state: 'failed', works: [{ workId: works[0]!.id }] });
    expect(result.value.items.find(t => t.taskId === tasks[0]!.id)?.works).toHaveLength(1);
    expect(result.value.items.find(t => t.taskId === tasks[1]!.id)?.works).toEqual([]);
    expect(result.value.items.find(t => t.taskId === tasks[2]!.id)).toMatchObject({ state: 'cancelled', works: [] });
    await writeCollection(storage, projectStoragePaths.entities.executions, [...executions, {
      ...retry, failure: { stage: 'processing', message: '查询中断', retryability: 'unknown' }
    }]);
    const uncertain = await new GlobalReadModelController(catalog).listGenerationHistory({ projectId, draftId: 'draft-performance-shared-0', mediaKind: 'image' });
    expect(uncertain.ok && uncertain.value.activeItems.find(t => t.taskId === tasks[0]!.id))
      .toMatchObject({ state: 'submission_outcome_unknown', works: [{ workId: works[0]!.id }] });
  });
  it('reads each project entity file at most once per task and work snapshot', async () => {
    const projectCount = 2;
    const tasksPerProject = 25;
    const catalog = new ProjectCatalogService(new InMemoryProjectCatalogStore());
    for (let projectIndex = 0; projectIndex < projectCount; projectIndex += 1) {
      const root = await createProjectFixture(projectIndex, tasksPerProject);
      await catalog.remember({
        projectId: toProjectId(`project-performance-${projectIndex}`),
        projectName: `Performance project ${projectIndex}`,
        rootDirectory: root
      });
    }

    const reads = new Map<string, number>();
    const original = NodeProjectStorage.prototype.readJsonWithBackup;
    vi.spyOn(NodeProjectStorage.prototype, 'readJsonWithBackup')
      .mockImplementation(async function (
        this: NodeProjectStorage,
        relativePath,
        parse
      ) {
        const key = String(relativePath);
        reads.set(key, (reads.get(key) ?? 0) + 1);
        return original.call(this, relativePath, parse);
      });

    const controller = new GlobalReadModelController(catalog);
    const taskStart = performance.now();
    const tasks = await controller.listTasks();
    const taskDurationMs = performance.now() - taskStart;
    const taskReads = new Map(reads);
    reads.clear();
    controller.invalidate();
    const workStart = performance.now();
    const works = await controller.listWorks();
    const workDurationMs = performance.now() - workStart;

    expect(tasks).toMatchObject({ ok: true, value: { items: { length: 50 } } });
    expect(works).toMatchObject({ ok: true, value: { items: { length: 50 } } });
    expect(taskReads.get(projectStoragePaths.entities.tasks)).toBe(projectCount);
    expect(taskReads.get(projectStoragePaths.entities.executions)).toBe(projectCount);
    expect(reads.get(projectStoragePaths.entities.works)).toBe(projectCount);
    expect(reads.get(projectStoragePaths.entities.executions)).toBe(projectCount);
    expect(reads.get(projectStoragePaths.entities.fileReferences)).toBe(projectCount);
    expect(taskDurationMs).toBeGreaterThanOrEqual(0);
    expect(workDurationMs).toBeGreaterThanOrEqual(0);
  });

  it('coalesces concurrent identical queries into one read per project file', async () => {
    const catalog = new ProjectCatalogService(new InMemoryProjectCatalogStore());
    const root = await createProjectFixture(0, 25);
    await catalog.remember({
      projectId: toProjectId('project-performance-0'),
      projectName: 'Performance project 0',
      rootDirectory: root
    });
    const reads = new Map<string, number>();
    const original = NodeProjectStorage.prototype.readJsonWithBackup;
    vi.spyOn(NodeProjectStorage.prototype, 'readJsonWithBackup')
      .mockImplementation(async function (this: NodeProjectStorage, relativePath, parse) {
        const key = String(relativePath);
        reads.set(key, (reads.get(key) ?? 0) + 1);
        return original.call(this, relativePath, parse);
      });

    const controller = new GlobalReadModelController(catalog);
    const results = await Promise.all(
      Array.from({ length: 20 }, () => controller.listTasks())
    );

    expect(results.every((result) => result.ok && result.value.items.length === 25)).toBe(true);
    expect(reads.get(projectStoragePaths.entities.tasks)).toBe(1);
    expect(reads.get(projectStoragePaths.entities.executions)).toBe(1);
  });

  it('pages one draft history without reading any other project', async () => {
    const catalog = new ProjectCatalogService(new InMemoryProjectCatalogStore());
    const targetRoot = await createProjectFixture(0, 25, true);
    const otherRoot = await createProjectFixture(1, 25, true);
    await catalog.remember({
      projectId: toProjectId('project-performance-0'),
      projectName: 'Performance project 0',
      rootDirectory: targetRoot
    });
    await catalog.remember({
      projectId: toProjectId('project-performance-1'),
      projectName: 'Performance project 1',
      rootDirectory: otherRoot
    });
    const reads = new Map<string, number>();
    const original = NodeProjectStorage.prototype.readJsonWithBackup;
    vi.spyOn(NodeProjectStorage.prototype, 'readJsonWithBackup')
      .mockImplementation(async function (this: NodeProjectStorage, relativePath, parse) {
        const key = String(relativePath);
        reads.set(key, (reads.get(key) ?? 0) + 1);
        return original.call(this, relativePath, parse);
      });

    const controller = new GlobalReadModelController(catalog);
    const first = await controller.listGenerationHistory({
      projectId: 'project-performance-0',
      draftId: 'draft-performance-shared-0',
      mediaKind: 'image',
      limit: 20
    });
    expect(first).toMatchObject({ ok: true, value: { items: { length: 20 }, nextCursor: expect.any(String) } });
    if (!first.ok || !first.value.nextCursor) throw new TypeError('Missing cursor');
    const second = await controller.listGenerationHistory({
      projectId: 'project-performance-0',
      draftId: 'draft-performance-shared-0',
      mediaKind: 'image',
      cursor: first.value.nextCursor,
      limit: 20
    });
    expect(second.ok && second.value.items).toHaveLength(5);
    expect(second.ok && second.value.nextCursor).toBeUndefined();
    const ids = [...first.value.items, ...(second.ok ? second.value.items : [])]
      .map((item) => item.taskId);
    expect(new Set(ids).size).toBe(25);
    for (const path of [
      projectStoragePaths.entities.tasks,
      projectStoragePaths.entities.executions,
      projectStoragePaths.entities.works,
      projectStoragePaths.entities.fileReferences
    ]) expect(reads.get(path)).toBe(1);
  });

  it('keeps verified works together in one task card and returns active tasks outside history paging', async () => {
    const catalog = new ProjectCatalogService(new InMemoryProjectCatalogStore());
    const root = await createProjectFixture(0, 100, true);
    await catalog.remember({ projectId: toProjectId('project-performance-0'), projectName: 'Performance project 0', rootDirectory: root });
    const storage = new NodeProjectStorage(root);
    const tasks = (await storage.readJsonWithBackup(projectStoragePaths.entities.tasks, (value) => value as { entities: Task[] }))!.value;
    const executions = (await storage.readJsonWithBackup(projectStoragePaths.entities.executions, (value) => value as { entities: Execution[] }))!.value.entities;
    const activeTask = tasks.entities[0]!;
    const retryExecutionId = toExecutionId('execution-performance-retry');
    const retryExecution = {
      ...execution(activeTask.id, retryExecutionId),
      attempt: 2,
      state: 'processing' as const,
      updatedAt: toIsoTimestamp('2026-08-28T00:02:00.000Z')
    };
    const updatedTask = { ...activeTask, executionIds: [...activeTask.executionIds, retryExecutionId] };
    await writeCollection(storage, projectStoragePaths.entities.executions, [...executions, retryExecution]);
    await writeCollection(storage, projectStoragePaths.entities.tasks, [updatedTask, ...tasks.entities.slice(1)]);
    const extra = work(toProjectId('project-performance-0'), tasks.entities[1]!.id, executions[1]!.id, toFileReferenceId('file-performance-extra'), 'extra');
    const existingWorks = (await storage.readJsonWithBackup(projectStoragePaths.entities.works, (value) => value as { entities: Work[] }))!.value.entities;
    await writeCollection(storage, projectStoragePaths.entities.works, [...existingWorks, extra]);
    const existingFiles = (await storage.readJsonWithBackup(projectStoragePaths.entities.fileReferences, (value) => value as { entities: FileReference[] }))!.value.entities;
    await writeCollection(storage, projectStoragePaths.entities.fileReferences, [...existingFiles, file(toProjectId('project-performance-0'), toFileReferenceId('file-performance-extra'), executions[1]!.id, 'extra')]);

    const controller = new GlobalReadModelController(catalog);
    const first = await controller.listGenerationHistory({ projectId: 'project-performance-0', draftId: 'draft-performance-shared-0', mediaKind: 'image', limit: 20 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.activeItems.map((item) => item.taskId)).toContain(activeTask.id);
    const activeCard = first.value.activeItems.find((item) => item.taskId === activeTask.id);
    expect(activeCard).toMatchObject({ state: 'processing', works: [{ workId: 'work-performance-0-0' }] });
    expect(first.value.items.find((item) => item.taskId === tasks.entities[1]!.id)?.works).toHaveLength(2);
    expect(first.value.items).toHaveLength(20);
    expect(first.value.nextCursor).toBeTruthy();
  });

  it('meets the Windows synthetic 10-project and 1000-entity read targets', async () => {
    const projectCount = 10;
    const itemsPerProject = 100;
    const catalog = new ProjectCatalogService(new InMemoryProjectCatalogStore());
    for (let projectIndex = 0; projectIndex < projectCount; projectIndex += 1) {
      const root = await createProjectFixture(projectIndex, itemsPerProject, true);
      await catalog.remember({
        projectId: toProjectId(`project-performance-${projectIndex}`),
        projectName: `Performance project ${projectIndex}`,
        rootDirectory: root
      });
    }

    const controller = new GlobalReadModelController(catalog);
    const coldStartedAt = performance.now();
    const cold = await controller.listTasks();
    const coldTaskMs = performance.now() - coldStartedAt;
    expect(cold).toMatchObject({ ok: true, value: { items: { length: 1_000 } } });

    const warmDurations: number[] = [];
    for (let iteration = 0; iteration < 20; iteration += 1) {
      const startedAt = performance.now();
      await controller.listTasks();
      warmDurations.push(performance.now() - startedAt);
    }

    controller.invalidate();
    const historyStartedAt = performance.now();
    const history = await controller.listGenerationHistory({
      projectId: 'project-performance-0',
      draftId: 'draft-performance-shared-0',
      mediaKind: 'image',
      limit: 20
    });
    const coldHistoryMs = performance.now() - historyStartedAt;
    expect(history).toMatchObject({ ok: true, value: { items: { length: 20 } } });

    const metrics = {
      projectCount,
      taskCount: projectCount * itemsPerProject,
      coldTaskMs: roundMetric(coldTaskMs),
      warmTaskMedianMs: roundMetric(percentile(warmDurations, 0.5)),
      warmTaskP95Ms: roundMetric(percentile(warmDurations, 0.95)),
      coldHistoryMs: roundMetric(coldHistoryMs)
    };
    console.info(`read-model-performance ${JSON.stringify(metrics)}`);
    expect(metrics.coldTaskMs).toBeLessThan(800);
    expect(metrics.warmTaskP95Ms).toBeLessThan(300);
    expect(metrics.coldHistoryMs).toBeLessThan(600);
  }, 30_000);
});

function percentile(values: readonly number[], ratio: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)] ?? 0;
}

function roundMetric(value: number): number {
  return Math.round(value * 100) / 100;
}

async function createProjectFixture(
  projectIndex: number,
  itemCount: number,
  sharedDraft = false
): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-read-performance-'));
  roots.push(root);
  const projectId = toProjectId(`project-performance-${projectIndex}`);
  const tasks: Task[] = [];
  const executions: Execution[] = [];
  const works: Work[] = [];
  const files: FileReference[] = [];
  for (let itemIndex = 0; itemIndex < itemCount; itemIndex += 1) {
    const suffix = `${projectIndex}-${itemIndex}`;
    const taskId = toTaskId(`task-performance-${suffix}`);
    const executionId = toExecutionId(`execution-performance-${suffix}`);
    const fileId = toFileReferenceId(`file-performance-${suffix}`);
    tasks.push(task(
      projectId,
      taskId,
      executionId,
      sharedDraft ? `shared-${projectIndex}` : suffix
    ));
    executions.push(execution(taskId, executionId));
    files.push(file(projectId, fileId, executionId, suffix));
    works.push(work(projectId, taskId, executionId, fileId, suffix));
  }
  const storage = new NodeProjectStorage(root);
  await Promise.all([
    writeCollection(storage, projectStoragePaths.entities.tasks, tasks),
    writeCollection(storage, projectStoragePaths.entities.executions, executions),
    writeCollection(storage, projectStoragePaths.entities.works, works),
    writeCollection(storage, projectStoragePaths.entities.fileReferences, files)
  ]);
  return root;
}

async function writeCollection(
  storage: NodeProjectStorage,
  relativePath: ProjectRelativePath,
  entities: readonly unknown[]
): Promise<void> {
  await storage.writeJsonAtomically(relativePath, {
    schemaVersion: 2,
    revision: 1,
    entities
  });
}

function task(
  projectId: ProjectId,
  id: ReturnType<typeof toTaskId>,
  executionId: ReturnType<typeof toExecutionId>,
  suffix: string
): Task {
  return {
    schemaVersion: 1,
    id,
    projectId,
    sourceDraftId: toDraftId(`draft-performance-${suffix}`),
    submission: {
      kind: 'image_generation',
      prompt: {
        originalInput: `Original ${suffix}`,
        systemSupplements: [],
        finalPrompt: `Final ${suffix}`
      },
      assetIds: [],
      confirmedAt: createdAt
    },
    executionIds: [executionId],
    createdAt
  };
}

function execution(
  taskId: ReturnType<typeof toTaskId>,
  id: ReturnType<typeof toExecutionId>
): Execution {
  return {
    schemaVersion: 1,
    id,
    taskId,
    attempt: 1,
    state: 'completed',
    createdAt,
    updatedAt
  };
}

function file(
  projectId: ProjectId,
  id: ReturnType<typeof toFileReferenceId>,
  executionId: ReturnType<typeof toExecutionId>,
  suffix: string
): FileReference {
  return {
    schemaVersion: 1,
    id,
    projectId,
    sourceExecutionId: executionId,
    locator: { kind: 'project', relativePath: `files/result-${suffix}.png` },
    state: 'available',
    sizeBytes: 42,
    checksumSha256: checksum,
    lastVerification: {
      sizeBytes: 42,
      checksumSha256: checksum,
      matchesExpected: true,
      verifiedAt: updatedAt
    },
    createdAt,
    updatedAt
  };
}

function work(
  projectId: ProjectId,
  taskId: ReturnType<typeof toTaskId>,
  executionId: ReturnType<typeof toExecutionId>,
  fileId: ReturnType<typeof toFileReferenceId>,
  suffix: string
): Work {
  return {
    schemaVersion: 1,
    id: toWorkId(`work-performance-${suffix}`),
    projectId,
    sourceTaskId: taskId,
    sourceExecutionId: executionId,
    fileId,
    mediaKind: 'image',
    name: `Work ${suffix}`,
    createdAt: updatedAt
  };
}
