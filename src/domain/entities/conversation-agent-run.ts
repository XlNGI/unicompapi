import { InvalidStateTransitionError, InvariantViolationError } from '../errors';
import {
  toConversationAgentRunId,
  toConversationId,
  toConversationResponseExecutionId,
  toMessageId,
  toProjectId,
  type ConversationAgentRunId,
  type ConversationId,
  type ConversationResponseExecutionId,
  type MessageId,
  type ProjectId
} from '../ids';
import { assertTimestampNotBefore, toIsoTimestamp, type IsoTimestamp } from '../timestamps';

export const agentRunStatuses = [
  'running',
  'waiting_user',
  'waiting_authorization',
  'executing_tool',
  'completed',
  'failed',
  'cancelled'
] as const;
export type AgentRunStatus = (typeof agentRunStatuses)[number];

export interface ConversationAgentRunV1 {
  readonly schemaVersion: 1;
  readonly id: ConversationAgentRunId;
  readonly revision: number;
  readonly projectId: ProjectId;
  readonly conversationId: ConversationId;
  readonly sourceMessageId: MessageId;
  readonly parentRunId?: ConversationAgentRunId;
  readonly responseExecutionId?: ConversationResponseExecutionId;
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
  if (run.status !== 'running') {
    throw new InvalidStateTransitionError('conversation agent run', run.status, 'executing_tool');
  }
  return updateConversationAgentRun(run, { responseExecutionId, status: 'executing_tool' }, updatedAt);
}

export function transitionConversationAgentRun(
  run: ConversationAgentRunV1,
  status: AgentRunStatus,
  updatedAt: IsoTimestamp
): ConversationAgentRunV1 {
  if (run.status === status) return run;
  if (!agentRunTransitions[run.status].includes(status)) {
    throw new InvalidStateTransitionError('conversation agent run', run.status, status);
  }
  return updateConversationAgentRun(run, { status }, updatedAt);
}

function updateConversationAgentRun(
  run: ConversationAgentRunV1,
  patch: Partial<Pick<ConversationAgentRunV1, 'responseExecutionId' | 'status'>>,
  updatedAt: IsoTimestamp
): ConversationAgentRunV1 {
  return parseConversationAgentRun({ ...run, ...patch, revision: run.revision + 1, updatedAt });
}

const agentRunTransitions: Record<AgentRunStatus, readonly AgentRunStatus[]> = {
  running: ['waiting_user', 'waiting_authorization', 'executing_tool', 'completed', 'failed', 'cancelled'],
  waiting_user: ['running', 'cancelled', 'failed'],
  waiting_authorization: ['running', 'cancelled', 'failed'],
  executing_tool: ['running', 'waiting_user', 'waiting_authorization', 'completed', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: []
};

export function parseConversationAgentRun(value: unknown): ConversationAgentRunV1 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InvariantViolationError('conversation agent run must be an object');
  }
  const item = value as Record<string, unknown>;
  const allowed = new Set(['schemaVersion', 'id', 'revision', 'projectId', 'conversationId', 'sourceMessageId', 'parentRunId', 'responseExecutionId', 'status', 'createdAt', 'updatedAt']);
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
  return {
    schemaVersion: 1,
    id: toConversationAgentRunId(String(item.id)),
    revision: Number(item.revision),
    projectId: toProjectId(String(item.projectId)),
    conversationId: toConversationId(String(item.conversationId)),
    sourceMessageId: toMessageId(String(item.sourceMessageId)),
    ...(parentRunId ? { parentRunId } : {}),
    ...(responseExecutionId ? { responseExecutionId } : {}),
    status: item.status as AgentRunStatus,
    createdAt,
    updatedAt
  };
}
