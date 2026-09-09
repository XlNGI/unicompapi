import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  toExecutionId,
  toProjectId,
  toTaskId,
  toWorkId
} from '../../src/domain';
import {
  JsonFileReferenceRepository,
  JsonVideoEditDraftRepository,
  JsonWorkRepository,
  LocalMediaHandleRegistry,
  NodeProjectStorage,
  VideoEditorController,
  VideoEditorMediaController,
  VideoWorkspaceMutationCoordinator
} from '../../src/platform';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-editor-media-'));
  roots.push(root);
  const projectRoot = path.join(root, 'project');
  await mkdir(projectRoot);
  const original = path.join(root, 'original-video.bin');
  const exactReplacement = path.join(root, 'exact-replacement.bin');
  const mismatchReplacement = path.join(root, 'mismatch-replacement.bin');
  const backgroundMusic = path.join(root, 'background.wav');
  const coverImage = path.join(root, 'cover.png');
  const content = isoBmffVideo();
  await writeFile(original, content);
  await writeFile(exactReplacement, content);
  await writeFile(
    mismatchReplacement,
    isoBmffVideo({ suffix: 'different-video-payload' })
  );
  await writeFile(backgroundMusic, waveAudio());
  await writeFile(coverImage, pngImage());

  const projectId = toProjectId('project-video-editor-media');
  const session = {
    projectId,
    projectName: 'Editor media project',
    rootDirectory: projectRoot
  };
  const mutations = new VideoWorkspaceMutationCoordinator();
  let draftSequence = 0;
  const editor = new VideoEditorController({
    getSession: () => session,
    mutations,
    createDraftId: () => `editor-media-draft-${++draftSequence}`
  });
  const created = await editor.create({});
  if (!created.ok) throw new Error(created.error.message);

  let selectedPath: string | undefined = original;
  let fileSequence = 0;
  let assetSequence = 0;
  let clipSequence = 0;
  let lastError: unknown;
  const handles = new LocalMediaHandleRegistry();
  const controller = new VideoEditorMediaController({
    getSession: () => session,
    chooseAudioFile: async () => backgroundMusic,
    chooseImageFile: async () => coverImage,
    chooseVideoFile: async () => selectedPath,
    handles,
    editor,
    createFileId: () => `editor-media-file-${++fileSequence}`,
    createAssetId: () => `editor-media-asset-${++assetSequence}`,
    createClipId: () => `editor-media-clip-${++clipSequence}`,
    onError: (error) => {
      lastError = error;
    }
  });
  const storage = new NodeProjectStorage(projectRoot);

  return {
    controller,
    backgroundMusic,
    coverImage,
    created: created.value,
    editor,
    exactReplacement,
    getLastError: () => lastError,
    handles,
    mismatchReplacement,
    original,
    projectId,
    projectRoot,
    setSelected: (target: string | undefined) => {
      selectedPath = target;
    },
    storage
  };
}

describe('VideoEditorMediaController', () => {
  it('registers a verified external source and exposes only controlled previews', async () => {
    const fixture = await createFixture();
    await expect(
      fixture.controller.selectSource({
        draftId: fixture.created.draftId,
        expectedRevision: fixture.created.revision,
        strategy: 'external_reference',
        absolutePath: fixture.original
      })
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'invalid_request' }
    });
    const selected = await fixture.controller.selectSource({
      draftId: fixture.created.draftId,
      expectedRevision: fixture.created.revision,
      strategy: 'external_reference'
    });
    if (!selected.ok || selected.value.cancelled || !selected.value.source) {
      throw fixture.getLastError();
    }

    expect(selected.value).toMatchObject({
      draft: { revision: 1, videoTrack: [{ clipId: 'editor-media-clip-1' }] },
      source: {
        referenceKind: 'external_reference',
        fileState: 'available',
        identity: { durationUs: 2_500_000, width: 1280, height: 720 }
      }
    });
    const serialized = JSON.stringify(selected);
    expect(serialized).not.toContain(fixture.projectRoot);
    expect(serialized).not.toContain('checksumSha256');
    expect(serialized).not.toContain('modifiedAtMs');

    const preview = await fixture.controller.createSourcePreview({
      draftId: fixture.created.draftId,
      clipId: selected.value.source.clipId
    });
    if (!preview.ok) throw fixture.getLastError();
    const url = new URL(preview.value.url);
    expect(fixture.handles.resolve(url.pathname.slice(1))).toBe(fixture.original);
    expect(preview.value).toMatchObject({ kind: 'original', mimeType: 'video/mp4' });

    await expect(
      fixture.controller.requestPreviewArtifact({
        draftId: fixture.created.draftId,
        clipId: selected.value.source.clipId,
        kind: 'thumbnail_strip'
      })
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'adapter_unavailable' }
    });
  });

  it('keeps one verified background track and registers a path-free local cover', async () => {
    const fixture = await createFixture();
    const source = await fixture.controller.selectSource({
      draftId: fixture.created.draftId,
      expectedRevision: 0,
      strategy: 'external_reference'
    });
    if (!source.ok || source.value.cancelled || !source.value.draft) {
      throw fixture.getLastError();
    }

    const music = await fixture.controller.selectBackgroundMusic({
      draftId: fixture.created.draftId,
      expectedRevision: 1
    });
    if (!music.ok || music.value.cancelled || !music.value.draft) {
      throw new Error(JSON.stringify(music));
    }
    expect(music.value.draft).toMatchObject({
      revision: 2,
      backgroundMusic: {
        identity: { container: 'wav', durationUs: 1_000_000, width: 0, height: 0 },
        timelineRange: { startUs: 0, endUs: 1_000_000 }
      }
    });

    const replacement = await fixture.controller.selectBackgroundMusic({
      draftId: fixture.created.draftId,
      expectedRevision: 2
    });
    expect(replacement).toMatchObject({
      ok: true,
      value: { draft: { revision: 3, backgroundMusic: { identity: { container: 'wav' } } } }
    });

    const cover = await fixture.controller.selectCoverImage({
      draftId: fixture.created.draftId,
      expectedRevision: 3,
      prependToVideo: false
    });
    expect(cover).toMatchObject({
      ok: true,
      value: {
        draft: {
          revision: 4,
          cover: { kind: 'local_image', prependToVideo: false }
        }
      }
    });
    const serialized = JSON.stringify({ music, cover });
    expect(serialized).not.toContain(fixture.backgroundMusic);
    expect(serialized).not.toContain(fixture.coverImage);
    expect(serialized).not.toContain('checksumSha256');
    if (
      !cover.ok ||
      cover.value.cancelled ||
      cover.value.draft?.cover?.kind !== 'local_image'
    ) {
      throw new Error(JSON.stringify(cover));
    }
    await new JsonWorkRepository(fixture.storage, fixture.projectId).save({
      schemaVersion: 1,
      id: toWorkId('editor-cover-work'),
      projectId: fixture.projectId,
      sourceTaskId: toTaskId('editor-cover-task'),
      sourceExecutionId: toExecutionId('editor-cover-execution'),
      fileId: cover.value.draft.cover.fileId as never,
      mediaKind: 'image',
      name: '项目封面作品',
      createdAt: new Date().toISOString() as never
    });
    await expect(
      fixture.controller.attachCoverWork({
        draftId: fixture.created.draftId,
        expectedRevision: 4,
        workId: 'editor-cover-work',
        prependToVideo: false
      })
    ).resolves.toMatchObject({
      ok: true,
      value: {
        revision: 5,
        cover: {
          kind: 'project_image',
          workId: 'editor-cover-work',
          prependToVideo: false
        }
      }
    });
    await expect(
      fixture.controller.selectCoverImage({
        draftId: fixture.created.draftId,
        expectedRevision: 5,
        prependToVideo: false,
        absolutePath: fixture.coverImage
      })
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'invalid_request' }
    });
  });

  it('publishes a verified managed copy atomically and keeps it after the original is removed', async () => {
    const fixture = await createFixture();
    const selected = await fixture.controller.selectSource({
      draftId: fixture.created.draftId,
      expectedRevision: 0,
      strategy: 'managed_project_copy'
    });
    if (!selected.ok || selected.value.cancelled || !selected.value.source) {
      throw fixture.getLastError();
    }
    const files = await new JsonFileReferenceRepository(
      fixture.storage,
      fixture.projectId
    ).list(fixture.projectId);
    const managed = files.find(
      (file) => file.id === selected.value.draft?.videoTrack[0]?.source.fileId
    );
    expect(managed?.locator.kind).toBe('project');
    expect(managed?.locator.kind === 'project' && managed.locator.relativePath)
      .toMatch(/^files\/editor-sources\//);

    await rm(fixture.original);
    const preview = await fixture.controller.createSourcePreview({
      draftId: fixture.created.draftId,
      clipId: selected.value.source.clipId
    });
    expect(preview).toMatchObject({ ok: true, value: { kind: 'original' } });
    await expect(fixture.controller.clearPreviewCache()).resolves.toEqual({
      ok: true,
      value: { cleared: true }
    });
    await expect(
      new JsonVideoEditDraftRepository(
        fixture.storage,
        fixture.projectId
      ).get(fixture.created.draftId as never)
    ).resolves.toMatchObject({ revision: 1, videoTrack: [{ id: selected.value.source.clipId }] });
  });

  it('reports missing and changed sources without removing their clips', async () => {
    const missing = await createFixture();
    const selectedMissing = await missing.controller.selectSource({
      draftId: missing.created.draftId,
      expectedRevision: 0,
      strategy: 'external_reference'
    });
    if (!selectedMissing.ok || selectedMissing.value.cancelled || !selectedMissing.value.source) {
      throw missing.getLastError();
    }
    await rm(missing.original);
    await expect(
      missing.controller.getSourceStatus({
        draftId: missing.created.draftId,
        clipId: selectedMissing.value.source.clipId
      })
    ).resolves.toMatchObject({
      ok: true,
      value: { state: 'missing', relinkRequired: true }
    });

    const changed = await createFixture();
    const selectedChanged = await changed.controller.selectSource({
      draftId: changed.created.draftId,
      expectedRevision: 0,
      strategy: 'external_reference'
    });
    if (!selectedChanged.ok || selectedChanged.value.cancelled || !selectedChanged.value.source) {
      throw changed.getLastError();
    }
    await writeFile(changed.original, isoBmffVideo({ suffix: 'changed-in-place' }));
    await expect(
      changed.controller.getSourceStatus({
        draftId: changed.created.draftId,
        clipId: selectedChanged.value.source.clipId
      })
    ).resolves.toMatchObject({
      ok: true,
      value: {
        state: 'corrupted',
        matchesIdentity: false,
        relinkRequired: true
      }
    });
    const stored = await new JsonVideoEditDraftRepository(
      changed.storage,
      changed.projectId
    ).get(changed.created.draftId as never);
    expect(stored?.videoTrack).toHaveLength(1);
  });

  it('uses a two-stage relink and requires explicit acceptance for mismatches', async () => {
    const fixture = await createFixture();
    const selected = await fixture.controller.selectSource({
      draftId: fixture.created.draftId,
      expectedRevision: 0,
      strategy: 'external_reference'
    });
    if (!selected.ok || selected.value.cancelled || !selected.value.source || !selected.value.draft) {
      throw fixture.getLastError();
    }
    fixture.setSelected(fixture.mismatchReplacement);
    const prepared = await fixture.controller.prepareRelink({
      draftId: fixture.created.draftId,
      clipId: selected.value.source.clipId
    });
    if (!prepared.ok || prepared.value.cancelled || !prepared.value.token) {
      throw fixture.getLastError();
    }
    expect(prepared.value).toMatchObject({
      matchesIdentity: false,
      differences: { content: true }
    });
    expect(JSON.stringify(prepared)).not.toContain(fixture.mismatchReplacement);
    await expect(
      fixture.controller.confirmRelink({
        draftId: fixture.created.draftId,
        clipId: selected.value.source.clipId,
        token: prepared.value.token,
        acceptMismatch: false
      })
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'relink_mismatch_confirmation_required' }
    });

    const confirmed = await fixture.controller.confirmRelink({
      draftId: fixture.created.draftId,
      clipId: selected.value.source.clipId,
      token: prepared.value.token,
      acceptMismatch: true
    });
    expect(confirmed).toMatchObject({ ok: true, value: { draft: { revision: 2 } } });
    const undone = await fixture.editor.undo({
      draftId: fixture.created.draftId,
      expectedRevision: 2
    });
    expect(undone).toMatchObject({
      ok: true,
      value: {
        revision: 3,
        videoTrack: [{ source: { fileId: selected.value.draft.videoTrack[0]?.source.fileId } }]
      }
    });
  });

  it('accepts an exact relink without mismatch approval and attaches managed works', async () => {
    const fixture = await createFixture();
    const selected = await fixture.controller.selectSource({
      draftId: fixture.created.draftId,
      expectedRevision: 0,
      strategy: 'external_reference'
    });
    if (!selected.ok || selected.value.cancelled || !selected.value.source || !selected.value.draft) {
      throw fixture.getLastError();
    }
    fixture.setSelected(fixture.exactReplacement);
    const prepared = await fixture.controller.prepareRelink({
      draftId: fixture.created.draftId,
      clipId: selected.value.source.clipId
    });
    if (!prepared.ok || prepared.value.cancelled || !prepared.value.token) {
      throw fixture.getLastError();
    }
    expect(prepared.value.matchesIdentity).toBe(true);
    await expect(
      fixture.controller.confirmRelink({
        draftId: fixture.created.draftId,
        clipId: selected.value.source.clipId,
        token: prepared.value.token,
        acceptMismatch: false
      })
    ).resolves.toMatchObject({ ok: true, value: { draft: { revision: 2 } } });

    const fileId = selected.value.draft.videoTrack[0]!.source.fileId;
    await new JsonWorkRepository(fixture.storage, fixture.projectId).save({
      schemaVersion: 1,
      id: toWorkId('managed-editor-work'),
      projectId: fixture.projectId,
      sourceTaskId: toTaskId('managed-editor-task'),
      sourceExecutionId: toExecutionId('managed-editor-execution'),
      fileId: fileId as never,
      mediaKind: 'video',
      name: '已完成视频作品',
      createdAt: new Date().toISOString() as never
    });
    const nextDraft = await fixture.editor.create({});
    if (!nextDraft.ok) throw new Error(nextDraft.error.message);
    const attached = await fixture.controller.attachWork({
      draftId: nextDraft.value.draftId,
      expectedRevision: 0,
      workId: 'managed-editor-work'
    });
    expect(attached).toMatchObject({
      ok: true,
      value: {
        source: {
          workId: 'managed-editor-work',
          referenceKind: 'managed_work'
        },
        draft: { revision: 1 }
      }
    });
  });
});

function isoBmffVideo(options: { readonly suffix?: string } = {}): Buffer {
  const ftypPayload = Buffer.alloc(16);
  ftypPayload.write('isom', 0, 4, 'ascii');
  ftypPayload.write('isom', 8, 4, 'ascii');
  ftypPayload.write('mp42', 12, 4, 'ascii');
  const mvhdPayload = Buffer.alloc(20);
  mvhdPayload.writeUInt32BE(1_000, 12);
  mvhdPayload.writeUInt32BE(2_500, 16);
  const tkhdPayload = Buffer.alloc(84);
  tkhdPayload.writeUInt32BE(1_280 * 65_536, 76);
  tkhdPayload.writeUInt32BE(720 * 65_536, 80);
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

function waveAudio(): Buffer {
  const dataSize = 16_000;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0, 4, 'ascii');
  buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write('WAVEfmt ', 8, 8, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(8_000, 24);
  buffer.writeUInt32LE(16_000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 4, 'ascii');
  buffer.writeUInt32LE(dataSize, 40);
  return buffer;
}

function pngImage(): Buffer {
  const buffer = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(buffer);
  buffer.writeUInt32BE(13, 8);
  buffer.write('IHDR', 12, 4, 'ascii');
  buffer.writeUInt32BE(640, 16);
  buffer.writeUInt32BE(360, 20);
  return buffer;
}
