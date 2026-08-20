import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { toProjectId } from '../../src/domain';
import { ImageWorkspaceController } from '../../src/platform';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-image-controller-'));
  roots.push(root);
  const ids = ['draft-image-1', 'draft-image-2', 'draft-image-3'];
  const times = [
    '2026-07-23T02:00:00.000Z',
    '2026-07-23T02:01:00.000Z',
    '2026-07-23T02:02:00.000Z',
    '2026-07-23T02:03:00.000Z'
  ];
  let lastError: unknown;
  const controller = new ImageWorkspaceController({
    getSession: () => ({
      projectId: toProjectId('project-image-controller'),
      projectName: 'Image project',
      rootDirectory: root
    }),
    createDraftId: () => ids.shift() ?? 'draft-image-fallback',
    now: () => times.shift() ?? '2026-07-23T02:59:00.000Z',
    onError: (error) => {
      lastError = error;
    }
  });

  return { controller, getLastError: () => lastError, root };
}

describe('ImageWorkspaceController', () => {
  it('requires an active project and an approved mode', async () => {
    const withoutProject = new ImageWorkspaceController({
      getSession: () => undefined
    });

    await expect(
      withoutProject.create({ mode: 'quick_image' })
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'project_not_open' }
    });

    const fixture = await createFixture();
    await expect(
      fixture.controller.create({ mode: 'batch_image' })
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'invalid_request' }
    });
  });

  it('creates, reads, updates and lists a local draft without creating a task', async () => {
    const fixture = await createFixture();
    const created = await fixture.controller.create({ mode: 'quick_image' });

    if (!created.ok) {
      throw fixture.getLastError();
    }

    const updateRequest = {
      ...created.value,
      state: 'saved' as const,
      prompt: {
        originalInput: 'A local-only image draft',
        systemSupplements: [],
        finalPrompt: 'A local-only image draft'
      }
    };
    const updated = await fixture.controller.update({ draft: updateRequest });

    expect(updated).toMatchObject({
      ok: true,
      value: {
        draftId: created.value.draftId,
        state: 'saved',
        prompt: { originalInput: 'A local-only image draft' }
      }
    });
    await expect(
      fixture.controller.get({ draftId: created.value.draftId })
    ).resolves.toEqual(updated);
    const listed = await fixture.controller.list();
    expect(listed).toMatchObject({ ok: true, value: [{ state: 'saved' }] });
    expect(JSON.stringify(listed)).not.toContain('taskId');
  });

  it('rejects stale updates and immutable-field changes', async () => {
    const fixture = await createFixture();
    const created = await fixture.controller.create({
      mode: 'professional_image'
    });

    if (!created.ok) {
      throw fixture.getLastError();
    }

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

    if (!firstUpdate.ok) {
      throw fixture.getLastError();
    }
    await expect(
      fixture.controller.update({
        draft: { ...firstUpdate.value, projectId: 'project-injected' }
      })
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'invalid_request' }
    });
  });

  it('removes legacy reference purpose from professional drafts', async () => {
    const fixture = await createFixture();
    const created = await fixture.controller.create({
      mode: 'professional_image'
    });
    if (!created.ok) {
      throw fixture.getLastError();
    }

    const updated = await fixture.controller.update({
      draft: {
        ...created.value,
        input: {
          assetId: 'asset-professional-reference',
          role: 'reference',
          purpose: 'legacy composition reference',
          selectedAt: created.value.updatedAt
        }
      }
    });

    expect(updated).toMatchObject({ ok: true });
    if (!updated.ok) {
      throw fixture.getLastError();
    }
    expect(updated.value.input).not.toHaveProperty('purpose');
    await expect(
      fixture.controller.get({ draftId: created.value.draftId })
    ).resolves.toEqual(updated);
  });

  it('creates a derived draft while preserving the source draft', async () => {
    const fixture = await createFixture();
    const created = await fixture.controller.create({ mode: 'quick_image' });

    if (!created.ok) {
      throw fixture.getLastError();
    }

    const source = await fixture.controller.update({
      draft: {
        ...created.value,
        prompt: {
          originalInput: 'Source prompt',
          systemSupplements: [],
          finalPrompt: 'Source prompt'
        }
      }
    });
    if (!source.ok) {
      throw fixture.getLastError();
    }

    const derived = await fixture.controller.derive({
      sourceDraftId: source.value.draftId,
      targetMode: 'image_to_prompt'
    });

    expect(derived).toMatchObject({
      ok: true,
      value: {
        mode: 'image_to_prompt',
        origin: {
          kind: 'derived',
          parentDraftId: source.value.draftId,
          parentMode: 'quick_image'
        },
        prompt: { originalInput: 'Source prompt' }
      }
    });
    const listed = await fixture.controller.list();
    expect(listed.ok && listed.value).toHaveLength(2);
  });

  it('returns renderer DTOs without project paths or protected internals', async () => {
    const fixture = await createFixture();
    const created = await fixture.controller.create({ mode: 'image_editing' });
    if (!created.ok) {
      throw fixture.getLastError();
    }
    await expect(
      fixture.controller.update({
        draft: {
          ...created.value,
          absolutePath: path.join(fixture.root, 'private.png')
        }
      })
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'invalid_request' }
    });
    const result = await fixture.controller.list();
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain(fixture.root);
    expect(serialized).not.toContain('checksumSha256');
    expect(serialized).not.toContain('credentialReference');
    expect(serialized).not.toContain('endpoint');
    expect(serialized).not.toContain('stack');
  });
});
