import { describe, expect, it } from 'vitest';
import {
  applyImageWorkspaceChangeStaleness,
  createEmptyImageWorkspaceDraft,
  createImageWorkspaceDraft,
  deriveImageWorkspaceDraft,
  imageWorkspaceModes,
  isImageWorkspaceDraft,
  markImageAnalysisStale,
  toAssetId,
  toCapabilityEvidenceId,
  toDraftId,
  toIsoTimestamp,
  toModelId,
  toProjectId,
  type ImageToPromptWorkspaceDraft,
  type ProfessionalImageWorkspaceDraft
} from '../../src/domain';

const t0 = toIsoTimestamp('2026-07-23T00:00:00.000Z');
const t1 = toIsoTimestamp('2026-07-23T00:01:00.000Z');
const projectId = toProjectId('project-image-workspace');

function createEmpty(mode: (typeof imageWorkspaceModes)[number]) {
  return createEmptyImageWorkspaceDraft({
    id: toDraftId(`draft-${mode}`),
    projectId,
    mode,
    createdAt: t0
  });
}

describe('image workspace contracts', () => {
  it('defines exactly the five approved image modes', () => {
    expect(imageWorkspaceModes).toEqual([
      'quick_image',
      'professional_image',
      'image_understanding',
      'image_editing',
      'image_to_prompt'
    ]);
    expect(imageWorkspaceModes).not.toContain('batch_image');
    expect(imageWorkspaceModes).not.toContain('multi_reference');
  });

  it('creates valid local-only empty drafts for every approved mode', () => {
    const drafts = imageWorkspaceModes.map(createEmpty);

    expect(drafts.every(isImageWorkspaceDraft)).toBe(true);
    expect(drafts.every((draft) => draft.state === 'editing')).toBe(true);
    expect(drafts.every((draft) => draft.input === undefined)).toBe(true);
    expect(drafts.every((draft) => !('taskId' in draft))).toBe(true);
  });

  it('keeps prompt layers separate and binds dynamic values to capability evidence', () => {
    const base = createEmpty('professional_image') as ProfessionalImageWorkspaceDraft;
    const draft = createImageWorkspaceDraft({
      ...base,
      prompt: {
        originalInput: 'A quiet harbor',
        systemSupplements: [
          { content: 'Use project palette', source: 'project_context' }
        ],
        finalPrompt: 'A quiet harbor using the project palette'
      },
      input: {
        assetId: toAssetId('asset-reference'),
        role: 'reference',
        purpose: 'style reference',
        selectedAt: t0
      },
      generation: {
        model: {
          modelId: toModelId('model-image'),
          capabilityEvidenceId: toCapabilityEvidenceId('evidence-image')
        },
        parameters: {
          capabilityEvidenceId: toCapabilityEvidenceId('evidence-image'),
          values: {
            provider_defined_option: 'value',
            nested: { enabled: true }
          }
        }
      }
    });

    expect(draft.prompt.originalInput).toBe('A quiet harbor');
    expect(draft.prompt.systemSupplements[0]?.content).toBe(
      'Use project palette'
    );
    expect(draft.prompt.finalPrompt).toContain('project palette');
    expect(draft.generation.parameters?.capabilityEvidenceId).toBe(
      'evidence-image'
    );
  });

  it('preserves model observations when users add understanding revisions', () => {
    const base = createEmpty('image_understanding');
    if (base.mode !== 'image_understanding') {
      throw new Error('unexpected mode');
    }

    const draft = createImageWorkspaceDraft({
      ...base,
      input: {
        assetId: toAssetId('asset-understanding'),
        role: 'source',
        selectedAt: t0
      },
      understanding: {
        analysisState: 'current',
        observations: {
          visibleFacts: [{ id: 'fact-1', content: 'A red cup is visible' }],
          modelInferences: [{ id: 'inference-1', content: 'Possibly ceramic' }],
          uncertainties: [{ id: 'uncertain-1', content: 'Material is unclear' }],
          unrecognized: [{ id: 'unknown-1', content: 'Logo text is unreadable' }]
        },
        userRevisions: [
          {
            id: 'revision-1',
            targetObservationId: 'inference-1',
            content: 'The cup is known to be metal',
            createdAt: t1
          }
        ],
        saveScope: 'draft_only',
        staleReasons: [],
        analyzedAt: t0
      }
    });

    expect(draft.understanding.observations.modelInferences[0]?.content).toBe(
      'Possibly ceramic'
    );
    expect(draft.understanding.userRevisions[0]?.content).toBe(
      'The cup is known to be metal'
    );
  });

  it('creates a derived editing draft with traceable parent lineage and no task', () => {
    const sourceBase = createEmpty('quick_image');
    if (sourceBase.mode !== 'quick_image') {
      throw new Error('unexpected mode');
    }
    const source = createImageWorkspaceDraft({
      ...sourceBase,
      input: {
        assetId: toAssetId('asset-source'),
        role: 'reference',
        selectedAt: t0
      }
    });

    const derived = deriveImageWorkspaceDraft({
      id: toDraftId('draft-derived-editing'),
      source,
      targetMode: 'image_editing',
      createdAt: t1
    });

    expect(derived.mode).toBe('image_editing');
    expect(derived.origin).toEqual({
      kind: 'derived',
      parentDraftId: source.id,
      parentMode: 'quick_image'
    });
    expect(derived.input?.role).toBe('source');
    if (derived.mode !== 'image_editing') {
      throw new Error('unexpected mode');
    }
    expect(derived.editing.lineage).toEqual({
      parentDraftId: source.id,
      parentAssetId: toAssetId('asset-source')
    });
    expect('taskId' in derived).toBe(false);
  });

  it('migrates a legacy quick image input to explicit professional reference-to-image', () => {
    const source = createImageWorkspaceDraft({
      ...createEmpty('quick_image'),
      input: {
        assetId: toAssetId('asset-legacy-quick-reference'),
        role: 'reference' as const,
        selectedAt: t0
      }
    });
    const derived = deriveImageWorkspaceDraft({
      id: toDraftId('draft-derived-professional-reference'),
      source,
      targetMode: 'professional_image',
      createdAt: t1
    });
    expect(derived).toMatchObject({
      mode: 'professional_image',
      featureSelection: {
        productFeature: 'reference_to_image',
        parameterValues: {}
      },
      input: { role: 'reference' }
    });
  });

  it('marks an existing image-to-prompt result stale without deleting it', () => {
    const base = createEmpty('image_to_prompt') as ImageToPromptWorkspaceDraft;
    const analyzed = createImageWorkspaceDraft({
      ...base,
      imageToPrompt: {
        analysisState: 'current',
        purpose: 'product listing',
        requirements: ['Keep visible facts'],
        observations: {
          visibleFacts: [{ id: 'fact-1', content: 'A watch on a table' }],
          modelInferences: [],
          uncertainties: [],
          unrecognized: []
        },
        staleReasons: [],
        analyzedAt: t0
      }
    }) as ImageToPromptWorkspaceDraft;

    const stale = markImageAnalysisStale(analyzed, 'purpose_changed', t1);

    expect(stale.state).toBe('stale');
    expect(stale.imageToPrompt.analysisState).toBe('stale');
    expect(stale.imageToPrompt.staleReasons).toEqual(['purpose_changed']);
    expect(stale.imageToPrompt.observations.visibleFacts).toEqual(
      analyzed.imageToPrompt.observations.visibleFacts
    );
  });

  it('marks region, purpose and requirement changes with separate stale reasons', () => {
    const base = createEmpty('image_to_prompt') as ImageToPromptWorkspaceDraft;
    const analyzed = createImageWorkspaceDraft({
      ...base,
      state: 'saved',
      input: {
        assetId: toAssetId('asset-analysis-source'),
        role: 'source',
        purpose: 'source purpose',
        region: { x: 0, y: 0, width: 1, height: 1 },
        selectedAt: t0
      },
      imageToPrompt: {
        ...base.imageToPrompt,
        analysisState: 'current',
        purpose: 'listing',
        requirements: ['Keep facts'],
        analyzedAt: t0
      }
    });
    const changed = createImageWorkspaceDraft({
      ...analyzed,
      input: {
        ...analyzed.input,
        region: { x: 0, y: 0, width: 0.5, height: 1 }
      },
      imageToPrompt: {
        ...analyzed.imageToPrompt,
        purpose: 'advertisement',
        requirements: ['Keep facts', 'Mention lighting']
      },
      updatedAt: t1
    });

    const stale = applyImageWorkspaceChangeStaleness(analyzed, changed, t1);
    if (stale.mode !== 'image_to_prompt') {
      throw new Error('unexpected mode');
    }

    expect(stale.imageToPrompt.staleReasons).toEqual([
      'region_changed',
      'purpose_changed',
      'requirements_changed'
    ]);
  });

  it('rejects unsupported modes, wrong input roles and unbounded regions', () => {
    const valid = createEmpty('quick_image');

    expect(isImageWorkspaceDraft({ ...valid, mode: 'batch_image' })).toBe(false);
    expect(
      isImageWorkspaceDraft({ ...valid, absolutePath: 'C:\\private\\image.png' })
    ).toBe(false);
    expect(
      isImageWorkspaceDraft({
        ...valid,
        input: {
          assetId: 'asset-source',
          role: 'source',
          selectedAt: t0
        }
      })
    ).toBe(false);
    expect(
      isImageWorkspaceDraft({
        ...valid,
        input: {
          assetId: 'asset-reference',
          role: 'reference',
          selectedAt: t0,
          region: { x: 0.8, y: 0, width: 0.4, height: 1 }
        }
      })
    ).toBe(false);
  });
});
