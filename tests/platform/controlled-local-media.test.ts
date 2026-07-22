import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  toExecutionId,
  toFileReferenceId,
  toIsoTimestamp,
  toProjectId,
  toTaskId,
  toWorkId,
  type FileReference,
  type Work
} from '../../src/domain';
import {
  ControlledLocalMediaController,
  InMemoryProjectCatalogStore,
  JsonFileReferenceRepository,
  JsonWorkRepository,
  LocalMediaHandleRegistry,
  NodeProjectStorage,
  ProjectCatalogService
} from '../../src/platform';

const roots: string[] = [];
const timestamp = toIsoTimestamp('2026-07-22T00:00:00.000Z');

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-media-'));
  roots.push(root);
  const projectId = toProjectId('project-media');
  const storage = new NodeProjectStorage(root);
  const mediaPath = path.join(root, 'files', 'preview.png');
  await mkdir(path.dirname(mediaPath), { recursive: true });
  await writeFile(mediaPath, 'preview bytes', 'utf8');
  const file: FileReference = {
    schemaVersion: 1,
    id: toFileReferenceId('file-media'),
    projectId,
    sourceExecutionId: toExecutionId('execution-media'),
    locator: { kind: 'project', relativePath: 'files/preview.png' },
    state: 'available',
    sizeBytes: 13,
    checksumSha256: 'b'.repeat(64),
    createdAt: timestamp,
    updatedAt: timestamp
  };
  const work: Work = {
    schemaVersion: 1,
    id: toWorkId('work-media'),
    projectId,
    sourceTaskId: toTaskId('task-media'),
    sourceExecutionId: toExecutionId('execution-media'),
    fileId: file.id,
    mediaKind: 'image',
    name: 'Preview work',
    createdAt: timestamp
  };
  await new JsonFileReferenceRepository(storage, projectId).save(file);
  await new JsonWorkRepository(storage, projectId).save(work);
  const catalog = new ProjectCatalogService(new InMemoryProjectCatalogStore());
  await catalog.remember({
    projectId,
    projectName: 'Media project',
    rootDirectory: root
  });
  return { catalog, mediaPath, root };
}

describe('ControlledLocalMediaController', () => {
  it('creates an opaque media handle and reveals the file without returning paths', async () => {
    const fixture = await createFixture();
    const handles = new LocalMediaHandleRegistry(() => 1_000, 5_000);
    let revealedPath: string | undefined;
    const controller = new ControlledLocalMediaController({
      catalog: fixture.catalog,
      handles,
      revealFile: (target) => {
        revealedPath = target;
      }
    });

    const handle = await controller.createHandle({ workId: 'work-media' });
    const reveal = await controller.revealWorkFile({ workId: 'work-media' });

    expect(handle).toMatchObject({
      ok: true,
      value: {
        mediaKind: 'image',
        url: expect.stringMatching(/^unicomp-media:\/\/local\//)
      }
    });
    if (!handle.ok) throw new Error('Expected a media handle');
    const token = new URL(handle.value.url).pathname.slice(1);
    expect(handles.resolve(token)).toBe(fixture.mediaPath);
    expect(reveal).toEqual({ ok: true, value: { revealed: true } });
    expect(revealedPath).toBe(fixture.mediaPath);
    expect(JSON.stringify({ handle, reveal })).not.toContain(fixture.root);
  });

  it('rejects unavailable files and expires old handles', async () => {
    const fixture = await createFixture();
    let now = 1_000;
    const handles = new LocalMediaHandleRegistry(() => now, 10);
    const created = handles.create(fixture.mediaPath);
    const token = new URL(created.url).pathname.slice(1);
    now = 1_011;
    expect(handles.resolve(token)).toBeUndefined();

    await rm(fixture.mediaPath, { force: true });
    const controller = new ControlledLocalMediaController({
      catalog: fixture.catalog,
      handles,
      revealFile: () => undefined
    });
    await expect(
      controller.createHandle({ workId: 'work-media' })
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'media_unavailable' }
    });
  });
});
