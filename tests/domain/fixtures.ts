import {
  addExecutionToTask,
  createDraft,
  createExecution,
  createTaskFromDraft,
  toAssetId,
  toDraftId,
  toExecutionId,
  toIsoTimestamp,
  toProjectId,
  toTaskId
} from '../../src/domain';

export const t0 = toIsoTimestamp('2026-07-21T00:00:00.000Z');
export const t1 = toIsoTimestamp('2026-07-21T00:01:00.000Z');
export const t2 = toIsoTimestamp('2026-07-21T00:02:00.000Z');
export const t3 = toIsoTimestamp('2026-07-21T00:03:00.000Z');
export const t4 = toIsoTimestamp('2026-07-21T00:04:00.000Z');
export const t5 = toIsoTimestamp('2026-07-21T00:05:00.000Z');
export const t6 = toIsoTimestamp('2026-07-21T00:06:00.000Z');
export const t7 = toIsoTimestamp('2026-07-21T00:07:00.000Z');

export function createDraftFixture() {
  return createDraft({
    id: toDraftId('draft-1'),
    projectId: toProjectId('project-1'),
    kind: 'image_generation',
    state: 'saved',
    prompt: {
      originalInput: 'Create a product image',
      systemSupplements: [
        {
          content: 'Use the selected project context',
          source: 'selected_context',
          sourceReference: 'context-1'
        }
      ],
      finalPrompt: 'Create a product image using the selected project context'
    },
    selectedAssetIds: [toAssetId('asset-1')],
    createdAt: t0,
    updatedAt: t0
  });
}

export function createTaskFixture() {
  return createTaskFromDraft({
    id: toTaskId('task-1'),
    draft: createDraftFixture(),
    confirmedAt: t1
  });
}

export function createLinkedExecutionFixture() {
  const task = createTaskFixture();
  const execution = createExecution({
    id: toExecutionId('execution-1'),
    taskId: task.id,
    createdAt: t2
  });

  return {
    execution,
    task: addExecutionToTask(task, execution)
  };
}
