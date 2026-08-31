import { createHash } from 'node:crypto';
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
  JsonFileReferenceRepository,
  JsonTaskRepository,
  JsonWorkRepository,
  NodeProjectStorage,
  VideoWorkspaceController
} from '../../src/platform';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-video-controller-'));
  roots.push(root);
  const projectId = toProjectId('project-video-controller');
  const ids = ['draft-video-1', 'draft-video-2', 'draft-video-3'];
  const times = [
    '2026-07-23T11:00:00.000Z',
    '2026-07-23T11:01:00.000Z',
    '2026-07-23T11:02:00.000Z',
    '2026-07-23T11:03:00.000Z',
    '2026-07-23T11:04:00.000Z'
  ];
  let lastError: unknown;
  const controller = new VideoWorkspaceController({
    getSession: () => ({
      projectId,
      projectName: 'Video project',
      rootDirectory: root
    }),
    createDraftId: () => ids.shift() ?? 'draft-video-fallback',
    now: () => times.shift() ?? '2026-07-23T11:59:00.000Z',
    onError: (error) => {
      lastError = error;
    }
  });
  return { controller, getLastError: () => lastError, projectId, root };
}

describe('VideoWorkspaceController', () => {
  it('requires an active project and an approved generation mode', async () => {
    const withoutProject = new VideoWorkspaceController({
      getSession: () => undefined
    });

    await expect(
      withoutProject.create({ mode: 'quick_video' })
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'project_not_open' }
    });

    const fixture = await createFixture();
    await expect(
      fixture.controller.create({ mode: 'video_editing' })
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'invalid_request' }
    });
  });

  it('creates, reads, updates and lists a local draft without tasks', async () => {
    const fixture = await createFixture();
    const created = await fixture.controller.create({ mode: 'quick_video' });
    if (!created.ok) throw fixture.getLastError();

    const updated = await fixture.controller.update({
      draft: {
        ...created.value,
        state: 'saved',
        prompt: {
          originalInput: 'A local-only video draft',
          systemSupplements: [],
          finalPrompt: 'A local-only video draft'
        }
      }
    });

    expect(updated).toMatchObject({
      ok: true,
      value: {
        draftId: created.value.draftId,
        state: 'saved',
        prompt: { originalInput: 'A local-only video draft' }
      }
    });
    await expect(
      fixture.controller.get({ draftId: created.value.draftId })
    ).resolves.toEqual(updated);
    const listed = await fixture.controller.list();
    expect(listed).toMatchObject({ ok: true, value: [{ state: 'saved' }] });
    expect(JSON.stringify(listed)).not.toContain('taskId');
  });

  it('rejects stale updates and immutable field changes', async () => {
    const fixture = await createFixture();
    const created = await fixture.controller.create({ mode: 'text_to_video' });
    if (!created.ok) throw fixture.getLastError();

    const firstUpdate = await fixture.controller.update({
      draft: { ...created.value, state: 'saved' }
    });
    expect(firstUpdate).toMatchObject({ ok: true });

    await expect(
      fixture.controller.update({ draft: created.value })
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'draft_conflict' }
    });

    if (!firstUpdate.ok) throw fixture.getLastError();
    await expect(
      fixture.controller.update({
        draft: { ...firstUpdate.value, projectId: 'project-injected' }
      })
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'invalid_request' }
    });
  });

  it('creates a derived generation draft while preserving its source', async () => {
    const fixture = await createFixture();
    const created = await fixture.controller.create({ mode: 'quick_video' });
    if (!created.ok) throw fixture.getLastError();

    const source = await fixture.controller.update({
      draft: {
        ...created.value,
        prompt: {
          originalInput: 'Source video prompt',
          systemSupplements: [],
          finalPrompt: 'Source video prompt'
        },
        contextReferences: [
          { kind: 'project_context', referenceId: 'context-explicit' }
        ]
      }
    });
    if (!source.ok) throw fixture.getLastError();

    const derived = await fixture.controller.derive({
      sourceDraftId: source.value.draftId,
      targetMode: 'image_to_video'
    });

    expect(derived).toMatchObject({
      ok: true,
      value: {
        mode: 'image_to_video',
        origin: {
          kind: 'derived',
          parentDraftId: source.value.draftId,
          parentMode: 'quick_video'
        },
        prompt: { originalInput: 'Source video prompt' }
      }
    });
    const listed = await fixture.controller.list();
    expect(listed.ok && listed.value).toHaveLength(2);
  });

  it('returns safe DTOs and rejects protected or editor-only fields', async () => {
    const fixture = await createFixture();
    const created = await fixture.controller.create({ mode: 'image_to_video' });
    if (!created.ok) throw fixture.getLastError();

    await expect(
      fixture.controller.update({
        draft: {
          ...created.value,
          absolutePath: path.join(fixture.root, 'private.mp4')
        }
      })
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'invalid_request' }
    });

    await expect(
      fixture.controller.update({
        draft: {
          ...created.value,
          timeline: []
        }
      })
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'invalid_request' }
    });

    const serialized = JSON.stringify(await fixture.controller.list());
    expect(serialized).not.toContain(fixture.root);
    expect(serialized).not.toContain('checksumSha256');
    expect(serialized).not.toContain('credentialReference');
    expect(serialized).not.toContain('endpoint');
    expect(serialized).not.toContain('remoteOperationId');
    expect(serialized).not.toContain('stack');
  });

  it('creates an image-to-video draft only from an unchanged verified image Work', async () => {
    const fixture = await createFixture();
    const storage = new NodeProjectStorage(fixture.root);
    const relativePath = 'files/verified-result.png';
    const target = path.join(fixture.root, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    const bytes = pngBytes(320, 180);
    await writeFile(target, bytes);
    const checksumSha256 = createHash('sha256').update(bytes).digest('hex');
    const createdAt = toIsoTimestamp('2026-07-23T10:00:00.000Z');
    const file: FileReference = {
      schemaVersion: 1,
      id: toFileReferenceId('file-image-work-source'),
      projectId: fixture.projectId,
      sourceExecutionId: toExecutionId('execution-image-work-source'),
      locator: { kind: 'project', relativePath },
      state: 'available',
      sizeBytes: bytes.byteLength,
      checksumSha256,
      lastVerification: {
        sizeBytes: bytes.byteLength,
        checksumSha256,
        matchesExpected: true,
        verifiedAt: createdAt
      },
      createdAt,
      updatedAt: createdAt
    };
    const work: Work = {
      schemaVersion: 1,
      id: toWorkId('work-image-source'),
      projectId: fixture.projectId,
      sourceTaskId: toTaskId('task-image-work-source'),
      sourceExecutionId: toExecutionId('execution-image-work-source'),
      fileId: file.id,
      mediaKind: 'image',
      name: 'Verified image result',
      createdAt
    };
    await new JsonFileReferenceRepository(storage, fixture.projectId).save(file);
    await new JsonWorkRepository(storage, fixture.projectId).save(work);

    const created = await fixture.controller.createFromImageWork({
      workId: work.id
    });
    expect(created).toMatchObject({
      ok: true,
      value: {
        mode: 'image_to_video',
        origin: { kind: 'new' },
        imageToVideo: {
          source: { mediaKind: 'image', role: 'reference' }
        }
      }
    });
    expect(await new JsonTaskRepository(storage, fixture.projectId).list(
      fixture.projectId
    )).toEqual([]);
    expect(JSON.stringify(created)).not.toContain(fixture.root);
    expect(JSON.stringify(created)).not.toContain(checksumSha256);

    await writeFile(target, pngBytes(321, 180));
    await expect(
      fixture.controller.createFromImageWork({ workId: work.id })
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'material_not_found' }
    });
  });

  it('rejects non-image Works and renderer-supplied paths', async () => {
    const fixture = await createFixture();
    await expect(
      fixture.controller.createFromImageWork({
        workId: 'work-missing',
        absolutePath: 'C:\\private\\source.png'
      })
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'invalid_request' }
    });
    await expect(
      fixture.controller.createFromImageWork({ workId: 'work-missing' })
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'material_not_found' }
    });
  });
});

function pngBytes(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write('IHDR', 12, 'ascii');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}
