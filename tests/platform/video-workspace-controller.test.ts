import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { toProjectId } from '../../src/domain';
import { VideoWorkspaceController } from '../../src/platform';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-video-controller-'));
  roots.push(root);
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
      projectId: toProjectId('project-video-controller'),
      projectName: 'Video project',
      rootDirectory: root
    }),
    createDraftId: () => ids.shift() ?? 'draft-video-fallback',
    now: () => times.shift() ?? '2026-07-23T11:59:00.000Z',
    onError: (error) => {
      lastError = error;
    }
  });
  return { controller, getLastError: () => lastError, root };
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
});
