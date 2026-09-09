import { describe, expect, it } from 'vitest';
import {
  createEmptyImageWorkspaceDraft,
  createImageTask,
  createExecution,
  toCapabilityEvidenceId,
  toConnectionId,
  toDraftId,
  toExecutionId,
  toIsoTimestamp,
  toModelId,
  toProjectId,
  toProviderId,
  toTaskId,
  transitionExecution
} from '../../src/domain';

const t0 = toIsoTimestamp('2026-07-23T07:00:00.000Z');
const t1 = toIsoTimestamp('2026-07-23T07:01:00.000Z');

function createTask() {
  const draft = createEmptyImageWorkspaceDraft({
    id: toDraftId('draft-image-submission-domain'),
    projectId: toProjectId('project-image-submission-domain'),
    mode: 'quick_image',
    createdAt: t0
  });
  return createImageTask({
    id: toTaskId('task-image-submission-domain'),
    draft,
    confirmation: {
      mode: 'quick_image',
      purpose: 'image_generation',
      modelId: toModelId('model-image-submission-domain'),
      capabilityEvidenceId: toCapabilityEvidenceId(
        'evidence-image-submission-domain'
      ),
      providerId: toProviderId('provider-image-submission-domain'),
      connectionId: toConnectionId('connection-image-submission-domain'),
      recipientName: 'Confirmed recipient',
      accessCategory: 'online',
      outboundScope: 'external_service',
      costState: 'unknown',
      privacyState: 'unknown',
      regionState: 'unknown',
      parameters: { dynamic_key: 'dynamic_value' },
      confirmations: {
        recipient: true,
        outboundScope: true,
        cost: true,
        finalPrompt: true,
        model: true
      }
    },
    confirmedAt: t1
  });
}

describe('image submission domain contracts', () => {
  it('freezes explicit routing and confirmation facts without creating an execution', () => {
    const task = createTask();

    expect(task.submission.image).toMatchObject({
      purpose: 'image_generation',
      recipientName: 'Confirmed recipient',
      costState: 'unknown',
      confirmations: {
        recipient: true,
        outboundScope: true,
        cost: true,
        finalPrompt: true,
        model: true
      }
    });
    expect(task.executionIds).toEqual([]);
  });

  it('persists a remote operation ID only after submission', () => {
    const execution = createExecution({
      id: toExecutionId('execution-image-submission-domain'),
      taskId: createTask().id,
      createdAt: t0
    });
    expect(() =>
      transitionExecution(execution, 'submitting', t1, {
        remoteOperationId: 'too-early'
      })
    ).toThrow('remote operation ID can only be attached after submission');

    const submitting = transitionExecution(execution, 'submitting', t1);
    const queued = transitionExecution(submitting, 'queued', t1, {
      remoteOperationId: 'internal-remote-operation'
    });
    expect(queued.remoteOperationId).toBe('internal-remote-operation');
  });
});
