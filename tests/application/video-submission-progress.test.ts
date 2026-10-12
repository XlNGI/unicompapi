import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { historyLiveStatusWindowMs } from '../../src/components/GenerationHistory';
import {
  publishVideoSubmissionProgress,
  readVideoSubmissionProgress,
  resetVideoSubmissionProgressForTests,
  resolveWatchedVideoProgress,
  type VideoSubmissionProgressRecord
} from '../../src/pages/creation/video/VideoFeatureSubmissionPanel';

const now = Date.parse('2026-10-10T12:00:00.000Z');
const fresh = new Date(now - 60_000).toISOString();
const stale = new Date(now - historyLiveStatusWindowMs - 1).toISOString();

function task(
  taskId: string,
  state: string | undefined,
  works: readonly { readonly mediaKind: 'image' | 'video' }[] = [],
  occurredAt = fresh
) {
  return { taskId, createdAt: fresh, state, occurredAt, works };
}

describe('watched video submission progress', () => {
  beforeEach(() => {
    resetVideoSubmissionProgressForTests();
  });

  it('completes only the current task when its video work exists', () => {
    expect(resolveWatchedVideoProgress({
      taskId: 'current',
      nowMs: now,
      items: [
        task('other', 'completed', [{ mediaKind: 'video' }]),
        task('current', 'processing', [{ mediaKind: 'video' }])
      ]
    }).phase).toBe('completed');
  });

  it('does not treat another task or a non-video work as completion', () => {
    expect(resolveWatchedVideoProgress({
      taskId: 'current',
      nowMs: now,
      items: [
        task('other', 'completed', [{ mediaKind: 'video' }]),
        task('current', 'processing', [{ mediaKind: 'image' }])
      ]
    }).phase).toBe('waiting');
    expect(resolveWatchedVideoProgress({
      taskId: 'missing',
      nowMs: now,
      items: [task('other', 'completed', [{ mediaKind: 'video' }])]
    }).phase).toBe('waiting');
  });

  it('fails a task without a work when it failed, expired, or was cancelled', () => {
    for (const state of ['failed', 'expired', 'cancelled']) {
      expect(resolveWatchedVideoProgress({
        taskId: 'current',
        nowMs: now,
        items: [task('current', state)]
      }).phase).toBe('failed');
    }
  });

  it('keeps a cancelled task completed once a video work exists', () => {
    expect(resolveWatchedVideoProgress({
      taskId: 'current',
      nowMs: now,
      items: [task('current', 'cancelled', [{ mediaKind: 'video' }])]
    }).phase).toBe('completed');
  });

  it('marks uncertain outcomes and expired in-progress states without guessing', () => {
    expect(resolveWatchedVideoProgress({
      taskId: 'current',
      nowMs: now,
      items: [task('current', 'submission_outcome_unknown')]
    }).phase).toBe('uncertain');
    expect(resolveWatchedVideoProgress({
      taskId: 'current',
      nowMs: now,
      items: [task('current', 'processing', [], fresh)]
    }).phase).toBe('waiting');
    expect(resolveWatchedVideoProgress({
      taskId: 'current',
      nowMs: now,
      items: [task('current', 'downloading', [], stale)]
    }).phase).toBe('uncertain');
    expect(resolveWatchedVideoProgress({
      taskId: 'current',
      nowMs: now,
      items: [task('current', 'not_a_state')]
    }).phase).toBe('waiting');
  });

  it('completes when the task itself is completed even before a work is attached', () => {
    expect(resolveWatchedVideoProgress({
      taskId: 'current',
      nowMs: now,
      items: [task('current', 'completed')]
    }).phase).toBe('completed');
  });

  it('restores one draft without copying its result onto another draft', () => {
    const completed: VideoSubmissionProgressRecord = {
      phase: 'completed',
      taskId: 'task-a'
    };
    publishVideoSubmissionProgress('draft-a', completed);
    publishVideoSubmissionProgress('draft-b', { phase: 'waiting', taskId: 'task-b' });
    expect(readVideoSubmissionProgress('draft-a')).toEqual(completed);
    expect(readVideoSubmissionProgress('draft-b')?.phase).toBe('waiting');
    expect(readVideoSubmissionProgress('draft-c')).toBeUndefined();
  });

  it('replaces the same draft when generation starts again', () => {
    publishVideoSubmissionProgress('draft-a', { phase: 'completed', taskId: 'task-a' });
    publishVideoSubmissionProgress('draft-a', { phase: 'preparing' });
    expect(readVideoSubmissionProgress('draft-a')).toEqual({ phase: 'preparing' });
    publishVideoSubmissionProgress('draft-a', undefined);
    expect(readVideoSubmissionProgress('draft-a')).toBeUndefined();
  });

  it('keeps the video panel subscribed to the current draft history', () => {
    const source = readFileSync(
      'src/pages/creation/video/VideoFeatureSubmissionPanel.tsx',
      'utf8'
    );
    expect(source).toContain('readVideoSubmissionProgress(draft.draftId)');
    expect(source).toContain("mediaKind: 'video'");
    expect(source).toContain('limit: 30');
    expect(source).toContain('onLocalStorageChanged(applyHistory)');
    expect(source).not.toMatch(/useEffect\(\(\) => \{\s*setProgressPhase\('idle'\)/);
  });
});
