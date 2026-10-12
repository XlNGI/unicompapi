import {
  appendTurnExecutionLink,
  createItemV1,
  itemIdKey,
  createTurnV1,
  parseConversation,
  assertThreadUpdate,
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
  type Conversation,
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
    readonly thread?: Partial<Pick<ThreadV1, 'title' | 'status' | 'lastItemId' | 'lastItemSequence' | 'itemCount' | 'turnCount' | 'generation'>>;
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
  readonly eventSystem?: 'agent_runtime' | 'response_execution';
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

  /** Apply Host-validated Conversation changes as one transcript commit. */
  async saveConversation(input: { readonly previous: Conversation; readonly next: Conversation }): Promise<void> {
    const previous = parseConversation(input.previous), next = parseConversation(input.next);
    const threadId = toThreadId(previous.id), thread = await this.repository.getThread(threadId);
    if (!thread || thread.generation !== previous.revision) throw new Error('generation_conflict');
    if (next.id !== previous.id || next.projectId !== previous.projectId || next.projectId !== thread.projectId ||
        next.createdAt !== previous.createdAt || next.revision !== previous.revision + 1 || next.updatedAt < previous.updatedAt ||
        next.messages.length < previous.messages.length || previous.messages.some((message, index) => next.messages[index]?.id !== message.id)) {
      throw new Error('thread_conversation_update_invalid');
    }
    const existingItems = await this.repository.readItems(threadId), turns = [...await this.repository.readTurns(threadId)];
    const items: ItemV1[] = [], changedTurns = new Map<string, TurnV1>();
    const previousMessages = new Map(previous.messages.map(message => [message.id, message]));
    let sequence = thread.lastItemSequence, turnSequence = thread.turnCount, currentTurn: TurnV1 | undefined;
    for (const message of next.messages) {
      const existing = existingItems.find(item => item.itemId.namespace === 'message' && item.itemId.value === message.id);
      if (message.role === 'user') {
        currentTurn = turns.find(turn => turn.userItemId?.namespace === 'message' && turn.userItemId.value === message.id);
        if (!currentTurn && !existing) {
          currentTurn = createTurnV1({ threadId, turnId: toTurnId(`turn-transcript-${sha256Hex(message.id)}`), turnSequence: ++turnSequence,
            userItemId: toMessageItemId(message.id), createdAt: message.createdAt, provenance: 'native' });
          turns.push(currentTurn); changedTurns.set(currentTurn.turnId, currentTurn);
        }
      }
      const prior = previousMessages.get(message.id);
      if (prior && JSON.stringify(prior) === JSON.stringify(message)) continue;
      if (prior && (prior.role !== message.role || prior.createdAt !== message.createdAt || message.revision < prior.revision || message.updatedAt < prior.updatedAt)) {
        throw new Error('thread_message_update_invalid');
      }
      const item = createItemV1({ ...(existing ? updateItemV1(existing, { status: message.state, content: message.content, updatedAt: message.updatedAt }) : {}),
        itemId: toMessageItemId(message.id), threadId, ...(existing?.turnId ?? currentTurn?.turnId ? { turnId: existing?.turnId ?? currentTurn!.turnId } : {}),
        sequence: existing?.sequence ?? ++sequence, type: message.role === 'user' ? 'user_message' : 'assistant_message',
        status: message.state, content: message.content, createdAt: message.createdAt, updatedAt: message.updatedAt,
        messageSource: { messageId: message.id, messageRevision: message.revision },
        legacyMessageSnapshot: message as unknown as Readonly<Record<string, unknown>> });
      items.push(item);
      if (message.role === 'assistant' && item.turnId) {
        const turn = changedTurns.get(item.turnId) ?? turns.find(turn => turn.turnId === item.turnId);
        if (!turn) throw new Error('turn_not_found_for_assistant');
        const updated = updateTurnForAssistant(turn, item);
        changedTurns.set(turn.turnId, updated);
        if (currentTurn?.turnId === updated.turnId) currentTurn = updated;
      }
    }
    const lastItem = items.reduce((latest, item) => !latest || item.sequence >= latest.sequence ? item : latest, existingItems.at(-1));
    const projectedThread = { ...thread, ...(lastItem ? { lastItemId: lastItem.itemId } : {}), title: next.title, status: next.status, generation: thread.generation + 1,
      updatedAt: next.updatedAt, itemCount: Math.max(thread.itemCount, sequence), lastItemSequence: sequence, turnCount: turnSequence };
    assertThreadUpdate(thread, projectedThread);
    const key = `thread-conversation:${threadId}:${previous.revision}:${sha256Hex(JSON.stringify(next))}`;
    const outbox: ThreadProjectionOutboxEventV1[] = items.map(item => projectionEvent(item, `${key}:${item.itemId.value}`, next.updatedAt));
    outbox.push({ schemaVersion: 1, eventType: 'thread_upsert', threadId, thread: projectedThread, sequence,
      eventId: `thread-projection-${sha256Hex(key)}`, idempotencyKey: key, occurredAt: next.updatedAt });
    await this.repository.append({ threadId, idempotencyKey: key, expectedGeneration: previous.revision, occurredAt: next.updatedAt,
      thread: { title: next.title, status: next.status, ...(lastItem ? { lastItemId: lastItem.itemId } : {}) }, turns: [...changedTurns.values()], items, projectionOutbox: outbox });
  }

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
      const item = { ...updateItemV1(existing, { status: input.status, content: input.content, updatedAt: input.updatedAt }),
        ...(input.legacyMessageSnapshot ? { legacyMessageSnapshot: input.legacyMessageSnapshot } : {}) };
      const updatedTurn = updateTurnForAssistant(turn, item);
      if (item.status === existing.status && item.content === existing.content && item.updatedAt === existing.updatedAt &&
        JSON.stringify(item.legacyMessageSnapshot) === JSON.stringify(existing.legacyMessageSnapshot) &&
        JSON.stringify(updatedTurn) === JSON.stringify(turn)) {
        return { thread, item: existing, alreadyCommitted: true };
      }
      const result = await this.repository.append({
        threadId,
        idempotencyKey: `thread-item-update:${threadId}:message:${input.assistantMessageId}:${input.status}:${input.updatedAt}:${sha256Hex(JSON.stringify(item.legacyMessageSnapshot ?? null))}`,
        occurredAt: input.updatedAt,
        expectedGeneration: thread.generation,
        turns: [updatedTurn],
        items: [item],
        projectionOutbox: [projectionEvent(item, `thread-item-update:${threadId}:message:${input.assistantMessageId}:${input.status}:${input.updatedAt}:${sha256Hex(JSON.stringify(item.legacyMessageSnapshot ?? null))}`, input.updatedAt)]
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
      String(item.projectionSource.toolCallId) === input.toolCallId &&
      item.projectionSource.responseExecutionId === input.responseExecutionId &&
      item.projectionSource.agentRunId === input.agentRunId &&
      item.projectionSource.eventSystem === (input.eventSystem ?? 'agent_runtime') &&
      item.projectionSource.sourceIdentity === `${input.toolId}:${input.toolCallId}`
    ));
    if (existing) {
      if (existing.status === input.status && existing.content === input.content && existing.updatedAt === input.updatedAt) return { thread, item: existing, alreadyCommitted: true };
      return this.updateItem({ threadId, itemId: existing.itemId, status: input.status, content: input.content, updatedAt: input.updatedAt });
    }
    const projected = createToolProjectionItem({ ...input, threadId, turnId: turn.turnId, sequence: thread.lastItemSequence + 1 });
    const idempotencyKey = `thread-tool:${threadId}:${input.kind}:${toolProjectionIdentity(input)}`;
    const result = await this.repository.append({
      threadId,
      idempotencyKey,
      occurredAt: input.updatedAt,
      expectedGeneration: thread.generation,
      items: [projected],
      projectionOutbox: [projectionEvent(projected, idempotencyKey, input.updatedAt)]
    });
    if (!result.alreadyCommitted) return { thread: result.thread, item: projected, alreadyCommitted: false };
    const committed = (await this.repository.readItems(threadId)).find(candidate =>
      candidate.type === input.kind && candidate.projectionSource?.toolCallId !== undefined &&
      candidate.itemId.value === projected.itemId.value
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
  const assistantItemIds = turn.assistantItemIds.some(candidate => itemIdKey(candidate) === itemIdKey(item.itemId))
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
    itemId: toProjectionItemId(`item-projection-v1:${toolProjectionIdentity(input)}`),
    threadId: input.threadId,
    turnId: input.turnId,
    sequence: input.sequence,
    type: input.kind,
    status: input.status,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    ...(input.content !== undefined ? { content: input.content } : {}),
    projectionSource: {
      eventSystem: input.eventSystem ?? 'agent_runtime',
      sourceIdentity: `${input.toolId}:${input.toolCallId}`,
      ...(input.responseExecutionId ? { responseExecutionId: toConversationResponseExecutionId(String(input.responseExecutionId)) } : {}),
      ...(input.agentRunId ? { agentRunId: toConversationAgentRunId(String(input.agentRunId)) } : {}),
      toolCallId: toToolCallId(input.toolCallId)
    }
  });
}

function toolProjectionIdentity(input: ProjectToolProjectionInput): string {
  return sha256Hex(JSON.stringify([input.threadId, input.kind, input.eventSystem ?? 'agent_runtime',
    input.responseExecutionId ?? null, input.agentRunId ?? null, input.toolId, input.toolCallId]));
}
