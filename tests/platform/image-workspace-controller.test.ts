import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { toProjectId } from '../../src/domain';
import {
  ImageSpecializedResultReceiver,
  ImageWorkspaceController,
  ImageWorkspaceMutationCoordinator,
  JsonImageWorkspaceRepository,
  JsonProjectContextRepository,
  NodeProjectStorage
} from '../../src/platform';

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

  it('uses narrow revision, context registration and result-bound derivation operations', async () => {
    const fixture = await createFixture();
    const created = await fixture.controller.create({ mode: 'image_understanding' });
    if (!created.ok) throw fixture.getLastError();
    const storage = new NodeProjectStorage(fixture.root);
    const drafts = new JsonImageWorkspaceRepository(
      storage,
      toProjectId('project-image-controller')
    );
    const received = await new ImageSpecializedResultReceiver(
      drafts,
      new ImageWorkspaceMutationCoordinator(),
      () => '2026-07-23T02:30:00.000Z'
    ).receive({
      draftId: created.value.draftId,
      expectedDraftUpdatedAt: created.value.updatedAt,
      result: {
        schemaVersion: 1,
        productFeature: 'image_understanding',
        observations: {
          visibleFacts: [{ id: 'remote-fact', content: '画面中有雪山' }],
          modelInferences: [],
          uncertainties: [],
          unrecognized: []
        }
      }
    });
    if (received.mode !== 'image_understanding') {
      throw new Error('unexpected result mode');
    }

    await expect(fixture.controller.update({
      draft: {
        ...received,
        draftId: received.id,
        understanding: {
          ...received.understanding,
          observations: {
            ...received.understanding.observations,
            visibleFacts: [{ id: 'forged', content: 'renderer injection' }]
          }
        }
      }
    })).resolves.toMatchObject({
      ok: false,
      error: { code: 'invalid_request' }
    });

    const revised = await fixture.controller.addUnderstandingRevision({
      draftId: received.id,
      expectedDraftUpdatedAt: received.updatedAt,
      targetObservationId: 'visible-fact-1',
      content: '用户确认这是阿尔卑斯山'
    });
    expect(revised).toMatchObject({
      ok: true,
      value: {
        understanding: {
          resultRevision: 1,
          observations: { visibleFacts: [{ content: '画面中有雪山' }] },
          userRevisions: [{ revision: 1, content: '用户确认这是阿尔卑斯山' }]
        }
      }
    });
    if (!revised.ok) throw fixture.getLastError();

    const registered = await fixture.controller.registerResultContext({
      draftId: revised.value.draftId,
      expectedDraftUpdatedAt: revised.value.updatedAt,
      expectedResultRevision: 1,
      labels: ['图片识别']
    });
    expect(registered).toMatchObject({ ok: true, value: { revision: 1 } });
    if (!registered.ok) throw fixture.getLastError();
    const contexts = await new JsonProjectContextRepository(
      storage,
      toProjectId('project-image-controller')
    ).list();
    expect(contexts[0]?.versions[0]).toMatchObject({
      sourceKind: 'image_analysis',
      sourceImageDraftId: received.id,
      sourceImageResultRevision: 1,
      contentSnapshot: expect.stringContaining('用户确认这是阿尔卑斯山')
    });

    const afterRegistration = await fixture.controller.get({ draftId: received.id });
    if (!afterRegistration.ok || !afterRegistration.value) throw fixture.getLastError();
    const secondRevision = await fixture.controller.addUnderstandingRevision({
      draftId: received.id,
      expectedDraftUpdatedAt: afterRegistration.value.updatedAt,
      content: '用户补充：画面时间为日出'
    });
    if (!secondRevision.ok) throw fixture.getLastError();
    const registeredAgain = await fixture.controller.registerResultContext({
      draftId: received.id,
      expectedDraftUpdatedAt: secondRevision.value.updatedAt,
      expectedResultRevision: 1,
      labels: ['图片识别']
    });
    expect(registeredAgain).toMatchObject({
      ok: true,
      value: { contextId: registered.value.contextId, revision: 2 }
    });
    const [updatedContext] = await new JsonProjectContextRepository(
      storage,
      toProjectId('project-image-controller')
    ).list();
    expect(updatedContext?.versions).toHaveLength(2);
    expect(updatedContext?.versions[1]?.contentSnapshot).toContain(
      '用户补充：画面时间为日出'
    );

    const current = await fixture.controller.get({ draftId: received.id });
    if (!current.ok || !current.value) throw fixture.getLastError();
    await expect(fixture.controller.deriveFromResult({
      sourceDraftId: current.value.draftId,
      expectedDraftUpdatedAt: current.value.updatedAt,
      expectedResultRevision: 1,
      targetMode: 'image_editing'
    })).resolves.toMatchObject({
      ok: true,
      value: { mode: 'image_editing' }
    });
  });
});
