export interface TaskSelectionInput {
  readonly taskIds: readonly string[];
  readonly selectedTaskId?: string;
  readonly initialTaskId?: string;
  readonly appliedInitialTaskId?: string;
}

export interface TaskSelectionDecision {
  readonly selectedTaskId?: string;
  readonly appliedInitialTaskId?: string;
}

export function decideTaskSelection(input: TaskSelectionInput): TaskSelectionDecision {
  if (input.taskIds.length === 0) {
    return {
      selectedTaskId: input.selectedTaskId,
      appliedInitialTaskId: input.appliedInitialTaskId,
    };
  }

  const initialTaskIsPresent = input.initialTaskId !== undefined
    && input.taskIds.includes(input.initialTaskId);
  if (initialTaskIsPresent && input.initialTaskId !== input.appliedInitialTaskId) {
    return {
      selectedTaskId: input.initialTaskId,
      appliedInitialTaskId: input.initialTaskId,
    };
  }

  if (!input.selectedTaskId) {
    return {
      selectedTaskId: input.taskIds[0],
      appliedInitialTaskId: input.appliedInitialTaskId,
    };
  }

  return {
    selectedTaskId: input.selectedTaskId,
    appliedInitialTaskId: input.appliedInitialTaskId,
  };
}
