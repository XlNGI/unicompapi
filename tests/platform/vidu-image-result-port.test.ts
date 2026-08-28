import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  addExecutionToTask,
  createEmptyImageWorkspaceDraft,
  createExecution,
  createFileReference,
  createImageTask,
  createProviderOperationRecord,
  toCapabilityEvidenceId,
  toConnectionId,
  toDraftId,
  toExecutionId,
  toFileReferenceId,
  toIsoTimestamp,
  toModelId,
  toProjectId,
  toProviderId,
  toProviderOperationRecordId,
  toTaskId,
  transitionExecution,
  transitionFile,
  type FileReference,
  type ProviderImmediateResultReference
} from '../../src/domain';
import {
  ImageWorkspaceMutationCoordinator,
  JsonExecutionRepository,
  JsonFileReferenceRepository,
  JsonProviderOperationRepository,
  JsonProviderRegistryStore,
  JsonTaskRepository,
  JsonWorkRepository,
  LocalImageResultReceiver,
  NodeProjectStorage,
  ProviderPackageRegistry,
  SecureCredentialVault,
  ViduImmediateImageResultPort,
  ViduSharedRuntime,
  createImageFeatureControllerRuntime,
  type CredentialProtector,
  type ViduHttpTransport,
  type ViduHttpTransportRequest,
  type ViduHttpTransportResponse
} from '../../src/platform';

const roots: string[] = [];
const timestamp = toIsoTimestamp('2026-07-29T02:00:00.000Z');

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe('ViduImmediateImageResultPort', () => {
  it('decodes a private base64 receipt without exposing it through the descriptor', async () => {
    const fixture = await createPortFixture({
      kind: 'base64',
      value: pngBytes(7, 9).toString('base64'),
      mimeType: 'image/png'
    });
    const destination = path.join(fixture.root, 'decoded.png');

    await expect(
      fixture.port.getCompletedResult(fixture.reference)
    ).resolves.toEqual({
      name: 'vidu-image-result.png',
      declaredMimeType: 'image/png',
      expectedSizeBytes: 24
    });
    await fixture.port.download(fixture.reference, destination);
    await expect(readFile(destination)).resolves.toEqual(pngBytes(7, 9));
    expect(JSON.stringify(await fixture.port.getCompletedResult(fixture.reference)))
      .not.toContain('iVBOR');
  });

  it('downloads HTTPS URL and file URI results with bounded no-redirect transport', async () => {
    const bytes = pngBytes(3, 4);
    const fixture = await createPortFixture({
      kind: 'file_uri',
      value: 'https://files.synthetic.invalid/result.png?signature=private'
    });
    fixture.transport.responses.push({
      status: 200,
      headers: {
        'content-type': 'image/png',
        'content-length': String(bytes.byteLength)
      },
      body: bytes
    });
    const destination = path.join(fixture.root, 'downloaded.png');

    await fixture.port.download(fixture.reference, destination);
    await expect(readFile(destination)).resolves.toEqual(bytes);
    expect(fixture.transport.requests[0]).toMatchObject({
      method: 'GET',
      redirect: 'manual',
      maxResponseBytes: 20 * 1024 * 1024
    });
    expect(fixture.transport.requests[0].headers).not.toHaveProperty('authorization');
  });

  it('rejects malformed base64, unsafe result hosts and non-image responses', async () => {
    const malformed = await createPortFixture({
      kind: 'base64',
      value: 'not-base64',
      mimeType: 'image/png'
    });
    await expect(
      malformed.port.download(
        malformed.reference,
        path.join(malformed.root, 'malformed.png')
      )
    ).rejects.toMatchObject({ retryability: 'not_retryable' });

    const unsafe = await createPortFixture({
      kind: 'remote_url',
      value: 'https://127.0.0.1/private.png'
    });
    await expect(
      unsafe.port.download(unsafe.reference, path.join(unsafe.root, 'unsafe.png'))
    ).rejects.toMatchObject({ retryability: 'not_retryable' });
    expect(unsafe.transport.requests).toHaveLength(0);

    const wrongType = await createPortFixture({
      kind: 'remote_url',
      value: 'https://files.synthetic.invalid/result.png'
    });
    wrongType.transport.responses.push({
      status: 200,
      headers: { 'content-type': 'text/html' },
      body: new TextEncoder().encode('not an image')
    });
    await expect(
      wrongType.port.download(
        wrongType.reference,
        path.join(wrongType.root, 'wrong-type.png')
      )
    ).rejects.toMatchObject({ retryability: 'not_retryable' });
  });
});

describe('synchronous image receipt integration', () => {
  it('receives, probes, hashes and registers a Work from completed_sync', async () => {
    const fixture = await createReceiverFixture('remote_completed');

    await expect(fixture.receiver.receive(fixture.execution.id)).resolves.toEqual({
      ok: true,
      value: {
        workId: 'work-sync-image',
        executionId: fixture.execution.id,
        name: 'vidu-image-result.png'
      }
    });
    const execution = await new JsonExecutionRepository(fixture.storage).get(
      fixture.execution.id
    );
    expect(execution).toMatchObject({
      state: 'completed',
      outputFileId: 'file-sync-image',
      workId: 'work-sync-image'
    });
    const works = await new JsonWorkRepository(
      fixture.storage,
      fixture.projectId
    ).list(fixture.projectId);
    expect(works).toHaveLength(1);
  });

  it('recovers idempotently when a verified file exists before Work registration', async () => {
    const fixture = await createReceiverFixture('verifying');

    const first = await fixture.receiver.receive(fixture.execution.id);
    const second = await fixture.receiver.receive(fixture.execution.id);

    expect(first).toEqual(second);
    await expect(
      new JsonWorkRepository(fixture.storage, fixture.projectId).list(
        fixture.projectId
      )
    ).resolves.toHaveLength(1);
    await expect(
      new JsonExecutionRepository(fixture.storage).get(fixture.execution.id)
    ).resolves.toMatchObject({ state: 'completed', workId: 'work-sync-image' });
  });

  it('recovers a retryable result-discovery failure after runtime reconstruction', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-image-recovery-'));
    roots.push(root);
    await mkdir(path.join(root, 'tmp'), { recursive: true });
    const storage = new NodeProjectStorage(root);
    const projectId = toProjectId('project-image-recovery');
    const task = createRecoveryTask(projectId);
    const recordId = toProviderOperationRecordId('provider-operation-recovery');
    const created = createExecution({
      id: toExecutionId('execution-image-recovery'),
      taskId: task.id,
      createdAt: timestamp
    });
    const submitting = transitionExecution(created, 'submitting', timestamp);
    const remoteCompleted = transitionExecution(
      submitting,
      'remote_completed',
      timestamp,
      {
        providerOperationRecordId: recordId,
        submissionOutcome: 'completed_sync'
      }
    );
    const failed = transitionExecution(remoteCompleted, 'failed', timestamp, {
      failure: {
        stage: 'remote_completed',
        message: 'Temporary result discovery failure',
        retryability: 'retryable'
      }
    });
    await new JsonTaskRepository(storage, projectId).save(
      addExecutionToTask(task, failed)
    );
    await new JsonExecutionRepository(storage).save(failed);
    await new JsonProviderOperationRepository(storage).save(
      createProviderOperationRecord({
        id: recordId,
        taskId: task.id,
        executionId: remoteCompleted.id,
        mediaKind: 'image',
        executionLifecycle: 'synchronous_completed',
        outcome: {
          kind: 'completed_sync',
          providerOperationId: 'persisted-image-result',
          results: [{
            kind: 'base64',
            value: pngBytes(16, 9).toString('base64'),
            mimeType: 'image/png'
          }]
        },
        createdAt: timestamp,
        updatedAt: timestamp
      })
    );

    const vault = new SecureCredentialVault(
      path.join(root, 'credentials.json'),
      reversibleProtector()
    );
    const resultPort = new ViduImmediateImageResultPort({
      operations: new JsonProviderOperationRepository(storage),
      runtime: new ViduSharedRuntime({
        credentialVault: vault,
        transport: new FixtureTransport()
      })
    });
    const mutations = new ImageWorkspaceMutationCoordinator();
    const session = {
      projectId,
      projectName: 'Image recovery project',
      rootDirectory: root
    };
    const receiver = new LocalImageResultReceiver({
      getSession: () => session,
      mutations,
      port: resultPort,
      now: () => '2026-07-29T03:00:00.000Z'
    });
    const runtime = createImageFeatureControllerRuntime({
      session,
      providerRegistry: new JsonProviderRegistryStore(
        path.join(root, 'provider-registry.json')
      ),
      providerPackages: new ProviderPackageRegistry([]),
      runtimeAuthorization: {
        async checkAccess() {
          return {
            allowed: false,
            operation: 'submit' as const,
            reason: 'no_matching_policy' as const
          };
        }
      },
      resultReceiver: receiver,
      mutations,
      now: () => '2026-07-29T03:00:00.000Z'
    });

    await expect(runtime.recoverResult?.(task.id)).resolves.toMatchObject({
      taskId: task.id,
      executionId: failed.id,
      workId: expect.stringMatching(/^work-result-/)
    });
    const completed = await new JsonExecutionRepository(storage).get(failed.id);
    expect(completed).toMatchObject({
      id: failed.id,
      state: 'completed'
    });
    expect(completed).not.toHaveProperty('failure');
    const works = await new JsonWorkRepository(storage, projectId).list(projectId);
    expect(works).toHaveLength(1);
    expect(works[0]?.sourceExecutionId).toBe(failed.id);
  });
});

function createRecoveryTask(projectId: ReturnType<typeof toProjectId>) {
  const draft = createEmptyImageWorkspaceDraft({
    id: toDraftId('draft-image-recovery'),
    projectId,
    mode: 'quick_image',
    createdAt: timestamp
  });
  return createImageTask({
    id: toTaskId('task-image-recovery'),
    draft: {
      ...draft,
      prompt: {
        originalInput: 'recover image',
        systemSupplements: [],
        finalPrompt: 'recover image'
      }
    },
    confirmation: {
      mode: 'quick_image',
      purpose: 'image_generation',
      modelId: toModelId('model-image-recovery'),
      capabilityEvidenceId: toCapabilityEvidenceId('evidence-image-recovery'),
      providerId: toProviderId('provider-image-recovery'),
      connectionId: toConnectionId('connection-image-recovery'),
      recipientName: 'Image provider',
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
    confirmedAt: timestamp
  });
}

async function createPortFixture(
  result: ProviderImmediateResultReference
) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-vidu-result-'));
  roots.push(root);
  const storage = new NodeProjectStorage(root);
  const operations = new JsonProviderOperationRepository(storage);
  const recordId = toProviderOperationRecordId('provider-operation-result');
  await operations.save(createProviderOperationRecord({
    id: recordId,
    taskId: toTaskId('task-result'),
    executionId: toExecutionId('execution-result'),
    mediaKind: 'image',
    executionLifecycle: 'synchronous_completed',
    outcome: {
      kind: 'completed_sync',
      providerOperationId: 'local-result-operation',
      results: [result]
    },
    createdAt: timestamp,
    updatedAt: timestamp
  }));
  const vault = new SecureCredentialVault(
    path.join(root, 'credentials.json'),
    reversibleProtector()
  );
  const transport = new FixtureTransport();
  const runtime = new ViduSharedRuntime({ credentialVault: vault, transport });
  return {
    root,
    transport,
    reference: { kind: 'provider_operation_record' as const, id: recordId },
    port: new ViduImmediateImageResultPort({ operations, runtime })
  };
}

async function createReceiverFixture(
  state: 'remote_completed' | 'verifying'
) {
  const resultBytes = pngBytes(10, 12);
  const portFixture = await createPortFixture({
    kind: 'base64',
    value: resultBytes.toString('base64'),
    mimeType: 'image/png'
  });
  const root = portFixture.root;
  await mkdir(path.join(root, 'tmp'), { recursive: true });
  const storage = new NodeProjectStorage(root);
  const projectId = toProjectId('project-sync-image');
  const draft = createEmptyImageWorkspaceDraft({
    id: toDraftId('draft-sync-image'),
    projectId,
    mode: 'quick_image',
    createdAt: timestamp
  });
  const task = createImageTask({
    id: toTaskId('task-sync-image'),
    draft: {
      ...draft,
      prompt: {
        originalInput: 'sync image',
        systemSupplements: [],
        finalPrompt: 'sync image'
      }
    },
    confirmation: {
      mode: 'quick_image',
      purpose: 'image_generation',
      modelId: toModelId('model-sync-image'),
      capabilityEvidenceId: toCapabilityEvidenceId('evidence-sync-image'),
      providerId: toProviderId('provider-vidu'),
      connectionId: toConnectionId('connection-vidu-default'),
      recipientName: 'Vidu',
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
    confirmedAt: timestamp
  });
  const created = createExecution({
    id: toExecutionId('execution-result'),
    taskId: task.id,
    createdAt: timestamp
  });
  const submitting = transitionExecution(created, 'submitting', timestamp);
  let execution = transitionExecution(submitting, 'remote_completed', timestamp, {
    providerOperationRecordId: toProviderOperationRecordId(
      'provider-operation-result'
    ),
    submissionOutcome: 'completed_sync'
  });
  if (state === 'verifying') {
    execution = transitionExecution(execution, 'downloading', timestamp);
    execution = transitionExecution(execution, 'writing', timestamp);
    execution = transitionExecution(execution, 'verifying', timestamp);
    await saveAvailableResultFile(root, storage, projectId, execution.id, resultBytes);
  }
  await new JsonTaskRepository(storage, projectId).save(
    addExecutionToTask(task, execution)
  );
  await new JsonExecutionRepository(storage).save(execution);
  const times = Array.from({ length: 16 }, (_, index) =>
    `2026-07-29T02:${String(index + 1).padStart(2, '0')}:00.000Z`
  );
  const receiver = new LocalImageResultReceiver({
    getSession: () => ({
      projectId,
      projectName: 'Synchronous image project',
      rootDirectory: root
    }),
    port: portFixture.port,
    mutations: new ImageWorkspaceMutationCoordinator(),
    createFileId: () => 'file-sync-image',
    createWorkId: () => 'work-sync-image',
    now: () => times.shift() ?? '2026-07-29T02:59:00.000Z'
  });
  return { root, storage, projectId, execution, receiver };
}

async function saveAvailableResultFile(
  root: string,
  storage: NodeProjectStorage,
  projectId: ReturnType<typeof toProjectId>,
  executionId: ReturnType<typeof toExecutionId>,
  bytes: Buffer
) {
  const relativePath = 'files/results/recovered.png';
  const absolutePath = path.join(root, relativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, bytes);
  const checksum = createHash('sha256').update(bytes).digest('hex');
  const pending = createFileReference({
    id: toFileReferenceId('file-sync-image'),
    projectId,
    sourceExecutionId: executionId,
    locator: { kind: 'project', relativePath },
    createdAt: timestamp
  });
  const verifying = transitionFile(pending, 'verifying', timestamp);
  const available = transitionFile(verifying, 'available', timestamp, {
    sizeBytes: bytes.byteLength,
    checksumSha256: checksum
  });
  const file: FileReference = {
    ...available,
    lastVerification: {
      sizeBytes: bytes.byteLength,
      checksumSha256: checksum,
      matchesExpected: true,
      verifiedAt: timestamp
    }
  };
  await new JsonFileReferenceRepository(storage, projectId).save(file);
}

class FixtureTransport implements ViduHttpTransport {
  readonly requests: ViduHttpTransportRequest[] = [];
  readonly responses: ViduHttpTransportResponse[] = [];

  async send(request: ViduHttpTransportRequest): Promise<ViduHttpTransportResponse> {
    this.requests.push(request);
    return this.responses.shift() ?? {
      status: 500,
      headers: {},
      body: new Uint8Array()
    };
  }
}

function pngBytes(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write('IHDR', 12, 'ascii');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

function reversibleProtector(): CredentialProtector {
  return {
    isAvailable: () => true,
    protect: (value) => Buffer.from(value, 'utf8'),
    unprotect: (value) => Buffer.from(value).toString('utf8')
  };
}
