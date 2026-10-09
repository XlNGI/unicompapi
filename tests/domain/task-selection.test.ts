import { describe, expect, it } from 'vitest';
import { decideTaskSelection } from '../../src/pages/tasks/task-selection';

const taskIds = ['task-from-dock', 'task-other'];

describe('task center selection after opening a specific task', () => {
  it('selects the task opened from the status dock once', () => {
    expect(decideTaskSelection({
      taskIds,
      initialTaskId: 'task-from-dock',
    })).toEqual({
      selectedTaskId: 'task-from-dock',
      appliedInitialTaskId: 'task-from-dock',
    });
  });

  it('keeps a later list click instead of returning to the dock task', () => {
    const opened = decideTaskSelection({
      taskIds,
      initialTaskId: 'task-from-dock',
    });
    const clicked = decideTaskSelection({
      taskIds,
      selectedTaskId: 'task-other',
      initialTaskId: 'task-from-dock',
      appliedInitialTaskId: opened.appliedInitialTaskId,
    });
    const refreshed = decideTaskSelection({
      taskIds: [...taskIds],
      selectedTaskId: clicked.selectedTaskId,
      initialTaskId: 'task-from-dock',
      appliedInitialTaskId: clicked.appliedInitialTaskId,
    });

    expect(clicked.selectedTaskId).toBe('task-other');
    expect(refreshed.selectedTaskId).toBe('task-other');
  });

  it('selects the first task only when the page was opened without a target', () => {
    const opened = decideTaskSelection({ taskIds });
    const clicked = decideTaskSelection({
      taskIds,
      selectedTaskId: 'task-other',
      appliedInitialTaskId: opened.appliedInitialTaskId,
    });

    expect(opened.selectedTaskId).toBe('task-from-dock');
    expect(clicked.selectedTaskId).toBe('task-other');
  });

  it('follows a new dock target without changing an empty task list', () => {
    expect(decideTaskSelection({
      taskIds: [],
      selectedTaskId: 'task-other',
      initialTaskId: 'task-from-dock',
    })).toEqual({
      selectedTaskId: 'task-other',
      appliedInitialTaskId: undefined,
    });
    expect(decideTaskSelection({
      taskIds,
      selectedTaskId: 'task-other',
      initialTaskId: 'task-from-dock',
      appliedInitialTaskId: 'task-older',
    }).selectedTaskId).toBe('task-from-dock');
  });
});
