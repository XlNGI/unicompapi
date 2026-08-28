import { describe, expect, it } from 'vitest';
import {
  canRecoverRemoteCompletedExecution,
  createRetryExecution,
  recoverRemoteCompletedExecution,
  InvalidStateTransitionError,
  RetryNotAllowedError,
  toExecutionId,
  toProviderOperationRecordId,
  transitionExecution
} from '../../src/domain';
import {
  createLinkedExecutionFixture,
  t1,
  t3,
  t4,
  t5,
  t6,
  t7
} from './fixtures';

describe('execution state machine', () => {
  it('requires remote completion, download, write and verification before completion', () => {
    const { execution } = createLinkedExecutionFixture();

    const submitting = transitionExecution(execution, 'submitting', t3);
    const processing = transitionExecution(submitting, 'processing', t4);
    const remoteCompleted = transitionExecution(
      processing,
      'remote_completed',
      t5
    );
    const downloading = transitionExecution(
      remoteCompleted,
      'downloading',
      t6
    );
    const writing = transitionExecution(downloading, 'writing', t7);
    const verifying = transitionExecution(writing, 'verifying', t7);
    const completed = transitionExecution(verifying, 'completed', t7);

    expect(completed.state).toBe('completed');
  });

  it('rejects skipping directly from created to completed', () => {
    const { execution } = createLinkedExecutionFixture();

    expect(() => transitionExecution(execution, 'completed', t3)).toThrow(
      InvalidStateTransitionError
    );
  });

  it('requires failure evidence and creates a new execution for retry', () => {
    const { execution } = createLinkedExecutionFixture();
    const submitting = transitionExecution(execution, 'submitting', t3);
    const processing = transitionExecution(submitting, 'processing', t4);

    expect(() => transitionExecution(processing, 'failed', t5)).toThrow(
      'failed execution transition requires failure evidence'
    );

    const failed = transitionExecution(processing, 'failed', t5, {
      failure: {
        stage: 'processing',
        message: 'Temporary remote failure',
        retryability: 'retryable'
      }
    });
    const retry = createRetryExecution(
      failed,
      toExecutionId('execution-2'),
      t6
    );

    expect(retry.id).not.toBe(failed.id);
    expect(retry.attempt).toBe(failed.attempt + 1);
    expect(retry.state).toBe('created');
    expect(retry.failure).toBeUndefined();
  });

  it('can preserve a failure discovered after remote completion', () => {
    const { execution } = createLinkedExecutionFixture();
    const submitting = transitionExecution(execution, 'submitting', t3);
    const processing = transitionExecution(submitting, 'processing', t4);
    const remoteCompleted = transitionExecution(
      processing,
      'remote_completed',
      t5
    );
    const failed = transitionExecution(remoteCompleted, 'failed', t6, {
      failure: {
        stage: 'remote_completed',
        message: 'Result discovery failed',
        retryability: 'retryable'
      }
    });

    expect(failed).toMatchObject({
      state: 'failed',
      failure: { stage: 'remote_completed', retryability: 'retryable' }
    });
  });

  it('resumes only a retryable failed download without creating a new execution', () => {
    const { execution } = createLinkedExecutionFixture();
    const submitting = transitionExecution(execution, 'submitting', t3);
    const queued = transitionExecution(submitting, 'queued', t4, {
      remoteOperationId: 'remote-video-1',
      providerOperationRecordId: toProviderOperationRecordId('provider-operation-1'),
      submissionOutcome: 'accepted_async'
    });
    const remoteCompleted = transitionExecution(queued, 'remote_completed', t5);
    const downloading = transitionExecution(remoteCompleted, 'downloading', t6);
    const failed = transitionExecution(downloading, 'failed', t7, {
      failure: {
        stage: 'downloading',
        message: 'Temporary download failure',
        retryability: 'retryable'
      }
    });

    expect(recoverRemoteCompletedExecution(failed, t7)).toMatchObject({
      id: failed.id,
      state: 'remote_completed',
      failure: undefined,
      remoteOperationId: 'remote-video-1'
    });
    expect(() => transitionExecution(
      { ...failed, failure: { ...failed.failure!, stage: 'processing' } },
      'remote_completed',
      t7
    )).toThrow(RetryNotAllowedError);

    const synchronousImage = {
      ...failed,
      remoteOperationId: undefined,
      submissionOutcome: 'completed_sync' as const
    };
    expect(recoverRemoteCompletedExecution(synchronousImage, t7)).toMatchObject({
      id: failed.id,
      state: 'remote_completed',
      providerOperationRecordId: 'provider-operation-1'
    });

    const discoveryFailure = {
      ...synchronousImage,
      failure: {
        ...synchronousImage.failure!,
        stage: 'remote_completed' as const
      }
    };
    expect(canRecoverRemoteCompletedExecution(discoveryFailure)).toBe(true);
    expect(recoverRemoteCompletedExecution(discoveryFailure, t7)).toMatchObject({
      id: failed.id,
      state: 'remote_completed',
      failure: undefined
    });
  });

  it('does not allow blind retry while cancellation status is unknown', () => {
    const { execution } = createLinkedExecutionFixture();
    const submitting = transitionExecution(execution, 'submitting', t3);
    const unknown = transitionExecution(
      submitting,
      'cancellation_unknown',
      t4
    );

    expect(() =>
      createRetryExecution(unknown, toExecutionId('execution-2'), t5)
    ).toThrow(RetryNotAllowedError);
  });

  it('allows local document verification to acknowledge cancellation', () => {
    const { execution } = createLinkedExecutionFixture();
    const queued = transitionExecution(execution, 'queued', t3);
    const validating = transitionExecution(queued, 'validating_sources', t4);
    const preparing = transitionExecution(validating, 'preparing_media', t5);
    const encoding = transitionExecution(preparing, 'encoding', t6);
    const writing = transitionExecution(encoding, 'writing_file', t7);
    const verifying = transitionExecution(writing, 'verifying_file', t7);
    const cancelRequested = transitionExecution(
      verifying,
      'cancel_requested',
      t7
    );
    const cancelled = transitionExecution(cancelRequested, 'cancelled', t7);

    expect(cancelRequested.cancelRequestedAt).toBe(t7);
    expect(cancelled.state).toBe('cancelled');
  });

  it('rejects timestamps that move backwards', () => {
    const { execution } = createLinkedExecutionFixture();

    expect(() => transitionExecution(execution, 'submitting', t1)).toThrow(
      'execution.updatedAt cannot move backwards'
    );
  });
});
