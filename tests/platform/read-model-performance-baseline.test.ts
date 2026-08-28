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

describe('read-model I/O performance baseline', () => {
  it('captures the pre-optimization task and work read amplification deterministically', async () => {
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
    const workStart = performance.now();
    const works = await controller.listWorks();
    const workDurationMs = performance.now() - workStart;

    expect(tasks).toMatchObject({ ok: true, value: { items: { length: 50 } } });
    expect(works).toMatchObject({ ok: true, value: { items: { length: 50 } } });
    expect(taskReads.get(projectStoragePaths.entities.tasks)).toBe(projectCount);
    expect(taskReads.get(projectStoragePaths.entities.executions)).toBe(
      projectCount * tasksPerProject
    );
    expect(reads.get(projectStoragePaths.entities.works)).toBe(projectCount);
    expect(reads.get(projectStoragePaths.entities.executions)).toBe(
      projectCount * tasksPerProject
    );
    expect(reads.get(projectStoragePaths.entities.fileReferences)).toBe(
      projectCount * tasksPerProject
    );
    expect(taskDurationMs).toBeGreaterThanOrEqual(0);
    expect(workDurationMs).toBeGreaterThanOrEqual(0);
  });
});

async function createProjectFixture(projectIndex: number, itemCount: number): Promise<string> {
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
    tasks.push(task(projectId, taskId, executionId, suffix));
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
