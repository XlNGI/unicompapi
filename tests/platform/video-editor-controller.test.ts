import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyVideoEditCommand,
  createEmptyVideoEditDraft,
  createEmptyVideoWorkspaceDraft,
  toAssetId,
  toFileReferenceId,
  toIsoTimestamp,
  toProjectId,
  toTextOverlayId,
  toVideoClipId,
  toVideoEditDraftId,
  toDraftId,
  type VideoClip,
  type VideoEditDraft,
  type VideoEditDraftRepository
} from '../../src/domain';
import {
  JsonVideoEditDraftRepository,
  JsonVideoWorkspaceRepository,
  NodeProjectStorage,
  VideoEditorController
} from '../../src/platform';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

function clip(): VideoClip {
  return {
    kind: 'video_clip',
    id: toVideoClipId('editor-controller-clip'),
    source: {
      fileId: toFileReferenceId('editor-controller-file'),
      assetId: toAssetId('editor-controller-asset'),
      identity: {
        sizeBytes: 4096,
        modifiedAtMs: 1_721_822_400_000,
        durationUs: 12_000_000,
        container: 'mp4',
        width: 1280,
        height: 720,
        checksumSha256: 'b'.repeat(64)
      }
    },
    sourceRange: { inUs: 0, outUs: 10_000_000 },
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

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-editor-controller-'));
  roots.push(root);
  const projectId = toProjectId('project-editor-controller');
  const ids = ['editor-draft-1', 'editor-draft-2', 'editor-draft-3'];
  const clipIds = ['editor-split-clip', 'editor-copy-clip'];
  const times = [
    '2026-07-24T14:00:00.000Z',
    '2026-07-24T14:01:00.000Z',
    '2026-07-24T14:02:00.000Z',
    '2026-07-24T14:03:00.000Z',
    '2026-07-24T14:04:00.000Z',
    '2026-07-24T14:05:00.000Z'
  ];
  let lastError: unknown;
  const controller = new VideoEditorController({
    getSession: () => ({
      projectId,
      projectName: 'Editor project',
      rootDirectory: root
    }),
    createDraftId: () => ids.shift() ?? 'editor-draft-fallback',
    createClipId: () => clipIds.shift() ?? 'editor-clip-fallback',
    now: () => times.shift() ?? '2026-07-24T14:59:00.000Z',
    onError: (error) => {
      lastError = error;
    }
  });
  return {
    controller,
    getLastError: () => lastError,
    projectId,
    root,
    storage: new NodeProjectStorage(root)
  };
}

describe('VideoEditorController', () => {
  it('requires an active project and validates source intent', async () => {
    const withoutProject = new VideoEditorController({
      getSession: () => undefined
    });

    await expect(withoutProject.create({})).resolves.toMatchObject({
      ok: false,
      error: { code: 'project_not_open' }
    });

    const fixture = await createFixture();
    await expect(
      fixture.controller.create({
        sourceIntent: {
          kind: 'from_work',
          sourceWorkId: 'missing-video-work'
        }
      })
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'source_not_found' }
    });
  });

  it('creates, updates, undoes, redoes and copies revisioned drafts', async () => {
    const fixture = await createFixture();
    const created = await fixture.controller.create({});
    if (!created.ok) throw fixture.getLastError();

    const updated = await fixture.controller.update({
      draftId: created.value.draftId,
      expectedRevision: created.value.revision,
      command: { kind: 'set_title', title: '负责人剪辑草稿' }
    });
    if (!updated.ok) throw fixture.getLastError();

    const undone = await fixture.controller.undo({
      draftId: updated.value.draftId,
      expectedRevision: updated.value.revision
    });
    if (!undone.ok) throw fixture.getLastError();

    const redone = await fixture.controller.redo({
      draftId: undone.value.draftId,
      expectedRevision: undone.value.revision
    });
    if (!redone.ok) throw fixture.getLastError();

    const copied = await fixture.controller.copy({
      draftId: redone.value.draftId,
      expectedRevision: redone.value.revision,
      title: '负责人剪辑草稿副本'
    });

    expect(updated.value).toMatchObject({
      title: '负责人剪辑草稿',
      revision: 1,
      canUndo: true,
      canRedo: false
    });
    expect(undone.value).toMatchObject({
      title: '视频基础编辑草稿',
      revision: 2,
      canRedo: true
    });
    expect(redone.value.title).toBe('负责人剪辑草稿');
    expect(copied).toMatchObject({
      ok: true,
      value: {
        title: '负责人剪辑草稿副本',
        revision: 0,
        canUndo: false,
        canRedo: false
      }
    });
    const listed = await fixture.controller.list();
    expect(listed.ok && listed.value).toHaveLength(2);
  });

  it('rejects stale revisions and unsupported command fields', async () => {
    const fixture = await createFixture();
    const created = await fixture.controller.create({});
    if (!created.ok) throw fixture.getLastError();

    await fixture.controller.update({
      draftId: created.value.draftId,
      expectedRevision: 0,
      command: { kind: 'set_title', title: 'first' }
    });

    await expect(
      fixture.controller.update({
        draftId: created.value.draftId,
        expectedRevision: 0,
        command: { kind: 'set_title', title: 'stale' }
      })
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'draft_conflict' }
    });

    await expect(
      fixture.controller.update({
        draftId: created.value.draftId,
        expectedRevision: 1,
        command: {
          kind: 'set_title',
          title: 'unsafe',
          absolutePath: path.join(fixture.root, 'source.mp4')
        }
      })
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'invalid_request' }
    });
  });

  it('derives split command facts in the main process and returns safe DTOs', async () => {
    const fixture = await createFixture();
    const repository = new JsonVideoEditDraftRepository(
      fixture.storage,
      fixture.projectId
    );
    const base = createEmptyVideoEditDraft({
      id: toVideoEditDraftId('seeded-editor-draft'),
      projectId: fixture.projectId,
      createdAt: toIsoTimestamp('2026-07-24T13:59:00.000Z')
    });
    const seeded = applyVideoEditCommand(
      base,
      {
        schemaVersion: 1,
        kind: 'insert_clip',
        clip: clip(),
        targetIndex: 0
      },
      toIsoTimestamp('2026-07-24T13:59:30.000Z')
    );
    await repository.save(seeded);

    const split = await fixture.controller.update({
      draftId: seeded.id,
      expectedRevision: seeded.revision,
      command: {
        kind: 'split_clip',
        clipId: seeded.videoTrack[0]!.id,
        atSourceUs: 4_000_000
      }
    });

    expect(split).toMatchObject({
      ok: true,
      value: {
        revision: 2,
        videoTrack: [
          { sourceRange: { inUs: 0, outUs: 4_000_000 } },
          { clipId: 'editor-split-clip', sourceRange: { inUs: 4_000_000 } }
        ]
      }
    });
    const serialized = JSON.stringify(split);
    expect(serialized).not.toContain(fixture.root);
    expect(serialized).not.toContain('checksumSha256');
    expect(serialized).not.toContain('modifiedAtMs');
    expect(serialized).not.toContain('undoStack');
    expect(serialized).not.toContain('internalCommand');
  });

  it('removes a clip while keeping dependent timeline content valid and undoable', async () => {
    const fixture = await createFixture();
    const repository = new JsonVideoEditDraftRepository(
      fixture.storage,
      fixture.projectId
    );
    const firstClip = clip();
    const secondClip: VideoClip = {
      ...clip(),
      id: toVideoClipId('editor-controller-clip-2')
    };
    const base = createEmptyVideoEditDraft({
      id: toVideoEditDraftId('remove-dependent-editor-draft'),
      projectId: fixture.projectId,
      createdAt: toIsoTimestamp('2026-07-24T13:50:00.000Z')
    });
    const withFirstClip = applyVideoEditCommand(
      base,
      { schemaVersion: 1, kind: 'insert_clip', clip: firstClip, targetIndex: 0 },
      toIsoTimestamp('2026-07-24T13:51:00.000Z')
    );
    const withClips = applyVideoEditCommand(
      withFirstClip,
      { schemaVersion: 1, kind: 'insert_clip', clip: secondClip, targetIndex: 1 },
      toIsoTimestamp('2026-07-24T13:52:00.000Z')
    );
    const textStyle = {
      requestedFontFamily: 'system-ui',
      fontSizeMilliPx: 32_000,
      alignment: 'center' as const,
      opacityPermille: 1000,
      color: '#ffffff'
    };
    const textPosition = { xPermille: 500, yPermille: 800 };
    const withFirstText = applyVideoEditCommand(
      withClips,
      {
        schemaVersion: 1,
        kind: 'upsert_text',
        before: null,
        after: {
          kind: 'text_overlay',
          id: toTextOverlayId('editor-controller-text-1'),
          content: 'keep and trim',
          range: { startUs: 0, endUs: 20_000_000 },
          style: textStyle,
          position: textPosition,
          entrance: 'none',
          exit: 'none'
        }
      },
      toIsoTimestamp('2026-07-24T13:53:00.000Z')
    );
    const withTexts = applyVideoEditCommand(
      withFirstText,
      {
        schemaVersion: 1,
        kind: 'upsert_text',
        before: null,
        after: {
          kind: 'text_overlay',
          id: toTextOverlayId('editor-controller-text-2'),
          content: 'remove after timeline end',
          range: { startUs: 15_000_000, endUs: 19_000_000 },
          style: textStyle,
          position: textPosition,
          entrance: 'none',
          exit: 'none'
        }
      },
      toIsoTimestamp('2026-07-24T13:54:00.000Z')
    );
    const withMusic = applyVideoEditCommand(
      withTexts,
      {
        schemaVersion: 1,
        kind: 'set_background_music',
        before: null,
        after: {
          kind: 'background_music',
          fileId: toFileReferenceId('editor-controller-music'),
          identity: {
            sizeBytes: 2048,
            modifiedAtMs: 1_721_822_400_000,
            durationUs: 20_000_000,
            container: 'wav',
            width: 0,
            height: 0,
            checksumSha256: 'c'.repeat(64)
          },
          sourceRange: { inUs: 0, outUs: 20_000_000 },
          timelineRange: { startUs: 0, endUs: 20_000_000 },
          volumePermille: 700,
          fadeInUs: 6_000_000,
          fadeOutUs: 6_000_000
        }
      },
      toIsoTimestamp('2026-07-24T13:55:00.000Z')
    );
    const seeded = applyVideoEditCommand(
      withMusic,
      {
        schemaVersion: 1,
        kind: 'set_cover',
        before: null,
        after: {
          kind: 'video_frame',
          clipId: firstClip.id,
          sourceTimeUs: 1_000_000,
          prependToVideo: false
        }
      },
      toIsoTimestamp('2026-07-24T13:56:00.000Z')
    );
    await repository.save(seeded);

    const removed = await fixture.controller.update({
      draftId: seeded.id,
      expectedRevision: seeded.revision,
      command: { kind: 'remove_clip', clipId: firstClip.id }
    });
    if (!removed.ok) throw fixture.getLastError();

    expect(removed.value.videoTrack).toHaveLength(1);
    expect(removed.value.textTrack).toEqual([
      expect.objectContaining({ range: { startUs: 0, endUs: 10_000_000 } })
    ]);
    expect(removed.value.backgroundMusic).toMatchObject({
      timelineRange: { startUs: 0, endUs: 10_000_000 },
      fadeInUs: 6_000_000,
      fadeOutUs: 4_000_000
    });
    expect(removed.value.cover).toBeNull();

    const undone = await fixture.controller.undo({
      draftId: removed.value.draftId,
      expectedRevision: removed.value.revision
    });
    if (!undone.ok) throw fixture.getLastError();
    expect(undone.value.videoTrack).toHaveLength(2);
    expect(undone.value.textTrack.map((text) => text.range)).toEqual([
      { startUs: 0, endUs: 20_000_000 },
      { startUs: 15_000_000, endUs: 19_000_000 }
    ]);
    expect(undone.value.backgroundMusic).toMatchObject({
      timelineRange: { startUs: 0, endUs: 20_000_000 },
      fadeInUs: 6_000_000,
      fadeOutUs: 6_000_000
    });
    expect(undone.value.cover).toMatchObject({ clipId: firstClip.id });
  });

  it('accepts an existing video generation draft as explicit source intent', async () => {
    const fixture = await createFixture();
    const source = createEmptyVideoWorkspaceDraft({
      id: toDraftId('source-video-workspace'),
      projectId: fixture.projectId,
      mode: 'quick_video',
      createdAt: toIsoTimestamp('2026-07-24T13:58:00.000Z')
    });
    await new JsonVideoWorkspaceRepository(
      fixture.storage,
      fixture.projectId
    ).save(source);

    const created = await fixture.controller.create({
      sourceIntent: {
        kind: 'from_video_draft',
        sourceDraftId: source.id
      }
    });

    expect(created).toMatchObject({
      ok: true,
      value: {
        sourceIntent: {
          kind: 'from_video_draft',
          sourceDraftId: source.id
        },
        videoTrack: []
      }
    });
  });

  it('retains a recoverable in-memory draft when atomic save fails', async () => {
    let failSave = true;
    let saved: VideoEditDraft | undefined;
    const repository: VideoEditDraftRepository = {
      get: async (id) => (saved?.id === id ? saved : undefined),
      list: async () => (saved ? [saved] : []),
      save: async (draft) => {
        if (failSave) throw new Error('simulated disk failure');
        saved = draft;
      }
    };
    const projectId = toProjectId('project-editor-save-failure');
    const controller = new VideoEditorController({
      getSession: () => ({
        projectId,
        projectName: 'Save failure project',
        rootDirectory: 'virtual-project-root'
      }),
      createRepository: () => repository,
      createDraftId: () => 'recoverable-editor-draft',
      now: () => '2026-07-24T15:00:00.000Z'
    });

    const created = await controller.create({});
    expect(created).toMatchObject({
      ok: false,
      error: {
        code: 'workspace_storage_error',
        recoverableDraft: {
          draftId: 'recoverable-editor-draft',
          revision: 0
        }
      }
    });

    const pending = await controller.get({
      draftId: 'recoverable-editor-draft'
    });
    expect(pending).toMatchObject({ ok: true, value: { revision: 0 } });

    failSave = false;
    const savedResult = await controller.update({
      draftId: 'recoverable-editor-draft',
      expectedRevision: 0,
      command: { kind: 'set_title', title: '恢复后保存' }
    });
    expect(savedResult).toMatchObject({
      ok: true,
      value: { title: '恢复后保存', revision: 1 }
    });
    expect(saved?.title).toBe('恢复后保存');
  });
});
