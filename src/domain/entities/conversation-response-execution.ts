import { InvalidStateTransitionError, InvariantViolationError } from '../errors';
import {
  toConnectionId,
  toConversationId,
  toConversationResponseDraftId,
  toConversationResponseExecutionId,
  toConversationResponseStreamEventId,
  toMessageId,
  toModelId,
  toProjectId,
  toProtocolBindingId,
  toProviderExecutionRouteSnapshotId,
  toProviderId,
  toProviderInvocationAttemptId,
  type ConnectionId,
  type ConversationId,
  type ConversationResponseDraftId,
  type ConversationResponseExecutionId,
  type ConversationResponseStreamEventId,
  type MessageId,
  type ModelId,
  type ProjectId,
  type ProtocolBindingId,
  type ProviderExecutionRouteSnapshotId,
  type ProviderId,
  type ProviderInvocationAttemptId
} from '../ids';
import { assertTimestampNotBefore, toIsoTimestamp, type IsoTimestamp } from '../timestamps';
import {
  parseProjectContextOutboundSnapshot,
  type ProjectContextOutboundSnapshotV1
} from './project-context-selection';
import type { ConversationResponseProductFeature } from './conversation-response';
import { parseProductFeature } from './product-feature';

export const conversationResponseRuntimeSources = [
  'official_direct',
  'newapi_gateway'
] as const;
export type ConversationResponseRuntimeSource =
  (typeof conversationResponseRuntimeSources)[number];

export const conversationResponseExecutionStates = [
  'pending',
  'streaming',
  'completed',
  'failed',
  'cancelled',
  'interrupted'
] as const;
export type ConversationResponseExecutionState =
  (typeof conversationResponseExecutionStates)[number];

export const conversationResponseStreamEventTypes = [
  'execution_created',
  'stream_started',
  'reasoning_delta',
  'content_delta',
  'cancel_requested',
  'stream_completed',
  'stream_failed',
  'stream_cancelled',
  'stream_interrupted',
  'stream_resumed'
] as const;
export type ConversationResponseStreamEventType =
  (typeof conversationResponseStreamEventTypes)[number];

export const conversationResponseInterruptionReasons = [
  'provider_disconnected',
  'transport_interrupted',
  'application_shutdown'
] as const;
export type ConversationResponseInterruptionReason =
  (typeof conversationResponseInterruptionReasons)[number];

export interface ConversationResponseCandidateSnapshotV1 {
  readonly schemaVersion: 1;
  readonly providerId: ProviderId;
  readonly connectionId: ConnectionId;
  readonly connectionRevision: number;
  readonly modelId: ModelId;
  readonly modelRevision: number;
  readonly profileId: string;
  readonly profileRevision: number;
  readonly protocolBindingId: ProtocolBindingId;
  readonly protocolBindingRevision: number;
  readonly runtimeSource: ConversationResponseRuntimeSource;
}

export interface ConversationResponseExecutionSnapshotV1 {
  readonly schemaVersion: 1;
  readonly responseDraftId: ConversationResponseDraftId;
  readonly responseDraftRevision: number;
  readonly conversationId: ConversationId;
  readonly conversationRevision: number;
  readonly userMessageId: MessageId;
  readonly userMessageRevision: number;
  readonly assistantMessageId: MessageId;
  readonly productFeature: ConversationResponseProductFeature;
  readonly routeSnapshotId: ProviderExecutionRouteSnapshotId;
  readonly candidate: ConversationResponseCandidateSnapshotV1;
  readonly outboundUserTextSnapshot: string;
  readonly contextSnapshots: readonly ProjectContextOutboundSnapshotV1[];
}

export interface ConversationResponseExecutionV1 {
  readonly schemaVersion: 1;
  readonly id: ConversationResponseExecutionId;
  readonly projectId: ProjectId;
  readonly providerInvocationAttemptId: ProviderInvocationAttemptId;
  readonly retryOfExecutionId?: ConversationResponseExecutionId;
  readonly snapshot: ConversationResponseExecutionSnapshotV1;
  readonly state: ConversationResponseExecutionState;
  readonly createdAt: IsoTimestamp;
}

export interface ConversationResponseStreamEventV1 {
  readonly schemaVersion: 1;
  readonly id: ConversationResponseStreamEventId;
  readonly responseExecutionId: ConversationResponseExecutionId;
  readonly sequence: number;
  readonly type: ConversationResponseStreamEventType;
  readonly reasoningDelta?: string;
  readonly contentDelta?: string;
  readonly safeCode?: string;
  readonly interruptionReason?: ConversationResponseInterruptionReason;
  readonly occurredAt: IsoTimestamp;
}

export interface ConversationResponseExecutionReadModelV1 {
  readonly schemaVersion: 1;
  readonly responseExecutionId: ConversationResponseExecutionId;
  readonly projectId: ProjectId;
  readonly conversationId: ConversationId;
  readonly userMessageId: MessageId;
  readonly assistantMessageId: MessageId;
  readonly productFeature: ConversationResponseProductFeature;
  readonly providerId: ProviderId;
  readonly connectionId: ConnectionId;
  readonly modelId: ModelId;
  readonly runtimeSource: ConversationResponseRuntimeSource;
  readonly retryOfExecutionId?: ConversationResponseExecutionId;
  readonly state: ConversationResponseExecutionState;
  readonly streamSequence: number;
  readonly reasoningContent: string;
  readonly content: string;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

export interface ControlledConversationResponseStreamEventDtoV1 {
  readonly schemaVersion: 1;
  readonly responseExecutionId: string;
  readonly conversationId: string;
  readonly assistantMessageId: string;
  readonly sequence: number;
  readonly type: ConversationResponseStreamEventType;
  readonly reasoningDelta?: string;
  readonly contentDelta?: string;
  readonly safeCode?: string;
  readonly interruptionReason?: ConversationResponseInterruptionReason;
  readonly occurredAt: string;
}

export function createConversationResponseExecution(input: {
  readonly id: ConversationResponseExecutionId;
  readonly projectId: ProjectId;
  readonly providerInvocationAttemptId: ProviderInvocationAttemptId;
  readonly retryOfExecutionId?: ConversationResponseExecutionId;
  readonly snapshot: ConversationResponseExecutionSnapshotV1;
  readonly createdAt: IsoTimestamp;
}): ConversationResponseExecutionV1 {
  return parseConversationResponseExecution({
    schemaVersion: 1,
    ...input,
    state: 'pending'
  });
}

export function createConversationResponseStreamEvent(
  input: Omit<ConversationResponseStreamEventV1, 'schemaVersion'>
): ConversationResponseStreamEventV1 {
  return parseConversationResponseStreamEvent({ schemaVersion: 1, ...input });
}

export function parseConversationResponseExecution(
  value: unknown
): ConversationResponseExecutionV1 {
  const item = exactRecord(
    value,
    [
      'schemaVersion',
      'id',
      'projectId',
      'providerInvocationAttemptId',
      'snapshot',
      'state',
      'createdAt'
    ],
    ['retryOfExecutionId'],
    'conversation response execution'
  );
  if (
    item.schemaVersion !== 1 ||
    !conversationResponseExecutionStates.includes(
      item.state as ConversationResponseExecutionState
    )
  ) {
    throw new InvariantViolationError('conversation response execution is invalid');
  }
  const projectId = toProjectId(nonBlank(item.projectId, 'execution.projectId'));
  const id = toConversationResponseExecutionId(nonBlank(item.id, 'execution.id'));
  const retryOfExecutionId = item.retryOfExecutionId === undefined
    ? undefined
    : toConversationResponseExecutionId(
      nonBlank(item.retryOfExecutionId, 'execution.retryOfExecutionId')
    );
  if (retryOfExecutionId === id) {
    throw new InvariantViolationError('conversation response execution cannot retry itself');
  }
  return {
    schemaVersion: 1,
    id,
    projectId,
    providerInvocationAttemptId: toProviderInvocationAttemptId(
      nonBlank(item.providerInvocationAttemptId, 'execution.providerInvocationAttemptId')
    ),
    ...(retryOfExecutionId ? { retryOfExecutionId } : {}),
    snapshot: parseConversationResponseExecutionSnapshot(item.snapshot),
    state: item.state as ConversationResponseExecutionState,
    createdAt: toIsoTimestamp(String(item.createdAt))
  };
}

export function parseConversationResponseExecutionSnapshot(
  value: unknown
): ConversationResponseExecutionSnapshotV1 {
  const item = exactRecord(
    value,
    [
      'schemaVersion',
      'responseDraftId',
      'responseDraftRevision',
      'conversationId',
      'conversationRevision',
      'userMessageId',
      'userMessageRevision',
      'assistantMessageId',
      'productFeature',
      'routeSnapshotId',
      'candidate',
      'outboundUserTextSnapshot',
      'contextSnapshots'
    ],
    [],
    'conversation response execution snapshot'
  );
  if (
    item.schemaVersion !== 1 ||
    !Array.isArray(item.contextSnapshots)
  ) {
    throw new InvariantViolationError('conversation response execution snapshot is invalid');
  }
  const productFeature = parseProductFeature(item.productFeature);
  if (productFeature !== 'text_chat' && productFeature !== 'text_reasoning') {
    throw new InvariantViolationError('conversation response execution requires a text feature');
  }
  const contextSnapshots = item.contextSnapshots.map(parseProjectContextOutboundSnapshot);
  if (
    new Set(contextSnapshots.map((snapshot) => snapshot.contextId)).size !==
    contextSnapshots.length
  ) {
    throw new InvariantViolationError('conversation response context snapshots must be unique');
  }
  const userMessageId = toMessageId(nonBlank(item.userMessageId, 'snapshot.userMessageId'));
  const assistantMessageId = toMessageId(
    nonBlank(item.assistantMessageId, 'snapshot.assistantMessageId')
  );
  if (userMessageId === assistantMessageId) {
    throw new InvariantViolationError(
      'conversation response user and assistant messages must be distinct'
    );
  }
  return {
    schemaVersion: 1,
    responseDraftId: toConversationResponseDraftId(
      nonBlank(item.responseDraftId, 'snapshot.responseDraftId')
    ),
    responseDraftRevision: nonNegativeInteger(
      item.responseDraftRevision,
      'snapshot.responseDraftRevision'
    ),
    conversationId: toConversationId(
      nonBlank(item.conversationId, 'snapshot.conversationId')
    ),
    conversationRevision: nonNegativeInteger(
      item.conversationRevision,
      'snapshot.conversationRevision'
    ),
    userMessageId,
    userMessageRevision: nonNegativeInteger(
      item.userMessageRevision,
      'snapshot.userMessageRevision'
    ),
    assistantMessageId,
    productFeature,
    routeSnapshotId: toProviderExecutionRouteSnapshotId(
      nonBlank(item.routeSnapshotId, 'snapshot.routeSnapshotId')
    ),
    candidate: parseConversationResponseCandidateSnapshot(item.candidate),
    outboundUserTextSnapshot: boundedText(
      item.outboundUserTextSnapshot,
      'snapshot.outboundUserTextSnapshot',
      1_000_000
    ),
    contextSnapshots
  };
}

export function parseConversationResponseCandidateSnapshot(
  value: unknown
): ConversationResponseCandidateSnapshotV1 {
  const item = exactRecord(
    value,
    [
      'schemaVersion',
      'providerId',
      'connectionId',
      'connectionRevision',
      'modelId',
      'modelRevision',
      'profileId',
      'profileRevision',
      'protocolBindingId',
      'protocolBindingRevision',
      'runtimeSource'
    ],
    [],
    'conversation response candidate snapshot'
  );
  if (
    item.schemaVersion !== 1 ||
    !conversationResponseRuntimeSources.includes(
      item.runtimeSource as ConversationResponseRuntimeSource
    )
  ) {
    throw new InvariantViolationError('conversation response candidate snapshot is invalid');
  }
  return {
    schemaVersion: 1,
    providerId: toProviderId(nonBlank(item.providerId, 'candidate.providerId')),
    connectionId: toConnectionId(nonBlank(item.connectionId, 'candidate.connectionId')),
    connectionRevision: positiveInteger(
      item.connectionRevision,
      'candidate.connectionRevision'
    ),
    modelId: toModelId(nonBlank(item.modelId, 'candidate.modelId')),
    modelRevision: positiveInteger(item.modelRevision, 'candidate.modelRevision'),
    profileId: opaqueId(item.profileId, 'candidate.profileId'),
    profileRevision: positiveInteger(item.profileRevision, 'candidate.profileRevision'),
    protocolBindingId: toProtocolBindingId(
      nonBlank(item.protocolBindingId, 'candidate.protocolBindingId')
    ),
    protocolBindingRevision: positiveInteger(
      item.protocolBindingRevision,
      'candidate.protocolBindingRevision'
    ),
    runtimeSource: item.runtimeSource as ConversationResponseRuntimeSource
  };
}

export function parseConversationResponseStreamEvent(
  value: unknown
): ConversationResponseStreamEventV1 {
  const loose = record(value, 'conversation response stream event');
  const type = loose.type as ConversationResponseStreamEventType;
  if (!conversationResponseStreamEventTypes.includes(type)) {
    throw new InvariantViolationError('conversation response stream event type is invalid');
  }
  const typeFields: Record<ConversationResponseStreamEventType, readonly string[]> = {
    execution_created: [],
    stream_started: [],
    reasoning_delta: ['reasoningDelta'],
    content_delta: ['contentDelta'],
    cancel_requested: [],
    stream_completed: [],
    stream_failed: ['safeCode'],
    stream_cancelled: [],
    stream_interrupted: ['interruptionReason'],
    stream_resumed: []
  };
  const item = exactRecord(
    loose,
    [
      'schemaVersion',
      'id',
      'responseExecutionId',
      'sequence',
      'type',
      ...typeFields[type],
      'occurredAt'
    ],
    [],
    'conversation response stream event'
  );
  if (item.schemaVersion !== 1) {
    throw new InvariantViolationError('conversation response stream event is invalid');
  }
  return {
    schemaVersion: 1,
    id: toConversationResponseStreamEventId(nonBlank(item.id, 'event.id')),
    responseExecutionId: toConversationResponseExecutionId(
      nonBlank(item.responseExecutionId, 'event.responseExecutionId')
    ),
    sequence: positiveInteger(item.sequence, 'event.sequence'),
    type,
    ...(type === 'reasoning_delta'
      ? { reasoningDelta: streamContentDelta(item.reasoningDelta, 'event.reasoningDelta', 65_536) }
      : {}),
    ...(type === 'content_delta'
      ? { contentDelta: streamContentDelta(item.contentDelta, 'event.contentDelta', 65_536) }
      : {}),
    ...(type === 'stream_failed'
      ? { safeCode: safeCode(item.safeCode) }
      : {}),
    ...(type === 'stream_interrupted'
      ? {
          interruptionReason: oneOf(
            item.interruptionReason,
            conversationResponseInterruptionReasons,
            'event.interruptionReason'
          )
        }
      : {}),
    occurredAt: toIsoTimestamp(String(item.occurredAt))
  };
}

export function projectConversationResponseExecution(input: {
  readonly execution: ConversationResponseExecutionV1;
  readonly events: readonly ConversationResponseStreamEventV1[];
}): ConversationResponseExecutionReadModelV1 {
  const execution = parseConversationResponseExecution(input.execution);
  const projected = projectConversationResponseTimeline(execution, input.events);
  if (projected.state !== execution.state) {
    throw new InvariantViolationError('conversation response execution state does not match events');
  }
  const candidate = execution.snapshot.candidate;
  return {
    schemaVersion: 1,
    responseExecutionId: execution.id,
    projectId: execution.projectId,
    conversationId: execution.snapshot.conversationId,
    userMessageId: execution.snapshot.userMessageId,
    assistantMessageId: execution.snapshot.assistantMessageId,
    productFeature: execution.snapshot.productFeature,
    providerId: candidate.providerId,
    connectionId: candidate.connectionId,
    modelId: candidate.modelId,
    runtimeSource: candidate.runtimeSource,
    ...(execution.retryOfExecutionId
      ? { retryOfExecutionId: execution.retryOfExecutionId }
      : {}),
    state: projected.state,
    streamSequence: projected.streamSequence,
    reasoningContent: projected.reasoningContent,
    content: projected.content,
    createdAt: execution.createdAt,
    updatedAt: projected.updatedAt
  };
}

export function projectConversationResponseExecutionState(
  execution: ConversationResponseExecutionV1,
  events: readonly ConversationResponseStreamEventV1[]
): ConversationResponseExecutionState {
  return projectConversationResponseTimeline(
    parseConversationResponseExecution(execution),
    events
  ).state;
}

function projectConversationResponseTimeline(
  execution: ConversationResponseExecutionV1,
  inputEvents: readonly ConversationResponseStreamEventV1[]
): {
  readonly state: ConversationResponseExecutionState;
  readonly streamSequence: number;
  readonly reasoningContent: string;
  readonly content: string;
  readonly updatedAt: IsoTimestamp;
} {
  const events = inputEvents.map(parseConversationResponseStreamEvent);
  if (
    events.length === 0 ||
    events.some((event) => event.responseExecutionId !== execution.id)
  ) {
    throw new InvariantViolationError('conversation response stream timeline is incomplete');
  }
  let state: ConversationResponseExecutionState = 'pending';
  let reasoningContent = '';
  let content = '';
  let previousAt = execution.createdAt;
  const eventIds = new Set<string>();
  for (const [index, event] of events.entries()) {
    if (event.sequence !== index + 1 || eventIds.has(event.id)) {
      throw new InvariantViolationError(
        'conversation response stream sequence must be contiguous and unique'
      );
    }
    eventIds.add(event.id);
    assertTimestampNotBefore(event.occurredAt, previousAt, 'response stream event occurredAt');
    previousAt = event.occurredAt;
    if (index === 0) {
      if (event.type !== 'execution_created') {
        throw new InvariantViolationError('conversation response stream must start with execution_created');
      }
      continue;
    }
    if (event.type === 'execution_created') {
      throw new InvalidStateTransitionError('conversation_response_execution', state, event.type);
    }
    if (event.type === 'cancel_requested') {
      if (state === 'completed' || state === 'failed' || state === 'cancelled') {
        throw new InvalidStateTransitionError('conversation_response_execution', state, event.type);
      }
      continue;
    }
    if (event.type === 'stream_started') {
      if (state !== 'pending') invalidTransition(state, event.type);
      state = 'streaming';
      continue;
    }
    if (event.type === 'reasoning_delta') {
      if (state !== 'streaming') invalidTransition(state, event.type);
      if (execution.snapshot.productFeature !== 'text_reasoning') {
        throw new InvariantViolationError(
          'conversation response reasoning content requires text_reasoning'
        );
      }
      reasoningContent += event.reasoningDelta;
      if (reasoningContent.length > 1_000_000) {
        throw new InvariantViolationError(
          'conversation response reasoning content exceeds the maximum length'
        );
      }
      continue;
    }
    if (event.type === 'content_delta') {
      if (state !== 'streaming') invalidTransition(state, event.type);
      content += event.contentDelta;
      if (content.length > 1_000_000) {
        throw new InvariantViolationError('conversation response content exceeds the maximum length');
      }
      continue;
    }
    if (event.type === 'stream_completed') {
      if (state !== 'streaming') invalidTransition(state, event.type);
      if (content.trim().length === 0) {
        throw new InvariantViolationError('completed conversation response cannot be empty');
      }
      state = 'completed';
      continue;
    }
    if (event.type === 'stream_failed') {
      if (state !== 'pending' && state !== 'streaming' && state !== 'interrupted') {
        invalidTransition(state, event.type);
      }
      state = 'failed';
      continue;
    }
    if (event.type === 'stream_cancelled') {
      if (state !== 'pending' && state !== 'streaming' && state !== 'interrupted') {
        invalidTransition(state, event.type);
      }
      state = 'cancelled';
      continue;
    }
    if (event.type === 'stream_interrupted') {
      if (state !== 'pending' && state !== 'streaming') invalidTransition(state, event.type);
      state = 'interrupted';
      continue;
    }
    if (state !== 'interrupted') invalidTransition(state, event.type);
    state = 'streaming';
  }
  return {
    state,
    streamSequence: events.length,
    reasoningContent,
    content,
    updatedAt: events[events.length - 1].occurredAt
  };
}

export function toControlledConversationResponseStreamEventDto(input: {
  readonly execution: ConversationResponseExecutionV1;
  readonly event: ConversationResponseStreamEventV1;
}): ControlledConversationResponseStreamEventDtoV1 {
  const execution = parseConversationResponseExecution(input.execution);
  const event = parseConversationResponseStreamEvent(input.event);
  if (event.responseExecutionId !== execution.id) {
    throw new InvariantViolationError('conversation response event belongs to another execution');
  }
  return {
    schemaVersion: 1,
    responseExecutionId: execution.id,
    conversationId: execution.snapshot.conversationId,
    assistantMessageId: execution.snapshot.assistantMessageId,
    sequence: event.sequence,
    type: event.type,
    ...(event.reasoningDelta !== undefined ? { reasoningDelta: event.reasoningDelta } : {}),
    ...(event.contentDelta !== undefined ? { contentDelta: event.contentDelta } : {}),
    ...(event.safeCode !== undefined ? { safeCode: event.safeCode } : {}),
    ...(event.interruptionReason !== undefined
      ? { interruptionReason: event.interruptionReason }
      : {}),
    occurredAt: event.occurredAt
  };
}

function invalidTransition(
  state: ConversationResponseExecutionState,
  event: ConversationResponseStreamEventType
): never {
  throw new InvalidStateTransitionError('conversation_response_execution', state, event);
}

function exactRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  label: string
): Record<string, unknown> {
  const item = record(value, label);
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !(key in item)) ||
    Object.keys(item).some((key) => !allowed.has(key))
  ) {
    throw new InvariantViolationError(`${label} contains unsupported fields`);
  }
  return item;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InvariantViolationError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function nonBlank(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new InvariantViolationError(`${label} cannot be empty`);
  }
  return value.trim();
}

function boundedText(value: unknown, label: string, maximumLength: number): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maximumLength) {
    throw new InvariantViolationError(`${label} is invalid`);
  }
  return value;
}

/** Stream deltas may be whitespace-only (e.g. "\\n\\n"); still reject empty and oversized. */
function streamContentDelta(value: unknown, label: string, maximumLength: number): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximumLength ||
    /\u0000/.test(value)
  ) {
    throw new InvariantViolationError(`${label} is invalid`);
  }
  return value;
}

function safeCode(value: unknown): string {
  const code = nonBlank(value, 'event.safeCode');
  if (!/^[a-z0-9][a-z0-9_.-]{0,127}$/.test(code)) {
    throw new InvariantViolationError('event.safeCode is invalid');
  }
  return code;
}

function opaqueId(value: unknown, label: string): string {
  const id = nonBlank(value, label);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(id)) {
    throw new InvariantViolationError(`${label} is invalid`);
  }
  return id;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new InvariantViolationError(`${label} must be a positive safe integer`);
  }
  return Number(value);
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new InvariantViolationError(`${label} must be a non-negative safe integer`);
  }
  return Number(value);
}

function oneOf<T extends string>(
  value: unknown,
  values: readonly T[],
  label: string
): T {
  if (!values.includes(value as T)) {
    throw new InvariantViolationError(`${label} is invalid`);
  }
  return value as T;
}
