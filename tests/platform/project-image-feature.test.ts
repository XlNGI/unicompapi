import { describe, expect, it } from 'vitest';
import {
  createAsset,
  createEmptyImageWorkspaceDraft,
  createImageWorkspaceDraft,
  promptEnhanceInputFingerprint,
  promptEnhanceSourceReference,
  toAssetId,
  toConversationId,
  toDraftId,
  toFileReferenceId,
  toIsoTimestamp,
  toProjectContextId,
  toProjectId,
  type Asset,
  type AssetRepository,
  type ImageWorkspaceDraft,
  type ImageWorkspaceRepository,
  type ProjectContextRepository,
  type ProjectContextV1
} from '../../src/domain';
import {
  ProjectImageFeatureSubjectResolver,
  assertImagePromptEnhancementSatisfied,
  createProjectContextContentHash,
  imageDraftRevision
} from '../../src/platform';

const projectId = toProjectId('project-image-feature-resolver');
const createdAt = toIsoTimestamp('2026-08-03T10:00:00.000Z');

describe('ProjectImageFeatureSubjectResolver', () => {
  it('resolves quick image as pure text with no context or media', async () => {
    const fixture = createFixture(savedDraft('quick_image', 'text_to_image'));
    const value = await fixture.resolver.resolve(subject(fixture.draft));
    expect(value).toMatchObject({
      projectId,
      productFeature: 'text_to_image',
      surface: 'quick',
      imageCount: 0,
      videoCount: 0,
      contextCount: 0,
      outboundTextSnapshot: 'Fixture image prompt'
    });
    expect(value.materialReferences).toEqual([]);
    expect(value.contextContentHashes).toEqual([]);
  });

  it('rejects quick context and requires a pinned available revision', async () => {
    const quick = createFixture(createImageWorkspaceDraft({
      ...savedDraft('quick_image', 'text_to_image'),
      contextReferences: [{
        kind: 'project_context',
        referenceId: context.id,
        contextRevision: 1,
        includeInPrompt: true
      }]
    }));
    await expect(quick.resolver.resolve(subject(quick.draft)))
      .rejects.toMatchObject({ code: 'quick_context_forbidden' });

    const professional = createFixture(createImageWorkspaceDraft({
      ...savedDraft('professional_image', 'text_to_image'),
      contextReferences: [{
        kind: 'project_context',
        referenceId: context.id,
        contextRevision: 2,
        includeInPrompt: true
      }]
    }));
    await expect(professional.resolver.resolve(subject(professional.draft)))
      .rejects.toMatchObject({ code: 'context_revision_not_found' });
  });

  it('resolves one registered image only for explicit reference-to-image', async () => {
    const draft = createImageWorkspaceDraft({
      ...savedDraft('professional_image', 'reference_to_image'),
      input: {
        assetId: imageAsset.id,
        role: 'reference',
        selectedAt: createdAt
      },
      contextReferences: [{
        kind: 'project_context',
        referenceId: context.id,
        contextRevision: 1,
        includeInPrompt: true
      }]
    });
    const fixture = createFixture(draft);
    const value = await fixture.resolver.resolve(subject(fixture.draft));
    expect(value).toMatchObject({
      productFeature: 'reference_to_image',
      surface: 'professional',
      imageCount: 1,
      contextCount: 1
    });
    expect(value.materialReferences).toEqual([{
      kind: 'asset',
      referenceId: imageAsset.id,
      revision: 1
    }]);
    expect(value.contextContentHashes).toHaveLength(1);
  });

  it('requires a current adopted enhancement when project context is selected', async () => {
    const contextSnapshot = {
      schemaVersion: 1 as const,
      contextId: context.id,
      contextRevision: 1,
      contentHash: createProjectContextContentHash(
        context.versions[0].contentSnapshot
      ),
      contentSnapshot: context.versions[0].contentSnapshot
    };
    const base = createImageWorkspaceDraft({
      ...savedDraft('professional_image', 'text_to_image'),
      contextReferences: [{
        kind: 'project_context',
        referenceId: context.id,
        contextRevision: 1,
        includeInPrompt: true
      }]
    });
    await expect(assertImagePromptEnhancementSatisfied({
      projectId,
      draft: base,
      contexts: contextRepository()
    })).rejects.toThrow('requires a current prompt enhancement');

    const enhancedText = 'Enhanced prompt with project context';
    const inputFingerprint = await promptEnhanceInputFingerprint({
      originalInput: base.prompt.originalInput,
      contextSnapshots: [contextSnapshot]
    });
    const enhanced = createImageWorkspaceDraft({
      ...base,
      prompt: {
        ...base.prompt,
        finalPrompt: enhancedText,
        systemSupplements: [{
          source: 'enhancement',
          content: enhancedText,
          sourceReference: promptEnhanceSourceReference({
            inputFingerprint,
            executionId: 'prompt-once-fixture'
          })
        }]
      }
    });
    await expect(assertImagePromptEnhancementSatisfied({
      projectId,
      draft: enhanced,
      contexts: contextRepository()
    })).resolves.toBeUndefined();

    await expect(assertImagePromptEnhancementSatisfied({
      projectId,
      draft: createImageWorkspaceDraft({
        ...enhanced,
        prompt: { ...enhanced.prompt, originalInput: 'Changed original input' }
      }),
      contexts: contextRepository()
    })).rejects.toThrow('requires a current prompt enhancement');
  });

  it('ignores removed professional reference-purpose data', async () => {
    const base = createImageWorkspaceDraft({
      ...savedDraft('professional_image', 'reference_to_image'),
      input: {
        assetId: imageAsset.id,
        role: 'reference',
        selectedAt: createdAt,
        purpose: '仅参考构图，不复制人物'
      }
    });
    expect(base.input).not.toHaveProperty('purpose');
    await expect(assertImagePromptEnhancementSatisfied({
      projectId,
      draft: base,
      contexts: contextRepository()
    })).resolves.toBeUndefined();
  });
});

function savedDraft(
  mode: 'quick_image' | 'professional_image',
  productFeature: 'text_to_image' | 'reference_to_image'
): ImageWorkspaceDraft {
  return createImageWorkspaceDraft({
    ...createEmptyImageWorkspaceDraft({
      id: toDraftId(`draft-${mode}-${productFeature}`),
      projectId,
      mode,
      createdAt
    }),
    state: 'saved',
    prompt: {
      originalInput: 'Fixture image prompt',
      systemSupplements: [],
      finalPrompt: 'Fixture image prompt'
    },
    featureSelection: { productFeature, parameterValues: {} }
  });
}

function subject(draft: ImageWorkspaceDraft) {
  return {
    kind: 'draft' as const,
    draftId: draft.id,
    draftRevision: imageDraftRevision(draft.updatedAt)
  };
}

function createFixture(initialDraft: ImageWorkspaceDraft) {
  let draft = initialDraft;
  const drafts: ImageWorkspaceRepository = {
    async get(id) { return id === draft.id ? structuredClone(draft) : undefined; },
    async list() { return [structuredClone(draft)]; },
    async save(value) { draft = structuredClone(value); }
  };
  const contexts = contextRepository();
  const assets: AssetRepository = {
    async get(id) { return id === imageAsset.id ? structuredClone(imageAsset) : undefined; },
    async list() { return [structuredClone(imageAsset)]; },
    async save() {}
  };
  return {
    get draft() { return draft; },
    resolver: new ProjectImageFeatureSubjectResolver(projectId, drafts, contexts, assets)
  };
}

const context: ProjectContextV1 = {
  schemaVersion: 1,
  id: toProjectContextId('context-image-feature-resolver'),
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
    sourceConversationId: toConversationId('conversation-image-feature-resolver'),
    sourceFragments: [],
    labels: ['Image context'],
    contentSnapshot: 'Pinned project context for image creation',
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
  id: toAssetId('asset-image-feature-resolver'),
  projectId,
  fileId: toFileReferenceId('file-image-feature-resolver'),
  name: 'fixture.png',
  mediaKind: 'image',
  origin: 'imported',
  role: 'reference',
  imageMetadata: { mimeType: 'image/png', width: 1280, height: 720 },
  createdAt
});
