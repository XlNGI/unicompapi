import { describe, expect, it } from 'vitest';
import {
  createRetryExecution,
  InvalidStateTransitionError,
  RetryNotAllowedError,
  toExecutionId,
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

  it('rejects timestamps that move backwards', () => {
    const { execution } = createLinkedExecutionFixture();

    expect(() => transitionExecution(execution, 'submitting', t1)).toThrow(
      'execution.updatedAt cannot move backwards'
    );
  });
});
