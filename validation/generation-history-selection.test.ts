import { describe, expect, it } from 'vitest';
import {
  canRetryAutoSelect,
  resolveHistorySelection
} from '../src/components/GenerationHistory';

const works = [
  { workId: 'work-oldest', createdAt: '2026-09-16T10:00:00.000Z' },
  { workId: 'work-current', createdAt: '2026-09-16T10:05:00.000Z' },
  { workId: 'work-target', createdAt: '2026-09-16T10:10:00.000Z' }
];

describe('generation history selection', () => {
  it('selects the expected work when an active auto-selection finds it', () => {
    expect(resolveHistorySelection({
      autoSelectActive: true,
      selectedWorkId: 'work-current',
      targetWorkId: 'work-target',
      works
    })).toEqual({
      matchedTarget: true,
      selectedStatusId: undefined,
      selectedWorkId: 'work-target',
      shouldScrollToLatest: true
    });
  });

  it('preserves a valid user selection after takeover', () => {
    expect(resolveHistorySelection({
      autoSelectActive: false,
      selectedWorkId: 'work-oldest',
      targetWorkId: 'work-target',
      works
    })).toEqual({
      matchedTarget: false,
      selectedStatusId: undefined,
      selectedWorkId: 'work-oldest',
      shouldScrollToLatest: false
    });
  });

  it('preserves the current work while the expected work is still absent', () => {
    expect(resolveHistorySelection({
      autoSelectActive: true,
      selectedWorkId: 'work-current',
      targetWorkId: 'work-target',
      works: works.slice(0, 2)
    })).toEqual({
      matchedTarget: false,
      selectedStatusId: undefined,
      selectedWorkId: 'work-current',
      shouldScrollToLatest: false
    });
  });

  it('selects the latest work only when there is no valid selection and no pending generation', () => {
    expect(resolveHistorySelection({
      autoSelectActive: false,
      selectedWorkId: 'work-missing',
      works
    })).toEqual({
      matchedTarget: false,
      selectedStatusId: undefined,
      selectedWorkId: 'work-target',
      shouldScrollToLatest: true
    });
  });

  it('does not select a fallback historical work when generation is pending', () => {
    expect(resolveHistorySelection({
      autoSelectActive: false,
      hasPendingGeneration: true,
      selectedWorkId: undefined,
      works
    })).toEqual({
      matchedTarget: false,
      selectedStatusId: undefined,
      selectedWorkId: undefined,
      shouldScrollToLatest: true
    });
  });

  it('selects latest failed task node when returning from other pages after generation failed', () => {
    const failedNodes = [
      { id: 'task-1-failed', taskId: 'task-1', kind: 'failed' as const, occurredAt: '2026-09-16T10:15:00.000Z' }
    ];
    expect(resolveHistorySelection({
      autoSelectActive: false,
      hasPendingGeneration: false,
      selectedWorkId: undefined,
      statusNodes: failedNodes,
      works
    })).toEqual({
      matchedTarget: false,
      selectedStatusId: 'task-1-failed',
      selectedTaskId: 'task-1',
      selectedWorkId: undefined,
      shouldScrollToLatest: true
    });
  });

  it('preserves selected status node when user explicitly chooses a status card', () => {
    const statusNodes = [
      { id: 'task-1-failed', kind: 'failed' as const, occurredAt: '2026-09-16T10:15:00.000Z' }
    ];
    expect(resolveHistorySelection({
      autoSelectActive: false,
      selectedStatusId: 'task-1-failed',
      statusNodes,
      works
    })).toEqual({
      matchedTarget: false,
      selectedStatusId: 'task-1-failed',
      selectedWorkId: undefined,
      shouldScrollToLatest: false
    });
  });

  it('stops retrying at either the retry or elapsed-time boundary', () => {
    expect(canRetryAutoSelect(4, 5_999)).toBe(true);
    expect(canRetryAutoSelect(5, 1_000)).toBe(false);
    expect(canRetryAutoSelect(1, 6_000)).toBe(false);
  });
});
