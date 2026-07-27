import { describe, expect, it } from 'vitest';
import {
  applyVideoEditCommand,
  copyVideoEditDraft,
  createEmptyVideoEditDraft,
  getVideoTimelineDurationUs,
  isVideoEditCommand,
  isVideoEditDraft,
  redoVideoEditCommand,
  toAssetId,
  toFileReferenceId,
  toIsoTimestamp,
  toProjectId,
  toTextOverlayId,
  toVideoClipId,
  toVideoEditDraftId,
  toWorkId,
  undoVideoEditCommand,
  videoEditHistoryLimit,
  type TextOverlay,
  type VideoClip,
  type VideoEditCommand,
  type VideoEditDraft
} from '../../src/domain';

const t0 = toIsoTimestamp('2026-07-24T12:00:00.000Z');
const t1 = toIsoTimestamp('2026-07-24T12:01:00.000Z');
const t2 = toIsoTimestamp('2026-07-24T12:02:00.000Z');
const projectId = toProjectId('project-video-editor');

function emptyDraft(): VideoEditDraft {
  return createEmptyVideoEditDraft({
    id: toVideoEditDraftId('edit-draft-1'),
    projectId,
    createdAt: t0
  });
}

function clip(id = 'clip-1', inUs = 0, outUs = 10_000_000): VideoClip {
  return {
    kind: 'video_clip',
    id: toVideoClipId(id),
    source: {
      fileId: toFileReferenceId('file-' + id),
      assetId: toAssetId('asset-' + id),
      workId: toWorkId('work-' + id),
      identity: {
        sizeBytes: 1024,
        modifiedAtMs: 1_721_822_400_000,
        durationUs: 20_000_000,
        container: 'mp4',
        width: 1920,
        height: 1080,
        checksumSha256: 'a'.repeat(64)
      }
    },
    sourceRange: { inUs, outUs },
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

function insert(
  draft: VideoEditDraft,
  item = clip(),
  targetIndex = 0
): VideoEditDraft {
  return applyVideoEditCommand(
    draft,
    {
      schemaVersion: 1,
      kind: 'insert_clip',
      clip: item,
      targetIndex
    },
    t1
  );
}

describe('video editor draft contracts', () => {
  it('creates a strict non-destructive empty edit draft', () => {
    const draft = emptyDraft();

    expect(isVideoEditDraft(draft)).toBe(true);
    expect(draft.kind).toBe('video_basic_edit');
    expect(draft.videoTrack).toEqual([]);
    expect(draft.backgroundMusic).toBeNull();
    expect(draft.history).toEqual({
      baseRevision: 0,
      undoStack: [],
      redoStack: []
    });
    expect(JSON.stringify(draft)).not.toContain('absolutePath');
    expect(JSON.stringify(draft)).not.toContain('taskId');
    expect(JSON.stringify(draft)).not.toContain('exportPlan');
  });

  it('applies serialized commands and derives duration from range and speed', () => {
    const inserted = insert(emptyDraft());
    const speed: VideoEditCommand = {
      schemaVersion: 1,
      kind: 'set_clip_speed',
      clipId: inserted.videoTrack[0]!.id,
      before: { numerator: 1, denominator: 1 },
      after: { numerator: 2, denominator: 1 }
    };
    const changed = applyVideoEditCommand(inserted, speed, t2);

    expect(isVideoEditCommand(speed)).toBe(true);
    expect(changed.revision).toBe(2);
    expect(getVideoTimelineDurationUs(changed)).toBe(5_000_000);
    expect(changed.history.undoStack.map((command) => command.kind)).toEqual([
      'insert_clip',
      'set_clip_speed'
    ]);
  });

  it('undoes and redoes without replacing prior command facts', () => {
    const inserted = insert(emptyDraft());
    const renamed = applyVideoEditCommand(
      inserted,
      {
        schemaVersion: 1,
        kind: 'set_title',
        before: inserted.title,
        after: '本地剪辑草稿'
      },
      t2
    );
    const undone = undoVideoEditCommand(renamed, t2);
    const redone = redoVideoEditCommand(undone, t2);

    expect(undone.title).toBe('视频基础编辑草稿');
    expect(undone.history.redoStack.at(-1)?.kind).toBe('set_title');
    expect(redone.title).toBe('本地剪辑草稿');
    expect(redone.revision).toBe(4);
  });

  it('relinks a clip source through reversible domain history', () => {
    const inserted = insert(emptyDraft());
    const original = inserted.videoTrack[0]!;
    const replacement = {
      fileId: toFileReferenceId('file-relinked'),
      assetId: toAssetId('asset-relinked'),
      identity: {
        ...original.source.identity,
        modifiedAtMs: original.source.identity.modifiedAtMs + 1,
        checksumSha256: 'b'.repeat(64)
      }
    };
    const relinked = applyVideoEditCommand(
      inserted,
      {
        schemaVersion: 1,
        kind: 'set_clip_source',
        clipId: original.id,
        before: original.source,
        after: replacement
      },
      t2
    );

    expect(relinked.videoTrack[0]?.source).toEqual(replacement);
    expect(undoVideoEditCommand(relinked, t2).videoTrack[0]?.source).toEqual(
      original.source
    );
    expect(isVideoEditCommand(relinked.history.undoStack.at(-1))).toBe(true);
  });

  it('supports split, remove and restore as reversible single-track commands', () => {
    const inserted = insert(emptyDraft());
    const original = inserted.videoTrack[0]!;
    const left = {
      ...original,
      sourceRange: { inUs: 0, outUs: 4_000_000 }
    };
    const right = {
      ...original,
      id: toVideoClipId('clip-2'),
      sourceRange: { inUs: 4_000_000, outUs: 10_000_000 }
    };
    const split = applyVideoEditCommand(
      inserted,
      {
        schemaVersion: 1,
        kind: 'split_clip',
        sourceIndex: 0,
        before: original,
        afterLeft: left,
        createdRight: right
      },
      t2
    );
    const removed = applyVideoEditCommand(
      split,
      {
        schemaVersion: 1,
        kind: 'remove_clip',
        clip: right,
        previousIndex: 1
      },
      t2
    );
    const restored = applyVideoEditCommand(
      removed,
      {
        schemaVersion: 1,
        kind: 'restore_clip',
        clip: right,
        targetIndex: 1
      },
      t2
    );

    expect(split.videoTrack.map((item) => item.id)).toEqual([
      'clip-1',
      'clip-2'
    ]);
    expect(removed.removedClips[0]?.clip.id).toBe('clip-2');
    expect(restored.removedClips).toEqual([]);
    expect(getVideoTimelineDurationUs(restored)).toBe(10_000_000);
    expect(undoVideoEditCommand(restored, t2).removedClips[0]?.clip.id).toBe(
      'clip-2'
    );
  });

  it('keeps text, music and cover inside the current timeline', () => {
    const inserted = insert(emptyDraft());
    const text: TextOverlay = {
      kind: 'text_overlay',
      id: toTextOverlayId('text-1'),
      content: '基础文字',
      range: { startUs: 1_000_000, endUs: 5_000_000 },
      style: {
        requestedFontFamily: 'system-ui',
        fontSizeMilliPx: 32_000,
        alignment: 'center',
        opacityPermille: 1000,
        color: '#ffffff'
      },
      position: { xPermille: 500, yPermille: 800 },
      entrance: 'fade_in',
      exit: 'fade_out'
    };
    const withText = applyVideoEditCommand(
      inserted,
      {
        schemaVersion: 1,
        kind: 'upsert_text',
        before: null,
        after: text
      },
      t2
    );
    const withCover = applyVideoEditCommand(
      withText,
      {
        schemaVersion: 1,
        kind: 'set_cover',
        before: null,
        after: {
          kind: 'video_frame',
          clipId: inserted.videoTrack[0]!.id,
          sourceTimeUs: 2_000_000,
          prependToVideo: false
        }
      },
      t2
    );

    expect(isVideoEditDraft(withCover)).toBe(true);
    expect(withCover.textTrack).toHaveLength(1);
    expect(withCover.cover).toMatchObject({ prependToVideo: false });
    expect(isVideoEditDraft({
      ...withCover,
      cover: { ...withCover.cover!, prependToVideo: true }
    })).toBe(false);
    expect(isVideoEditDraft({
      ...withCover,
      cover: {
        ...withCover.cover!,
        prependToVideo: true,
        prependDurationUs: 750_000
      }
    })).toBe(true);
    expect(
      isVideoEditDraft({
        ...withCover,
        textTrack: [
          { ...text, range: { startUs: 0, endUs: 11_000_000 } }
        ]
      })
    ).toBe(false);
  });

  it('copies current edit state under a new identity with cleared history', () => {
    const source = insert(emptyDraft());
    const copy = copyVideoEditDraft({
      source,
      id: toVideoEditDraftId('edit-draft-copy'),
      createdAt: t2
    });

    expect(copy.id).toBe('edit-draft-copy');
    expect(copy.videoTrack).toEqual(source.videoTrack);
    expect(copy.revision).toBe(0);
    expect(copy.history.undoStack).toEqual([]);
    expect(copy.createdAt).toBe(t2);
  });

  it('bounds persisted command history without losing current state', () => {
    let draft = emptyDraft();
    for (let index = 0; index < videoEditHistoryLimit + 1; index += 1) {
      const nextTitle = '草稿-' + index;
      draft = applyVideoEditCommand(
        draft,
        {
          schemaVersion: 1,
          kind: 'set_title',
          before: draft.title,
          after: nextTitle
        },
        t2
      );
    }

    expect(draft.history.undoStack).toHaveLength(videoEditHistoryLimit);
    expect(draft.history.baseRevision).toBe(1);
    expect(draft.title).toBe('草稿-100');
  });

  it('rejects protected fields, duplicate identities and malformed commands', () => {
    const valid = insert(emptyDraft());
    const duplicate = valid.videoTrack[0]!;

    expect(
      isVideoEditDraft({
        ...valid,
        absolutePath: 'C:\\private\\source.mp4'
      })
    ).toBe(false);
    expect(
      isVideoEditDraft({
        ...valid,
        videoTrack: [duplicate, duplicate]
      })
    ).toBe(false);
    expect(
      isVideoEditCommand({
        schemaVersion: 1,
        kind: 'trim_clip',
        clipId: duplicate.id,
        before: duplicate.sourceRange,
        after: { inUs: 9_000_000, outUs: 1_000_000 }
      })
    ).toBe(false);
  });
});
