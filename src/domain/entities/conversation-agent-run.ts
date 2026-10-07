import { InvalidStateTransitionError, InvariantViolationError } from '../errors';
import {
  toConversationAgentRunId,
  toConversationId,
  toConversationResponseExecutionId,
  toDocumentTaskRuntimeId,
  toMessageId,
  toProjectId,
  type ConversationAgentRunId,
  type ConversationId,
  type ConversationResponseExecutionId,
  type DocumentTaskRuntimeId,
  type MessageId,
  type ProjectId
} from '../ids';
import { assertTimestampNotBefore, toIsoTimestamp, type IsoTimestamp } from '../timestamps';

export const agentRunStatuses = [
  'running',
  'waiting_user',
  'waiting_authorization',
  'executing_tool',
  'needs_reconciliation',
  'completed',
  'failed',
  'cancelled'
] as const;
export type AgentRunStatus = (typeof agentRunStatuses)[number];

export const agentRunReconciliationReasons = [
  'unknown_result', 'unsettled_tool_call', 'observation_missing', 'entity_conflict'
] as const;
export type AgentRunReconciliationReason = (typeof agentRunReconciliationReasons)[number];

export interface AgentRunReconciliationAcknowledgement {
  readonly kind: 'closed_without_replay';
  readonly confirmedAt: IsoTimestamp;
}

export interface ConversationAgentRunV1 {
  readonly schemaVersion: 1;
  readonly id: ConversationAgentRunId;
  readonly revision: number;
  readonly projectId: ProjectId;
  readonly conversationId: ConversationId;
  readonly sourceMessageId: MessageId;
  readonly parentRunId?: ConversationAgentRunId;
  readonly responseExecutionId?: ConversationResponseExecutionId;
  readonly documentTaskIds?: readonly DocumentTaskRuntimeId[];
  readonly reconciliationReason?: AgentRunReconciliationReason;
  readonly reconciliationAcknowledgement?: AgentRunReconciliationAcknowledgement;
  readonly status: AgentRunStatus;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

export function createConversationAgentRun(input: {
  readonly id: ConversationAgentRunId;
  readonly projectId: ProjectId;
  readonly conversationId: ConversationId;
  readonly sourceMessageId: MessageId;
  readonly parentRunId?: ConversationAgentRunId;
  readonly createdAt: IsoTimestamp;
}): ConversationAgentRunV1 {
  return parseConversationAgentRun({
    schemaVersion: 1,
    id: input.id,
    revision: 0,
    projectId: input.projectId,
    conversationId: input.conversationId,
    sourceMessageId: input.sourceMessageId,
    ...(input.parentRunId ? { parentRunId: input.parentRunId } : {}),
    status: 'running',
    createdAt: input.createdAt,
    updatedAt: input.createdAt
  });
}

export function attachConversationAgentRunExecution(
  run: ConversationAgentRunV1,
  responseExecutionId: ConversationResponseExecutionId,
  updatedAt: IsoTimestamp
): ConversationAgentRunV1 {
  if (run.responseExecutionId === responseExecutionId) return run;
  if (run.responseExecutionId !== undefined) {
    throw new InvariantViolationError('conversation agent run execution binding is immutable');
  }
  if (run.status !== 'running') {
    throw new InvalidStateTransitionError('conversation agent run', run.status, 'executing_tool');
  }
  return updateConversationAgentRun(run, { responseExecutionId, status: 'executing_tool' }, updatedAt);
}

/** The host appends child ownership before executing it. Existing ownership cannot be removed. */
export function bindConversationAgentRunTasks(
  run: ConversationAgentRunV1,
  documentTaskIds: readonly DocumentTaskRuntimeId[],
  updatedAt: IsoTimestamp
): ConversationAgentRunV1 {
  const ids = parseDocumentTaskIds(documentTaskIds);
  if ((run.documentTaskIds ?? []).some(id => !ids.includes(id))) {
    throw new InvariantViolationError('conversation agent run task binding is immutable');
  }
  if (JSON.stringify(run.documentTaskIds ?? []) === JSON.stringify(ids)) return run;
  if (isTerminal(run.status) || run.status === 'needs_reconciliation') {
    throw new InvalidStateTransitionError('conversation agent run', run.status, 'executing_tool');
  }
  return updateConversationAgentRun(run, { documentTaskIds: ids }, updatedAt);
}

export function markConversationAgentRunNeedsReconciliation(
  run: ConversationAgentRunV1,
  reason: AgentRunReconciliationReason,
  updatedAt: IsoTimestamp
): ConversationAgentRunV1 {
  if (run.status === 'needs_reconciliation') return run;
  if (isTerminal(run.status)) {
    throw new InvalidStateTransitionError('conversation agent run', run.status, 'needs_reconciliation');
  }
  return updateConversationAgentRun(run, { status: 'needs_reconciliation', reconciliationReason: reason }, updatedAt);
}

/** Explicit acknowledgement closes the conversation attempt without claiming that the effect did not happen. */
export function acknowledgeConversationAgentRunReconciliation(
  run: ConversationAgentRunV1,
  updatedAt: IsoTimestamp,
  reason: AgentRunReconciliationReason = run.reconciliationReason ?? 'unknown_result'
): ConversationAgentRunV1 {
  if (run.reconciliationAcknowledgement) return run;
  if (run.status !== 'needs_reconciliation' && !isTerminal(run.status)) {
    throw new InvalidStateTransitionError('conversation agent run', run.status, 'cancelled');
  }
  return updateConversationAgentRun(run, {
    status: run.status === 'needs_reconciliation' ? 'cancelled' : run.status,
    reconciliationReason: run.reconciliationReason ?? reason,
    reconciliationAcknowledgement: { kind: 'closed_without_replay', confirmedAt: updatedAt }
  }, updatedAt, true);
}

/** Host-only confirmation of a known local projection; it never grants replay authority. */
export function confirmConversationAgentRunProjectedCompletion(
  run: ConversationAgentRunV1,
  status: 'completed' | 'failed' | 'cancelled',
  updatedAt: IsoTimestamp
): ConversationAgentRunV1 {
  if (!['completed', 'failed', 'cancelled'].includes(status) || run.status !== 'needs_reconciliation') {
    throw new InvalidStateTransitionError('conversation agent run', run.status, status);
  }
  return updateConversationAgentRun(run, {
    status,
    reconciliationAcknowledgement: { kind: 'closed_without_replay', confirmedAt: updatedAt }
  }, updatedAt, true, true);
}

export function transitionConversationAgentRun(
  run: ConversationAgentRunV1,
  status: AgentRunStatus,
  updatedAt: IsoTimestamp
): ConversationAgentRunV1 {
  if (run.status === status) return run;
  if (status === 'needs_reconciliation') {
    throw new InvariantViolationError('conversation agent run reconciliation requires a controlled reason');
  }
  if (!agentRunTransitions[run.status].includes(status)) {
    throw new InvalidStateTransitionError('conversation agent run', run.status, status);
  }
  return updateConversationAgentRun(run, { status }, updatedAt);
}

function updateConversationAgentRun(
  run: ConversationAgentRunV1,
  patch: Partial<Pick<ConversationAgentRunV1, 'responseExecutionId' | 'documentTaskIds' | 'status' | 'reconciliationReason' | 'reconciliationAcknowledgement'>>,
  updatedAt: IsoTimestamp,
  reconciliationAcknowledged = false,
  projectedCompletionConfirmed = false
): ConversationAgentRunV1 {
  const next = parseConversationAgentRun({ ...run, ...patch, revision: run.revision + 1, updatedAt });
  assertConversationAgentRunUpdate(run, next, { reconciliationAcknowledged, projectedCompletionConfirmed });
  return next;
}

const agentRunTransitions: Record<AgentRunStatus, readonly AgentRunStatus[]> = {
  running: ['waiting_user', 'waiting_authorization', 'executing_tool', 'needs_reconciliation', 'completed', 'failed', 'cancelled'],
  waiting_user: ['running', 'needs_reconciliation', 'cancelled', 'failed'],
  waiting_authorization: ['running', 'needs_reconciliation', 'cancelled', 'failed'],
  executing_tool: ['running', 'waiting_user', 'waiting_authorization', 'needs_reconciliation', 'completed', 'failed', 'cancelled'],
  needs_reconciliation: [],
  completed: [],
  failed: [],
  cancelled: []
};

/** Repositories enforce this against the stored version, so object spreads cannot rebind ownership. */
export function assertConversationAgentRunUpdate(
  previous: ConversationAgentRunV1,
  next: ConversationAgentRunV1,
  options: { readonly reconciliationAcknowledged?: boolean; readonly projectedCompletionConfirmed?: boolean } = {}
): void {
  for (const field of ['id', 'projectId', 'conversationId', 'sourceMessageId', 'parentRunId', 'createdAt'] as const) {
    if (previous[field] !== next[field]) throw new InvariantViolationError('conversation agent run identity is immutable');
  }
  if (previous.responseExecutionId !== undefined && previous.responseExecutionId !== next.responseExecutionId) {
    throw new InvariantViolationError('conversation agent run execution binding is immutable');
  }
  const previousTasks = previous.documentTaskIds ?? [];
  const nextTasks = next.documentTaskIds ?? [];
  if (previousTasks.some((id, index) => nextTasks[index] !== id) ||
      (isTerminal(previous.status) || previous.status === 'needs_reconciliation') &&
      JSON.stringify(previousTasks) !== JSON.stringify(nextTasks)) {
    throw new InvariantViolationError('conversation agent run task binding is immutable');
  }
  const acknowledged = options.reconciliationAcknowledged === true && previous.reconciliationAcknowledgement === undefined &&
    next.reconciliationAcknowledgement?.kind === 'closed_without_replay' && next.reconciliationAcknowledgement.confirmedAt === next.updatedAt &&
    previous.responseExecutionId === next.responseExecutionId &&
    (previous.reconciliationReason === undefined || previous.reconciliationReason === next.reconciliationReason) &&
    (previous.status === 'needs_reconciliation' && (next.status === 'cancelled' ||
      options.projectedCompletionConfirmed === true && isTerminal(next.status)) || isTerminal(previous.status) && next.status === previous.status);
  if (!acknowledged && (JSON.stringify(previous.reconciliationAcknowledgement) !== JSON.stringify(next.reconciliationAcknowledgement) ||
      previous.reconciliationReason !== undefined && previous.reconciliationReason !== next.reconciliationReason)) {
    throw new InvariantViolationError('conversation agent run reconciliation facts are immutable');
  }
  if (next.revision !== previous.revision + 1 || next.updatedAt < previous.updatedAt ||
      (isTerminal(previous.status) && !acknowledged) ||
      (previous.status === 'needs_reconciliation' && !acknowledged) ||
      (!acknowledged && next.status !== previous.status && !agentRunTransitions[previous.status].includes(next.status))) {
    throw new InvalidStateTransitionError('conversation agent run', previous.status, next.status);
  }
}

function isTerminal(status: AgentRunStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

export function parseConversationAgentRun(value: unknown): ConversationAgentRunV1 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InvariantViolationError('conversation agent run must be an object');
  }
  const item = value as Record<string, unknown>;
  const allowed = new Set(['schemaVersion', 'id', 'revision', 'projectId', 'conversationId', 'sourceMessageId', 'parentRunId', 'responseExecutionId', 'documentTaskIds', 'reconciliationReason', 'reconciliationAcknowledgement', 'status', 'createdAt', 'updatedAt']);
  if (Object.keys(item).some(key => !allowed.has(key)) || item.schemaVersion !== 1 ||
      !Number.isSafeInteger(item.revision) || Number(item.revision) < 0 ||
      !agentRunStatuses.includes(item.status as AgentRunStatus)) {
    throw new InvariantViolationError('conversation agent run is invalid');
  }
  const createdAt = toIsoTimestamp(String(item.createdAt));
  const updatedAt = toIsoTimestamp(String(item.updatedAt));
  assertTimestampNotBefore(updatedAt, createdAt, 'conversationAgentRun.updatedAt');
  const parentRunId = item.parentRunId === undefined ? undefined : toConversationAgentRunId(String(item.parentRunId));
  const responseExecutionId = item.responseExecutionId === undefined ? undefined : toConversationResponseExecutionId(String(item.responseExecutionId));
  const documentTaskIds = item.documentTaskIds === undefined ? undefined : parseDocumentTaskIds(item.documentTaskIds);
  const reconciliationReason = item.reconciliationReason as AgentRunReconciliationReason | undefined;
  const reconciliationAcknowledgement = parseAcknowledgement(item.reconciliationAcknowledgement, createdAt, updatedAt);
  if ((item.status === 'needs_reconciliation' && (reconciliationReason === undefined || reconciliationAcknowledgement !== undefined)) ||
      (reconciliationReason !== undefined && item.status !== 'needs_reconciliation' && reconciliationAcknowledgement === undefined) ||
      (reconciliationAcknowledgement !== undefined && (!isTerminal(item.status as AgentRunStatus) || reconciliationReason === undefined)) ||
      reconciliationReason !== undefined && !agentRunReconciliationReasons.includes(reconciliationReason)) {
    throw new InvariantViolationError('conversation agent run reconciliation reason is invalid');
  }
  return {
    schemaVersion: 1,
    id: toConversationAgentRunId(String(item.id)),
    revision: Number(item.revision),
    projectId: toProjectId(String(item.projectId)),
    conversationId: toConversationId(String(item.conversationId)),
    sourceMessageId: toMessageId(String(item.sourceMessageId)),
    ...(parentRunId ? { parentRunId } : {}),
    ...(responseExecutionId ? { responseExecutionId } : {}),
    ...(documentTaskIds ? { documentTaskIds } : {}),
    ...(reconciliationReason ? { reconciliationReason } : {}),
    ...(reconciliationAcknowledgement ? { reconciliationAcknowledgement } : {}),
    status: item.status as AgentRunStatus,
    createdAt,
    updatedAt
  };
}

function parseAcknowledgement(value: unknown, createdAt: IsoTimestamp, updatedAt: IsoTimestamp): AgentRunReconciliationAcknowledgement | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new InvariantViolationError('conversation agent run acknowledgement is invalid');
  const item = value as Record<string, unknown>;
  if (Object.keys(item).length !== 2 || item.kind !== 'closed_without_replay' || typeof item.confirmedAt !== 'string') {
    throw new InvariantViolationError('conversation agent run acknowledgement is invalid');
  }
  const confirmedAt = toIsoTimestamp(item.confirmedAt);
  if (confirmedAt < createdAt || confirmedAt > updatedAt) throw new InvariantViolationError('conversation agent run acknowledgement timestamp is invalid');
  return { kind: 'closed_without_replay', confirmedAt };
}

function parseDocumentTaskIds(value: unknown): readonly DocumentTaskRuntimeId[] {
  if (!Array.isArray(value) || value.length > 32 || value.some(id =>
    typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(id)) || new Set(value).size !== value.length) {
    throw new InvariantViolationError('conversation agent run task manifest is invalid');
  }
  return value.map(id => toDocumentTaskRuntimeId(id as string));
}
