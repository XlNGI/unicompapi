import { InvariantViolationError, InvalidStateTransitionError } from '../errors';
import {
  itemIdKey,
  toConversationAgentRunId,
  toConversationResponseExecutionId,
  toItemId,
  toMessageId,
  toProjectId,
  toThreadId,
  toTurnId,
  toToolCallId,
  toWorkId,
  type ConversationAgentRunId,
  type ConversationResponseExecutionId,
  type ItemId,
  type MessageId,
  type ProjectId,
  type ThreadId,
  type ToolCallId,
  type TurnId,
  type WorkId
} from '../ids';
import { toIsoTimestamp, type IsoTimestamp } from '../timestamps';

export const threadStatuses = ['active', 'archived', 'deleted'] as const;
export type ThreadStatus = (typeof threadStatuses)[number];
export const turnStatuses = ['open', 'completed', 'failed', 'cancelled', 'interrupted', 'unknown'] as const;
export type TurnStatus = (typeof turnStatuses)[number];
export const itemTypes = ['user_message', 'assistant_message', 'tool_call_projection', 'tool_result_projection', 'document_artifact_projection'] as const;
export type ItemType = (typeof itemTypes)[number];
export const itemStatuses = ['pending', 'streaming', 'completed', 'failed', 'cancelled', 'interrupted', 'unknown'] as const;
export type ItemStatus = (typeof itemStatuses)[number];

export interface ThreadV1 {
  readonly schemaVersion: 1;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId | null;
  readonly title: string;
  readonly status: ThreadStatus;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
  readonly lastItemId?: ItemId;
  readonly lastItemSequence: number;
  readonly itemCount: number;
  readonly turnCount: number;
  readonly generation: number;
}

export interface TurnV1 {
  readonly schemaVersion: 1;
  readonly turnId: TurnId;
  readonly threadId: ThreadId;
  readonly turnSequence: number;
  readonly status: TurnStatus;
  readonly createdAt: IsoTimestamp;
  readonly completedAt?: IsoTimestamp;
  readonly userItemId?: ItemId;
  readonly assistantItemIds: readonly ItemId[];
  readonly provenance: 'native' | 'legacy_inferred';
  readonly executionLinkRevision: number;
}

export interface ItemBodyRefV1 {
  readonly segmentId: string;
  readonly offset: number;
  readonly length: number;
  readonly sha256: string;
}

export interface ItemProjectionSourceV1 {
  readonly eventSystem: 'response_execution' | 'agent_runtime' | 'production_trace' | 'work_repository';
  readonly sourceIdentity: string;
  readonly responseExecutionId?: ConversationResponseExecutionId;
  readonly agentRunId?: ConversationAgentRunId;
  readonly toolCallId?: ToolCallId;
  readonly workId?: WorkId;
}

/** Exact legacy Message payload retained as an opaque, versioned snapshot. */
export type LegacyMessageSnapshotV1 = Readonly<Record<string, unknown>>;

export interface ItemV1 {
  readonly schemaVersion: 1;
  readonly itemId: ItemId;
  readonly threadId: ThreadId;
  readonly turnId?: TurnId;
  readonly sequence: number;
  readonly type: ItemType;
  readonly status: ItemStatus;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
  readonly messageSource?: { readonly messageId: MessageId; readonly messageRevision: number };
  readonly legacyMessageSnapshot?: LegacyMessageSnapshotV1;
  readonly content?: string;
  readonly bodyRef?: ItemBodyRefV1;
  readonly projectionSource?: ItemProjectionSourceV1;
}

export interface TurnExecutionLinkV1 {
  readonly schemaVersion: 1;
  readonly turnId: TurnId;
  readonly threadId: ThreadId;
  readonly agentRunId: ConversationAgentRunId;
  readonly responseExecutionId?: ConversationResponseExecutionId;
  readonly sourceMessageId?: string;
  readonly linkSequence: number;
  readonly createdAt: IsoTimestamp;
}

export function createThreadV1(input: { readonly threadId: ThreadId; readonly projectId: ProjectId | null; readonly title: string; readonly createdAt: IsoTimestamp }): ThreadV1 {
  const title = input.title.trim();
  if (!title) throw new InvariantViolationError('Thread title cannot be empty');
  return { schemaVersion: 1, threadId: input.threadId, projectId: input.projectId, title, status: 'active', createdAt: input.createdAt, updatedAt: input.createdAt, lastItemSequence: 0, itemCount: 0, turnCount: 0, generation: 0 };
}

export function updateThreadV1(previous: ThreadV1, patch: Partial<Pick<ThreadV1, 'title' | 'status' | 'lastItemId' | 'lastItemSequence' | 'itemCount' | 'turnCount' | 'generation'>>, updatedAt: IsoTimestamp): ThreadV1 {
  const next = { ...previous, ...patch, ...(patch.title !== undefined ? { title: patch.title.trim() } : {}), updatedAt };
  assertThreadUpdate(previous, next);
  return next;
}

export function assertThreadUpdate(previous: ThreadV1, next: ThreadV1): void {
  if (previous.threadId !== next.threadId || previous.projectId !== next.projectId || previous.createdAt !== next.createdAt) throw new InvariantViolationError('Thread identity and ownership are immutable');
  if (!next.title.trim() || next.updatedAt < previous.updatedAt || next.generation < previous.generation || next.itemCount < previous.itemCount || next.turnCount < previous.turnCount || next.lastItemSequence < previous.lastItemSequence) throw new InvariantViolationError('Thread counters or timestamp regressed');
  if (previous.status === 'deleted' && next.status !== 'deleted') throw new InvalidStateTransitionError('thread', previous.status, next.status);
  if (previous.status === 'archived' && next.status === 'active') return;
  if (previous.status !== next.status && previous.status === 'active' && !['archived', 'deleted'].includes(next.status)) throw new InvalidStateTransitionError('thread', previous.status, next.status);
}

export function createTurnV1(input: { readonly turnId: TurnId; readonly threadId: ThreadId; readonly turnSequence: number; readonly createdAt: IsoTimestamp; readonly userItemId?: ItemId; readonly provenance: 'native' | 'legacy_inferred' }): TurnV1 {
  positiveInteger(input.turnSequence, 'turnSequence');
  return { schemaVersion: 1, turnId: input.turnId, threadId: input.threadId, turnSequence: input.turnSequence, status: 'open', createdAt: input.createdAt, ...(input.userItemId ? { userItemId: input.userItemId } : {}), assistantItemIds: [], provenance: input.provenance, executionLinkRevision: 0 };
}

export function updateTurnV1(previous: TurnV1, patch: Partial<Pick<TurnV1, 'status' | 'completedAt' | 'userItemId' | 'assistantItemIds' | 'executionLinkRevision'>>): TurnV1 {
  const next = { ...previous, ...patch };
  if (next.threadId !== previous.threadId || next.turnId !== previous.turnId || next.turnSequence !== previous.turnSequence || next.provenance !== previous.provenance || next.createdAt !== previous.createdAt) throw new InvariantViolationError('Turn identity is immutable');
  if (next.executionLinkRevision < previous.executionLinkRevision || next.assistantItemIds.length < previous.assistantItemIds.length) throw new InvariantViolationError('Turn links or assistant Items cannot be removed');
  if (previous.status !== next.status && !allowedTurnTransitions[previous.status].includes(next.status)) throw new InvalidStateTransitionError('turn', previous.status, next.status);
  if (next.completedAt && next.completedAt < previous.createdAt) throw new InvariantViolationError('Turn completedAt precedes createdAt');
  return next;
}

const allowedTurnTransitions: Readonly<Record<TurnStatus, readonly TurnStatus[]>> = { open: ['completed', 'failed', 'cancelled', 'interrupted', 'unknown'], completed: [], failed: [], cancelled: [], interrupted: [], unknown: [] };

export function appendTurnExecutionLink(previous: TurnV1, link: TurnExecutionLinkV1): TurnV1 {
  if (link.threadId !== previous.threadId || link.turnId !== previous.turnId) throw new InvariantViolationError('Execution link scope does not match Turn');
  if (link.linkSequence !== previous.executionLinkRevision + 1) throw new InvariantViolationError('Execution link sequence is not append-only');
  return updateTurnV1(previous, { executionLinkRevision: link.linkSequence });
}

export function createItemV1(input: Omit<ItemV1, 'schemaVersion'>): ItemV1 {
  positiveInteger(input.sequence, 'item sequence');
  if (input.updatedAt < input.createdAt) throw new InvariantViolationError('Item updatedAt precedes createdAt');
  if (input.type === 'user_message' || input.type === 'assistant_message') {
    if (input.itemId.namespace !== 'message' || !input.messageSource) throw new InvariantViolationError('Message Item requires original MessageId source');
  } else if (input.itemId.namespace !== 'projection' || !input.projectionSource) throw new InvariantViolationError('Projection Item requires projection source');
  return { schemaVersion: 1, ...input };
}

export function updateItemV1(previous: ItemV1, patch: Partial<Pick<ItemV1, 'status' | 'content' | 'updatedAt' | 'bodyRef'>>): ItemV1 {
  const next = { ...previous, ...patch };
  if (next.itemId.namespace !== previous.itemId.namespace || itemIdKey(next.itemId) !== itemIdKey(previous.itemId) || next.threadId !== previous.threadId || next.sequence !== previous.sequence) throw new InvariantViolationError('Item identity and ordering are immutable');
  if (next.updatedAt < previous.updatedAt || (next.status !== previous.status && !allowedItemTransitions[previous.status].includes(next.status))) throw new InvalidStateTransitionError('item', previous.status, next.status);
  return next;
}

const allowedItemTransitions: Readonly<Record<ItemStatus, readonly ItemStatus[]>> = { pending: ['streaming', 'completed', 'failed', 'cancelled', 'interrupted', 'unknown'], streaming: ['completed', 'failed', 'cancelled', 'interrupted', 'unknown'], completed: [], failed: [], cancelled: [], interrupted: [], unknown: [] };

export function parseThreadV1(value: unknown): ThreadV1 {
  const item = exactRecord(value, ['schemaVersion', 'threadId', 'projectId', 'title', 'status', 'createdAt', 'updatedAt', 'lastItemSequence', 'itemCount', 'turnCount', 'generation'], ['lastItemId']);
  if (item.schemaVersion !== 1) throw new TypeError('Unsupported Thread schema');
  return { schemaVersion: 1, threadId: toThreadId(stringValue(item.threadId, 'threadId')), projectId: item.projectId === null ? null : toProjectId(stringValue(item.projectId, 'projectId')), title: nonEmpty(item.title, 'title'), status: choice(item.status, threadStatuses), createdAt: timestamp(item.createdAt), updatedAt: timestamp(item.updatedAt), ...(item.lastItemId !== undefined ? { lastItemId: toItemId(item.lastItemId) } : {}), lastItemSequence: positiveOrZero(item.lastItemSequence, 'lastItemSequence'), itemCount: positiveOrZero(item.itemCount, 'itemCount'), turnCount: positiveOrZero(item.turnCount, 'turnCount'), generation: positiveOrZero(item.generation, 'generation') };
}

export function parseTurnV1(value: unknown): TurnV1 {
  const item = exactRecord(value, ['schemaVersion', 'turnId', 'threadId', 'turnSequence', 'status', 'createdAt', 'assistantItemIds', 'provenance', 'executionLinkRevision'], ['completedAt', 'userItemId']);
  if (item.schemaVersion !== 1) throw new TypeError('Unsupported Turn schema');
  const assistantItemIds = array(item.assistantItemIds).map(toItemId);
  unique(assistantItemIds.map(itemIdKey));
  return { schemaVersion: 1, turnId: toTurnId(stringValue(item.turnId, 'turnId')), threadId: toThreadId(stringValue(item.threadId, 'threadId')), turnSequence: positiveInteger(item.turnSequence, 'turnSequence'), status: choice(item.status, turnStatuses), createdAt: timestamp(item.createdAt), ...(item.completedAt !== undefined ? { completedAt: timestamp(item.completedAt) } : {}), ...(item.userItemId !== undefined ? { userItemId: toItemId(item.userItemId) } : {}), assistantItemIds, provenance: choice(item.provenance, ['native', 'legacy_inferred'] as const), executionLinkRevision: positiveOrZero(item.executionLinkRevision, 'executionLinkRevision') };
}

export function parseItemV1(value: unknown): ItemV1 {
  const item = exactRecord(value, ['schemaVersion', 'itemId', 'threadId', 'sequence', 'type', 'status', 'createdAt', 'updatedAt'], ['turnId', 'messageSource', 'legacyMessageSnapshot', 'content', 'bodyRef', 'projectionSource']);
  if (item.schemaVersion !== 1) throw new TypeError('Unsupported Item schema');
  const messageSource = item.messageSource === undefined ? undefined : parseMessageSource(item.messageSource);
  const projectionSource = item.projectionSource === undefined ? undefined : parseProjectionSource(item.projectionSource);
  const legacyMessageSnapshot = item.legacyMessageSnapshot === undefined ? undefined : record(item.legacyMessageSnapshot, 'legacyMessageSnapshot');
  return createItemV1({ itemId: toItemId(item.itemId), threadId: toThreadId(stringValue(item.threadId, 'threadId')), ...(item.turnId !== undefined ? { turnId: toTurnId(stringValue(item.turnId, 'turnId')) } : {}), sequence: positiveInteger(item.sequence, 'item sequence'), type: choice(item.type, itemTypes), status: choice(item.status, itemStatuses), createdAt: timestamp(item.createdAt), updatedAt: timestamp(item.updatedAt), ...(messageSource ? { messageSource } : {}), ...(legacyMessageSnapshot ? { legacyMessageSnapshot } : {}), ...(item.content !== undefined ? { content: stringValue(item.content, 'content') } : {}), ...(item.bodyRef !== undefined ? { bodyRef: parseBodyRef(item.bodyRef) } : {}), ...(projectionSource ? { projectionSource } : {}) });
}

export function parseTurnExecutionLinkV1(value: unknown): TurnExecutionLinkV1 {
  const item = exactRecord(value, ['schemaVersion', 'turnId', 'threadId', 'agentRunId', 'linkSequence', 'createdAt'], ['responseExecutionId', 'sourceMessageId']);
  if (item.schemaVersion !== 1) throw new TypeError('Unsupported TurnExecutionLink schema');
  return { schemaVersion: 1, turnId: toTurnId(stringValue(item.turnId, 'turnId')), threadId: toThreadId(stringValue(item.threadId, 'threadId')), agentRunId: toConversationAgentRunId(stringValue(item.agentRunId, 'agentRunId')), ...(item.responseExecutionId !== undefined ? { responseExecutionId: toConversationResponseExecutionId(stringValue(item.responseExecutionId, 'responseExecutionId')) } : {}), ...(item.sourceMessageId !== undefined ? { sourceMessageId: stringValue(item.sourceMessageId, 'sourceMessageId') } : {}), linkSequence: positiveInteger(item.linkSequence, 'linkSequence'), createdAt: timestamp(item.createdAt) };
}

function parseMessageSource(value: unknown): ItemV1['messageSource'] {
  const item = exactRecord(value, ['messageId', 'messageRevision']);
  return { messageId: toMessageId(stringValue(item.messageId, 'messageId')), messageRevision: positiveOrZero(item.messageRevision, 'messageRevision') };
}
function record(value: unknown, label: string): Readonly<Record<string, unknown>> { if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError(`${label} is invalid`); return value as Readonly<Record<string, unknown>>; }
function parseProjectionSource(value: unknown): ItemProjectionSourceV1 {
  const item = exactRecord(value, ['eventSystem', 'sourceIdentity'], ['responseExecutionId', 'agentRunId', 'toolCallId', 'workId']);
  return { eventSystem: choice(item.eventSystem, ['response_execution', 'agent_runtime', 'production_trace', 'work_repository'] as const), sourceIdentity: nonEmpty(item.sourceIdentity, 'sourceIdentity'), ...(item.responseExecutionId !== undefined ? { responseExecutionId: toConversationResponseExecutionId(stringValue(item.responseExecutionId, 'responseExecutionId')) } : {}), ...(item.agentRunId !== undefined ? { agentRunId: toConversationAgentRunId(stringValue(item.agentRunId, 'agentRunId')) } : {}), ...(item.toolCallId !== undefined ? { toolCallId: toToolCallId(stringValue(item.toolCallId, 'toolCallId')) } : {}), ...(item.workId !== undefined ? { workId: toWorkId(stringValue(item.workId, 'workId')) } : {}) };
}
function parseBodyRef(value: unknown): ItemBodyRefV1 {
  const item = exactRecord(value, ['segmentId', 'offset', 'length', 'sha256']);
  return { segmentId: nonEmpty(item.segmentId, 'segmentId'), offset: positiveOrZero(item.offset, 'offset'), length: positiveOrZero(item.length, 'length'), sha256: hash(item.sha256) };
}
function exactRecord(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('Expected a record');
  const item = value as Record<string, unknown>, allowed = [...required, ...optional];
  if (required.some(key => !(key in item)) || Object.keys(item).some(key => !allowed.includes(key))) throw new TypeError('Unexpected or missing record field');
  return item;
}
function stringValue(value: unknown, label: string): string { if (typeof value !== 'string') throw new TypeError(`${label} is invalid`); return value; }
function nonEmpty(value: unknown, label: string): string { const result = stringValue(value, label).trim(); if (!result) throw new TypeError(`${label} is empty`); return result; }
function positiveInteger(value: unknown, label: string): number { if (!Number.isSafeInteger(value) || Number(value) < 1) throw new TypeError(`${label} is invalid`); return Number(value); }
function positiveOrZero(value: unknown, label: string): number { if (!Number.isSafeInteger(value) || Number(value) < 0) throw new TypeError(`${label} is invalid`); return Number(value); }
function timestamp(value: unknown): IsoTimestamp { return toIsoTimestamp(stringValue(value, 'timestamp')); }
function choice<const T extends readonly string[]>(value: unknown, values: T): T[number] { if (!values.includes(value as string)) throw new TypeError('Unsupported enum value'); return value as T[number]; }
function array(value: unknown): readonly unknown[] { if (!Array.isArray(value)) throw new TypeError('Expected an array'); return value; }
function unique(values: readonly string[]): void { if (new Set(values).size !== values.length) throw new TypeError('Duplicate identity'); }
function hash(value: unknown): string { const result = stringValue(value, 'sha256'); if (!/^[a-f0-9]{64}$/.test(result)) throw new TypeError('sha256 must be 64 lowercase hex characters'); return result; }
