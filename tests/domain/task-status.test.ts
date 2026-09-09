import { describe, expect, it } from 'vitest';
import {
  createTaskFromDraft,
  deriveTaskStatus,
  toExecutionId,
  toTaskId,
  transitionExecution
} from '../../src/domain';
import {
  createDraftFixture,
  createLinkedExecutionFixture,
  t1,
  t3,
  t4,
  t5,
  t6
} from './fixtures';

describe('task status projection', () => {
  it('keeps a confirmed task without executions awaiting execution', () => {
    const task = createTaskFromDraft({
      id: toTaskId('task-awaiting'),
      draft: createDraftFixture(),
      confirmedAt: t1
    });

    expect(deriveTaskStatus(task, [])).toBe('awaiting_execution');
  });

  it('distinguishes remote completion from local completion', () => {
    const { execution, task } = createLinkedExecutionFixture();
    const submitting = transitionExecution(execution, 'submitting', t3);
    const processing = transitionExecution(submitting, 'processing', t4);
    const remoteCompleted = transitionExecution(
      processing,
      'remote_completed',
      t5
    );

    expect(deriveTaskStatus(task, [remoteCompleted])).toBe('remote_completed');

    const downloading = transitionExecution(
      remoteCompleted,
      'downloading',
      t6
    );
    expect(deriveTaskStatus(task, [downloading])).toBe('localizing');
  });

  it('rejects a missing latest execution instead of inventing task state', () => {
    const { task } = createLinkedExecutionFixture();

    expect(() => deriveTaskStatus(task, [])).toThrow(
      'latest task execution is missing from status projection'
    );
  });

  it('uses the latest retry execution as the current task fact', () => {
    const { execution, task } = createLinkedExecutionFixture();
    const retry = {
      ...execution,
      id: toExecutionId('execution-2'),
      attempt: 2
    };
    const taskWithRetry = {
      ...task,
      executionIds: [...task.executionIds, retry.id]
    };

    expect(deriveTaskStatus(taskWithRetry, [execution, retry])).toBe(
      'awaiting_execution'
    );
  });
});
