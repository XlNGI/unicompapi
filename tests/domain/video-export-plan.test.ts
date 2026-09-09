import { describe, expect, it } from 'vitest';
import {
  createVideoEditingTask,
  createVideoExportPlan,
  isVideoExportPlan,
  toFileReferenceId,
  toIsoTimestamp,
  toProjectId,
  toTaskId,
  toVideoClipId,
  toVideoEditDraftId,
  toVideoExportPlanId,
  type VideoClip
} from '../../src/domain';

const timestamp = toIsoTimestamp('2026-07-27T01:00:00.000Z');

function clip(): VideoClip {
  return {
    kind: 'video_clip',
    id: toVideoClipId('export-clip'),
    source: {
      fileId: toFileReferenceId('export-source'),
      identity: {
        sizeBytes: 1024,
        modifiedAtMs: 1,
        durationUs: 1_000_000,
        container: 'webm',
        width: 96,
        height: 64,
        checksumSha256: 'b'.repeat(64)
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
    sourceAudio: { muted: false, volumePermille: 1000 },
    transitionToNext: { kind: 'none' }
  };
}

function plan(item = clip()) {
  return createVideoExportPlan({
    id: toVideoExportPlanId('export-plan'),
    projectId: toProjectId('export-project'),
    taskId: toTaskId('export-task'),
    draftId: toVideoEditDraftId('export-draft'),
    draftRevision: 3,
    title: 'Frozen edit',
    inputs: [{
      fileId: item.source.fileId,
      role: { kind: 'clip', clipId: item.id },
      identity: item.source.identity
    }],
    timeline: {
      canvas: {
        aspectRatio: { kind: 'source' },
        transformPolicy: 'fit',
        background: { kind: 'solid', color: '#000000' }
      },
      clips: [item],
      textTrack: [],
      backgroundMusic: null,
      cover: null
    },
    output: {
      relativePath: 'files/results/frozen.webm',
      fileName: 'frozen.webm',
      conflictPolicy: 'create_unique_name',
      container: 'webm',
      videoCodec: 'libvpx-vp9',
      audioCodec: 'libopus',
      resolution: { kind: 'source' },
      frameRate: { kind: 'source' },
      quality: { kind: 'crf', value: 32 },
      hardwareAcceleration: 'software_only'
    },
    engine: {
      adapterId: 'ffmpeg',
      adapterVersion: '8.1.2',
      engineVersion: 'ffmpeg version 8.1.2',
      videoEncoder: 'libvpx-vp9',
      audioEncoder: 'libopus',
      container: 'webm'
    },
    estimatedOutputBytes: 1_048_576,
    planHash: 'a'.repeat(64),
    createdAt: timestamp
  });
}

describe('video export plan contracts', () => {
  it('deep-freezes editing semantics away from subsequent draft mutations', () => {
    const original = clip();
    const frozen = plan(original);
    (original as unknown as { transform: { scalePermille: number } })
      .transform.scalePermille = 500;

    expect(frozen.timeline.clips[0].transform.scalePermille).toBe(1000);
    expect(isVideoExportPlan(frozen)).toBe(true);
    expect(frozen.planHash).toHaveLength(64);
  });

  it('creates a video editing task without a synthetic prompt', () => {
    const frozen = plan();
    const task = createVideoEditingTask({
      id: frozen.taskId,
      projectId: frozen.projectId,
      draftId: frozen.draftId,
      draftRevision: frozen.draftRevision,
      exportPlanId: frozen.id,
      title: frozen.title,
      confirmedAt: timestamp
    });

    expect(task.submission).toMatchObject({
      kind: 'video_editing',
      videoEditing: { exportPlanId: frozen.id, draftRevision: 3 }
    });
    expect('prompt' in task.submission).toBe(false);
  });
});
