import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
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
  JsonExecutionRepository,
  JsonFileReferenceRepository,
  JsonTaskRepository,
  JsonVideoEditDraftRepository,
  JsonVideoExportPlanRepository,
  JsonWorkRepository,
  NodeProjectStorage,
  VideoExportController,
  type MediaEngineAdapter,
  type MediaEngineCancelResult,
  type MediaEngineExportPlan,
  type MediaEngineExportResult
} from '../../src/platform';

const roots: string[] = [];
const t0 = toIsoTimestamp('2026-07-27T02:00:00.000Z');

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

class ControlledExportAdapter implements MediaEngineAdapter {
  readonly descriptor = { adapterId: 'ffmpeg', adapterVersion: 'test' };
  mode: 'wait' | 'fail' | 'succeed' = 'wait';
  started = false;
  private finish?: (result: MediaEngineExportResult) => void;

  async getCapabilities() {
    return {
      descriptor: this.descriptor,
      version: 'ffmpeg test',
      videoEncoders: ['libvpx-vp9'],
      audioEncoders: ['libopus'],
      containers: ['webm'],
      filters: ['concat', 'scale', 'pad', 'atrim', 'amix'],
      supportsProbe: true as const,
      supportsPreview: true as const,
      supportsExport: true as const,
      supportsCancel: true as const
    };
  }

  async probe() {
    return {
      container: 'webm',
      durationUs: 1_000_000,
      streams: [{
        index: 0,
        type: 'video' as const,
        codec: 'vp9',
        width: 64,
        height: 64,
        durationUs: 1_000_000
      }]
    };
  }

  async buildPreview(): Promise<never> {
    throw new Error('not used');
  }

  async validateFontFamily() {
    return true;
  }

  async export(plan: MediaEngineExportPlan): Promise<MediaEngineExportResult> {
    this.started = true;
    if (this.mode === 'fail') {
      return { status: 'failed', code: 'process_failed', message: 'injected' };
    }
    if (this.mode === 'succeed') {
      await mkdir(path.dirname(plan.outputPath), { recursive: true });
      await writeFile(plan.outputPath, 'verified-output');
      return {
        status: 'completed',
        output: {
          status: 'verified',
          path: plan.outputPath,
          durationUs: 1_000_000,
          hasVideo: true,
          hasAudio: false,
          container: 'webm',
          width: 64,
          height: 64
        }
      };
    }
    return new Promise((resolve) => { this.finish = resolve; });
  }

  async cancel(): Promise<MediaEngineCancelResult> {
    if (!this.finish) return { status: 'not_found' };
    this.finish({ status: 'cancelled' });
    this.finish = undefined;
    return { status: 'accepted' };
  }

  async verifyOutput(outputPath: string) {
    try {
      const metadata = await stat(outputPath);
      if (metadata.size > 0) {
        return {
          status: 'verified' as const,
          path: outputPath,
          durationUs: 1_000_000,
          hasVideo: true as const,
          hasAudio: false,
          container: 'webm',
          width: 64,
          height: 64
        };
      }
    } catch {
      // Missing output is the expected state before an export begins.
    }
    return { status: 'invalid' as const, path: outputPath, reason: 'missing' as const };
  }
}

async function fixture(
  adapter: ControlledExportAdapter,
  onActiveCountChanged?: (count: number) => void
) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-export-fault-'));
  roots.push(root);
  const projectRoot = path.join(root, 'project');
  const sourcePath = path.join(root, 'source.webm');
  await mkdir(projectRoot);
  await writeFile(sourcePath, 'controlled-source');
  const metadata = await stat(sourcePath);
  const checksum = createHash('sha256').update(await readFile(sourcePath)).digest('hex');
  const projectId = toProjectId('fault-project');
  const storage = new NodeProjectStorage(projectRoot);
  const files = new JsonFileReferenceRepository(storage, projectId);
  let file = createFileReference({
    id: toFileReferenceId('fault-source'),
    projectId,
    locator: { kind: 'external', absolutePath: sourcePath },
    createdAt: t0
  });
  file = transitionFile(file, 'verifying', t0);
  file = transitionFile(file, 'available', t0, {
    sizeBytes: metadata.size,
    checksumSha256: checksum
  });
  await files.save(file);
  const empty = createEmptyVideoEditDraft({
    id: toVideoEditDraftId('fault-draft'),
    projectId,
    createdAt: t0
  });
  const clip: VideoClip = {
    kind: 'video_clip',
    id: toVideoClipId('fault-clip'),
    source: {
      fileId: file.id,
      identity: {
        sizeBytes: metadata.size,
        modifiedAtMs: Math.round(metadata.mtimeMs),
        durationUs: 1_000_000,
        container: 'webm',
        width: 64,
        height: 64,
        checksumSha256: checksum
      }
    },
    sourceRange: { inUs: 0, outUs: 1_000_000 },
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
    sourceAudio: { muted: true, volumePermille: 0 },
    transitionToNext: { kind: 'none' }
  };
  const draft = applyVideoEditCommand(empty, {
    schemaVersion: 1,
    kind: 'insert_clip',
    clip,
    targetIndex: 0
  }, t0);
  await new JsonVideoEditDraftRepository(storage, projectId).save(draft);
  let sequence = 0;
  const controller = new VideoExportController({
    getSession: () => ({ projectId, projectName: 'Fault project', rootDirectory: projectRoot }),
    getAdapter: () => adapter,
    now: () => '2026-07-27T02:01:00.000Z',
    createId: () => `fault-${++sequence}`,
    onActiveCountChanged
  });
  return {
    controller,
    draft,
    files,
    projectId,
    projectRoot,
    sourcePath,
    storage
  };
}

describe('VideoExportController fault handling', () => {
  it('freezes fail-on-conflict without changing the requested output name', async () => {
    const adapter = new ControlledExportAdapter();
    const test = await fixture(adapter);
    const draft = applyVideoEditCommand(test.draft, {
      schemaVersion: 1,
      kind: 'set_output_preference',
      before: test.draft.outputPreference,
      after: {
        ...test.draft.outputPreference,
        fileName: 'collision.webm',
        conflictPolicy: 'fail'
      }
    }, t0);
    await new JsonVideoEditDraftRepository(test.storage, test.projectId).save(draft);

    const started = await test.controller.startExport({
      draftId: draft.id,
      expectedRevision: draft.revision
    });
    if (!started.ok) throw new Error(started.error.message);
    const plans = await new JsonVideoExportPlanRepository(test.storage, test.projectId)
      .list(test.projectId);
    expect(plans[0]?.output).toMatchObject({
      relativePath: 'files/results/collision.webm',
      fileName: 'collision.webm',
      conflictPolicy: 'fail'
    });
    await waitUntil(() => adapter.started);
    await test.controller.cancelExport({ taskId: started.value.taskId });
    await test.controller.waitForExports();
  });

  it('does not create a Work until process cancellation is confirmed', async () => {
    const adapter = new ControlledExportAdapter();
    const test = await fixture(adapter);
    const started = await test.controller.startExport({
      draftId: test.draft.id,
      expectedRevision: test.draft.revision
    });
    if (!started.ok) throw new Error(started.error.message);
    await waitUntil(() => adapter.started);
    const cancelling = await test.controller.cancelExport({ taskId: started.value.taskId });
    expect(cancelling).toMatchObject({ ok: true, value: { state: 'cancel_requested' } });
    await test.controller.waitForExports();
    await expect(test.controller.getExport({ taskId: started.value.taskId }))
      .resolves.toMatchObject({ ok: true, value: { state: 'cancelled' } });
    await expect(new JsonWorkRepository(test.storage, test.projectId).list(test.projectId))
      .resolves.toEqual([]);
  });

  it('maps suspend interruption to recovery required without duplicate completion', async () => {
    const adapter = new ControlledExportAdapter();
    const activeCounts: number[] = [];
    const test = await fixture(adapter, (count) => activeCounts.push(count));
    const started = await test.controller.startExport({
      draftId: test.draft.id,
      expectedRevision: test.draft.revision
    });
    if (!started.ok) throw new Error(started.error.message);
    await waitUntil(() => adapter.started);

    expect(test.controller.activeExportCount).toBe(1);
    await expect(test.controller.interruptActiveExports('system_suspend'))
      .resolves.toBe(1);
    await expect(test.controller.getExport({ taskId: started.value.taskId }))
      .resolves.toMatchObject({
        ok: true,
        value: { state: 'recovery_required', canRetry: true }
      });
    expect(test.controller.activeExportCount).toBe(0);
    expect(activeCounts).toEqual([1, 0]);
    await expect(new JsonWorkRepository(test.storage, test.projectId).list(test.projectId))
      .resolves.toEqual([]);
  });

  it('keeps a failed attempt and completes a new retry attempt', async () => {
    const adapter = new ControlledExportAdapter();
    adapter.mode = 'fail';
    const test = await fixture(adapter);
    const started = await test.controller.startExport({
      draftId: test.draft.id,
      expectedRevision: test.draft.revision
    });
    if (!started.ok) throw new Error(started.error.message);
    await test.controller.waitForExports();
    await expect(test.controller.getExport({ taskId: started.value.taskId }))
      .resolves.toMatchObject({
        ok: true,
        value: { state: 'failed', attempt: 1, canRetry: true }
      });

    adapter.mode = 'succeed';
    const retried = await test.controller.retryExport({ taskId: started.value.taskId });
    expect(retried).toMatchObject({ ok: true, value: { state: 'queued', attempt: 2 } });
    await test.controller.waitForExports();
    await expect(test.controller.getExport({ taskId: started.value.taskId }))
      .resolves.toMatchObject({ ok: true, value: { state: 'completed', attempt: 2 } });
    const task = await new JsonTaskRepository(test.storage, test.projectId)
      .get(started.value.taskId as never);
    const attempts = task
      ? await Promise.all(task.executionIds.map((id) =>
          new JsonExecutionRepository(test.storage).get(id)))
      : [];
    expect(attempts.map((attempt) => attempt?.state)).toEqual(['failed', 'completed']);
    await expect(new JsonWorkRepository(test.storage, test.projectId).list(test.projectId))
      .resolves.toHaveLength(1);
  });

  it('persists a source action requirement and never registers an output Work', async () => {
    const adapter = new ControlledExportAdapter();
    const test = await fixture(adapter);
    const started = await test.controller.startExport({
      draftId: test.draft.id,
      expectedRevision: test.draft.revision
    });
    if (!started.ok) throw new Error(started.error.message);
    await waitUntil(() => adapter.started);
    await test.controller.cancelExport({ taskId: started.value.taskId });
    await test.controller.waitForExports();
    await rm(test.sourcePath);

    adapter.started = false;
    const retried = await test.controller.retryExport({ taskId: started.value.taskId });
    expect(retried).toMatchObject({ ok: true, value: { state: 'queued', attempt: 2 } });
    await test.controller.waitForExports();
    await expect(test.controller.getExport({ taskId: started.value.taskId }))
      .resolves.toMatchObject({
        ok: true,
        value: {
          state: 'needs_user_action',
          attempt: 2,
          canRetry: true,
          requiredAction: {
            code: 'source_unavailable',
            message: 'A frozen source identity no longer matches'
          }
        }
      });
    const task = await new JsonTaskRepository(test.storage, test.projectId)
      .get(started.value.taskId as never);
    const latestId = task?.executionIds.at(-1);
    const persisted = latestId
      ? await new JsonExecutionRepository(test.storage).get(latestId)
      : undefined;
    expect(persisted?.userAction).toEqual({
      code: 'source_unavailable',
      message: 'A frozen source identity no longer matches'
    });
    await expect(new JsonWorkRepository(test.storage, test.projectId).list(test.projectId))
      .resolves.toEqual([]);
  });

  it('marks an abandoned active attempt as recovery required on startup scan', async () => {
    const adapter = new ControlledExportAdapter();
    const test = await fixture(adapter);
    const started = await test.controller.startExport({
      draftId: test.draft.id,
      expectedRevision: test.draft.revision
    });
    if (!started.ok) throw new Error(started.error.message);
    await waitUntil(() => adapter.started);

    const restarted = new VideoExportController({
      getSession: () => ({
        projectId: test.projectId,
        projectName: 'Fault project',
        rootDirectory: test.projectRoot
      }),
      getAdapter: () => adapter,
      now: () => '2026-07-27T02:02:00.000Z'
    });
    const recovered = await restarted.recoverExports();
    expect(recovered).toEqual({ ok: true, value: { recoveryRequired: 1 } });
    await expect(restarted.getExport({ taskId: started.value.taskId }))
      .resolves.toMatchObject({
        ok: true,
        value: { state: 'recovery_required', canRetry: true }
      });
  });
});

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for controlled export state');
}
