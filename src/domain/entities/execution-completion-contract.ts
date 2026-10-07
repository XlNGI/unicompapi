import type { ConversationId, ConversationResponseExecutionId, DocumentTaskRuntimeId, MessageId, ProjectId, WorkId } from '../ids';
import type { IsoTimestamp } from '../timestamps';
import {
  markConversationAgentRunNeedsReconciliation,
  transitionConversationAgentRun,
  type AgentRunReconciliationReason,
  type AgentRunStatus,
  type ConversationAgentRunV1
} from './conversation-agent-run';
import type { ConversationResponseExecutionState } from './conversation-response-execution';
import type { DocumentTaskRuntime } from './document-task-runtime';
import type { Work } from './work';

/** Facts come from host repositories and local readback, never from a model's claim. */
export interface ConversationDocumentCompletionFacts {
  readonly runtime: DocumentTaskRuntime;
  readonly active?: boolean;
  /** Host-confirmed deliverable/read intent; an available capability alone is not required. */
  readonly required?: boolean;
  readonly registeredWork?: Pick<Work, 'id' | 'projectId' | 'sourceExecutionId'> & {
    /** The host verifies the publication receipt; Work.sourceExecutionId is a local execution ID. */
    readonly sourceTaskRuntimeId: DocumentTaskRuntimeId;
  };
  readonly readBackConfirmed?: boolean;
  /** Persisted assistant documentResult or an equivalent local delivery receipt. */
  readonly deliveryConfirmed?: boolean;
}

export interface ConversationExecutionCompletionFacts {
  readonly run: ConversationAgentRunV1;
  readonly response: {
    readonly id: ConversationResponseExecutionId;
    readonly projectId: ProjectId;
    readonly conversationId: ConversationId;
    readonly sourceMessageId: MessageId;
    readonly state: ConversationResponseExecutionState;
  };
  readonly documentTasks?: readonly ConversationDocumentCompletionFacts[];
  readonly pendingToolCallCount?: number;
  readonly unpersistedObservationCount?: number;
  readonly unknownResult?: boolean;
  /** A final unrecovered failure, rather than an earlier corrected attempt. */
  readonly toolFailed?: boolean;
}

export const conversationExecutionCompletionReasons = [
  'completed', 'response_pending', 'response_failed', 'response_cancelled', 'response_interrupted',
  'tool_pending', 'tool_failed', 'document_pending', 'work_unverified', 'readback_missing',
  'delivery_missing', 'reconciliation_required', 'entity_conflict'
] as const;
export type ConversationExecutionCompletionReason = (typeof conversationExecutionCompletionReasons)[number];

export interface ConversationExecutionCompletionDecision {
  readonly status: AgentRunStatus;
  readonly reason: ConversationExecutionCompletionReason;
  readonly reconciliationReason?: AgentRunReconciliationReason;
  readonly registeredWorkIds: readonly WorkId[];
  readonly executionOwner: 'response' | 'document_task' | 'none';
  /** Completion is a settlement decision and never grants replay authority. */
  readonly canReplay: false;
  readonly responseCompleted: boolean;
  readonly documentCompleted: boolean;
}

/** Pure cross-entity completion contract. Unknown effects dominate response cancellation/completion. */
export function evaluateConversationExecutionCompletion(
  facts: ConversationExecutionCompletionFacts
): ConversationExecutionCompletionDecision {
  const { run, response } = facts;
  const tasks = facts.documentTasks ?? [];
  const responseCompleted = response.state === 'completed';
  const registeredWorkIds = [...new Set(tasks.flatMap(task => {
    const work = task.registeredWork;
    return work && task.runtime.projectId === run.projectId && task.runtime.conversationId === run.conversationId &&
      task.runtime.sourceMessageId === run.sourceMessageId && task.runtime.executionId === response.id &&
      work.projectId === run.projectId && work.sourceTaskRuntimeId === task.runtime.id &&
      task.runtime.workRef?.kind === 'registered' && task.runtime.workRef.ref === work.id ? [work.id] : [];
  }))];
  const decision = (
    status: AgentRunStatus,
    reason: ConversationExecutionCompletionReason,
    options: { readonly reconciliationReason?: AgentRunReconciliationReason; readonly documentCompleted?: boolean;
      readonly executionOwner?: ConversationExecutionCompletionDecision['executionOwner'] } = {}
  ): ConversationExecutionCompletionDecision => ({
    status, reason,
    ...(options.reconciliationReason ? { reconciliationReason: options.reconciliationReason } : {}),
    registeredWorkIds,
    executionOwner: options.executionOwner ?? (status === 'running' ? 'response' : status === 'executing_tool' ? 'document_task' : 'none'),
    canReplay: false,
    responseCompleted,
    documentCompleted: options.documentCompleted ?? false
  });
  const freeze = (reason: AgentRunReconciliationReason) => decision('needs_reconciliation',
    reason === 'entity_conflict' ? 'entity_conflict' : 'reconciliation_required', { reconciliationReason: reason });
  if (!validCount(facts.pendingToolCallCount) || !validCount(facts.unpersistedObservationCount) ||
      tasks.length > 32 || new Set(tasks.map(task => task.runtime.id)).size !== tasks.length ||
      run.responseExecutionId !== response.id || response.projectId !== run.projectId ||
      response.conversationId !== run.conversationId || response.sourceMessageId !== run.sourceMessageId ||
      tasks.some(task => task.runtime.projectId !== run.projectId || task.runtime.conversationId !== run.conversationId ||
        task.runtime.sourceMessageId !== run.sourceMessageId || task.runtime.executionId !== response.id) ||
      run.documentTaskIds !== undefined && (run.documentTaskIds.some(id => !tasks.some(task => task.runtime.id === id)) ||
        tasks.some(task => !run.documentTaskIds!.includes(task.runtime.id)))) return freeze('entity_conflict');
  // Scope is checked even for historical terminal records; their stored terminal facts remain immutable.
  if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') {
    return decision(run.status, run.status === 'completed' ? 'completed' : run.status === 'failed' ? 'response_failed' : 'response_cancelled',
      { documentCompleted: run.status === 'completed' });
  }
  if (run.status === 'needs_reconciliation') return freeze(run.reconciliationReason ?? 'unknown_result');
  if (facts.unknownResult || tasks.some(task => task.runtime.status === 'needs_reconciliation' ||
    task.runtime.toolCalls.some(call => call.status === 'unknown'))) return freeze('unknown_result');
  if ((facts.unpersistedObservationCount ?? 0) > 0 || tasks.some(task => task.runtime.toolCalls
    .filter(call => call.status === 'completed' || call.status === 'failed')
    .some(call => !task.runtime.observations.some(observation => observation.step === call.step &&
      observation.toolId === call.toolId && observation.ok === (call.status === 'completed'))))) return freeze('observation_missing');
  const pending = (facts.pendingToolCallCount ?? 0) > 0 || tasks.some(task =>
    task.runtime.toolCalls.some(call => call.status === 'started'));
  if (pending) {
    if (['completed', 'failed', 'cancelled', 'interrupted'].includes(response.state)) return freeze('unsettled_tool_call');
    return decision('executing_tool', 'tool_pending');
  }
  const activeTasks = tasks.filter(task => task.runtime.toolCalls.length > 0 || task.runtime.workRef?.kind === 'registered' ||
    task.required === true || task.active === true || !['planning', 'paused', 'waiting_input'].includes(task.runtime.status));
  const documentCompleted = activeTasks.every(task => {
    if (!task.readBackConfirmed) return false;
    if (task.runtime.operation === 'analyze') {
      return ['completed', 'paused'].includes(task.runtime.status) &&
        task.runtime.observations.some(item => item.toolId === 'read_document_structure' && item.ok);
    }
    return task.runtime.status === 'completed' && task.runtime.workRef?.kind === 'registered' &&
      task.registeredWork?.id === task.runtime.workRef.ref && task.registeredWork.projectId === run.projectId &&
      task.registeredWork.sourceTaskRuntimeId === task.runtime.id;
  });
  const failedTask = activeTasks.some(task => task.runtime.status === 'failed' || task.runtime.toolCalls.at(-1)?.status === 'failed');
  if (facts.toolFailed || failedTask) return decision('failed', 'tool_failed', { documentCompleted });
  if (response.state === 'failed') return decision('failed', 'response_failed', { documentCompleted });
  if (response.state === 'cancelled' || activeTasks.some(task => task.runtime.status === 'cancelled')) {
    return decision('cancelled', 'response_cancelled', { documentCompleted });
  }
  if (response.state === 'interrupted') return decision('failed', 'response_interrupted', { documentCompleted });
  if (!responseCompleted) return decision(activeTasks.length > 0 ? 'executing_tool' : 'running', 'response_pending', {
    documentCompleted, executionOwner: documentCompleted ? 'response' : 'document_task'
  });
  // The provider reports its final response before DocumentToolSession.close settles
  // the local runtime. Keep ownership open until that settlement is persisted.
  if (activeTasks.some(task => task.runtime.status === 'planning' || task.runtime.status === 'running')) {
    return decision('executing_tool', 'document_pending', { documentCompleted });
  }
  for (const task of activeTasks) {
    const { runtime, registeredWork } = task;
    if (runtime.operation === 'analyze') {
      const successfulRead = runtime.observations.some(item => item.toolId === 'read_document_structure' && item.ok);
      if (!['completed', 'paused'].includes(runtime.status) || !successfulRead) return decision('failed', 'document_pending');
      if (!task.readBackConfirmed) return decision('failed', 'readback_missing');
      continue;
    }
    if (runtime.status !== 'completed') return decision('failed', 'document_pending');
    if (runtime.workRef?.kind !== 'registered' || !registeredWork || registeredWork.projectId !== run.projectId ||
        registeredWork.id !== runtime.workRef.ref || registeredWork.sourceTaskRuntimeId !== runtime.id) return freeze('entity_conflict');
    if (!task.readBackConfirmed) return decision('failed', 'readback_missing');
    if (!task.deliveryConfirmed) return decision('failed', 'delivery_missing', { documentCompleted });
  }
  return decision('completed', 'completed', { documentCompleted: true });
}

export function applyConversationExecutionCompletion(
  run: ConversationAgentRunV1,
  decision: ConversationExecutionCompletionDecision,
  updatedAt: IsoTimestamp
): ConversationAgentRunV1 {
  if (run.status === 'needs_reconciliation' || run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') return run;
  if (decision.status === 'needs_reconciliation') {
    return markConversationAgentRunNeedsReconciliation(run, decision.reconciliationReason ?? 'unknown_result', updatedAt);
  }
  return transitionConversationAgentRun(run, decision.status, updatedAt);
}

function validCount(value: number | undefined): boolean {
  return value === undefined || Number.isSafeInteger(value) && value >= 0 && value <= 128;
}
