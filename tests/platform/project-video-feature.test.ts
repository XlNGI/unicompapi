import { describe, expect, it } from 'vitest';
import {
  createAsset,
  createEmptyVideoWorkspaceDraft,
  createVideoWorkspaceDraft,
  toAssetId,
  toConversationId,
  toDraftId,
  toFileReferenceId,
  toIsoTimestamp,
  toProjectContextId,
  toProjectId,
  type Asset,
  type AssetRepository,
  type ProjectContextRepository,
  type ProjectContextV1,
  type VideoWorkspaceDraft,
  type VideoWorkspaceRepository
} from '../../src/domain';
import {
  ProjectVideoFeatureSubjectResolver,
  createVideoProviderFeatureContracts,
  videoDraftRevision
} from '../../src/platform';

const projectId = toProjectId('project-video-feature-resolver');
const createdAt = toIsoTimestamp('2026-08-03T10:00:00.000Z');

describe('ProjectVideoFeatureSubjectResolver', () => {
  it('resolves quick video as text only and rejects legacy material or context', async () => {
    const fixture = createFixture(savedDraft('quick_video'));
    await expect(fixture.resolver.resolve(subject(fixture.draft))).resolves.toMatchObject({
      projectId,
      productFeature: 'text_to_video',
      surface: 'quick',
      imageCount: 0,
      videoCount: 0,
      contextCount: 0,
      materialReferences: [],
      contextContentHashes: []
    });

    const legacy = createFixture(createVideoWorkspaceDraft({
      ...savedDraft('quick_video'),
      quick: {
        reference: {
          assetId: imageAsset.id,
          mediaKind: 'image',
          role: 'image_to_video_source',
          selectedAt: createdAt
        }
      }
    }));
    await expect(legacy.resolver.resolve(subject(legacy.draft)))
      .rejects.toThrow(/text only/);
  });

  it('resolves text-to-video with a pinned context and no material slots', async () => {
    const draft = createVideoWorkspaceDraft({
      ...savedDraft('text_to_video'),
      contextReferences: [{
        kind: 'project_context',
        referenceId: context.id,
        contextRevision: 1,
        includeInPrompt: true
      }]
    });
    const fixture = createFixture(draft);
    await expect(fixture.resolver.resolve(subject(fixture.draft))).resolves.toMatchObject({
      productFeature: 'text_to_video',
      surface: 'professional',
      imageCount: 0,
      videoCount: 0,
      contextCount: 1,
      materialReferences: []
    });
  });

  it('requires exactly one registered image for image-to-video', async () => {
    const draft = createVideoWorkspaceDraft({
      ...savedDraft('image_to_video'),
      imageToVideo: {
        ...(savedDraft('image_to_video') as Extract<VideoWorkspaceDraft, {
          mode: 'image_to_video'
        }>).imageToVideo,
        source: {
          assetId: imageAsset.id,
          mediaKind: 'image',
          role: 'image_to_video_source',
          selectedAt: createdAt
        }
      }
    });
    const fixture = createFixture(draft);
    const value = await fixture.resolver.resolve(subject(fixture.draft));
    expect(value).toMatchObject({
      productFeature: 'image_to_video',
      imageCount: 1,
      videoCount: 0
    });
    expect(value.materialReferences).toEqual([{
      kind: 'asset',
      referenceId: imageAsset.id,
      revision: 1
    }]);

    const missing = createFixture(savedDraft('image_to_video'));
    await expect(missing.resolver.resolve(subject(missing.draft)))
      .rejects.toThrow(/exactly one image/);
  });

  it('publishes complete fixed Vidu image-to-video and text-to-video contracts', () => {
    const contracts = createVideoProviderFeatureContracts();
    expect(contracts.length).toBeGreaterThan(0);
    const features = new Set(
      contracts.map((contract) => contract.parameterSchema.productFeature)
    );
    expect(features.has('image_to_video')).toBe(true);
    expect(features.has('text_to_video')).toBe(true);
    expect(
      contracts.every((contract) =>
        contract.parameterSchema.productFeature === 'image_to_video' ||
        contract.parameterSchema.productFeature === 'text_to_video'
      )
    ).toBe(true);
  });
});

function savedDraft(mode: VideoWorkspaceDraft['mode']): VideoWorkspaceDraft {
  return createVideoWorkspaceDraft({
    ...createEmptyVideoWorkspaceDraft({
      id: toDraftId(`draft-${mode}`),
      projectId,
      mode,
      createdAt
    }),
    state: 'saved',
    prompt: {
      originalInput: 'Fixture video prompt',
      systemSupplements: [],
      finalPrompt: 'Fixture video prompt'
    }
  });
}

function subject(draft: VideoWorkspaceDraft) {
  return {
    kind: 'draft' as const,
    draftId: draft.id,
    draftRevision: videoDraftRevision(draft.updatedAt)
  };
}

function createFixture(initialDraft: VideoWorkspaceDraft) {
  let draft = initialDraft;
  const drafts: VideoWorkspaceRepository = {
    async get(id) { return id === draft.id ? structuredClone(draft) : undefined; },
    async list() { return [structuredClone(draft)]; },
    async save(value) { draft = structuredClone(value); }
  };
  const assets: AssetRepository = {
    async get(id) { return id === imageAsset.id ? structuredClone(imageAsset) : undefined; },
    async list() { return [structuredClone(imageAsset)]; },
    async save() {}
  };
  return {
    get draft() { return draft; },
    resolver: new ProjectVideoFeatureSubjectResolver(
      projectId,
      drafts,
      contextRepository(),
      assets
    )
  };
}

const context: ProjectContextV1 = {
  schemaVersion: 1,
  id: toProjectContextId('context-video-feature-resolver'),
  projectId,
  currentRevision: 1,
  status: 'active',
  versions: [{
    schemaVersion: 1,
    revision: 1,
    status: 'active',
    sourceKindSchemaVersion: 1,
    sourceKind: 'conversation_selection',
    sourceStatus: 'available',
    sourceConversationId: toConversationId('conversation-video-feature-resolver'),
    sourceFragments: [],
    labels: ['Video context'],
    contentSnapshot: 'Pinned project context for video creation',
    registeredAt: createdAt,
    createdAt
  }],
  createdAt,
  updatedAt: createdAt
};

function contextRepository(): ProjectContextRepository {
  return {
    projectId,
    async getDraft() { return undefined; },
    async createDraft() {},
    async saveDraft() {},
    async registerDraft() {},
    async get(id) { return id === context.id ? structuredClone(context) : undefined; },
    async getRevision(id, revision) {
      return id === context.id
        ? structuredClone(context.versions.find((item) => item.revision === revision))
        : undefined;
    },
    async list() { return [structuredClone(context)]; },
    async save() {}
  };
}

const imageAsset: Asset = createAsset({
  id: toAssetId('asset-video-feature-resolver'),
  projectId,
  fileId: toFileReferenceId('file-video-feature-resolver'),
  name: 'fixture.png',
  mediaKind: 'image',
  origin: 'imported',
  role: 'image_to_video_source',
  imageMetadata: { mimeType: 'image/png', width: 1280, height: 720 },
  createdAt
});
