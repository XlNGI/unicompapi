import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createEmptyImageWorkspaceDraft,
  createImageWorkspaceDraft,
  toDraftId,
  toIsoTimestamp,
  toProjectId
} from '../../src/domain';
import {
  ImageLocalMediaController,
  ImageWorkspaceMutationCoordinator,
  JsonAssetRepository,
  JsonFileReferenceRepository,
  JsonImageWorkspaceRepository,
  LocalMediaHandleRegistry,
  NodeProjectStorage,
  projectStoragePaths
} from '../../src/platform';

const roots: string[] = [];
const t0 = toIsoTimestamp('2026-07-23T03:00:00.000Z');

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

function pngHeader(width: number, height: number, suffix = '') {
  const buffer = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write('IHDR', 12, 'ascii');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return Buffer.concat([buffer, Buffer.from(suffix)]);
}

async function createFixture(options: {
  readonly analyzed?: boolean;
  readonly quick?: boolean;
} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-image-input-'));
  roots.push(root);
  const selectedPath = path.join(root, 'selected-image.dat');
  await writeFile(selectedPath, pngHeader(800, 600));
  const projectId = toProjectId('project-image-input');
  const storage = new NodeProjectStorage(root);
  const workspaceRepository = new JsonImageWorkspaceRepository(
    storage,
    projectId
  );
  const base = createEmptyImageWorkspaceDraft({
    id: toDraftId('draft-image-input'),
    projectId,
    mode: options.analyzed
      ? 'image_to_prompt'
      : options.quick
        ? 'quick_image'
        : 'professional_image',
    createdAt: t0
  });
  const draft = options.analyzed && base.mode === 'image_to_prompt'
    ? createImageWorkspaceDraft({
        ...base,
        state: 'saved',
        imageToPrompt: {
          ...base.imageToPrompt,
          analysisState: 'current',
          purpose: 'catalog description',
          analyzedAt: t0
        }
      })
    : base.mode === 'professional_image'
      ? createImageWorkspaceDraft({
          ...base,
          state: 'saved',
          featureSelection: {
            productFeature: 'reference_to_image',
            parameterValues: {}
          }
        })
      : base;
  await workspaceRepository.save(draft);
  const handles = new LocalMediaHandleRegistry(
    () => Date.parse('2026-07-23T03:10:00.000Z')
  );
  const mutations = new ImageWorkspaceMutationCoordinator();
  let selection: string | undefined = selectedPath;
  let lastError: unknown;
  const controller = new ImageLocalMediaController({
    getSession: () => ({
      projectId,
      projectName: 'Image input project',
      rootDirectory: root
    }),
    chooseImageFile: async () => selection,
    handles,
    mutations,
    createAssetId: () => 'asset-selected-image',
    createFileId: () => 'file-selected-image',
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
    selectedPath,
    storage,
    workspaceRepository,
    getLastError: () => lastError,
    cancelSelection: () => {
      selection = undefined;
    }
  };
}

describe('ImageLocalMediaController', () => {
  it('requires an open project and never accepts a renderer path', async () => {
    const controller = new ImageLocalMediaController({
      getSession: () => undefined,
      chooseImageFile: async () => 'C:\\injected.png',
      handles: new LocalMediaHandleRegistry(),
      mutations: new ImageWorkspaceMutationCoordinator()
    });

    await expect(
      controller.selectInput({ draftId: 'draft-1', path: 'C:\\injected.png' })
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'project_not_open' }
    });
  });

  it('registers a selected verified image and returns path-free metadata', async () => {
    const fixture = await createFixture();
    const result = await fixture.controller.selectInput({
      draftId: fixture.draft.id
    });

    if (!result.ok || result.value.cancelled) {
      throw fixture.getLastError();
    }

    expect(result.value).toMatchObject({
      cancelled: false,
      draft: {
        input: { assetId: 'asset-selected-image', role: 'reference' }
      },
      input: {
        assetId: 'asset-selected-image',
        name: 'selected-image.dat',
        mimeType: 'image/png',
        width: 800,
        height: 600,
        fileState: 'available'
      }
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(fixture.root);
    expect(serialized).not.toContain('checksumSha256');

    const assets = await new JsonAssetRepository(
      fixture.storage,
      fixture.projectId
    ).list(fixture.projectId);
    const files = await new JsonFileReferenceRepository(
      fixture.storage,
      fixture.projectId
    ).list(fixture.projectId);
    expect(assets).toHaveLength(1);
    expect(assets[0]?.imageMetadata).toEqual({
      mimeType: 'image/png',
      width: 800,
      height: 600
    });
    expect(files[0]?.locator).toEqual({
      kind: 'external',
      absolutePath: fixture.selectedPath
    });
    expect(files[0]?.checksumSha256).toMatch(/^[a-f0-9]{64}$/);
    await expect(
      fixture.controller.getInput({ draftId: fixture.draft.id })
    ).resolves.toEqual({ ok: true, value: result.value.input });
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

  it('rejects image selection from quick text-to-image before opening media', async () => {
    const fixture = await createFixture({ quick: true });
    await expect(fixture.controller.selectInput({ draftId: fixture.draft.id }))
      .resolves.toMatchObject({
        ok: false,
        error: { code: 'invalid_request' }
      });
    await expect(
      new JsonAssetRepository(fixture.storage, fixture.projectId).list(
        fixture.projectId
      )
    ).resolves.toEqual([]);
  });

  it('creates a short-lived preview handle only after re-verification', async () => {
    const fixture = await createFixture();
    const selected = await fixture.controller.selectInput({
      draftId: fixture.draft.id
    });
    if (!selected.ok || selected.value.cancelled) {
      throw fixture.getLastError();
    }

    const preview = await fixture.controller.createInputPreview({
      draftId: fixture.draft.id
    });
    if (!preview.ok) {
      throw fixture.getLastError();
    }
    const url = new URL(preview.value.url);
    expect(url.protocol).toBe('unicomp-media:');
    expect(fixture.handles.resolve(url.pathname.slice(1))).toBe(
      fixture.selectedPath
    );
    expect(fixture.handles.resolveEntry(url.pathname.slice(1))?.mimeType).toBe(
      'image/png'
    );
    expect(JSON.stringify(preview)).not.toContain(fixture.root);

    await writeFile(fixture.selectedPath, pngHeader(800, 600, 'changed'));
    await expect(
      fixture.controller.createInputPreview({ draftId: fixture.draft.id })
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

  it('marks an existing prompt analysis stale when its image changes', async () => {
    const fixture = await createFixture({ analyzed: true });
    const result = await fixture.controller.selectInput({
      draftId: fixture.draft.id
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        cancelled: false,
        draft: {
          state: 'stale',
          imageToPrompt: {
            analysisState: 'stale',
            staleReasons: ['input_changed']
          }
        }
      }
    });
  });

  it('keeps cancellation and unsupported files as honest non-success states', async () => {
    const fixture = await createFixture();
    fixture.cancelSelection();
    await expect(
      fixture.controller.selectInput({ draftId: fixture.draft.id })
    ).resolves.toEqual({ ok: true, value: { cancelled: true } });

    await writeFile(fixture.selectedPath, 'not an image', 'utf8');
    const unsupported = new ImageLocalMediaController({
      getSession: () => ({
        projectId: fixture.projectId,
        projectName: 'Image input project',
        rootDirectory: fixture.root
      }),
      chooseImageFile: async () => fixture.selectedPath,
      handles: fixture.handles,
      mutations: new ImageWorkspaceMutationCoordinator()
    });
    await expect(
      unsupported.selectInput({ draftId: fixture.draft.id })
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'unsupported_image' }
    });
    await expect(
      new JsonAssetRepository(fixture.storage, fixture.projectId).list(
        fixture.projectId
      )
    ).resolves.toEqual([]);
    await expect(
      new JsonFileReferenceRepository(fixture.storage, fixture.projectId).list(
        fixture.projectId
      )
    ).resolves.toEqual([]);
  });
});
