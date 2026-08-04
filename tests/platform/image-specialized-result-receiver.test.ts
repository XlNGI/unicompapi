import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createEmptyImageWorkspaceDraft,
  toDraftId,
  toIsoTimestamp,
  toProjectId
} from '../../src/domain';
import {
  ImageSpecializedResultReceiver,
  ImageSpecializedResultReceiverError,
  ImageSpecializedSubmissionCoordinator,
  ImageWorkspaceMutationCoordinator,
  JsonImageWorkspaceRepository,
  NodeProjectStorage
} from '../../src/platform';

const roots: string[] = [];
const projectId = toProjectId('project-specialized-image-result');
const t0 = toIsoTimestamp('2026-08-04T01:00:00.000Z');
const t1 = toIsoTimestamp('2026-08-04T01:01:00.000Z');

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ));
});

describe('ImageSpecializedResultReceiver', () => {
  it('persists a trusted completed submission result in the same main-process flow', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-image-result-flow-'));
    roots.push(root);
    const repository = new JsonImageWorkspaceRepository(
      new NodeProjectStorage(root),
      projectId
    );
    const draft = createEmptyImageWorkspaceDraft({
      id: toDraftId('draft-specialized-flow'),
      projectId,
      mode: 'image_understanding',
      createdAt: t0
    });
    await repository.save(draft);
    const coordinator = new ImageSpecializedSubmissionCoordinator(
      {
        async submit() {
          return {
            submission: {
              schemaVersion: 1,
              submissionIntentId: 'intent-specialized-flow',
              status: 'completed',
              retryAllowed: false
            },
            result: {
              schemaVersion: 1,
              productFeature: 'image_understanding',
              observations: {
                visibleFacts: [{ id: 'remote', content: '蓝色玻璃杯' }],
                modelInferences: [],
                uncertainties: [],
                unrecognized: []
              }
            }
          };
        }
      },
      new ImageSpecializedResultReceiver(
        repository,
        new ImageWorkspaceMutationCoordinator(),
        () => t1
      )
    );

    await expect(coordinator.submit({
      subject: {
        kind: 'draft',
        draftId: draft.id,
        draftRevision: Date.parse(draft.updatedAt)
      },
      routeSelectionToken: 'trusted-route-token',
      confirmation: {
        schemaVersion: 1,
        confirmationId: 'confirmation-specialized-flow',
        confirmed: true
      },
      draftId: draft.id,
      expectedDraftUpdatedAt: draft.updatedAt
    })).resolves.toMatchObject({ status: 'completed' });
    await expect(repository.get(draft.id)).resolves.toMatchObject({
      understanding: {
        analysisState: 'current',
        observations: {
          visibleFacts: [{ id: 'visible-fact-1', content: '蓝色玻璃杯' }]
        }
      }
    });
  });

  it('normalizes and persists structured observations without exposing result writes to IPC', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-image-result-'));
    roots.push(root);
    const repository = new JsonImageWorkspaceRepository(
      new NodeProjectStorage(root),
      projectId
    );
    const draft = createEmptyImageWorkspaceDraft({
      id: toDraftId('draft-specialized-understanding'),
      projectId,
      mode: 'image_understanding',
      createdAt: t0
    });
    await repository.save(draft);
    const receiver = new ImageSpecializedResultReceiver(
      repository,
      new ImageWorkspaceMutationCoordinator(),
      () => t1
    );
    const result = await receiver.receive({
      draftId: draft.id,
      expectedDraftUpdatedAt: draft.updatedAt,
      result: {
        schemaVersion: 1,
        productFeature: 'image_understanding',
        observations: {
          visibleFacts: [{ id: '../../remote-id', content: '  红色杯子\u0000  ' }],
          modelInferences: [{ id: 'remote-2', content: '可能为金属材质' }],
          uncertainties: [],
          unrecognized: []
        }
      }
    });
    expect(result).toMatchObject({
      mode: 'image_understanding',
      understanding: {
        analysisState: 'current',
        resultRevision: 1,
        observations: {
          visibleFacts: [{ id: 'visible-fact-1', content: '红色杯子' }]
        },
        userRevisions: []
      }
    });
    expect(await repository.get(draft.id)).toEqual(result);

    await expect(receiver.receive({
      draftId: draft.id,
      expectedDraftUpdatedAt: result.updatedAt,
      result: {
        schemaVersion: 2,
        productFeature: 'image_understanding',
        observations: {
          visibleFacts: [],
          modelInferences: [],
          uncertainties: [],
          unrecognized: []
        }
      } as never
    })).rejects.toMatchObject({ code: 'invalid_result' });

    await expect(receiver.receive({
      draftId: draft.id,
      expectedDraftUpdatedAt: draft.updatedAt,
      result: {
        schemaVersion: 1,
        productFeature: 'image_to_prompt',
        observations: {
          visibleFacts: [],
          modelInferences: [],
          uncertainties: [],
          unrecognized: []
        }
      }
    })).rejects.toBeInstanceOf(ImageSpecializedResultReceiverError);
  });

  it('persists prompt and result revisions together for image-to-prompt', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-image-prompt-result-'));
    roots.push(root);
    const repository = new JsonImageWorkspaceRepository(
      new NodeProjectStorage(root),
      projectId
    );
    const draft = createEmptyImageWorkspaceDraft({
      id: toDraftId('draft-specialized-prompt'),
      projectId,
      mode: 'image_to_prompt',
      createdAt: t0
    });
    await repository.save(draft);
    const receiver = new ImageSpecializedResultReceiver(
      repository,
      new ImageWorkspaceMutationCoordinator(),
      () => t1
    );
    const result = await receiver.receive({
      draftId: draft.id,
      expectedDraftUpdatedAt: draft.updatedAt,
      result: {
        schemaVersion: 1,
        productFeature: 'image_to_prompt',
        observations: {
          visibleFacts: [{ id: 'remote', content: '雪山和湖面' }],
          modelInferences: [],
          uncertainties: [],
          unrecognized: []
        },
        promptDraft: {
          finalPrompt: '雪山湖面旅行海报',
          systemSupplements: [{
            content: '保留可见光线',
            source: 'structure'
          }]
        }
      }
    });
    expect(result).toMatchObject({
      prompt: { finalPrompt: '雪山湖面旅行海报' },
      imageToPrompt: { resultRevision: 1, promptRevision: 1 }
    });
  });
});
