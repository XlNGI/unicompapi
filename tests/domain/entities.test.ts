import { describe, expect, it } from 'vitest';
import {
  createDraft,
  createTaskFromDraft,
  toDraftId,
  toIsoTimestamp,
  toProjectId,
  toTaskId
} from '../../src/domain';
import { createDraftFixture, t1 } from './fixtures';

describe('draft and task boundary', () => {
  it('creates a task only through an explicit confirmation snapshot', () => {
    const draft = createDraftFixture();
    const task = createTaskFromDraft({
      id: toTaskId('task-confirmed'),
      draft,
      confirmedAt: t1
    });

    expect(task.sourceDraftId).toBe(draft.id);
    expect(task.submission.confirmedAt).toBe(t1);
    expect(task.submission.prompt).not.toBe(draft.prompt);
    expect(task.submission.assetIds).not.toBe(draft.selectedAssetIds);
    expect(task.executionIds).toEqual([]);
  });

  it('rejects non-canonical timestamps', () => {
    expect(() => toIsoTimestamp('2026-07-21')).toThrow(
      'Timestamp must be a canonical UTC ISO-8601 string'
    );
  });

  it('does not create a task from a stale draft', () => {
    const draft = createDraft({
      ...createDraftFixture(),
      id: toDraftId('stale-draft'),
      projectId: toProjectId('project-1'),
      state: 'stale'
    });

    expect(() =>
      createTaskFromDraft({
        id: toTaskId('task-stale'),
        draft,
        confirmedAt: t1
      })
    ).toThrow('draft in stale state cannot create a task');
  });
});
