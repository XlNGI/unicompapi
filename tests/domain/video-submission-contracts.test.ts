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
});
