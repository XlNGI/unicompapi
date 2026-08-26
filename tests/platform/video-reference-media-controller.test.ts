import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  JsonAssetRepository,
  JsonFileIndexRepository,
  JsonFileReferenceRepository,
  JsonVideoWorkspaceRepository,
  LocalMediaHandleRegistry,
  NodeProjectStorage,
  VideoReferenceMediaController,
  VideoWorkspaceMutationCoordinator,
  projectStoragePaths,
  toProjectRelativePath
} from '../../src/platform';
import {
  createEmptyVideoWorkspaceDraft,
  createFileReference,
  createVideoWorkspaceDraft,
  toCapabilityEvidenceId,
  toDraftId,
  toFileReferenceId,
  toIsoTimestamp,
  toModelId,
  toProjectId,
  transitionFile
} from '../../src/domain';

const roots: string[] = [];
const t0 = toIsoTimestamp('2026-07-23T08:00:00.000Z');
const t1 = '2026-07-23T08:10:00.000Z';

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

function pngHeader(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write('IHDR', 12, 'ascii');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

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

async function createFixture(
  mode: 'quick_video' | 'text_to_video' | 'image_to_video' = 'quick_video'
) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-video-material-'));
  roots.push(root);
  const projectRoot = path.join(root, 'project');
  await mkdir(projectRoot);
  const selectedVideo = path.join(root, 'selected-video.dat');
  const selectedImage = path.join(projectRoot, 'selected-image.dat');
  await writeFile(selectedVideo, isoBmffVideo());
  await writeFile(selectedImage, pngHeader(640, 480));

  const projectId = toProjectId('project-video-material');
  const storage = new NodeProjectStorage(projectRoot);
  const workspaceRepository = new JsonVideoWorkspaceRepository(
    storage,
    projectId
  );
  const base = createEmptyVideoWorkspaceDraft({
    id: toDraftId('draft-video-material'),
    projectId,
    mode,
    createdAt: t0
  });
  const draft = mode === 'text_to_video' && base.mode === 'text_to_video'
    ? createVideoWorkspaceDraft({
        ...base,
        generation: {
          ...base.generation,
          model: {
            modelId: toModelId('model-video'),
            capabilityEvidenceId: toCapabilityEvidenceId('evidence-video')
          }
        },
        textToVideo: {
          ...base.textToVideo,
          materials: {
            capabilityEvidenceId: toCapabilityEvidenceId('evidence-video'),
            slots: [
              {
                id: 'style-slot',
                role: 'style_reference',
                required: false,
                acceptedMediaKinds: ['image']
              }
            ]
          }
        }
      })
    : base;
  await workspaceRepository.save(draft);

  const handles = new LocalMediaHandleRegistry(
    () => Date.parse('2026-07-23T08:20:00.000Z')
  );
  let selectedPath: string | undefined = selectedVideo;
  let lastError: unknown;
  const controller = new VideoReferenceMediaController({
    getSession: () => ({
      projectId,
      projectName: 'Video material project',
      rootDirectory: projectRoot
    }),
    chooseMediaFile: async () => selectedPath,
    handles,
    mutations: new VideoWorkspaceMutationCoordinator(),
    createAssetId: () => 'asset-video-material',
    createFileId: () => 'file-video-material',
    now: () => t1,
    onError: (error) => {
      lastError = error;
    }
  });

  return {
    controller,
    draft,
    handles,
    projectId,
    root,
    selectedImage,
    selectedVideo,
    storage,
    getLastError: () => lastError,
    selectImage: () => {
      selectedPath = selectedImage;
    },
    cancelSelection: () => {
      selectedPath = undefined;
    }
  };
}

describe('VideoReferenceMediaController', () => {
  it('binds exactly one verified image to the image-to-video source target', async () => {
    const fixture = await createFixture('image_to_video');
    fixture.selectImage();
    const target = { kind: 'image_source' } as const;
    const selected = await fixture.controller.selectMaterial({
      draftId: fixture.draft.id,
      target,
      mediaKind: 'image'
    });
    if (!selected.ok || selected.value.cancelled) throw fixture.getLastError();
    expect(selected.value).toMatchObject({
      draft: {
        state: 'saved',
        imageToVideo: {
          source: {
            mediaKind: 'image',
            role: 'image_to_video_source'
          }
        }
      },
      material: { mediaKind: 'image', mimeType: 'image/png' }
    });
    await expect(fixture.controller.selectMaterial({
      draftId: fixture.draft.id,
      target,
      mediaKind: 'video'
    })).resolves.toMatchObject({
      ok: false,
      error: { code: 'material_type_mismatch' }
    });
    await expect(fixture.controller.getMaterial({
      draftId: fixture.draft.id,
      target
    })).resolves.toEqual({ ok: true, value: selected.value.material });
    const stored = await new JsonVideoWorkspaceRepository(
      fixture.storage,
      fixture.projectId
    ).get(fixture.draft.id);
    expect(stored).toMatchObject({ state: 'saved' });

    const cleared = await fixture.controller.clearMaterial({
      draftId: fixture.draft.id,
      target
    });
    expect(cleared).toMatchObject({ ok: true, value: { state: 'saved' } });
    if (!cleared.ok || cleared.value.mode !== 'image_to_video') {
      throw fixture.getLastError();
    }
    expect(cleared.value.imageToVideo.source).toBeUndefined();
  });

  it('registers a dropped image as the single image-to-video source', async () => {
    const fixture = await createFixture('image_to_video');
    const result = await fixture.controller.importMaterial({
      draftId: fixture.draft.id,
      target: { kind: 'image_source' },
      mediaKind: 'image',
      sourcePath: fixture.selectedImage
    });
    expect(result).toMatchObject({
      ok: true,
      value: {
        cancelled: false,
        material: { mediaKind: 'image', mimeType: 'image/png' },
        draft: {
          state: 'saved',
          imageToVideo: { source: { mediaKind: 'image' } }
        }
      }
    });
  });

  it('registers a verified external video without exposing its path or hash', async () => {
    const fixture = await createFixture();
    const result = await fixture.controller.selectMaterial({
      draftId: fixture.draft.id,
      target: { kind: 'quick_reference' },
      mediaKind: 'video',
      path: 'C:\\renderer-injected.mp4'
    });
    if (!result.ok || result.value.cancelled) throw fixture.getLastError();

    expect(result.value).toMatchObject({
      draft: {
        quick: {
          reference: {
            assetId: 'asset-video-material',
            mediaKind: 'video',
            role: 'reference'
          }
        }
      },
      material: {
        mediaKind: 'video',
        mimeType: 'video/mp4',
        container: 'mp4',
        durationMs: 2_500,
        width: 1_280,
        height: 720,
        referenceKind: 'external',
        fileState: 'available'
      }
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(fixture.root);
    expect(serialized).not.toContain('checksumSha256');
    expect(serialized).not.toContain('renderer-injected');

    const assets = await new JsonAssetRepository(
      fixture.storage,
      fixture.projectId
    ).list(fixture.projectId);
    const files = await new JsonFileReferenceRepository(
      fixture.storage,
      fixture.projectId
    ).list(fixture.projectId);
    expect(assets[0]?.videoMetadata).toMatchObject({
      mimeType: 'video/mp4',
      container: 'mp4',
      durationMs: 2_500
    });
    expect(files[0]?.locator).toEqual({
      kind: 'external',
      absolutePath: fixture.selectedVideo
    });
    expect(files[0]?.checksumSha256).toMatch(/^[a-f0-9]{64}$/);
    await expect(
      fixture.storage.readJson(projectStoragePaths.entities.tasks)
    ).resolves.toBeUndefined();
    await expect(
      fixture.storage.readJson(projectStoragePaths.entities.executions)
    ).resolves.toBeUndefined();
    await expect(
      fixture.storage.readJson(projectStoragePaths.entities.works)
    ).resolves.toBeUndefined();
  });

  it('binds a verified project image only to a compatible dynamic slot', async () => {
    const fixture = await createFixture('text_to_video');
    fixture.selectImage();
    const target = { kind: 'slot', slotId: 'style-slot' } as const;
    const result = await fixture.controller.selectMaterial({
      draftId: fixture.draft.id,
      target,
      mediaKind: 'image'
    });
    if (!result.ok || result.value.cancelled) throw fixture.getLastError();

    expect(result.value).toMatchObject({
      draft: {
        textToVideo: {
          materials: {
            slots: [
              {
                id: 'style-slot',
                role: 'style_reference',
                selection: {
                  assetId: 'asset-video-material',
                  mediaKind: 'image',
                  role: 'style_reference'
                }
              }
            ]
          }
        }
      },
      material: {
        mediaKind: 'image',
        mimeType: 'image/png',
        width: 640,
        height: 480,
        referenceKind: 'project'
      }
    });
    await expect(
      fixture.controller.getMaterial({ draftId: fixture.draft.id, target })
    ).resolves.toEqual({ ok: true, value: result.value.material });

    const cleared = await fixture.controller.clearMaterial({
      draftId: fixture.draft.id,
      target
    });
    expect(cleared).toMatchObject({ ok: true });
    if (!cleared.ok || cleared.value.mode !== 'text_to_video') {
      throw fixture.getLastError();
    }
    expect(cleared.value.textToVideo.materials?.slots[0]).not.toHaveProperty(
      'selection'
    );
  });

  it('reuses an indexed project result path instead of creating a conflicting alias', async () => {
    const { createHash } = await import('node:crypto');
    const fixture = await createFixture('image_to_video');
    const projectRoot = path.join(fixture.root, 'project');
    const relativePath = toProjectRelativePath('files/results/work-result.png');
    const absolutePath = path.join(projectRoot, relativePath);
    const bytes = pngHeader(640, 480);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, bytes);
    const checksum = createHash('sha256').update(bytes).digest('hex');

    const seeded = {
      ...transitionFile(
        transitionFile(
          createFileReference({
            id: toFileReferenceId('file-result-owner'),
            projectId: fixture.projectId,
            locator: { kind: 'project', relativePath },
            createdAt: t0
          }),
          'verifying',
          t0
        ),
        'available',
        t0,
        { sizeBytes: bytes.byteLength, checksumSha256: checksum }
      ),
      lastVerification: {
        sizeBytes: bytes.byteLength,
        checksumSha256: checksum,
        matchesExpected: true,
        verifiedAt: t0
      }
    };
    const files = new JsonFileReferenceRepository(
      fixture.storage,
      fixture.projectId
    );
    const index = new JsonFileIndexRepository(fixture.storage, fixture.projectId);
    await files.save(seeded);
    await index.upsert({
      fileId: seeded.id,
      relativePath,
      state: seeded.state,
      sizeBytes: seeded.sizeBytes,
      checksumSha256: seeded.checksumSha256,
      updatedAt: seeded.updatedAt
    });

    const controller = new VideoReferenceMediaController({
      getSession: () => ({
        projectId: fixture.projectId,
        projectName: 'Video material project',
        rootDirectory: projectRoot
      }),
      chooseMediaFile: async () => absolutePath,
      handles: fixture.handles,
      mutations: new VideoWorkspaceMutationCoordinator(),
      createAssetId: () => 'asset-video-material-reuse',
      createFileId: () => 'file-video-material-alias',
      now: () => t1
    });

    const selected = await controller.selectMaterial({
      draftId: fixture.draft.id,
      target: { kind: 'image_source' },
      mediaKind: 'image'
    });
    if (!selected.ok || selected.value.cancelled) {
      throw new Error('expected project result reuse selection to succeed');
    }

    const assets = await new JsonAssetRepository(
      fixture.storage,
      fixture.projectId
    ).list(fixture.projectId);
    const storedFiles = await files.list(fixture.projectId);
    expect(assets).toHaveLength(1);
    expect(assets[0]?.fileId).toBe(seeded.id);
    expect(storedFiles.map((file) => file.id)).toEqual([seeded.id]);
    await expect(index.get(seeded.id)).resolves.toMatchObject({
      relativePath,
      fileId: seeded.id
    });
    await expect(
      index.get(toFileReferenceId('file-video-material-alias'))
    ).resolves.toBeUndefined();

    await expect(
      controller.createMaterialPreview({
        draftId: fixture.draft.id,
        target: { kind: 'image_source' }
      })
    ).resolves.toMatchObject({ ok: true });
  });

  it('creates a short-lived preview only while the original content matches', async () => {
    const fixture = await createFixture();
    const target = { kind: 'quick_reference' } as const;
    const selected = await fixture.controller.selectMaterial({
      draftId: fixture.draft.id,
      target,
      mediaKind: 'video'
    });
    if (!selected.ok || selected.value.cancelled) throw fixture.getLastError();

    const preview = await fixture.controller.createMaterialPreview({
      draftId: fixture.draft.id,
      target
    });
    if (!preview.ok) throw fixture.getLastError();
    const url = new URL(preview.value.url);
    expect(url.protocol).toBe('unicomp-media:');
    expect(fixture.handles.resolve(url.pathname.slice(1))).toBe(
      fixture.selectedVideo
    );
    expect(fixture.handles.resolveEntry(url.pathname.slice(1))?.mimeType).toBe(
      'video/mp4'
    );

    await writeFile(fixture.selectedVideo, isoBmffVideo({ suffix: 'changed' }));
    await expect(
      fixture.controller.createMaterialPreview({
        draftId: fixture.draft.id,
        target
      })
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'preview_unavailable' }
    });
    const files = await new JsonFileReferenceRepository(
      fixture.storage,
      fixture.projectId
    ).list(fixture.projectId);
    expect(files[0]?.state).toBe('corrupted');
  });

  it('keeps cancellation, target mismatches and unsupported files honest', async () => {
    const slots = await createFixture('text_to_video');
    await expect(
      slots.controller.selectMaterial({
        draftId: slots.draft.id,
        target: { kind: 'slot', slotId: 'style-slot' },
        mediaKind: 'video'
      })
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'material_type_mismatch' }
    });

    const cancelled = await createFixture();
    cancelled.cancelSelection();
    await expect(
      cancelled.controller.selectMaterial({
        draftId: cancelled.draft.id,
        target: { kind: 'quick_reference' },
        mediaKind: 'video'
      })
    ).resolves.toEqual({ ok: true, value: { cancelled: true } });

    const unsupported = await createFixture();
    await writeFile(unsupported.selectedVideo, 'not a video', 'utf8');
    await expect(
      unsupported.controller.selectMaterial({
        draftId: unsupported.draft.id,
        target: { kind: 'quick_reference' },
        mediaKind: 'video'
      })
    ).resolves.toMatchObject({
      ok: false,
      error: { code: expect.stringMatching(/unsupported_video|media_unreadable/) }
    });
    await expect(
      new JsonAssetRepository(
        unsupported.storage,
        unsupported.projectId
      ).list(unsupported.projectId)
    ).resolves.toEqual([]);
  });
});
