import type {
  Conversation,
  ConversationResponseExecutionId,
  ItemId,
  ItemProjectionSourceV1,
  ItemStatus,
  ItemType,
  ItemV1,
  ThreadId,
  ThreadV1,
  TurnExecutionLinkV1,
  TurnId,
  TurnV1,
  WorkId
} from '../domain';
import {
  appendTurnExecutionLink,
  createItemV1,
  createThreadV1,
  createTurnV1,
  itemIdKey,
  toConversationResponseExecutionId,
  toConversationAgentRunId,
  itemStatuses,
  toMessageItemId,
  toProjectionItemId,
  toThreadId,
  toTurnId,
  toToolCallId,
  toWorkId,
  sha256Hex,
  type ConversationAgentRunId,
  type IsoTimestamp,
  type MessageId,
  type ProjectId,
  type ToolCallId
} from '../domain';

export interface ConversationThreadProjection {
  readonly thread: ThreadV1;
  readonly turns: readonly TurnV1[];
  readonly items: readonly ItemV1[];
  readonly executionLinks: readonly TurnExecutionLinkV1[];
}

export interface ConversationExecutionLinkInput {
  readonly agentRunId: ConversationAgentRunId;
  readonly responseExecutionId?: ConversationResponseExecutionId;
  readonly sourceMessageId?: MessageId;
  readonly createdAt: IsoTimestamp;
}

export interface ToolDisplayProjectionInput {
  readonly kind: 'tool_call_projection' | 'tool_result_projection';
  readonly threadId: ThreadId;
  readonly turnId?: TurnId;
  readonly sequence: number;
  readonly status: ItemStatus;
  readonly content?: string;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
  readonly eventSystem: 'response_execution' | 'agent_runtime' | 'production_trace';
  readonly sourceIdentity: string;
  readonly responseExecutionId?: ConversationResponseExecutionId | string;
  readonly agentRunId?: ConversationAgentRunId | string;
  readonly toolCallId: ToolCallId | string;
}

export interface ArtifactDisplayProjectionInput {
  readonly threadId: ThreadId;
  readonly turnId?: TurnId;
  readonly sequence: number;
  readonly status: ItemStatus;
  readonly content?: string;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
  readonly sourceIdentity: string;
  readonly responseExecutionId?: ConversationResponseExecutionId | string;
  readonly agentRunId?: ConversationAgentRunId | string;
  readonly workId: WorkId | string;
}

export function conversationToThreadProjection(
  conversation: Conversation,
  options: { readonly projectId?: ProjectId | null; readonly executionLinks?: readonly ConversationExecutionLinkInput[] } = {}
): ConversationThreadProjection {
  const threadId = toThreadId(conversation.id);
  const items: ItemV1[] = [];
  const turns: TurnV1[] = [];
  const turnById = new Map<string, TurnV1>();
  let currentTurn: TurnV1 | undefined;
  let turnSequence = 0;
  conversation.messages.forEach((message, index) => {
    if (message.role === 'user') {
      const turnId = legacyTurnId(threadId, message.id);
      const itemId = toMessageItemId(message.id);
      currentTurn = createTurnV1({ turnId, threadId, turnSequence: ++turnSequence, createdAt: message.createdAt, userItemId: itemId, provenance: 'legacy_inferred' });
      turnById.set(turnId, currentTurn);
      turns.push(currentTurn);
    }
    const turnId = currentTurn?.turnId;
    const item = createItemV1({
      itemId: toMessageItemId(message.id),
      threadId,
      ...(turnId ? { turnId } : {}),
      sequence: index + 1,
      type: message.role === 'user' ? 'user_message' : 'assistant_message',
      status: itemStatus(message.state),
      createdAt: message.createdAt,
      updatedAt: message.updatedAt,
      messageSource: { messageId: message.id, messageRevision: message.revision },
      content: message.content
    });
    items.push(item);
    if (message.role === 'assistant' && currentTurn) {
      const terminalAt = 'completedAt' in message ? message.completedAt : 'failedAt' in message ? message.failedAt : 'cancelledAt' in message ? message.cancelledAt : undefined;
      const updatedTurn = updateTurnWithAssistant(currentTurn, item.itemId, message.state, terminalAt);
      currentTurn = updatedTurn;
      turnById.set(updatedTurn.turnId, updatedTurn);
      turns[turns.length - 1] = updatedTurn;
    }
  });

  const executionLinks: TurnExecutionLinkV1[] = [];
  for (const input of options.executionLinks ?? []) {
    const sourceTurn = input.sourceMessageId
      ? turns.find(turn => turn.userItemId?.namespace === 'message' && turn.userItemId.value === input.sourceMessageId)
      : undefined;
    if (!sourceTurn) continue;
    const link: TurnExecutionLinkV1 = {
      schemaVersion: 1,
      turnId: sourceTurn.turnId,
      threadId,
      agentRunId: input.agentRunId,
      ...(input.responseExecutionId ? { responseExecutionId: input.responseExecutionId } : {}),
      ...(input.sourceMessageId ? { sourceMessageId: input.sourceMessageId } : {}),
      linkSequence: sourceTurn.executionLinkRevision + 1,
      createdAt: input.createdAt
    };
    const current = turnById.get(sourceTurn.turnId)!;
    const next = appendTurnExecutionLink(current, link);
    turnById.set(next.turnId, next);
    turns[turns.findIndex(turn => turn.turnId === next.turnId)] = next;
    executionLinks.push(link);
  }

  const last = items.at(-1);
  const thread = createThreadV1({ threadId, projectId: options.projectId ?? conversation.projectId, title: conversation.title, createdAt: conversation.createdAt });
  return {
    thread: { ...thread, status: conversation.status, updatedAt: conversation.updatedAt, lastItemId: last?.itemId, lastItemSequence: last?.sequence ?? 0, itemCount: items.length, turnCount: turns.length, generation: conversation.revision },
    turns,
    items,
    executionLinks
  };
}

export function projectToolCallItem(input: ToolDisplayProjectionInput): ItemV1 {
  return createProjectionItem({ ...input, type: input.kind, toolCallId: input.toolCallId });
}

export function projectArtifactItem(input: ArtifactDisplayProjectionInput): ItemV1 {
  return createProjectionItem({ ...input, type: 'document_artifact_projection', eventSystem: 'work_repository', workId: input.workId });
}

export function projectDisplayItems(inputs: readonly (ToolDisplayProjectionInput | ArtifactDisplayProjectionInput)[]): readonly ItemV1[] {
  const byId = new Map<string, ItemV1>();
  for (const input of inputs) {
    const item = 'kind' in input ? projectToolCallItem(input) : projectArtifactItem(input);
    const key = itemIdKey(item.itemId);
    const previous = byId.get(key);
    if (previous && previous.threadId !== item.threadId) throw new Error('Projection identity crossed Thread boundary');
    // A replay or later status event updates one projection identity; it never appends another Item.
    byId.set(key, previous && previous.updatedAt > item.updatedAt ? previous : item);
  }
  return [...byId.values()].sort((left, right) => left.sequence - right.sequence || itemIdKey(left.itemId).localeCompare(itemIdKey(right.itemId)));
}

export function appendDisplayItems(projection: ConversationThreadProjection, displayItems: readonly ItemV1[]): ConversationThreadProjection {
  const ids = new Set(projection.items.map(item => itemIdKey(item.itemId)));
  const additions = new Map<string, ItemV1>();
  for (const item of displayItems) {
    if (item.threadId !== projection.thread.threadId) throw new Error('Projection Item belongs to another Thread');
    const key = itemIdKey(item.itemId);
    if (ids.has(key)) continue;
    ids.add(key);
    const previous = additions.get(key);
    if (!previous || previous.updatedAt <= item.updatedAt) additions.set(key, item);
  }
  const items = [...projection.items, ...additions.values()].sort((left, right) => left.sequence - right.sequence);
  const last = items.at(-1);
  return { ...projection, items, thread: { ...projection.thread, lastItemId: last?.itemId, lastItemSequence: last?.sequence ?? projection.thread.lastItemSequence, itemCount: items.length } };
}

/** Disabled by default: this is a read-only shadow projection and never owns writes or execution. */
export class ConversationThreadShadowProjector {
  constructor(private readonly enabled = false) {}
  project(conversation: Conversation, options?: { readonly projectId?: ProjectId | null; readonly executionLinks?: readonly ConversationExecutionLinkInput[] }): ConversationThreadProjection | undefined {
    return this.enabled ? conversationToThreadProjection(conversation, options) : undefined;
  }
}

function createProjectionItem(input: {
  readonly type: ItemType;
  readonly threadId: ThreadId;
  readonly turnId?: TurnId;
  readonly sequence: number;
  readonly status: ItemStatus;
  readonly content?: string;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
  readonly eventSystem: ItemProjectionSourceV1['eventSystem'];
  readonly sourceIdentity: string;
  readonly responseExecutionId?: ConversationResponseExecutionId | string;
  readonly agentRunId?: ConversationAgentRunId | string;
  readonly toolCallId?: ToolCallId | string;
  readonly workId?: WorkId | string;
}): ItemV1 {
  const identity = `item-projection-v1:${sha256Hex(JSON.stringify([input.threadId, input.type, input.eventSystem, input.sourceIdentity]))}`;
  return createItemV1({ itemId: toProjectionItemId(identity), threadId: input.threadId, ...(input.turnId ? { turnId: input.turnId } : {}), sequence: input.sequence, type: input.type, status: input.status, createdAt: input.createdAt, updatedAt: input.updatedAt, ...(input.content !== undefined ? { content: input.content } : {}), projectionSource: { eventSystem: input.eventSystem, sourceIdentity: input.sourceIdentity, ...(input.responseExecutionId ? { responseExecutionId: toConversationResponseExecutionId(String(input.responseExecutionId)) } : {}), ...(input.agentRunId ? { agentRunId: toConversationAgentRunId(String(input.agentRunId)) } : {}), ...(input.toolCallId ? { toolCallId: toToolCallId(String(input.toolCallId)) } : {}), ...(input.workId ? { workId: toWorkId(String(input.workId)) } : {}) } });
}

function updateTurnWithAssistant(turn: TurnV1, itemId: ItemId, messageState: string, completedAt?: IsoTimestamp): TurnV1 {
  const status: TurnV1['status'] = messageState === 'failed' ? 'failed' : messageState === 'cancelled' ? 'cancelled' : messageState === 'completed' ? 'completed' : 'open';
  return { ...turn, status, ...(completedAt ? { completedAt } : {}), assistantItemIds: [...turn.assistantItemIds, itemId] };
}
function itemStatus(value: string): ItemStatus { return (itemStatuses as readonly string[]).includes(value) ? value as ItemStatus : 'unknown'; }
function legacyTurnId(threadId: ThreadId, messageId: MessageId): TurnId { return toTurnId(`turn-legacy-v1-${sha256Hex(JSON.stringify([threadId, messageId]))}`); }
