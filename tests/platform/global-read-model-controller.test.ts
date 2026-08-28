import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createProviderOperationRecord,
  toDraftId,
  toExecutionId,
  toFileReferenceId,
  toIsoTimestamp,
  toProjectId,
  toProviderOperationRecordId,
  toTaskId,
  toWorkId,
  type Execution,
  type FileReference,
  type Task,
  type Work
} from '../../src/domain';
import {
  GlobalReadModelController,
  InMemoryProjectCatalogStore,
  JsonExecutionRepository,
  JsonFileReferenceRepository,
  JsonProviderOperationRepository,
  JsonTaskRepository,
  JsonWorkRepository,
  NodeProjectStorage,
  ProjectCatalogService
} from '../../src/platform';

const roots: string[] = [];
const t0 = toIsoTimestamp('2026-07-22T00:00:00.000Z');
const t1 = toIsoTimestamp('2026-07-22T00:01:00.000Z');
const checksum = 'a'.repeat(64);

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

async function createRoot(prefix: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function createValidProject(root: string) {
  const projectId = toProjectId('project-read-model');
  const storage = new NodeProjectStorage(root);
  const taskRepository = new JsonTaskRepository(storage, projectId);
  const executionRepository = new JsonExecutionRepository(storage);
  const fileRepository = new JsonFileReferenceRepository(storage, projectId);
  const workRepository = new JsonWorkRepository(storage, projectId);
  const task: Task = {
    schemaVersion: 1,
    id: toTaskId('task-read-model'),
    projectId,
    sourceDraftId: toDraftId('draft-read-model'),
    submission: {
      kind: 'image_generation',
      prompt: {
        originalInput: 'Original prompt',
        systemSupplements: [],
        finalPrompt: 'Final prompt'
      },
      assetIds: [],
      confirmedAt: t0
    },
    executionIds: [toExecutionId('execution-read-model')],
    createdAt: t0
  };
  const execution: Execution = {
    schemaVersion: 1,
    id: toExecutionId('execution-read-model'),
    taskId: task.id,
    attempt: 1,
    state: 'completed',
    createdAt: t0,
    updatedAt: t1
  };
  const file: FileReference = {
    schemaVersion: 1,
    id: toFileReferenceId('file-read-model'),
    projectId,
    sourceExecutionId: execution.id,
    locator: { kind: 'project', relativePath: 'files/result.png' },
    state: 'available',
    sizeBytes: 42,
    checksumSha256: checksum,
    lastVerification: {
      sizeBytes: 42,
      checksumSha256: checksum,
      matchesExpected: true,
      verifiedAt: t1
    },
    createdAt: t0,
    updatedAt: t1
  };
  const work: Work = {
    schemaVersion: 1,
    id: toWorkId('work-read-model'),
    projectId,
    sourceTaskId: task.id,
    sourceExecutionId: execution.id,
    fileId: file.id,
    mediaKind: 'image',
    name: 'Verified result',
    createdAt: t1
  };

  await taskRepository.save(task);
  await executionRepository.save(execution);
  await fileRepository.save(file);
  await workRepository.save(work);
  return projectId;
}

describe('GlobalReadModelController', () => {
  it('aggregates task and work DTOs while isolating unavailable projects', async () => {
    const root = await createRoot('unicomp-read-model-');
    const missingRoot = path.join(os.tmpdir(), 'unicomp-missing-read-model');
    const projectId = await createValidProject(root);
    const catalog = new ProjectCatalogService(
      new InMemoryProjectCatalogStore(),
      () => t1
    );
    await catalog.remember({
      projectId,
      projectName: 'Read model project',
      rootDirectory: root
    });
    await catalog.remember({
      projectId: toProjectId('project-unavailable'),
      projectName: 'Unavailable project',
      rootDirectory: missingRoot
    });
    const controller = new GlobalReadModelController(catalog);

    const tasks = await controller.listTasks();
    const works = await controller.listWorks();
    const taskDetails = await controller.getTaskDetails({
      taskId: 'task-read-model'
    });
    const workDetails = await controller.getWorkDetails({
      workId: 'work-read-model'
    });

    expect(tasks).toMatchObject({
      ok: true,
      value: {
        items: [
          {
            taskId: 'task-read-model',
            projectName: 'Read model project',
            latestExecutionState: 'completed',
            executionCount: 1
          }
        ],
        issues: [{ projectId: 'project-unavailable', reason: 'unavailable' }]
      }
    });
    expect(works).toMatchObject({
      ok: true,
      value: {
        items: [
          {
            workId: 'work-read-model',
            fileState: 'available',
            name: 'Verified result'
          }
        ]
      }
    });
    expect(taskDetails).toMatchObject({
      ok: true,
      value: {
        originalInput: 'Original prompt',
        finalPrompt: 'Final prompt',
        canRecoverVideoResult: false
      }
    });
    expect(workDetails).toMatchObject({
      ok: true,
      value: { sizeBytes: 42, verifiedAt: t1 }
    });
    const serialized = JSON.stringify({ tasks, works, taskDetails, workDetails });
    expect(serialized).not.toContain(root);
    expect(serialized).not.toContain(checksum);
  });

  it('marks corrupt project repositories without blocking healthy projects', async () => {
    const healthyRoot = await createRoot('unicomp-read-model-healthy-');
    const corruptRoot = await createRoot('unicomp-read-model-corrupt-');
    const healthyProjectId = await createValidProject(healthyRoot);
    await writeFile(
      path.join(corruptRoot, 'project.json'),
      JSON.stringify({ schemaVersion: 1 }),
      'utf8'
    );
    await writeFile(path.join(corruptRoot, 'entities-tasks.json'), '{', 'utf8');
    const catalog = new ProjectCatalogService(new InMemoryProjectCatalogStore());
    await catalog.remember({
      projectId: healthyProjectId,
      projectName: 'Healthy project',
      rootDirectory: healthyRoot
    });
    await catalog.remember({
      projectId: toProjectId('project-corrupt'),
      projectName: 'Corrupt project',
      rootDirectory: corruptRoot
    });
    const storage = new NodeProjectStorage(corruptRoot);
    await storage.writeJsonAtomically(
      'entities/tasks.json' as never,
      { schemaVersion: 2, entities: [] }
    );

    const result = await new GlobalReadModelController(catalog).listTasks();

    expect(result).toMatchObject({
      ok: true,
      value: {
        items: [{ taskId: 'task-read-model' }],
        issues: [{ projectId: 'project-corrupt', reason: 'invalid_data' }]
      }
    });
  });

  it('offers image recovery only for a persisted completed result in the open project', async () => {
    const root = await createRoot('unicomp-read-model-image-recovery-');
    const projectId = toProjectId('project-image-recovery-read-model');
    const storage = new NodeProjectStorage(root);
    const task: Task = {
      schemaVersion: 1,
      id: toTaskId('task-image-recovery-read-model'),
      projectId,
      sourceDraftId: toDraftId('draft-image-recovery-read-model'),
      submission: {
        kind: 'image_generation',
        prompt: {
          originalInput: 'Recover original image',
          systemSupplements: [],
          finalPrompt: 'Recover final image'
        },
        assetIds: [],
        confirmedAt: t0
      },
      executionIds: [toExecutionId('execution-image-recovery-read-model')],
      createdAt: t0
    };
    const operationId = toProviderOperationRecordId(
      'provider-operation-image-recovery-read-model'
    );
    const execution: Execution = {
      schemaVersion: 1,
      id: task.executionIds[0],
      taskId: task.id,
      attempt: 1,
      state: 'failed',
      providerOperationRecordId: operationId,
      submissionOutcome: 'completed_sync',
      failure: {
        stage: 'downloading',
        message: 'Temporary image download failure',
        retryability: 'retryable'
      },
      createdAt: t0,
      updatedAt: t1
    };
    await new JsonTaskRepository(storage, projectId).save(task);
    await new JsonExecutionRepository(storage).save(execution);
    await new JsonProviderOperationRepository(storage).save(
      createProviderOperationRecord({
        id: operationId,
        taskId: task.id,
        executionId: execution.id,
        mediaKind: 'image',
        executionLifecycle: 'synchronous_completed',
        outcome: {
          kind: 'completed_sync',
          providerOperationId: 'persisted-image-result',
          results: [{
            kind: 'remote_url',
            value: 'https://files.example.test/result.png'
          }]
        },
        createdAt: t0,
        updatedAt: t1
      })
    );
    const catalog = new ProjectCatalogService(new InMemoryProjectCatalogStore());
    await catalog.remember({
      projectId,
      projectName: 'Image recovery project',
      rootDirectory: root
    });
    const openController = new GlobalReadModelController(catalog, () => ({
      projectId,
      projectName: 'Image recovery project',
      rootDirectory: root
    }));
    const closedController = new GlobalReadModelController(catalog);

    await expect(openController.getTaskDetails({ taskId: task.id }))
      .resolves.toMatchObject({
        ok: true,
        value: { canRecoverImageResult: true }
      });
    await expect(closedController.getTaskDetails({ taskId: task.id }))
      .resolves.toMatchObject({
        ok: true,
        value: { canRecoverImageResult: false }
      });

    await new JsonExecutionRepository(storage).save({
      ...execution,
      failure: {
        stage: 'remote_completed',
        message: 'Temporary image result discovery failure',
        retryability: 'retryable'
      },
      updatedAt: toIsoTimestamp('2026-08-11T08:02:30.000Z')
    });
    openController.invalidate();
    await expect(openController.getTaskDetails({ taskId: task.id }))
      .resolves.toMatchObject({
        ok: true,
        value: { canRecoverImageResult: true }
      });

    await new JsonExecutionRepository(storage).save({
      ...execution,
      state: 'remote_completed',
      failure: undefined,
      updatedAt: toIsoTimestamp('2026-08-11T08:03:00.000Z')
    });
    openController.invalidate();
    await expect(openController.getTaskDetails({ taskId: task.id }))
      .resolves.toMatchObject({
        ok: true,
        value: { canRecoverImageResult: true }
      });
  });

  it('reports all project usage and free space for the current project disk without paths', async () => {
    const root = await createRoot('unicomp-storage-summary-');
    const missingParent = await createRoot('unicomp-storage-summary-missing-');
    const missingRoot = path.join(missingParent, 'not-present');
    await writeFile(path.join(root, 'project-data.bin'), '1234567');
    const catalog = new ProjectCatalogService(new InMemoryProjectCatalogStore());
    const projectId = toProjectId('project-storage-summary');
    await catalog.remember({
      projectId,
      projectName: 'Storage summary project',
      rootDirectory: root
    });
    await catalog.remember({
      projectId: toProjectId('project-storage-summary-missing'),
      projectName: 'Missing storage project',
      rootDirectory: missingRoot
    });
    const controller = new GlobalReadModelController(catalog, () => ({
      projectId,
      projectName: 'Storage summary project',
      rootDirectory: root
    }));

    const first = await controller.getLocalStorageSummary();
    expect(first).toMatchObject({
      ok: true,
      value: {
        projectUsage: {
          totalBytes: 7,
          projectCount: 2,
          measuredProjectCount: 1,
          unavailableProjectCount: 1,
          truncated: false
        },
        currentProject: {
          projectId: 'project-storage-summary',
          projectName: 'Storage summary project',
          diskFreeBytes: expect.any(Number)
        }
      }
    });
    expect(JSON.stringify(first)).not.toContain(root);

    await writeFile(path.join(root, 'more-project-data.bin'), '12345');
    await expect(controller.getLocalStorageSummary()).resolves.toMatchObject({
      value: { projectUsage: { totalBytes: 7 } }
    });
    controller.invalidateLocalStorageSummary();
    await expect(controller.getLocalStorageSummary()).resolves.toMatchObject({
      value: { projectUsage: { totalBytes: 12 } }
    });
  });
});
