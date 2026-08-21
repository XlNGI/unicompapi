import { describe, expect, it } from 'vitest';
import type { StorageTaskSummaryDto } from '../../src/shared/storage-ipc';
import {
  summarizeTasks,
  taskDisplayGroup,
  taskPriority
} from '../../src/ui/layout/TaskStatusDock';

const now = Date.parse('2026-08-21T04:00:00.000Z');

function task(
  taskId: string,
  state: string,
  updatedAt = '2026-08-21T03:59:00.000Z'
): StorageTaskSummaryDto {
  return {
    taskId,
    projectId: 'project-status',
    projectName: '状态栏项目',
    kind: 'image_generation',
    createdAt: '2026-08-21T03:50:00.000Z',
    executionCount: 1,
    latestExecutionState: state,
    latestExecutionUpdatedAt: updatedAt
  };
}

describe('task status dock projection', () => {
  it('sorts actionable and failed tasks before localizing and generating tasks', () => {
    const tasks = [
      task('generating', 'processing'),
      task('receiving', 'downloading'),
      task('failed', 'failed'),
      task('attention', 'needs_user_action')
    ];

    const summary = summarizeTasks(tasks, now);

    expect(summary.visibleTasks.map((item) => item.taskId)).toEqual([
      'attention',
      'failed',
      'receiving',
      'generating'
    ]);
    expect(summary.attention).toBe(2);
    expect(summary.inProgress).toBe(2);
  });

  it('keeps only recent terminal tasks and never includes cancelled tasks', () => {
    const summary = summarizeTasks([
      task('recent-complete', 'completed'),
      task('old-complete', 'completed', '2026-08-21T03:40:00.000Z'),
      task('recent-failed', 'failed'),
      task('old-failed', 'failed', '2026-08-21T03:40:00.000Z'),
      task('old-expired', 'expired', '2026-08-21T03:40:00.000Z'),
      task('cancelled', 'cancelled')
    ], now);

    expect(summary.visibleTasks.map((item) => item.taskId)).toEqual([
      'recent-failed',
      'recent-complete'
    ]);
    expect(summary.inProgress).toBe(0);
    expect(summary.attention).toBe(1);
  });

  it('keeps only recently active recovery states in the compact monitor', () => {
    const summary = summarizeTasks([
      task('recent-recovery', 'recovery_required'),
      task('old-recovery', 'recovery_required', '2026-08-21T02:59:00.000Z'),
      task('old-unknown', 'submission_outcome_unknown', '2026-08-21T02:59:00.000Z')
    ], now);

    expect(summary.visibleTasks.map((item) => item.taskId)).toEqual(['recent-recovery']);
    expect(summary.attention).toBe(1);
  });

  it('shows recently created executions but excludes tasks without an execution', () => {
    const summary = summarizeTasks([
      task('without-execution', ''),
      task('created-only', 'created'),
      task('old-created', 'created', '2026-08-21T02:00:00.000Z'),
      task('recent-queued', 'queued'),
      task('old-queued', 'queued', '2026-08-21T02:00:00.000Z')
    ], now);

    expect(summary.visibleTasks.map((item) => item.taskId)).toEqual([
      'created-only',
      'recent-queued'
    ]);
    expect(summary.inProgress).toBe(2);
    expect(summary.waiting).toBe(2);
  });

  it('treats unknown states as requiring attention and preserves the priority order', () => {
    const unknown = task('unknown', 'provider_specific_state');

    expect(taskDisplayGroup(unknown.latestExecutionState)).toBe('attention');
    expect(taskPriority(unknown)).toBeLessThan(taskPriority(task('failed', 'failed')));
  });
});
