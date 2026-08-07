import { describe, expect, it } from 'vitest';
import {
  createEmptyVideoWorkspaceDraft,
  createVideoTask,
  toCapabilityEvidenceId,
  toConnectionId,
  toDraftId,
  toIsoTimestamp,
  toModelId,
  toProjectId,
  toProviderId,
  toTaskId,
  type VideoSubmissionConfirmationSnapshot
} from '../../src/domain';

const createdAt = toIsoTimestamp('2026-07-23T09:00:00.000Z');
const confirmedAt = toIsoTimestamp('2026-07-23T09:01:00.000Z');

function createConfirmation(): VideoSubmissionConfirmationSnapshot {
  return {
    mode: 'quick_video',
    purpose: 'video_generation',
    modelId: toModelId('model-video-task'),
    capabilityEvidenceId: toCapabilityEvidenceId('evidence-video-task'),
    providerId: toProviderId('provider-video-task'),
    connectionId: toConnectionId('connection-video-task'),
    recipientName: 'Video provider / connection',
    accessCategory: 'online',
    outboundScope: 'external_service',
    costState: 'unknown',
    privacyState: 'unknown',
    regionState: 'unknown',
    parameters: {},
    materials: [],
    contextReferences: [],
    input: { mode: 'quick_video' },
    confirmations: {
      recipient: true,
      outboundScope: true,
      materials: true,
      costPrivacyRegion: true,
      finalPrompt: true,
      model: true
    }
  };
}

describe('video submission task contracts', () => {
  it('freezes a video confirmation snapshot without creating executions', () => {
    const draft = createEmptyVideoWorkspaceDraft({
      id: toDraftId('draft-video-task'),
      projectId: toProjectId('project-video-task'),
      mode: 'quick_video',
      createdAt
    });
    const task = createVideoTask({
      id: toTaskId('task-video'),
      draft,
      confirmation: createConfirmation(),
      confirmedAt
    });

    expect(task.submission).toMatchObject({
      kind: 'video_generation',
      assetIds: [],
      video: {
        mode: 'quick_video',
        purpose: 'video_generation',
        costState: 'unknown'
      }
    });
    expect(task.executionIds).toEqual([]);
  });

  it('rejects stale video drafts and mismatched mode confirmations', () => {
    const draft = {
      ...createEmptyVideoWorkspaceDraft({
        id: toDraftId('draft-video-stale'),
        projectId: toProjectId('project-video-task'),
        mode: 'quick_video',
        createdAt
      }),
      state: 'stale' as const
    };
    expect(() => createVideoTask({
      id: toTaskId('task-video-stale'),
      draft,
      confirmation: createConfirmation(),
      confirmedAt
    })).toThrow(/cannot create a task/);

    const valid = createEmptyVideoWorkspaceDraft({
      id: toDraftId('draft-video-mismatch'),
      projectId: toProjectId('project-video-task'),
      mode: 'quick_video',
      createdAt
    });
    expect(() => createVideoTask({
      id: toTaskId('task-video-mismatch'),
      draft: valid,
      confirmation: {
        ...createConfirmation(),
        input: { mode: 'text_to_video', sourceKind: 'short_idea', shots: [] }
      },
      confirmedAt
    })).toThrow(/does not match/);
  });

  it('freezes image_to_video.source into confirmation materials and assetIds', () => {
    const base = createEmptyVideoWorkspaceDraft({
      id: toDraftId('draft-image-to-video-source'),
      projectId: toProjectId('project-video-task'),
      mode: 'image_to_video',
      createdAt
    });
    if (base.mode !== 'image_to_video') throw new Error('unexpected mode');
    const draft = {
      ...base,
      state: 'saved' as const,
      prompt: {
        ...base.prompt,
        originalInput: 'pan slowly',
        finalPrompt: 'pan slowly'
      },
      imageToVideo: {
        ...base.imageToVideo,
        source: {
          assetId: 'asset-image-to-video-source' as never,
          mediaKind: 'image' as const,
          role: 'image_to_video_source',
          selectedAt: createdAt
        }
      }
    };
    const confirmation: VideoSubmissionConfirmationSnapshot = {
      ...createConfirmation(),
      mode: 'image_to_video',
      materials: [{
        assetId: 'asset-image-to-video-source' as never,
        mediaKind: 'image',
        role: 'image_to_video_source',
        target: { kind: 'image_source' }
      }],
      input: {
        mode: 'image_to_video',
        mustKeep: [],
        allowedChanges: [],
        prohibited: [],
        subjectAction: '',
        cameraMovement: '',
        pace: '',
        depthOfField: ''
      }
    };
    const task = createVideoTask({
      id: toTaskId('task-image-to-video-source'),
      draft,
      confirmation,
      confirmedAt
    });
    expect(task.submission.assetIds).toEqual(['asset-image-to-video-source']);
    expect(task.submission.video.materials).toEqual([{
      assetId: 'asset-image-to-video-source',
      mediaKind: 'image',
      role: 'image_to_video_source',
      target: { kind: 'image_source' }
    }]);
  });
});
