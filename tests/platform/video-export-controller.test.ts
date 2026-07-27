import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyVideoEditCommand,
  createEmptyVideoEditDraft,
  createFileReference,
  toFileReferenceId,
  toIsoTimestamp,
  toProjectId,
  toVideoClipId,
  toVideoEditDraftId,
  transitionFile,
  type VideoClip
} from '../../src/domain';
import {
  FfmpegMediaEngineAdapter,
  JsonExecutionRepository,
  JsonFileReferenceRepository,
  JsonTaskRepository,
  JsonVideoEditDraftRepository,
  JsonVideoExportPlanRepository,
  JsonWorkRepository,
  NodeProjectStorage,
  projectStoragePaths,
  VideoExportController
} from '../../src/platform';

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const ffmpegPath = path.resolve(
  '.tools/media-engine/ffmpeg/8.1.2/win32-x64/bin/ffmpeg.exe'
);
const ffprobePath = path.resolve(
  '.tools/media-engine/ffmpeg/8.1.2/win32-x64/bin/ffprobe.exe'
);
const hasProjectFfmpeg = existsSync(ffmpegPath) && existsSync(ffprobePath);
const t0 = toIsoTimestamp('2026-07-27T01:00:00.000Z');
const t1 = toIsoTimestamp('2026-07-27T01:01:00.000Z');

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe.skipIf(!hasProjectFfmpeg)('VideoExportController real closure', () => {
  it('persists plan, task, execution, verified file and work only after FFmpeg succeeds', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-video-export-'));
    roots.push(root);
    const projectRoot = path.join(root, 'project');
    const sourcePath = path.join(root, 'source.webm');
    await mkdir(projectRoot);
    await execFileAsync(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'color=c=green:s=96x64:r=12',
      '-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=48000',
      '-t', '1.2', '-c:v', 'libvpx-vp9', '-c:a', 'libopus', sourcePath
    ]);
    const sourceStats = await stat(sourcePath);
    const sourceChecksum = createHash('sha256')
      .update(await readFile(sourcePath))
      .digest('hex');
    const projectId = toProjectId('video-export-project');
    const storage = new NodeProjectStorage(projectRoot);
    const files = new JsonFileReferenceRepository(storage, projectId);
    let sourceFile = createFileReference({
      id: toFileReferenceId('video-export-source-file'),
      projectId,
      locator: { kind: 'external', absolutePath: sourcePath },
      createdAt: t0
    });
    sourceFile = transitionFile(sourceFile, 'verifying', t0);
    sourceFile = transitionFile(sourceFile, 'available', t0, {
      sizeBytes: sourceStats.size,
      checksumSha256: sourceChecksum
    });
    await files.save(sourceFile);

    const draftId = toVideoEditDraftId('video-export-draft');
    const empty = createEmptyVideoEditDraft({
      id: draftId,
      projectId,
      title: 'Real closure',
      createdAt: t0
    });
    const clip: VideoClip = {
      kind: 'video_clip',
      id: toVideoClipId('video-export-clip'),
      source: {
        fileId: sourceFile.id,
        identity: {
          sizeBytes: sourceStats.size,
          modifiedAtMs: Math.round(sourceStats.mtimeMs),
          durationUs: 1_200_000,
          container: 'webm',
          width: 96,
          height: 64,
          checksumSha256: sourceChecksum
        }
      },
      sourceRange: { inUs: 100_000, outUs: 1_000_000 },
      speed: { numerator: 1, denominator: 1 },
      transform: {
        scalePermille: 1000,
        positionXPermille: 0,
        positionYPermille: 0,
        rotationMilliDegrees: 0,
        flipX: false,
        flipY: false,
        crop: null
      },
      sourceAudio: { muted: false, volumePermille: 800 },
      transitionToNext: { kind: 'none' }
    };
    const draft = applyVideoEditCommand(empty, {
      schemaVersion: 1,
      kind: 'insert_clip',
      clip,
      targetIndex: 0
    }, t1);
    await new JsonVideoEditDraftRepository(storage, projectId).save(draft);

    const session = {
      projectId,
      projectName: 'Video export project',
      rootDirectory: projectRoot
    };
    const adapter = new FfmpegMediaEngineAdapter({
      ffmpegPath,
      ffprobePath,
      adapterVersion: '8.1.2'
    });
    let sequence = 0;
    let lastError: unknown;
    const controller = new VideoExportController({
      getSession: () => session,
      getAdapter: () => adapter,
      now: () => '2026-07-27T01:02:00.000Z',
      createId: () => `id-${++sequence}`,
      onError: (error) => { lastError = error; }
    });

    const started = await controller.startExport({
      draftId,
      expectedRevision: draft.revision
    });
    if (!started.ok) throw new Error(`${started.error.code}: ${started.error.message}`);
    expect(started).toMatchObject({
      ok: true,
      value: { state: 'queued', attempt: 1, canCancel: true }
    });
    await controller.waitForExports();
    const completed = await controller.getExport({ taskId: started.value.taskId });
    if (completed.ok && completed.value.state === 'failed') {
      throw lastError ?? new Error(JSON.stringify(completed.value.failure));
    }
    expect(completed).toMatchObject({
      ok: true,
      value: { state: 'completed', attempt: 1, canCancel: false }
    });
    if (!completed.ok) throw new Error(completed.error.message);

    const task = await new JsonTaskRepository(storage, projectId)
      .get(started.value.taskId as never);
    const execution = await new JsonExecutionRepository(storage)
      .get(completed.value.executionId as never);
    const plans = await new JsonVideoExportPlanRepository(storage, projectId)
      .list(projectId);
    const works = await new JsonWorkRepository(storage, projectId).list(projectId);
    const persistedFiles = await files.list(projectId);
    expect(task?.submission.kind).toBe('video_editing');
    expect(execution).toMatchObject({
      state: 'completed',
      outputFileId: persistedFiles.find((file) => file.sourceExecutionId === execution?.id)?.id,
      workId: works[0]?.id
    });
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({
      draftId,
      draftRevision: draft.revision,
      planHash: expect.stringMatching(/^[a-f0-9]{64}$/)
    });
    expect(works).toHaveLength(1);
    const outputFile = persistedFiles.find((file) => file.id === works[0]?.fileId);
    expect(outputFile).toMatchObject({
      state: 'available',
      checksumSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      sourceExecutionId: execution?.id
    });
    const outputPath = path.join(projectRoot, outputFile!.locator.kind === 'project'
      ? outputFile!.locator.relativePath
      : 'invalid');
    await expect(stat(outputPath)).resolves.toMatchObject({ size: outputFile?.sizeBytes });

    const persistedPlans = await storage.readJson<{
      schemaVersion: 1;
      entities: Array<Record<string, unknown>>;
    }>(projectStoragePaths.entities.videoExportPlans);
    persistedPlans!.entities[0]!.title = 'tampered after planning';
    await storage.writeJsonAtomically(
      projectStoragePaths.entities.videoExportPlans,
      persistedPlans
    );
    await expect(
      new JsonVideoExportPlanRepository(storage, projectId).list(projectId)
    ).rejects.toThrow('failed SHA-256 integrity verification');
  }, 120_000);
});
