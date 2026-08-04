import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  toDraftId,
  toExecutionId,
  toFileReferenceId,
  toIsoTimestamp,
  toProjectId,
  toTaskId,
  toVideoExportPlanId,
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
  JsonTaskRepository,
  JsonWorkRepository,
  NodeProjectStorage,
  ProjectCatalogService
} from '../../src/platform';
import type { StorageCallRecordSummaryDto } from '../../src/shared/storage-ipc';

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
    const callRecords: readonly StorageCallRecordSummaryDto[] = [
      callRecord('attempt-read-model-1', '1.25'),
      callRecord('attempt-read-model-2', '2.25'),
      callRecord('attempt-read-model-3', '4', 'token')
    ];
    const controller = new GlobalReadModelController(catalog, {
      async listCallRecords(request) {
        const input = request as { readonly offset: number; readonly limit: number };
        return {
          ok: true,
          value: {
            items: callRecords.slice(input.offset, input.offset + input.limit),
            total: callRecords.length,
            offset: input.offset,
            limit: input.limit,
            issues: []
          }
        };
      }
    });

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
            executionCount: 1,
            routeSummary: {
              state: 'single',
              providerName: 'Provider A',
              connectionName: 'Connection A',
              modelName: 'Model A'
            },
            usageSummary: {
              availability: 'reported_complete',
              facts: [
                { metricId: 'credits', quantity: '3.5', unit: 'credit' },
                { metricId: 'credits', quantity: '4', unit: 'token' }
              ]
            }
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
        callRecords: [
          { invocationAttemptId: 'attempt-read-model-1' },
          { invocationAttemptId: 'attempt-read-model-2' },
          { invocationAttemptId: 'attempt-read-model-3' }
        ]
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

  it('projects mixed routes, partial usage, ignores conversation calls, and marks local work not applicable', async () => {
    const root = await createRoot('unicomp-read-model-projection-');
    const projectId = await createValidProject(root);
    const storage = new NodeProjectStorage(root);
    await new JsonTaskRepository(storage, projectId).save({
      schemaVersion: 1,
      id: toTaskId('task-local-edit'),
      projectId,
      sourceDraftId: toDraftId('draft-local-edit'),
      submission: {
        kind: 'video_editing',
        confirmedAt: t0,
        videoEditing: {
          exportPlanId: toVideoExportPlanId('plan-local-edit'),
          draftRevision: 1,
          title: '本地编辑'
        }
      },
      executionIds: [],
      createdAt: t0
    });
    const catalog = new ProjectCatalogService(
      new InMemoryProjectCatalogStore(),
      () => t1
    );
    await catalog.remember({
      projectId,
      projectName: 'Read model project',
      rootDirectory: root
    });
    const first = callRecord('attempt-route-a', '1');
    const second = callRecord('attempt-route-b', '0', 'credit', {
      providerId: 'provider-b',
      connectionId: 'connection-b',
      modelId: 'model-b',
      providerName: 'Provider B',
      connectionName: 'Connection B',
      modelName: 'Model B',
      usageAvailability: 'not_reported',
      usageFacts: []
    });
    const conversation = callRecord('attempt-conversation', '99', 'credit', {
      subjectKind: 'conversation',
      taskId: undefined,
      executionId: undefined
    });
    const controller = new GlobalReadModelController(catalog, {
      async listCallRecords() {
        return {
          ok: true,
          value: {
            items: [first, second, conversation],
            total: 3,
            offset: 0,
            limit: 200,
            issues: []
          }
        };
      }
    });

    const tasks = await controller.listTasks();
    if (!tasks.ok) throw new Error(tasks.error.message);
    expect(tasks.value.items).toContainEqual(expect.objectContaining({
      taskId: 'task-read-model',
      routeSummary: { state: 'mixed' },
      usageSummary: expect.objectContaining({
        availability: 'reported_partial',
        facts: [{ metricId: 'credits', quantity: '1', unit: 'credit' }]
      })
    }));
    expect(tasks.value.items).toContainEqual(expect.objectContaining({
      taskId: 'task-local-edit',
      usageSummary: expect.objectContaining({ availability: 'not_applicable' })
    }));
    await expect(controller.getTaskDetails({ taskId: 'task-read-model' }))
      .resolves.toMatchObject({
        ok: true,
        value: { callRecords: [{ taskId: 'task-read-model' }, { taskId: 'task-read-model' }] }
      });
  });
});

function callRecord(
  invocationAttemptId: string,
  quantity: string,
  unit = 'credit',
  overrides: Partial<StorageCallRecordSummaryDto> = {}
): StorageCallRecordSummaryDto {
  return {
    invocationAttemptId,
    projectId: 'project-read-model',
    projectName: 'Read model project',
    subjectKind: 'media',
    taskId: 'task-read-model',
    executionId: 'execution-read-model',
    productFeature: 'text_to_image',
    providerId: 'provider-a',
    connectionId: 'connection-a',
    modelId: 'model-a',
    providerName: 'Provider A',
    connectionName: 'Connection A',
    modelName: 'Model A',
    displayNameAvailability: 'snapshotted',
    state: 'completed',
    createdAt: t0,
    updatedAt: t1,
    usageAvailability: 'reported_complete',
    usageFacts: [{
      metricId: 'credits',
      quantity,
      unit,
      source: 'provider'
    }],
    localResultCount: 1,
    resultRegistrationState: 'registered',
    ...overrides
  };
}
