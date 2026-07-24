import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import {
  addExecutionToTask,
  createEmptyVideoWorkspaceDraft,
  createExecution,
  createVideoTask,
  createVideoWorkspaceDraft,
  toCapabilityEvidenceId,
  toConnectionId,
  toDraftId,
  toExecutionId,
  toIsoTimestamp,
  toModelId,
  toProjectId,
  toProviderId,
  toTaskId,
  transitionExecution
} from '../../src/domain';
import {
  JsonExecutionRepository,
  JsonFileReferenceRepository,
  JsonTaskRepository,
  JsonWorkRepository,
  LocalVideoResultReceiver,
  NodeProjectStorage,
  NodeVideoInspector,
  VideoResultPortError,
  VideoWorkspaceMutationCoordinator,
  type VideoRemoteResultDescriptor
} from '../../src/platform';

const roots: string[] = [];
const t0 = toIsoTimestamp('2026-07-24T02:00:00.000Z');

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

async function createFixture(options: {
  readonly videos?: readonly VideoFixture[];
  readonly discoveryFailure?: boolean;
  readonly corruptWorkStore?: boolean;
} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-video-result-'));
  roots.push(root);
  const projectId = toProjectId('project-video-result');
  const storage = new NodeProjectStorage(root);
  const draftBase = createEmptyVideoWorkspaceDraft({
    id: toDraftId('draft-video-result'),
    projectId,
    mode: 'quick_video',
    createdAt: t0
  });
  const draft = createVideoWorkspaceDraft({
    ...draftBase,
    state: 'saved',
    prompt: {
      originalInput: 'Create local video result',
      systemSupplements: [],
      finalPrompt: 'Create local video result'
    }
  });
  const task = createVideoTask({
    id: toTaskId('task-video-result'),
    draft,
    confirmation: {
      mode: 'quick_video',
      purpose: 'video_generation',
      modelId: toModelId('model-video-result'),
      capabilityEvidenceId: toCapabilityEvidenceId('evidence-video-result'),
      providerId: toProviderId('provider-video-result'),
      connectionId: toConnectionId('connection-video-result'),
      recipientName: 'Video result provider',
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
    },
    confirmedAt: t0
  });
  const created = createExecution({
    id: toExecutionId('execution-video-result'),
    taskId: task.id,
    createdAt: t0
  });
  const submitting = transitionExecution(created, 'submitting', t0);
  const processing = transitionExecution(submitting, 'processing', t0, {
    remoteOperationId: 'remote-video-result-internal'
  });
  await new JsonTaskRepository(storage, projectId).save(
    addExecutionToTask(task, processing)
  );
  await new JsonExecutionRepository(storage).save(processing);

  const videos = options.videos ?? [
    videoFixture({ remoteResultId: 'result-one', name: '../result-one.bin' })
  ];
  const fileIds = videos.map((_, index) => `file-video-result-${index + 1}`);
  const workIds = videos.map((_, index) => `work-video-result-${index + 1}`);
  let tick = 0;
  let inspectionCount = 0;
  const nodeVideoInspector = new NodeVideoInspector();
  const receiver = new LocalVideoResultReceiver({
    getSession: () => ({
      projectId,
      projectName: 'Video result project',
      rootDirectory: root
    }),
    port: {
      getCompletion: async () => {
        if (options.discoveryFailure) {
          throw new VideoResultPortError('retryable', 'temporary discovery error');
        }
        return { state: 'completed' };
      },
      listResults: async () => videos.map((video) => video.descriptor),
      openDownload: async (_operationId, resultId) => {
        const video = videos.find(
          (candidate) => candidate.descriptor.remoteResultId === resultId
        );
        if (!video) throw new Error('missing fixture result');
        const split = Math.max(1, Math.floor(video.bytes.length / 3));
        return Readable.from([
          video.bytes.subarray(0, split),
          video.bytes.subarray(split, split * 2),
          video.bytes.subarray(split * 2)
        ]);
      }
    },
    mutations: new VideoWorkspaceMutationCoordinator(),
    videoInspector: {
      inspect: async (target) => {
        const inspection = await nodeVideoInspector.inspect(target);
        inspectionCount += 1;
        if (options.corruptWorkStore && inspectionCount === videos.length * 2) {
          await mkdir(path.join(root, 'entities'), { recursive: true });
          await writeFile(
            path.join(root, 'entities', 'works.json'),
            '{invalid',
            'utf8'
          );
        }
        return inspection;
      }
    },
    createFileId: () => fileIds.shift() ?? 'file-video-result-fallback',
    createWorkId: () => workIds.shift() ?? 'work-video-result-fallback',
    now: () =>
      new Date(Date.parse(t0) + ++tick * 1_000).toISOString()
  });
  return { projectId, receiver, root, storage };
}

describe('LocalVideoResultReceiver', () => {
  it('streams and registers every verified remote video as an independent work', async () => {
    const first = videoFixture({
      remoteResultId: 'result-one',
      name: '../first-result.data',
      suffix: 'first-video'
    });
    const second = videoFixture({
      remoteResultId: 'result-two',
      name: '..\\second-result.data',
      brand: 'qt  ',
      durationMs: 4_000,
      width: 640,
      height: 360,
      suffix: 'second-video'
    });
    const fixture = await createFixture({ videos: [first, second] });

    await expect(
      fixture.receiver.receive('execution-video-result')
    ).resolves.toEqual({
      ok: true,
      value: {
        executionId: 'execution-video-result',
        works: [
          { workId: 'work-video-result-1', name: 'first-result.data' },
          { workId: 'work-video-result-2', name: 'second-result.data' }
        ]
      }
    });

    const execution = await new JsonExecutionRepository(fixture.storage).get(
      toExecutionId('execution-video-result')
    );
    expect(execution?.state).toBe('completed');
    const works = await new JsonWorkRepository(
      fixture.storage,
      fixture.projectId
    ).list(fixture.projectId);
    expect(works).toHaveLength(2);
    expect(works.every((work) => work.mediaKind === 'video')).toBe(true);
    expect(new Set(works.map((work) => work.fileId)).size).toBe(2);
    const files = await new JsonFileReferenceRepository(
      fixture.storage,
      fixture.projectId
    ).list(fixture.projectId);
    expect(files).toHaveLength(2);
    expect(files.every((file) => file.state === 'available')).toBe(true);
    expect(files.every((file) => file.sourceExecutionId === execution?.id)).toBe(
      true
    );
    expect(await readdir(path.join(fixture.root, 'files', 'results'))).toEqual([
      'work-video-result-1.mp4',
      'work-video-result-2.mov'
    ]);
    expect(await listOrEmpty(path.join(fixture.root, 'tmp'))).toEqual([]);
  });

  it('rejects a service declaration mismatch without creating a work', async () => {
    const video = videoFixture({ remoteResultId: 'bad-result', name: 'bad.mp4' });
    const fixture = await createFixture({
      videos: [{
        ...video,
        descriptor: { ...video.descriptor, expectedDurationMs: 9_999 }
      }]
    });

    await expect(
      fixture.receiver.receive('execution-video-result')
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'result_verification_failed' }
    });
    const execution = await new JsonExecutionRepository(fixture.storage).get(
      toExecutionId('execution-video-result')
    );
    expect(execution).toMatchObject({
      state: 'failed',
      failure: { stage: 'downloading', retryability: 'not_retryable' }
    });
    expect(
      await new JsonWorkRepository(fixture.storage, fixture.projectId).list(
        fixture.projectId
      )
    ).toEqual([]);
    expect(await listOrEmpty(path.join(fixture.root, 'tmp'))).toEqual([]);
    expect(await listOrEmpty(path.join(fixture.root, 'files', 'results'))).toEqual(
      []
    );
  });

  it('stops a stream that exceeds the declared byte count', async () => {
    const video = videoFixture({
      remoteResultId: 'oversized-result',
      name: 'oversized.mp4'
    });
    const fixture = await createFixture({
      videos: [{
        ...video,
        descriptor: {
          ...video.descriptor,
          expectedSizeBytes: video.bytes.length - 1
        }
      }]
    });

    await expect(
      fixture.receiver.receive('execution-video-result')
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'result_verification_failed' }
    });
    expect(
      await new JsonWorkRepository(fixture.storage, fixture.projectId).list(
        fixture.projectId
      )
    ).toEqual([]);
    expect(await listOrEmpty(path.join(fixture.root, 'tmp'))).toEqual([]);
  });

  it('rejects a checksum mismatch after streaming and trusted inspection', async () => {
    const video = videoFixture({
      remoteResultId: 'checksum-result',
      name: 'checksum.mp4'
    });
    const fixture = await createFixture({
      videos: [{
        ...video,
        descriptor: {
          ...video.descriptor,
          expectedChecksumSha256: '0'.repeat(64)
        }
      }]
    });

    await expect(
      fixture.receiver.receive('execution-video-result')
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'result_verification_failed' }
    });
    expect(
      await new JsonWorkRepository(fixture.storage, fixture.projectId).list(
        fixture.projectId
      )
    ).toEqual([]);
  });

  it('records retryable result discovery failures without inventing completion', async () => {
    const fixture = await createFixture({ discoveryFailure: true });

    await expect(
      fixture.receiver.receive('execution-video-result')
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'result_discovery_failed' }
    });
    const execution = await new JsonExecutionRepository(fixture.storage).get(
      toExecutionId('execution-video-result')
    );
    expect(execution).toMatchObject({
      state: 'failed',
      failure: { stage: 'processing', retryability: 'retryable' }
    });
  });

  it('returns registration failure while preserving completed local file facts', async () => {
    const fixture = await createFixture({ corruptWorkStore: true });

    await expect(
      fixture.receiver.receive('execution-video-result')
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'result_registration_failed' }
    });
    const execution = await new JsonExecutionRepository(fixture.storage).get(
      toExecutionId('execution-video-result')
    );
    expect(execution?.state).toBe('completed');
    const files = await new JsonFileReferenceRepository(
      fixture.storage,
      fixture.projectId
    ).list(fixture.projectId);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ state: 'available' });
    expect(await readdir(path.join(fixture.root, 'files', 'results'))).toEqual([
      'work-video-result-1.mp4'
    ]);
  });
});

interface VideoFixture {
  readonly bytes: Buffer;
  readonly descriptor: VideoRemoteResultDescriptor;
}

function videoFixture(options: {
  readonly remoteResultId: string;
  readonly name: string;
  readonly durationMs?: number;
  readonly width?: number;
  readonly height?: number;
  readonly brand?: string;
  readonly suffix?: string;
}): VideoFixture {
  const durationMs = options.durationMs ?? 2_500;
  const width = options.width ?? 1_280;
  const height = options.height ?? 720;
  const brand = options.brand ?? 'isom';
  const bytes = isoBmffVideo({
    durationMs,
    width,
    height,
    brand,
    suffix: options.suffix
  });
  const quicktime = brand === 'qt  ';
  return {
    bytes,
    descriptor: {
      remoteResultId: options.remoteResultId,
      name: options.name,
      declaredMimeType: quicktime ? 'video/quicktime' : 'video/mp4',
      declaredContainer: quicktime ? 'quicktime' : 'mp4',
      expectedSizeBytes: bytes.length,
      expectedChecksumSha256: createHash('sha256').update(bytes).digest('hex'),
      expectedDurationMs: durationMs,
      expectedWidth: width,
      expectedHeight: height
    }
  };
}

function isoBmffVideo(options: {
  readonly durationMs: number;
  readonly width: number;
  readonly height: number;
  readonly brand: string;
  readonly suffix?: string;
}): Buffer {
  const ftypPayload = Buffer.alloc(16);
  ftypPayload.write(options.brand, 0, 4, 'ascii');
  ftypPayload.writeUInt32BE(0, 4);
  ftypPayload.write('isom', 8, 4, 'ascii');
  ftypPayload.write('mp42', 12, 4, 'ascii');

  const mvhdPayload = Buffer.alloc(20);
  mvhdPayload.writeUInt32BE(1_000, 12);
  mvhdPayload.writeUInt32BE(options.durationMs, 16);

  const tkhdPayload = Buffer.alloc(84);
  tkhdPayload.writeUInt32BE(options.width * 65_536, 76);
  tkhdPayload.writeUInt32BE(options.height * 65_536, 80);

  const hdlrPayload = Buffer.alloc(12);
  hdlrPayload.write('vide', 8, 4, 'ascii');

  return Buffer.concat([
    box('ftyp', ftypPayload),
    box(
      'moov',
      Buffer.concat([
        box('mvhd', mvhdPayload),
        box(
          'trak',
          Buffer.concat([
            box('tkhd', tkhdPayload),
            box('mdia', box('hdlr', hdlrPayload))
          ])
        )
      ])
    ),
    box('mdat', Buffer.from(options.suffix ?? 'video-payload'))
  ]);
}

function box(type: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(header.length + payload.length, 0);
  header.write(type, 4, 4, 'ascii');
  return Buffer.concat([header, payload]);
}

async function listOrEmpty(target: string): Promise<readonly string[]> {
  try {
    return await readdir(target);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}
