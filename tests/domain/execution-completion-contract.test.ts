import { describe, expect, it } from 'vitest';
import {
  applyConversationExecutionCompletion, assertDocumentTaskRuntimeUpdate, attachConversationAgentRunExecution, bindConversationAgentRunTasks,
  createConversationAgentRun, createDocumentTaskRuntime, createDocumentToolRegistry,
  evaluateConversationExecutionCompletion, markConversationAgentRunNeedsReconciliation, parseDocumentTaskRuntime,
  toConversationAgentRunId, toConversationId, toConversationResponseExecutionId, toDocumentTaskRuntimeId,
  toExecutionId, toIsoTimestamp, toMessageId, toProjectId, toWorkId, updateDocumentTaskRuntime,
  transitionConversationAgentRun,
  type ConversationDocumentCompletionFacts, type ConversationExecutionCompletionFacts
} from '../../src/domain';

const projectId = toProjectId('project-completion');
const conversationId = toConversationId('conversation-completion');
const sourceMessageId = toMessageId('message-completion');
const responseId = toConversationResponseExecutionId('response-completion');
const runtimeId = toDocumentTaskRuntimeId('task-completion');
const workId = toWorkId('work-completion');
const t0 = toIsoTimestamp('2026-10-03T10:00:00.000Z');
const t1 = toIsoTimestamp('2026-10-03T10:01:00.000Z');
const t2 = toIsoTimestamp('2026-10-03T10:02:00.000Z');

function facts(): ConversationExecutionCompletionFacts {
  const run = attachConversationAgentRunExecution(createConversationAgentRun({
    id: toConversationAgentRunId('run-completion'), projectId, conversationId, sourceMessageId, createdAt: t0
  }), responseId, t1);
  return { run, response: { id: responseId, projectId, conversationId, sourceMessageId, state: 'completed' } };
}

function task(operation: 'create' | 'analyze' = 'create') {
  return createDocumentTaskRuntime({ id: runtimeId, projectId, conversationId, sourceMessageId,
    executionId: responseId, documentKind: 'ppt', operation, budget: { maxSteps: 8, budgetUnits: 24, timeoutMs: 360_000 }, createdAt: t0 });
}

function completedTask(): ConversationDocumentCompletionFacts {
  const base = task();
  const toolId = 'read_document_structure' as const;
  const costUnits = createDocumentToolRegistry().get(toolId)!.maxCostUnits;
  const runtime = parseDocumentTaskRuntime({ ...base, revision: 2, status: 'completed',
    workRef: { kind: 'registered', ref: workId }, checkpoint: { stage: 'complete', step: 1, costUnits, lastToolCallId: 'call-read' },
    toolCalls: [{ id: 'call-read', toolId, inputHash: 'a'.repeat(64), step: 1, status: 'completed' }],
    observations: [{ step: 1, toolId, ok: true, data: {} }], updatedAt: t1 });
  return { runtime, registeredWork: { id: workId, projectId, sourceExecutionId: toExecutionId('local-doc-execution'), sourceTaskRuntimeId: runtimeId },
    readBackConfirmed: true, deliveryConfirmed: true };
}

describe('cross-entity execution completion', () => {
  it('does not treat an explicitly required document as a completed pure reply when no tool ran', () => {
    const required = { runtime: { ...task(), status: 'paused' as const }, active: false, required: true };
    expect(evaluateConversationExecutionCompletion({ ...facts(), documentTasks: [required] }))
      .toMatchObject({ status: 'failed', reason: 'document_pending' });
    expect(evaluateConversationExecutionCompletion({ ...facts(), documentTasks: [{ ...required, required: false }] }).status).toBe('completed');
  });
  it('completes a pure answer and ignores an unused document capability', () => {
    expect(evaluateConversationExecutionCompletion(facts())).toMatchObject({ status: 'completed', canReplay: false });
    expect(evaluateConversationExecutionCompletion({ ...facts(), documentTasks: [{ runtime: task(), active: false }] }).status).toBe('completed');
    expect(evaluateConversationExecutionCompletion({ ...facts(), documentTasks: [{ runtime: { ...task(), status: 'paused' }, active: false }] }).status).toBe('completed');
  });

  it('requires a real registered Work, readback and persisted delivery receipt', () => {
    const document = completedTask();
    expect(evaluateConversationExecutionCompletion({ ...facts(), documentTasks: [document] })).toMatchObject({
      status: 'completed', documentCompleted: true, registeredWorkIds: [workId]
    });
    expect(evaluateConversationExecutionCompletion({ ...facts(), documentTasks: [{ ...document, registeredWork: undefined }] }))
      .toMatchObject({ status: 'needs_reconciliation', reconciliationReason: 'entity_conflict' });
    expect(evaluateConversationExecutionCompletion({ ...facts(), documentTasks: [{ ...document, readBackConfirmed: false }] }))
      .toMatchObject({ status: 'failed', reason: 'readback_missing', registeredWorkIds: [workId] });
    expect(evaluateConversationExecutionCompletion({ ...facts(), documentTasks: [{ ...document, deliveryConfirmed: false }] }))
      .toMatchObject({ status: 'failed', reason: 'delivery_missing', registeredWorkIds: [workId] });
  });

  it('does not confuse a local Work execution ID with its parent response owner', () => {
    const document = completedTask();
    expect(document.registeredWork?.sourceExecutionId).not.toBe(responseId);
    expect(evaluateConversationExecutionCompletion({ ...facts(), documentTasks: [document] }).status).toBe('completed');
    expect(evaluateConversationExecutionCompletion({ ...facts(), documentTasks: [{ ...document,
      registeredWork: { ...document.registeredWork!, sourceTaskRuntimeId: toDocumentTaskRuntimeId('other-task') } }] }))
      .toMatchObject({ status: 'needs_reconciliation', registeredWorkIds: [] });
  });

  it('retains committed Work while distinguishing an incomplete or failed answer', () => {
    const input = facts();
    expect(evaluateConversationExecutionCompletion({ ...input, response: { ...input.response, state: 'streaming' }, documentTasks: [completedTask()] }))
      .toMatchObject({ status: 'executing_tool', responseCompleted: false, documentCompleted: true,
        executionOwner: 'response', registeredWorkIds: [workId] });
    expect(evaluateConversationExecutionCompletion({ ...input, response: { ...input.response, state: 'failed' }, documentTasks: [completedTask()] }))
      .toMatchObject({ status: 'failed', documentCompleted: true, registeredWorkIds: [workId] });
    expect(evaluateConversationExecutionCompletion({ ...input, toolFailed: true }).status).toBe('failed');
  });

  it('waits for local close after provider completion instead of irreversibly failing the parent', () => {
    const input = facts();
    const completed = completedTask();
    for (const status of ['planning', 'running'] as const) {
      const runtime = parseDocumentTaskRuntime({ ...completed.runtime, status,
        checkpoint: { ...completed.runtime.checkpoint, stage: 'tool' } });
      const beforeClose = evaluateConversationExecutionCompletion({ ...input,
        documentTasks: [{ ...completed, runtime }] });
      expect(beforeClose).toMatchObject({ status: 'executing_tool', reason: 'document_pending',
        responseCompleted: true, documentCompleted: false, registeredWorkIds: [workId], executionOwner: 'document_task' });
      const pendingRun = applyConversationExecutionCompletion(input.run, beforeClose, t2);
      expect(pendingRun.status).toBe('executing_tool');
      const afterClose = evaluateConversationExecutionCompletion({ ...input, run: pendingRun, documentTasks: [completed] });
      expect(applyConversationExecutionCompletion(pendingRun, afterClose, t2).status).toBe('completed');
    }
    const paused = parseDocumentTaskRuntime({ ...completed.runtime, status: 'paused',
      checkpoint: { ...completed.runtime.checkpoint, stage: 'tool' } });
    expect(evaluateConversationExecutionCompletion({ ...input, documentTasks: [{ ...completed, runtime: paused }] }))
      .toMatchObject({ status: 'failed', reason: 'document_pending' });
  });

  it('also waits for close to finish a successful read-only runtime', () => {
    const input = facts();
    const completed = parseDocumentTaskRuntime({ ...completedTask().runtime, operation: 'analyze', workRef: undefined });
    const running = parseDocumentTaskRuntime({ ...completed, status: 'running', checkpoint: { ...completed.checkpoint, stage: 'tool' } });
    expect(evaluateConversationExecutionCompletion({ ...input, documentTasks: [{ runtime: running, readBackConfirmed: true }] }))
      .toMatchObject({ status: 'executing_tool', reason: 'document_pending' });
    expect(evaluateConversationExecutionCompletion({ ...input, documentTasks: [{ runtime: completed, readBackConfirmed: true }] }).status).toBe('completed');
  });

  it('freezes unsettled calls and observations before response terminal projection', () => {
    expect(evaluateConversationExecutionCompletion({ ...facts(), pendingToolCallCount: 1 }))
      .toMatchObject({ status: 'needs_reconciliation', reconciliationReason: 'unsettled_tool_call', canReplay: false });
    expect(evaluateConversationExecutionCompletion({ ...facts(), unpersistedObservationCount: 1 }))
      .toMatchObject({ status: 'needs_reconciliation', reconciliationReason: 'observation_missing' });
    const input = facts();
    expect(evaluateConversationExecutionCompletion({ ...input, response: { ...input.response, state: 'cancelled' }, unknownResult: true }))
      .toMatchObject({ status: 'needs_reconciliation', reconciliationReason: 'unknown_result' });
    const document = completedTask();
    expect(evaluateConversationExecutionCompletion({ ...facts(), documentTasks: [{ ...document, runtime: { ...document.runtime, observations: [] } }] }))
      .toMatchObject({ status: 'needs_reconciliation', reconciliationReason: 'observation_missing' });
    const runtime = updateDocumentTaskRuntime(task(), { status: 'needs_reconciliation',
      checkpoint: { stage: 'reconcile', step: 0, costUnits: 0 }, updatedAt: t1 });
    expect(evaluateConversationExecutionCompletion({ ...facts(), documentTasks: [{ runtime, active: false }] }))
      .toMatchObject({ status: 'needs_reconciliation', reconciliationReason: 'unknown_result' });
  });

  it('rejects cross-project/message/response ownership and missing manifest children', () => {
    const input = facts();
    for (const response of [
      { ...input.response, projectId: toProjectId('other-project') },
      { ...input.response, sourceMessageId: toMessageId('other-message') },
      { ...input.response, id: toConversationResponseExecutionId('other-response') }
    ]) expect(evaluateConversationExecutionCompletion({ ...input, response })).toMatchObject({ status: 'needs_reconciliation', reconciliationReason: 'entity_conflict' });
    const run = bindConversationAgentRunTasks(input.run, [runtimeId], t2);
    expect(evaluateConversationExecutionCompletion({ ...input, run })).toMatchObject({ status: 'needs_reconciliation', reconciliationReason: 'entity_conflict' });
    expect(evaluateConversationExecutionCompletion({ ...input, pendingToolCallCount: -1 }).status).toBe('needs_reconciliation');
  });

  it('validates scope for immutable historical terminal records', () => {
    const input = facts();
    const run = transitionConversationAgentRun(input.run, 'completed', t2);
    const result = evaluateConversationExecutionCompletion({ ...input, run,
      response: { ...input.response, projectId: toProjectId('other-project') } });
    expect(result).toMatchObject({ status: 'needs_reconciliation', reconciliationReason: 'entity_conflict' });
    expect(applyConversationExecutionCompletion(run, result, t2)).toBe(run);
  });

  it('does not clear a previous unknown result when a late final answer arrives', () => {
    const input = facts();
    const run = markConversationAgentRunNeedsReconciliation(input.run, 'unknown_result', t2);
    const result = evaluateConversationExecutionCompletion({ ...input, run, documentTasks: [completedTask()] });
    expect(result).toMatchObject({ status: 'needs_reconciliation', executionOwner: 'none', registeredWorkIds: [workId] });
    expect(applyConversationExecutionCompletion(run, { ...result, status: 'completed' }, t2)).toBe(run);
  });

  it('accepts successful analyze completion without manufacturing a Work', () => {
    const base = completedTask().runtime;
    const runtime = parseDocumentTaskRuntime({ ...base, operation: 'analyze', workRef: undefined });
    expect(evaluateConversationExecutionCompletion({ ...facts(), documentTasks: [{ runtime, readBackConfirmed: true }] })).toMatchObject({ status: 'completed', registeredWorkIds: [] });
  });
});

describe('document runtime registered receipts', () => {
  it('does not allow a stored write task to become a read-only task through object spreads', () => {
    const previous = task();
    const forged = parseDocumentTaskRuntime({ ...previous, operation: 'analyze', status: 'running', revision: 1, updatedAt: t1 });
    expect(() => assertDocumentTaskRuntimeUpdate(previous, forged)).toThrow(/immutable/);
  });

  it('preserves a registered Work inside an unknown runtime without changing the unknown call', () => {
    const base = task();
    const toolId = 'generate_pptx' as const;
    const unknown = parseDocumentTaskRuntime({ ...base, revision: 1, status: 'needs_reconciliation',
      checkpoint: { stage: 'reconcile', step: 1, costUnits: createDocumentToolRegistry().get(toolId)!.maxCostUnits, lastToolCallId: 'call-write' },
      toolCalls: [{ id: 'call-write', toolId, inputHash: 'a'.repeat(64), step: 1, status: 'unknown' }], updatedAt: t1 });
    const receipt = updateDocumentTaskRuntime(unknown, { workRef: { kind: 'registered', ref: workId }, updatedAt: t2 });
    expect(receipt).toMatchObject({ status: 'needs_reconciliation', workRef: { kind: 'registered', ref: workId } });
    expect(receipt.toolCalls).toEqual(unknown.toolCalls);
    expect(() => updateDocumentTaskRuntime(receipt, { status: 'completed', checkpoint: { ...receipt.checkpoint, stage: 'complete' }, updatedAt: t2 })).toThrow();
    expect(() => updateDocumentTaskRuntime(receipt, { workRef: { kind: 'registered', ref: 'other-work' }, updatedAt: t2 })).toThrow();
  });
});
