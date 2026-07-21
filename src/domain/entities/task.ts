import { InvariantViolationError } from '../errors';
import type {
  AssetId,
  DraftId,
  ExecutionId,
  ProjectId,
  TaskId
} from '../ids';
import type { IsoTimestamp } from '../timestamps';
import { assertTimestampNotBefore } from '../timestamps';
import type { CreationKind, Draft } from './draft';
import type { Execution } from './execution';
import type { PromptSnapshot } from './prompt';

export interface SubmissionSnapshot {
  readonly kind: CreationKind;
  readonly prompt: PromptSnapshot;
  readonly assetIds: readonly AssetId[];
  readonly confirmedAt: IsoTimestamp;
}

export interface Task {
  readonly schemaVersion: 1;
  readonly id: TaskId;
  readonly projectId: ProjectId;
  readonly sourceDraftId: DraftId;
  readonly submission: SubmissionSnapshot;
  readonly executionIds: readonly ExecutionId[];
  readonly createdAt: IsoTimestamp;
}

export interface CreateTaskFromDraftInput {
  readonly id: TaskId;
  readonly draft: Draft;
  readonly confirmedAt: IsoTimestamp;
}

export function createTaskFromDraft(input: CreateTaskFromDraftInput): Task {
  if (!['editing', 'saved'].includes(input.draft.state)) {
    throw new InvariantViolationError(
      `draft in ${input.draft.state} state cannot create a task`
    );
  }

  assertTimestampNotBefore(
    input.confirmedAt,
    input.draft.updatedAt,
    'task.confirmedAt'
  );

  return {
    schemaVersion: 1,
    id: input.id,
    projectId: input.draft.projectId,
    sourceDraftId: input.draft.id,
    submission: {
      kind: input.draft.kind,
      prompt: {
        ...input.draft.prompt,
        systemSupplements: input.draft.prompt.systemSupplements.map((item) => ({
          ...item
        }))
      },
      assetIds: [...input.draft.selectedAssetIds],
      confirmedAt: input.confirmedAt
    },
    executionIds: [],
    createdAt: input.confirmedAt
  };
}

export function addExecutionToTask(task: Task, execution: Execution): Task {
  if (execution.taskId !== task.id) {
    throw new InvariantViolationError('execution belongs to another task');
  }

  if (task.executionIds.includes(execution.id)) {
    throw new InvariantViolationError('execution is already linked to task');
  }

  return {
    ...task,
    executionIds: [...task.executionIds, execution.id]
  };
}
