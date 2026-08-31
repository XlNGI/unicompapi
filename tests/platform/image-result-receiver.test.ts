import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  addExecutionToTask,
  createEmptyImageWorkspaceDraft,
  createExecution,
  createImageTask,
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
  transitionExecution
} from '../../src/domain';
import {
  ImageWorkspaceMutationCoordinator,
  JsonExecutionRepository,
  JsonFileReferenceRepository,
  JsonTaskRepository,
  JsonWorkRepository,
  LocalImageResultReceiver,
  ImageResultPortError,
  NodeProjectStorage
} from '../../src/platform';

const roots: string[] = [];
const t0 = toIsoTimestamp('2026-07-23T06:00:00.000Z');

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

function pngBytes(width: number, height: number) {
  const buffer = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write('IHDR', 12, 'ascii');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

async function createFixture(options: {
  readonly badChecksum?: boolean;
  readonly descriptorFailure?: 'retryable' | 'not_retryable' | 'unknown';
  readonly diskFull?: boolean;
  readonly downloadFailure?: boolean;
  readonly downloadFailuresBeforeSuccess?: number;
  readonly startsRemoteCompleted?: boolean;
} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-image-result-'));
  roots.push(root);
  await mkdir(path.join(root, 'tmp'), { recursive: true });
  const projectId = toProjectId('project-image-result');
  const storage = new NodeProjectStorage(root);
  const draft = createEmptyImageWorkspaceDraft({
    id: toDraftId('draft-image-result'),
    projectId,
    mode: 'quick_image',
    createdAt: t0
  });
  const task = createImageTask({
    id: toTaskId('task-image-result'),
    draft: {
      ...draft,
      prompt: {
        originalInput: 'Create result',
        systemSupplements: [],
        finalPrompt: 'Create result'
      }
    },
    confirmation: {
      mode: 'quick_image',
      purpose: 'image_generation',
      modelId: toModelId('model-image-result'),
      capabilityEvidenceId: toCapabilityEvidenceId('evidence-image-result'),
      providerId: toProviderId('provider-image-result'),
      connectionId: toConnectionId('connection-image-result'),
      recipientName: 'Result provider',
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
    },
    confirmedAt: t0
  });
  const created = createExecution({
    id: toExecutionId('execution-image-result'),
    taskId: task.id,
    createdAt: t0
  });
  const submitting = transitionExecution(created, 'submitting', t0);
  const processing = transitionExecution(submitting, 'processing', t0, {
    remoteOperationId: 'remote-image-result'
  });
  const initialExecution = options.startsRemoteCompleted
    ? transitionExecution(submitting, 'remote_completed', t0, {
        providerOperationRecordId: toProviderOperationRecordId(
          'provider-operation-image-result'
        ),
        submissionOutcome: 'completed_sync'
      })
    : processing;
  const linkedTask = addExecutionToTask(task, initialExecution);
  await new JsonTaskRepository(storage, projectId).save(linkedTask);
  await new JsonExecutionRepository(storage).save(initialExecution);
  const times = [
    '2026-07-23T06:01:00.000Z',
    '2026-07-23T06:02:00.000Z',
    '2026-07-23T06:03:00.000Z',
    '2026-07-23T06:04:00.000Z',
    '2026-07-23T06:05:00.000Z',
    '2026-07-23T06:06:00.000Z',
    '2026-07-23T06:07:00.000Z'
  ];
  const bytes = pngBytes(320, 200);
  let downloadAttempts = 0;
  const receiver = new LocalImageResultReceiver({
    getSession: () => ({
      projectId,
      projectName: 'Image result project',
      rootDirectory: root
    }),
    port: {
      getCompletedResult: async () => {
        if (options.descriptorFailure) {
          throw new ImageResultPortError(
            options.descriptorFailure,
            'Synthetic result discovery failure'
          );
        }
        return {
          name: '../result-image.png',
          declaredMimeType: 'image/png',
          expectedSizeBytes: bytes.length,
          expectedChecksumSha256: options.badChecksum
            ? '0'.repeat(64)
            : undefined
        };
      },
      download: async (_remoteOperationId, destinationPath) => {
        downloadAttempts += 1;
        if (
          options.downloadFailure ||
          downloadAttempts <= (options.downloadFailuresBeforeSuccess ?? 0)
        ) {
          throw new ImageResultPortError('retryable', 'Temporary image download failure');
        }
        await writeFile(destinationPath, bytes);
      }
    },
    mutations: new ImageWorkspaceMutationCoordinator(),
    createFileId: () => 'file-image-result',
    createWorkId: () => 'work-image-result',
    publishFile: options.diskFull
      ? async () => {
          throw Object.assign(new Error('synthetic disk full'), {
            code: 'ENOSPC'
          });
        }
      : undefined,
    now: () => times.shift() ?? '2026-07-23T06:59:00.000Z'
  });
  return { projectId, receiver, root, storage, getDownloadAttempts: () => downloadAttempts };
}

describe('LocalImageResultReceiver', () => {
  it('registers a work only after download, verification and atomic project save', async () => {
    const fixture = await createFixture();
    const result = await fixture.receiver.receive('execution-image-result');

    expect(result).toEqual({
      ok: true,
      value: {
        workId: 'work-image-result',
        executionId: 'execution-image-result',
        name: 'result-image.png'
      }
    });
    const execution = await new JsonExecutionRepository(fixture.storage).get(
      toExecutionId('execution-image-result')
    );
    expect(execution?.state).toBe('completed');
    const works = await new JsonWorkRepository(
      fixture.storage,
      fixture.projectId
    ).list(fixture.projectId);
    expect(works).toHaveLength(1);
    const files = await new JsonFileReferenceRepository(
      fixture.storage,
      fixture.projectId
    ).list(fixture.projectId);
    expect(files[0]).toMatchObject({
      state: 'available',
      sourceExecutionId: 'execution-image-result',
      locator: { kind: 'project' }
    });
    expect(JSON.stringify(result)).not.toContain(fixture.root);
    await expect(readdir(path.join(fixture.root, 'tmp'))).resolves.toEqual([]);
  });

  it('rejects checksum mismatch, creates no work and records a failed execution', async () => {
    const fixture = await createFixture({ badChecksum: true });
    const result = await fixture.receiver.receive('execution-image-result');

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'result_verification_failed' }
    });
    await expect(
      new JsonWorkRepository(fixture.storage, fixture.projectId).list(
        fixture.projectId
      )
    ).resolves.toEqual([]);
    const execution = await new JsonExecutionRepository(fixture.storage).get(
      toExecutionId('execution-image-result')
    );
    expect(execution).toMatchObject({
      state: 'failed',
      failure: { retryability: 'not_retryable' }
    });
    await expect(readdir(path.join(fixture.root, 'tmp'))).resolves.toEqual([]);
  });

  it('preserves failure facts and creates no Work when atomic publish runs out of disk', async () => {
    const fixture = await createFixture({ diskFull: true });

    await expect(
      fixture.receiver.receive('execution-image-result')
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'download_failed' }
    });
    await expect(
      new JsonWorkRepository(fixture.storage, fixture.projectId).list(
        fixture.projectId
      )
    ).resolves.toEqual([]);
    await expect(readdir(path.join(fixture.root, 'tmp'))).resolves.toEqual([]);
    const execution = await new JsonExecutionRepository(fixture.storage).get(
      toExecutionId('execution-image-result')
    );
    expect(execution).toMatchObject({
      state: 'failed',
      failure: { stage: 'writing' }
    });
  });

  it('preserves retryability when the remote image download can be retried', async () => {
    const fixture = await createFixture({ downloadFailure: true });

    await expect(fixture.receiver.receive('execution-image-result'))
      .resolves.toMatchObject({
        ok: false,
        error: { code: 'download_failed' }
      });
    await expect(
      new JsonExecutionRepository(fixture.storage).get(
        toExecutionId('execution-image-result')
      )
    ).resolves.toMatchObject({
      state: 'failed',
      failure: { stage: 'downloading', retryability: 'retryable' }
    });
  });

  it('closes a result discovery failure instead of leaving remote completion stuck', async () => {
    const fixture = await createFixture({
      descriptorFailure: 'retryable',
      startsRemoteCompleted: true
    });

    await expect(fixture.receiver.receive('execution-image-result'))
      .resolves.toMatchObject({
        ok: false,
        error: { code: 'download_failed' }
      });
    await expect(
      new JsonExecutionRepository(fixture.storage).get(
        toExecutionId('execution-image-result')
      )
    ).resolves.toMatchObject({
      state: 'failed',
      failure: { stage: 'remote_completed', retryability: 'retryable' }
    });
    await expect(
      new JsonWorkRepository(fixture.storage, fixture.projectId).list(
        fixture.projectId
      )
    ).resolves.toEqual([]);
  });

  it('retries a transient remote download before failing the local receipt', async () => {
    const fixture = await createFixture({ downloadFailuresBeforeSuccess: 1 });

    await expect(fixture.receiver.receive('execution-image-result')).resolves.toMatchObject({
      ok: true,
      value: { workId: 'work-image-result' }
    });
    expect(fixture.getDownloadAttempts()).toBe(2);
    await expect(
      new JsonExecutionRepository(fixture.storage).get(
        toExecutionId('execution-image-result')
      )
    ).resolves.toMatchObject({ state: 'completed' });
  });
});
