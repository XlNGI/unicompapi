import { describe, expect, it } from 'vitest';
import {
  attachConversationAgentRunExecution,
  assertConversationAgentRunUpdate,
  bindConversationAgentRunTasks,
  acknowledgeConversationAgentRunReconciliation,
  confirmConversationAgentRunProjectedCompletion,
  createConversationAgentRun,
  InvalidStateTransitionError,
  toConversationAgentRunId,
  toConversationId,
  toConversationResponseExecutionId,
  toDocumentTaskRuntimeId,
  toIsoTimestamp,
  toMessageId,
  toProjectId,
  markConversationAgentRunNeedsReconciliation,
  parseConversationAgentRun,
  transitionConversationAgentRun
} from '../../src/domain';

const projectId = toProjectId('project-agent-run-domain');
const conversationId = toConversationId('conversation-agent-run-domain');
const sourceMessageId = toMessageId('message-agent-run-domain');
const runId = toConversationAgentRunId('agent-run-domain');
const executionId = toConversationResponseExecutionId('response-execution-agent-run-domain');
const t0 = toIsoTimestamp('2026-09-30T10:00:00.000Z');
const t1 = toIsoTimestamp('2026-09-30T10:01:00.000Z');
const t2 = toIsoTimestamp('2026-09-30T10:02:00.000Z');

describe('conversation agent run domain contract', () => {
  it('models one response lifecycle independently from the conversation workflow', () => {
    const created = createConversationAgentRun({
      id: runId,
      projectId,
      conversationId,
      sourceMessageId,
      createdAt: t0
    });
    expect(created).toMatchObject({ revision: 0, status: 'running' });

    const executing = attachConversationAgentRunExecution(created, executionId, t1);
    expect(executing).toMatchObject({
      revision: 1,
      status: 'executing_tool',
      responseExecutionId: executionId
    });

    const completed = transitionConversationAgentRun(executing, 'completed', t2);
    expect(completed).toMatchObject({ revision: 2, status: 'completed' });
    expect(() => transitionConversationAgentRun(completed, 'running', t2))
      .toThrow(InvalidStateTransitionError);
  });

  it('keeps old records readable and binds an execution exactly once', () => {
    const run = createConversationAgentRun({ id: runId, projectId, conversationId, sourceMessageId, createdAt: t0 });
    expect(parseConversationAgentRun(run).documentTaskIds).toBeUndefined();
    const executing = attachConversationAgentRunExecution(run, executionId, t1);
    expect(attachConversationAgentRunExecution(executing, executionId, t2)).toBe(executing);
    expect(() => attachConversationAgentRunExecution(executing, toConversationResponseExecutionId('other-response'), t2)).toThrow(/immutable/);
    expect(() => assertConversationAgentRunUpdate(executing, {
      ...executing, responseExecutionId: toConversationResponseExecutionId('other-response'), revision: 2, updatedAt: t2
    })).toThrow(/immutable/);
  });

  it('appends a bounded child manifest without permitting removal or rebinding', () => {
    const run = createConversationAgentRun({ id: runId, projectId, conversationId, sourceMessageId, createdAt: t0 });
    const child = toDocumentTaskRuntimeId('document-task-owned');
    const next = bindConversationAgentRunTasks(run, [child], t1);
    expect(next.documentTaskIds).toEqual([child]);
    expect(bindConversationAgentRunTasks(next, [child], t2)).toBe(next);
    expect(() => bindConversationAgentRunTasks(next, [], t2)).toThrow(/immutable/);
    expect(() => bindConversationAgentRunTasks(run, [child, child], t1)).toThrow(/manifest/);
    expect(() => bindConversationAgentRunTasks(run, Array.from({ length: 33 }, (_, i) => toDocumentTaskRuntimeId(`child-${i}`)), t1)).toThrow(/manifest/);
    expect(() => parseConversationAgentRun({ ...run, documentTaskIds: ['C:/private/file'] })).toThrow(/manifest/);
    expect(() => assertConversationAgentRunUpdate(next, { ...next, conversationId: toConversationId('other-conversation'), revision: 2, updatedAt: t2 })).toThrow(/immutable/);
  });

  it('freezes unknown effects against late completed or cancelled transitions', () => {
    const run = createConversationAgentRun({ id: runId, projectId, conversationId, sourceMessageId, createdAt: t0 });
    const frozen = markConversationAgentRunNeedsReconciliation(run, 'unknown_result', t1);
    expect(frozen).toMatchObject({ status: 'needs_reconciliation', reconciliationReason: 'unknown_result', revision: 1 });
    expect(() => transitionConversationAgentRun(frozen, 'completed', t2)).toThrow(InvalidStateTransitionError);
    expect(() => transitionConversationAgentRun(frozen, 'cancelled', t2)).toThrow(InvalidStateTransitionError);
    expect(markConversationAgentRunNeedsReconciliation(frozen, 'entity_conflict', t2)).toBe(frozen);
    expect(() => parseConversationAgentRun({ ...frozen, reconciliationReason: 'C:/private/file' })).toThrow(/reason/);
    expect(() => parseConversationAgentRun({ ...run, status: 'needs_reconciliation' })).toThrow(/reason/);
    expect(() => acknowledgeConversationAgentRunReconciliation(run, t2)).toThrow(InvalidStateTransitionError);
    const acknowledged = acknowledgeConversationAgentRunReconciliation(frozen, t2);
    expect(acknowledged).toMatchObject({ status: 'cancelled', revision: 2, reconciliationReason: 'unknown_result',
      reconciliationAcknowledgement: { kind: 'closed_without_replay', confirmedAt: t2 } });
    expect(acknowledgeConversationAgentRunReconciliation(acknowledged, t2)).toBe(acknowledged);
    expect(() => assertConversationAgentRunUpdate(frozen, acknowledged)).toThrow();
    expect(() => parseConversationAgentRun({ ...acknowledged, reconciliationReason: undefined })).toThrow(/reason/);
    expect(() => parseConversationAgentRun({ ...acknowledged, reconciliationAcknowledgement: { kind: 'replayed', confirmedAt: t2 } })).toThrow(/acknowledgement/);
  });

  it('adds an acknowledgement to a historical terminal without changing its terminal status', () => {
    const run = createConversationAgentRun({ id: runId, projectId, conversationId, sourceMessageId, createdAt: t0 });
    const completed = transitionConversationAgentRun(run, 'completed', t1);
    const acknowledged = acknowledgeConversationAgentRunReconciliation(completed, t2, 'entity_conflict');
    expect(acknowledged).toMatchObject({ status: 'completed', revision: 2, reconciliationReason: 'entity_conflict',
      reconciliationAcknowledgement: { kind: 'closed_without_replay', confirmedAt: t2 } });
    expect(() => assertConversationAgentRunUpdate(completed, acknowledged)).toThrow();
  });

  it('requires the host projection confirmation boundary to restore a known terminal while retaining no-replay facts', () => {
    const run = createConversationAgentRun({ id: runId, projectId, conversationId, sourceMessageId, createdAt: t0 });
    const frozen = markConversationAgentRunNeedsReconciliation(run, 'unknown_result', t1);
    const confirmed = confirmConversationAgentRunProjectedCompletion(frozen, 'completed', t2);
    expect(confirmed).toMatchObject({ status: 'completed', reconciliationReason: 'unknown_result', revision: 2,
      reconciliationAcknowledgement: { kind: 'closed_without_replay', confirmedAt: t2 } });
    expect(() => assertConversationAgentRunUpdate(frozen, confirmed)).toThrow();
    expect(() => assertConversationAgentRunUpdate(frozen, confirmed, { reconciliationAcknowledged: true })).toThrow();
    expect(() => assertConversationAgentRunUpdate(frozen, confirmed, { reconciliationAcknowledged: true, projectedCompletionConfirmed: true })).not.toThrow();
    expect(() => confirmConversationAgentRunProjectedCompletion(run, 'completed', t2)).toThrow();
  });
});
