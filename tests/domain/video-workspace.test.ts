import { describe, expect, it } from 'vitest';
import {
  applyVideoWorkspaceChangeStaleness,
  createEmptyVideoWorkspaceDraft,
  createVideoEditHandoffIntent,
  createVideoWorkspaceDraft,
  deriveVideoWorkspaceDraft,
  isVideoEditHandoffIntent,
  isVideoWorkspaceDraft,
  toAssetId,
  toCapabilityEvidenceId,
  toDraftId,
  toIsoTimestamp,
  toModelId,
  toProjectId,
  toWorkId,
  videoWorkspaceModes,
  type ImageToVideoWorkspaceDraft,
  type TextToVideoWorkspaceDraft
} from '../../src/domain';

const t0 = toIsoTimestamp('2026-07-23T09:00:00.000Z');
const t1 = toIsoTimestamp('2026-07-23T09:01:00.000Z');
const projectId = toProjectId('project-video-workspace');

function createEmpty(mode: (typeof videoWorkspaceModes)[number]) {
  return createEmptyVideoWorkspaceDraft({
    id: toDraftId(`draft-${mode}`),
    projectId,
    mode,
    createdAt: t0
  });
}

const currentArtifact = {
  state: 'current' as const,
  staleReasons: [],
  completedAt: t0
};

describe('video workspace contracts', () => {
  it('defines exactly the three approved video generation modes', () => {
    expect(videoWorkspaceModes).toEqual([
      'quick_video',
      'text_to_video',
      'image_to_video'
    ]);
    expect(videoWorkspaceModes).not.toContain('batch_video');
    expect(videoWorkspaceModes).not.toContain('video_editing');
  });

  it('creates strict local-only empty drafts for every generation mode', () => {
    const drafts = videoWorkspaceModes.map(createEmpty);

    expect(drafts.every(isVideoWorkspaceDraft)).toBe(true);
    expect(drafts.every((draft) => draft.state === 'editing')).toBe(true);
    expect(drafts.every((draft) => !('taskId' in draft))).toBe(true);
    expect(drafts.every((draft) => !('absolutePath' in draft))).toBe(true);
  });

  it('keeps quick video to one optional explicit reference', () => {
    const base = createEmpty('quick_video');
    if (base.mode !== 'quick_video') throw new Error('unexpected mode');

    const draft = createVideoWorkspaceDraft({
      ...base,
      quick: {
        reference: {
          assetId: toAssetId('asset-quick-reference'),
          mediaKind: 'image',
          role: 'provider-declared-reference',
          selectedAt: t0
        }
      }
    });

    expect(draft.quick.reference?.assetId).toBe('asset-quick-reference');
    expect(
      isVideoWorkspaceDraft({
        ...draft,
        quick: {
          ...draft.quick,
          references: [draft.quick.reference, draft.quick.reference]
        }
      })
    ).toBe(false);
  });

  it('binds dynamic material slots and parameters to model capability evidence', () => {
    const base = createEmpty('image_to_video');
    if (base.mode !== 'image_to_video') throw new Error('unexpected mode');
    const evidenceId = toCapabilityEvidenceId('evidence-video-generation');

    const draft = createVideoWorkspaceDraft({
      ...base,
      generation: {
        ...base.generation,
        model: {
          modelId: toModelId('model-video'),
          capabilityEvidenceId: evidenceId
        },
        parameters: {
          capabilityEvidenceId: evidenceId,
          values: {
            provider_option: 'dynamic',
            nested: { enabled: true }
          }
        }
      },
      imageToVideo: {
        ...base.imageToVideo,
        materials: {
          capabilityEvidenceId: evidenceId,
          slots: [
            {
              id: 'slot-provider-start',
              role: 'provider_start_role',
              required: true,
              acceptedMediaKinds: ['image'],
              selection: {
                assetId: toAssetId('asset-start'),
                mediaKind: 'image',
                role: 'provider_start_role',
                selectedAt: t0
              }
            }
          ]
        }
      }
    });

    expect(draft.imageToVideo.materials?.slots[0]?.role).toBe(
      'provider_start_role'
    );
    expect(
      isVideoWorkspaceDraft({
        ...draft,
        imageToVideo: {
          ...draft.imageToVideo,
          materials: {
            ...draft.imageToVideo.materials,
            capabilityEvidenceId: 'different-evidence'
          }
        }
      })
    ).toBe(false);
    expect(
      isVideoWorkspaceDraft({
        ...draft,
        imageToVideo: {
          ...draft.imageToVideo,
          materials: {
            ...draft.imageToVideo.materials,
            slots: [
              {
                ...draft.imageToVideo.materials?.slots[0],
                selection: {
                  ...draft.imageToVideo.materials?.slots[0]?.selection,
                  role: 'different-role'
                }
              }
            ]
          }
        }
      })
    ).toBe(false);
  });

  it('preserves editable shot facts and validates storyboard state', () => {
    const base = createEmpty('text_to_video');
    if (base.mode !== 'text_to_video') throw new Error('unexpected mode');

    const draft = createVideoWorkspaceDraft({
      ...base,
      state: 'saved',
      textToVideo: {
        sourceKind: 'long_form',
        shots: [
          {
            id: 'shot-1',
            order: 1,
            description: 'A person enters a rainy street',
            action: 'walking',
            cameraMovement: 'slow push',
            pace: 'calm',
            depthOfField: 'shallow'
          }
        ],
        storyboard: {
          ...currentArtifact,
          frameAssetIds: [toAssetId('asset-storyboard-frame')]
        }
      }
    });

    expect(draft.textToVideo.shots[0]?.cameraMovement).toBe('slow push');
    expect(
      isVideoWorkspaceDraft({
        ...draft,
        textToVideo: {
          ...draft.textToVideo,
          shots: [
            ...draft.textToVideo.shots,
            { ...draft.textToVideo.shots[0], id: 'shot-2' }
          ]
        }
      })
    ).toBe(false);
  });

  it('derives another generation draft without moving ambiguous materials', () => {
    const base = createEmpty('quick_video');
    if (base.mode !== 'quick_video') throw new Error('unexpected mode');
    const source = createVideoWorkspaceDraft({
      ...base,
      prompt: {
        originalInput: 'A local source prompt',
        systemSupplements: [],
        finalPrompt: 'A local source prompt'
      },
      contextReferences: [
        { kind: 'project_context', referenceId: 'context-selected' }
      ],
      quick: {
        reference: {
          assetId: toAssetId('asset-role-ambiguous'),
          mediaKind: 'image',
          role: 'quick-reference',
          selectedAt: t0
        }
      }
    });

    const derived = deriveVideoWorkspaceDraft({
      id: toDraftId('draft-derived-text-video'),
      source,
      targetMode: 'text_to_video',
      createdAt: t1
    });

    expect(derived.origin).toEqual({
      kind: 'derived',
      parentDraftId: source.id,
      parentMode: 'quick_video'
    });
    expect(derived.prompt.originalInput).toBe('A local source prompt');
    expect(derived.contextReferences).toEqual(source.contextReferences);
    if (derived.mode !== 'text_to_video') throw new Error('unexpected mode');
    expect(derived.textToVideo.materials).toBeUndefined();
    expect('taskId' in derived).toBe(false);
  });

  it('marks prompt, shot, material and requirement dependent facts stale', () => {
    const textBase = createEmpty('text_to_video') as TextToVideoWorkspaceDraft;
    const textCurrent = createVideoWorkspaceDraft({
      ...textBase,
      state: 'saved',
      generation: {
        ...textBase.generation,
        enhancement: currentArtifact,
        preflight: currentArtifact
      },
      textToVideo: {
        ...textBase.textToVideo,
        shots: [{ id: 'shot-1', order: 1, description: 'First shot' }],
        storyboard: { ...currentArtifact, frameAssetIds: [] }
      }
    });
    const textChanged = createVideoWorkspaceDraft({
      ...textCurrent,
      prompt: { ...textCurrent.prompt, originalInput: 'Changed prompt' },
      textToVideo: {
        ...textCurrent.textToVideo,
        shots: [{ id: 'shot-1', order: 1, description: 'Changed shot' }]
      },
      updatedAt: t1
    });
    const staleText = applyVideoWorkspaceChangeStaleness(
      textCurrent,
      textChanged,
      t1
    );
    if (staleText.mode !== 'text_to_video') throw new Error('unexpected mode');

    expect(staleText.state).toBe('stale');
    expect(staleText.generation.enhancement.staleReasons).toEqual([
      'prompt_changed',
      'shot_plan_changed'
    ]);
    expect(staleText.textToVideo.storyboard.staleReasons).toEqual([
      'prompt_changed',
      'shot_plan_changed'
    ]);

    const imageBase = createEmpty('image_to_video') as ImageToVideoWorkspaceDraft;
    const imageCurrent = createVideoWorkspaceDraft({
      ...imageBase,
      state: 'saved',
      generation: {
        ...imageBase.generation,
        enhancement: currentArtifact,
        preflight: currentArtifact
      }
    });
    const imageChanged = createVideoWorkspaceDraft({
      ...imageCurrent,
      imageToVideo: {
        ...imageCurrent.imageToVideo,
        mustKeep: ['Keep the subject identity'],
        subjectAction: 'Turn toward the camera'
      },
      updatedAt: t1
    });
    const staleImage = applyVideoWorkspaceChangeStaleness(
      imageCurrent,
      imageChanged,
      t1
    );

    expect(staleImage.generation.preflight.staleReasons).toContain(
      'requirements_changed'
    );
  });

  it('defines a minimal controlled edit handoff without an editor timeline', () => {
    const intent = createVideoEditHandoffIntent({
      projectId,
      sourceDraftId: toDraftId('draft-video-result'),
      sourceWorkId: toWorkId('work-video-result'),
      requestedAt: t1
    });

    expect(isVideoEditHandoffIntent(intent)).toBe(true);
    expect('timeline' in intent).toBe(false);
    expect('exportPlan' in intent).toBe(false);
    expect(
      isVideoEditHandoffIntent({
        ...intent,
        absolutePath: 'C:\\private\\result.mp4'
      })
    ).toBe(false);
  });

  it('rejects unsupported modes, protected internals and malformed artifacts', () => {
    const valid = createEmpty('quick_video');

    expect(isVideoWorkspaceDraft({ ...valid, mode: 'batch_video' })).toBe(false);
    expect(
      isVideoWorkspaceDraft({
        ...valid,
        absolutePath: 'C:\\private\\reference.mp4'
      })
    ).toBe(false);
    expect(
      isVideoWorkspaceDraft({
        ...valid,
        generation: {
          ...valid.generation,
          preflight: {
            state: 'current',
            staleReasons: []
          }
        }
      })
    ).toBe(false);
  });
});
