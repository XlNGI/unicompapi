import {
  appendTurnExecutionLink,
  createItemV1,
  updateItemV1,
  updateTurnV1,
  toConversationAgentRunId,
  toConversationResponseExecutionId,
  toProjectionItemId,
  toThreadId,
  toTurnId,
  toMessageItemId,
  toMessageId,
  toToolCallId,
  sha256Hex,
  type ItemStatus,
  type ItemV1,
  type ConversationAgentRunId,
  type ConversationResponseExecutionId,
  type IsoTimestamp,
  type ThreadId,
  type ThreadV1,
  type TurnExecutionLinkV1,
  type TurnId,
  type TurnV1,
  type ThreadProjectionOutboxEventV1
} from '../domain';
import { projectArtifactItem } from './conversation-thread-adapter';

export interface ThreadProjectionRepository {
  getThread(threadId: ThreadId): Promise<ThreadV1 | undefined>;
  readTurns(threadId: ThreadId): Promise<readonly TurnV1[]>;
  readExecutionLinks(threadId: ThreadId): Promise<readonly TurnExecutionLinkV1[]>;
  readItems(threadId: ThreadId): Promise<readonly ItemV1[]>;
  append(input: {
    readonly threadId: ThreadId;
    readonly idempotencyKey: string;
    readonly occurredAt: IsoTimestamp;
    readonly expectedGeneration?: number;
    readonly turns?: readonly TurnV1[];
    readonly items?: readonly ItemV1[];
    readonly executionLinks?: readonly TurnExecutionLinkV1[];
    readonly projectionOutbox?: readonly ThreadProjectionOutboxEventV1[];
  }): Promise<{ readonly thread: ThreadV1; readonly alreadyCommitted: boolean }>;
}

export interface LinkThreadExecutionInput {
  readonly threadId: ThreadId | string;
  readonly turnId: TurnId | string;
  readonly agentRunId: ConversationAgentRunId | string;
  readonly responseExecutionId?: ConversationResponseExecutionId | string;
  readonly sourceMessageId?: string;
  readonly createdAt: IsoTimestamp;
}

export interface ProjectAssistantMessageInput {
  readonly threadId: ThreadId | string;
  readonly sourceMessageId: string;
  readonly assistantMessageId: string;
  readonly messageRevision: number;
  readonly status: ItemStatus;
  readonly content: string;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
  readonly legacyMessageSnapshot?: Readonly<Record<string, unknown>>;
}

export interface UpdateThreadItemInput {
  readonly threadId: ThreadId | string;
  readonly itemId: ItemV1['itemId'];
  readonly status: ItemStatus;
  readonly content?: string;
  readonly updatedAt: IsoTimestamp;
}

export interface ProjectDocumentArtifactInput {
  readonly threadId: ThreadId | string;
  readonly sourceMessageId: string;
  readonly workId: string;
  readonly responseExecutionId?: ConversationResponseExecutionId | string;
  readonly agentRunId?: ConversationAgentRunId | string;
  readonly status: ItemStatus;
  readonly content?: string;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
  readonly legacyMessageSnapshot?: Readonly<Record<string, unknown>>;
}

export interface ProjectToolProjectionInput {
  readonly kind: 'tool_call_projection' | 'tool_result_projection';
  readonly threadId: ThreadId | string;
  readonly sourceMessageId: string;
  readonly toolCallId: string;
  readonly toolId: string;
  readonly status: ItemStatus;
  readonly responseExecutionId?: ConversationResponseExecutionId | string;
  readonly agentRunId?: ConversationAgentRunId | string;
  readonly content?: string;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

/**
 * Persists references to already admitted executions. It never dispatches a
 * Provider or Tool and treats a repeated link as an idempotent projection.
 */
export class ThreadProjectionCoordinator {
  constructor(private readonly repository: ThreadProjectionRepository) {}

  async linkExecution(input: LinkThreadExecutionInput): Promise<{ readonly thread: ThreadV1; readonly link: TurnExecutionLinkV1; readonly alreadyCommitted: boolean }> {
    const threadId = toThreadId(String(input.threadId));
    const turnId = toTurnId(String(input.turnId));
    const agentRunId = toConversationAgentRunId(String(input.agentRunId));
    const responseExecutionId = input.responseExecutionId === undefined
      ? undefined
      : toConversationResponseExecutionId(String(input.responseExecutionId));
    const thread = await this.repository.getThread(threadId);
    if (!thread) throw new Error('thread_not_found');
    const turn = (await this.repository.readTurns(threadId)).find(item => item.turnId === turnId);
    if (!turn) throw new Error('turn_not_found');
    const existing = (await this.repository.readExecutionLinks(threadId)).find(link =>
      link.turnId === turnId && link.agentRunId === agentRunId && link.responseExecutionId === responseExecutionId
    );
    if (existing) return { thread, link: existing, alreadyCommitted: true };
    const link: TurnExecutionLinkV1 = {
      schemaVersion: 1,
      turnId,
      threadId,
      agentRunId,
      ...(responseExecutionId ? { responseExecutionId } : {}),
      ...(input.sourceMessageId ? { sourceMessageId: input.sourceMessageId } : {}),
      linkSequence: turn.executionLinkRevision + 1,
      createdAt: input.createdAt
    };
    const updatedTurn = appendTurnExecutionLink(turn, link);
    const result = await this.repository.append({
      threadId,
      idempotencyKey: `thread-execution-link:${threadId}:${turnId}:${agentRunId}:${responseExecutionId ?? 'pending'}`,
      occurredAt: input.createdAt,
      expectedGeneration: thread.generation,
      turns: [updatedTurn],
      executionLinks: [link]
    });
    return { thread: result.thread, link, alreadyCommitted: result.alreadyCommitted };
  }

  async projectAssistantMessage(input: ProjectAssistantMessageInput): Promise<{ readonly thread: ThreadV1; readonly item: ItemV1; readonly alreadyCommitted: boolean }> {
    const threadId = toThreadId(String(input.threadId));
    const thread = await this.repository.getThread(threadId);
    if (!thread) throw new Error('thread_not_found');
    const existing = latestItem((await this.repository.readItems(threadId)).filter(item =>
      item.itemId.namespace === 'message' && item.itemId.value === input.assistantMessageId &&
      item.messageSource?.messageRevision === input.messageRevision
    ));
    const turns = await this.repository.readTurns(threadId);
    const turn = turns.find(candidate => candidate.userItemId?.namespace === 'message' && candidate.userItemId.value === input.sourceMessageId);
    if (!turn) throw new Error('turn_not_found_for_assistant');
    if (existing) {
      // A terminal Item is immutable with respect to late stream/status
      // events. This prevents a delayed delta from reopening a cancelled or
      // failed response.
      if (isTerminalItemStatus(existing.status) && input.status !== existing.status) {
        return { thread, item: existing, alreadyCommitted: true };
      }
      const item = updateItemV1(existing, { status: input.status, content: input.content, updatedAt: input.updatedAt });
      const updatedTurn = updateTurnForAssistant(turn, item);
      if (item.status === existing.status && item.content === existing.content && item.updatedAt === existing.updatedAt &&
        JSON.stringify(updatedTurn) === JSON.stringify(turn)) {
        return { thread, item: existing, alreadyCommitted: true };
      }
      const result = await this.repository.append({
        threadId,
        idempotencyKey: `thread-item-update:${threadId}:message:${input.assistantMessageId}:${input.status}:${input.updatedAt}`,
        occurredAt: input.updatedAt,
        expectedGeneration: thread.generation,
        turns: [updatedTurn],
        items: [item],
        projectionOutbox: [projectionEvent(item, `thread-item-update:${threadId}:message:${input.assistantMessageId}:${input.status}:${input.updatedAt}`, input.updatedAt)]
      });
      return { thread: result.thread, item, alreadyCommitted: result.alreadyCommitted };
    }
    const item = {
      schemaVersion: 1 as const,
      itemId: toMessageItemId(input.assistantMessageId),
      threadId,
      turnId: turn.turnId,
      sequence: thread.lastItemSequence + 1,
      type: 'assistant_message' as const,
      status: input.status,
      createdAt: input.createdAt,
      updatedAt: input.updatedAt,
      messageSource: { messageId: toMessageId(input.assistantMessageId), messageRevision: input.messageRevision },
      content: input.content,
      ...(input.legacyMessageSnapshot ? { legacyMessageSnapshot: input.legacyMessageSnapshot } : {})
    } satisfies ItemV1;
    const updatedTurn = updateTurnForAssistant(turn, item);
    const result = await this.repository.append({
      threadId,
      idempotencyKey: `thread-assistant:${input.assistantMessageId}:${input.messageRevision}`,
      occurredAt: input.updatedAt,
      expectedGeneration: thread.generation,
      turns: [updatedTurn],
      items: [item],
      projectionOutbox: [projectionEvent(item, `thread-assistant:${input.assistantMessageId}:${input.messageRevision}`, input.updatedAt)]
    });
    if (!result.alreadyCommitted) return { thread: result.thread, item, alreadyCommitted: false };
    const committed = (await this.repository.readItems(threadId)).find(candidate => candidate.itemId.namespace === 'message' && candidate.itemId.value === input.assistantMessageId && candidate.messageSource?.messageRevision === input.messageRevision);
    if (!committed) throw new Error('thread_assistant_idempotency_record_missing');
    return { thread: result.thread, item: committed, alreadyCommitted: true };
  }

  async projectDocumentArtifact(input: ProjectDocumentArtifactInput): Promise<{ readonly thread: ThreadV1; readonly item: ItemV1; readonly alreadyCommitted: boolean }> {
    const threadId = toThreadId(String(input.threadId));
    const thread = await this.repository.getThread(threadId);
    if (!thread) throw new Error('thread_not_found');
    const turns = await this.repository.readTurns(threadId);
    const turn = turns.find(candidate => candidate.userItemId?.namespace === 'message' && candidate.userItemId.value === input.sourceMessageId);
    if (!turn) throw new Error('turn_not_found_for_artifact');
    const existing = latestItem((await this.repository.readItems(threadId)).filter(item =>
      item.type === 'document_artifact_projection' && item.projectionSource?.workId !== undefined && String(item.projectionSource.workId) === String(input.workId)
    ));
    if (existing) {
      if (existing.status === input.status && existing.content === input.content && existing.updatedAt === input.updatedAt) return { thread, item: existing, alreadyCommitted: true };
      return this.updateItem({ threadId, itemId: existing.itemId, status: input.status, content: input.content, updatedAt: input.updatedAt });
    }
    const item = projectArtifactItem({
      threadId,
      turnId: turn.turnId,
      sequence: thread.lastItemSequence + 1,
      status: input.status,
      ...(input.content !== undefined ? { content: input.content } : {}),
      createdAt: input.createdAt,
      updatedAt: input.updatedAt,
      sourceIdentity: `work:${input.workId}`,
      ...(input.responseExecutionId ? { responseExecutionId: input.responseExecutionId } : {}),
      ...(input.agentRunId ? { agentRunId: input.agentRunId } : {}),
      ...(input.legacyMessageSnapshot ? { legacyMessageSnapshot: input.legacyMessageSnapshot } : {}),
      workId: input.workId
    });
    const result = await this.repository.append({
      threadId,
      idempotencyKey: `thread-artifact:${threadId}:${input.workId}`,
      occurredAt: input.updatedAt,
      expectedGeneration: thread.generation,
      items: [item],
      projectionOutbox: [projectionEvent(item, `thread-artifact:${threadId}:${input.workId}`, input.updatedAt)]
    });
    if (!result.alreadyCommitted) return { thread: result.thread, item, alreadyCommitted: false };
    const committed = (await this.repository.readItems(threadId)).find(candidate =>
      candidate.type === 'document_artifact_projection' && candidate.projectionSource?.workId !== undefined && String(candidate.projectionSource.workId) === String(input.workId)
    );
    if (!committed) throw new Error('thread_artifact_idempotency_record_missing');
    return { thread: result.thread, item: committed, alreadyCommitted: true };
  }

  async projectTool(input: ProjectToolProjectionInput): Promise<{ readonly thread: ThreadV1; readonly item: ItemV1; readonly alreadyCommitted: boolean }> {
    const threadId = toThreadId(String(input.threadId));
    const thread = await this.repository.getThread(threadId);
    if (!thread) throw new Error('thread_not_found');
    const turns = await this.repository.readTurns(threadId);
    const turn = turns.find(candidate => candidate.userItemId?.namespace === 'message' && candidate.userItemId.value === input.sourceMessageId);
    if (!turn) throw new Error('turn_not_found_for_tool_projection');
    const existing = latestItem((await this.repository.readItems(threadId)).filter(item =>
      item.type === input.kind && item.projectionSource?.toolCallId !== undefined &&
      String(item.projectionSource.toolCallId) === input.toolCallId
    ));
    if (existing) {
      if (existing.status === input.status && existing.content === input.content && existing.updatedAt === input.updatedAt) return { thread, item: existing, alreadyCommitted: true };
      return this.updateItem({ threadId, itemId: existing.itemId, status: input.status, content: input.content, updatedAt: input.updatedAt });
    }
    const projected = createToolProjectionItem({ ...input, threadId, turnId: turn.turnId, sequence: thread.lastItemSequence + 1 });
    const result = await this.repository.append({
      threadId,
      idempotencyKey: `thread-tool:${threadId}:${input.kind}:${input.toolCallId}`,
      occurredAt: input.updatedAt,
      expectedGeneration: thread.generation,
      items: [projected],
      projectionOutbox: [projectionEvent(projected, `thread-tool:${threadId}:${input.kind}:${input.toolCallId}`, input.updatedAt)]
    });
    if (!result.alreadyCommitted) return { thread: result.thread, item: projected, alreadyCommitted: false };
    const committed = (await this.repository.readItems(threadId)).find(candidate =>
      candidate.type === input.kind && candidate.projectionSource?.toolCallId !== undefined &&
      String(candidate.projectionSource.toolCallId) === input.toolCallId
    );
    if (!committed) throw new Error('thread_tool_idempotency_record_missing');
    return { thread: result.thread, item: committed, alreadyCommitted: true };
  }

  private async updateItem(input: UpdateThreadItemInput): Promise<{ readonly thread: ThreadV1; readonly item: ItemV1; readonly alreadyCommitted: boolean }> {
    const threadId = toThreadId(String(input.threadId));
    const thread = await this.repository.getThread(threadId);
    if (!thread) throw new Error('thread_not_found');
    const current = latestItem((await this.repository.readItems(threadId)).filter(item => item.itemId.namespace === input.itemId.namespace && item.itemId.value === input.itemId.value));
    if (!current) throw new Error('thread_item_not_found');
    if (isTerminalItemStatus(current.status) && input.status !== current.status) {
      return { thread, item: current, alreadyCommitted: true };
    }
    const next = updateItemV1(current, { status: input.status, updatedAt: input.updatedAt, ...(input.content !== undefined ? { content: input.content } : {}) });
    const result = await this.repository.append({
      threadId,
      idempotencyKey: `thread-item-update:${threadId}:${input.itemId.namespace}:${input.itemId.value}:${input.status}:${input.updatedAt}`,
      occurredAt: input.updatedAt,
      expectedGeneration: thread.generation,
      items: [next],
      projectionOutbox: [projectionEvent(next, `thread-item-update:${threadId}:${input.itemId.namespace}:${input.itemId.value}:${input.status}:${input.updatedAt}`, input.updatedAt)]
    });
    return { thread: result.thread, item: next, alreadyCommitted: result.alreadyCommitted };
  }
}

function isTerminalItemStatus(status: ItemStatus): boolean {
  return ['completed', 'failed', 'cancelled', 'interrupted', 'unknown'].includes(status);
}

function latestItem(items: readonly ItemV1[]): ItemV1 | undefined {
  return [...items].sort((left, right) => left.updatedAt.localeCompare(right.updatedAt) || left.sequence - right.sequence).at(-1);
}

function updateTurnForAssistant(turn: TurnV1, item: ItemV1): TurnV1 {
  const assistantItemIds = turn.assistantItemIds.some(candidate => String(candidate) === String(item.itemId))
    ? turn.assistantItemIds
    : [...turn.assistantItemIds, item.itemId];
  const status = item.status === 'completed' ? 'completed'
    : item.status === 'failed' ? 'failed'
      : item.status === 'cancelled' ? 'cancelled'
        : item.status === 'interrupted' ? 'interrupted'
          : item.status === 'unknown' ? 'unknown' : turn.status;
  if (isTerminalTurnStatus(turn.status) && status !== turn.status) return updateTurnV1(turn, { assistantItemIds });
  return updateTurnV1(turn, {
    assistantItemIds,
    status,
    ...(isTerminalTurnStatus(status) ? { completedAt: item.updatedAt } : {})
  });
}

function isTerminalTurnStatus(status: TurnV1['status']): boolean {
  return ['completed', 'failed', 'cancelled', 'interrupted', 'unknown'].includes(status);
}

function projectionEvent(item: ItemV1, idempotencyKey: string, occurredAt: IsoTimestamp): ThreadProjectionOutboxEventV1 {
  return {
    schemaVersion: 1,
    eventId: `thread-projection-${sha256Hex(JSON.stringify([item.threadId, item.itemId, idempotencyKey]))}`,
    threadId: item.threadId,
    eventType: 'item_upsert',
    sequence: item.sequence,
    idempotencyKey,
    item,
    occurredAt
  };
}

function createToolProjectionItem(input: ProjectToolProjectionInput & { readonly threadId: ThreadId; readonly turnId: TurnId; readonly sequence: number }): ItemV1 {
  return createItemV1({
    itemId: toProjectionItemId(`item-projection-v1:${sha256Hex(JSON.stringify([input.threadId, input.kind, input.toolId, input.toolCallId]))}`),
    threadId: input.threadId,
    turnId: input.turnId,
    sequence: input.sequence,
    type: input.kind,
    status: input.status,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    ...(input.content !== undefined ? { content: input.content } : {}),
    projectionSource: {
      eventSystem: 'agent_runtime',
      sourceIdentity: `${input.toolId}:${input.toolCallId}`,
      ...(input.responseExecutionId ? { responseExecutionId: toConversationResponseExecutionId(String(input.responseExecutionId)) } : {}),
      ...(input.agentRunId ? { agentRunId: toConversationAgentRunId(String(input.agentRunId)) } : {}),
      toolCallId: toToolCallId(input.toolCallId)
    }
  });
}
