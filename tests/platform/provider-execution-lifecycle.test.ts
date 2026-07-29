import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createExecution,
  createProviderOperationRecord,
  createRetryExecution,
  toCapabilityEvidenceId,
  toConnectionId,
  toDraftId,
  toExecutionId,
  toIsoTimestamp,
  toModelId,
  toProjectId,
  toProviderId,
  toProviderOperationRecordId,
  toTaskId,
  transitionExecution,
  type Task
} from '../../src/domain';
import {
  JsonExecutionRepository,
  JsonProviderOperationRepository,
  NodeProjectStorage,
  projectStoragePaths,
  ProviderAsyncOperationCoordinator,
  ProviderExecutionLifecycleService
} from '../../src/platform';

const roots: string[] = [];
const t0 = toIsoTimestamp('2026-07-28T10:00:00.000Z');
const t1 = toIsoTimestamp('2026-07-28T10:00:01.000Z');
const t2 = toIsoTimestamp('2026-07-28T10:00:02.000Z');
const t3 = toIsoTimestamp('2026-07-28T10:00:03.000Z');

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe('provider execution lifecycle', () => {
  it('persists synchronous result receipts before remote completion and reloads them after restart', async () => {
    const fixture = await createFixture('sync');
    const task = imageTask('task-provider-sync');
    const submitting = transitionExecution(
      createExecution({
        id: toExecutionId('execution-provider-sync'),
        taskId: task.id,
        createdAt: t0
      }),
      'submitting',
      t1
    );
    await fixture.executions.save(submitting);
    const service = lifecycle(fixture, 'record-provider-sync');

    const completed = await service.applySubmitOutcome({
      task,
      execution: submitting,
      mediaKind: 'image',
      executionLifecycle: 'synchronous_completed',
      outcome: {
        kind: 'completed_sync',
        providerOperationId: 'vidu-sync-correlation',
        results: [
          {
            kind: 'base64',
            value: 'c3ludGhldGljLWltYWdl',
            mimeType: 'image/png'
          }
        ]
      }
    });

    expect(completed).toMatchObject({
      state: 'remote_completed',
      submissionOutcome: 'completed_sync',
      providerOperationRecordId: 'record-provider-sync'
    });
    expect(completed.remoteOperationId).toBeUndefined();
    const restarted = new JsonProviderOperationRepository(fixture.storage);
    await expect(
      restarted.getByExecution(submitting.id)
    ).resolves.toMatchObject({
      automaticRetryCount: 0,
      outcome: {
        kind: 'completed_sync',
        results: [{ kind: 'base64', mimeType: 'image/png' }]
      }
    });
  });

  it('recovers an execution when the immutable receipt was saved before the execution update', async () => {
    const fixture = await createFixture('recover');
    const task = imageTask('task-provider-recover');
    const submitting = transitionExecution(
      createExecution({
        id: toExecutionId('execution-provider-recover'),
        taskId: task.id,
        createdAt: t0
      }),
      'submitting',
      t1
    );
    await fixture.executions.save(submitting);
    await fixture.operations.save(
      createProviderOperationRecord({
        id: toProviderOperationRecordId('record-provider-recover'),
        taskId: task.id,
        executionId: submitting.id,
        mediaKind: 'image',
        executionLifecycle: 'synchronous_completed',
        outcome: {
          kind: 'completed_sync',
          providerOperationId: 'vidu-sync-recover',
          results: [
            { kind: 'remote_url', value: 'https://synthetic.invalid/result.png' }
          ]
        },
        createdAt: t1,
        updatedAt: t1
      })
    );

    await expect(
      lifecycle(fixture, 'unused-record').recoverExecution(
        toProviderOperationRecordId('record-provider-recover')
      )
    ).resolves.toMatchObject({
      state: 'remote_completed',
      providerOperationRecordId: 'record-provider-recover'
    });
  });

  it('freezes an unknown paid submission with zero automatic retries', async () => {
    const fixture = await createFixture('unknown');
    const task = imageTask('task-provider-unknown');
    const submitting = transitionExecution(
      createExecution({
        id: toExecutionId('execution-provider-unknown'),
        taskId: task.id,
        createdAt: t0
      }),
      'submitting',
      t1
    );
    await fixture.executions.save(submitting);
    const service = lifecycle(fixture, 'record-provider-unknown');
    const unknown = await service.applySubmitOutcome({
      task,
      execution: submitting,
      mediaKind: 'image',
      executionLifecycle: 'synchronous_completed',
      outcome: {
        kind: 'submission_outcome_unknown',
        message: 'Synthetic transport closed after request write'
      }
    });

    expect(unknown.state).toBe('submission_outcome_unknown');
    expect(() =>
      createRetryExecution(
        unknown,
        toExecutionId('execution-provider-unknown-retry'),
        t2
      )
    ).toThrow('paid submission outcome is unknown');
    const records = await service.listRecoverable();
    expect(records).toHaveLength(1);
    expect(records[0].automaticRetryCount).toBe(0);
  });

  it('persists async provider IDs and supports query, completion and cancellation ports', async () => {
    const fixture = await createFixture('async');
    const task = videoTask('task-provider-async');
    const submitting = transitionExecution(
      createExecution({
        id: toExecutionId('execution-provider-async'),
        taskId: task.id,
        createdAt: t0
      }),
      'submitting',
      t1
    );
    await fixture.executions.save(submitting);
    const service = lifecycle(fixture, 'record-provider-async');
    const accepted = await service.applySubmitOutcome({
      task,
      execution: submitting,
      mediaKind: 'video',
      executionLifecycle: 'asynchronous_polling',
      outcome: {
        kind: 'accepted_async',
        providerOperationId: 'synthetic-task-id',
        state: 'queued'
      }
    });
    expect(accepted).toMatchObject({
      state: 'queued',
      remoteOperationId: 'synthetic-task-id'
    });

    const queries: string[] = [];
    const coordinator = new ProviderAsyncOperationCoordinator(
      fixture.executions,
      fixture.operations,
      {
        query: async (id) => {
          queries.push(id);
          return { state: 'completed' };
        },
        cancel: async () => ({ state: 'cancelled' })
      },
      () => t2
    );
    await expect(
      coordinator.refresh(toProviderOperationRecordId('record-provider-async'))
    ).resolves.toMatchObject({ state: 'remote_completed' });
    expect(queries).toEqual(['synthetic-task-id']);

    const cancelFixture = await createFixture('cancel');
    const cancelTask = videoTask('task-provider-cancel');
    const cancelSubmitting = transitionExecution(
      createExecution({
        id: toExecutionId('execution-provider-cancel'),
        taskId: cancelTask.id,
        createdAt: t0
      }),
      'submitting',
      t1
    );
    await cancelFixture.executions.save(cancelSubmitting);
    await lifecycle(cancelFixture, 'record-provider-cancel').applySubmitOutcome({
      task: cancelTask,
      execution: cancelSubmitting,
      mediaKind: 'video',
      executionLifecycle: 'asynchronous_polling',
      outcome: {
        kind: 'accepted_async',
        providerOperationId: 'synthetic-cancel-task-id',
        state: 'processing'
      }
    });
    let clock = t2;
    const cancelCoordinator = new ProviderAsyncOperationCoordinator(
      cancelFixture.executions,
      cancelFixture.operations,
      {
        query: async () => ({ state: 'processing' }),
        cancel: async () => ({ state: 'cancelled' })
      },
      () => {
        const current = clock;
        clock = t3;
        return current;
      }
    );
    await expect(
      cancelCoordinator.cancel(
        toProviderOperationRecordId('record-provider-cancel')
      )
    ).resolves.toMatchObject({ state: 'cancelled' });
  });

  it('migrates schema v1 receipts and rejects corrupted synchronous receipts', async () => {
    const fixture = await createFixture('migration');
    await fixture.storage.writeJsonAtomically(
      projectStoragePaths.entities.providerOperations,
      {
        schemaVersion: 1,
        records: [
          {
            schemaVersion: 1,
            id: 'record-provider-v1',
            taskId: 'task-provider-v1',
            executionId: 'execution-provider-v1',
            mediaKind: 'image',
            executionLifecycle: 'synchronous_completed',
            outcome: {
              kind: 'completed_sync',
              providerOperationId: 'provider-v1',
              results: [
                {
                  kind: 'file_uri',
                  value: 'synthetic://provider/result'
                }
              ]
            },
            createdAt: t0,
            updatedAt: t0
          }
        ]
      }
    );
    await expect(fixture.operations.list()).resolves.toMatchObject([
      { schemaVersion: 2, automaticRetryCount: 0 }
    ]);

    await fixture.storage.writeJsonAtomically(
      projectStoragePaths.entities.providerOperations,
      {
        schemaVersion: 2,
        records: [
          {
            schemaVersion: 2,
            id: 'record-provider-corrupt',
            taskId: 'task-provider-corrupt',
            executionId: 'execution-provider-corrupt',
            mediaKind: 'image',
            executionLifecycle: 'synchronous_completed',
            outcome: {
              kind: 'completed_sync',
              providerOperationId: 'provider-corrupt',
              results: []
            },
            automaticRetryCount: 0,
            createdAt: t0,
            updatedAt: t0
          }
        ]
      }
    );
    await expect(fixture.operations.list()).rejects.toThrow(
      'provider operation document is invalid'
    );
  });
});

async function createFixture(name: string) {
  const root = await mkdtemp(
    path.join(os.tmpdir(), `unicomp-provider-lifecycle-${name}-`)
  );
  roots.push(root);
  const storage = new NodeProjectStorage(root);
  return {
    storage,
    executions: new JsonExecutionRepository(storage),
    operations: new JsonProviderOperationRepository(storage)
  };
}

function lifecycle(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  recordId: string
) {
  return new ProviderExecutionLifecycleService({
    executionRepository: fixture.executions,
    operationRepository: fixture.operations,
    createRecordId: () => toProviderOperationRecordId(recordId),
    now: () => t2
  });
}

function imageTask(id: string): Task {
  return {
    schemaVersion: 1,
    id: toTaskId(id),
    projectId: toProjectId('project-provider-lifecycle'),
    sourceDraftId: toDraftId(`draft-${id}`),
    submission: {
      kind: 'image_generation',
      prompt: {
        originalInput: 'synthetic image',
        systemSupplements: [],
        finalPrompt: 'synthetic image'
      },
      assetIds: [],
      confirmedAt: t0,
      image: {
        mode: 'quick_image',
        purpose: 'image_generation',
        modelId: toModelId('model-provider-image'),
        capabilityEvidenceId: toCapabilityEvidenceId('evidence-provider-image'),
        providerId: toProviderId('provider-lifecycle'),
        connectionId: toConnectionId('connection-lifecycle'),
        recipientName: 'Synthetic provider',
        accessCategory: 'online',
        outboundScope: 'external_service',
        costState: 'unknown',
        privacyState: 'unknown',
        regionState: 'unknown',
        parameters: {},
        confirmations: {
          recipient: true,
          outboundScope: true,
          cost: true,
          finalPrompt: true,
          model: true
        }
      }
    },
    executionIds: [],
    createdAt: t0
  };
}

function videoTask(id: string): Task {
  return {
    schemaVersion: 1,
    id: toTaskId(id),
    projectId: toProjectId('project-provider-lifecycle'),
    sourceDraftId: toDraftId(`draft-${id}`),
    submission: {
      kind: 'video_generation',
      prompt: {
        originalInput: 'synthetic video',
        systemSupplements: [],
        finalPrompt: 'synthetic video'
      },
      assetIds: [],
      confirmedAt: t0,
      video: {
        mode: 'quick_video',
        purpose: 'video_generation',
        modelId: toModelId('model-provider-video'),
        capabilityEvidenceId: toCapabilityEvidenceId('evidence-provider-video'),
        providerId: toProviderId('provider-lifecycle'),
        connectionId: toConnectionId('connection-lifecycle'),
        recipientName: 'Synthetic provider',
        accessCategory: 'online',
        outboundScope: 'external_service',
        costState: 'unknown',
        privacyState: 'unknown',
        regionState: 'unknown',
        parameters: {},
        materials: [],
        contextReferences: [],
        input: { mode: 'quick_video' },
        confirmations: {
          recipient: true,
          outboundScope: true,
          materials: true,
          costPrivacyRegion: true,
          finalPrompt: true,
          model: true
        }
      }
    },
    executionIds: [],
    createdAt: t0
  };
}
