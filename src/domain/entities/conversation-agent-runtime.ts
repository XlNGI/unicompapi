import {
  toConversationAgentRunId, toConversationId, toConversationResponseExecutionId,
  toMessageId, toProjectId, toWorkId,
  type ConversationAgentRunId, type ConversationId, type ConversationResponseExecutionId,
  type MessageId, type ProjectId, type WorkId
} from '../ids';
import { toIsoTimestamp, type IsoTimestamp } from '../timestamps';

export const conversationAgentRuntimeStatuses = ['running', 'stopped', 'settled', 'needs_reconciliation'] as const;
export type ConversationAgentRuntimeStatus = typeof conversationAgentRuntimeStatuses[number];
export const conversationAgentRuntimeStages = ['prepared', 'model', 'tool', 'observation', 'settled', 'stopped', 'reconciliation'] as const;
export const conversationAgentRuntimeEventKinds = [
  'run_created', 'model_call_prepared', 'model_call_submitting', 'model_call_completed', 'model_call_failed',
  'model_call_unknown', 'tool_call_prepared', 'tool_call_started', 'tool_call_admitted', 'tool_call_observed', 'tool_call_unknown',
  'checkpoint_committed', 'run_stopped', 'run_settled', 'progress_recorded', 'work_registered'
] as const;
export const conversationAgentRuntimeStopReasons = ['timeout', 'cancelled', 'tool_call_limit', 'budget_exceeded', 'failure_limit', 'no_progress', 'unknown_result'] as const;

export interface ConversationAgentRuntimeBudgetV1 {
  readonly startedAt: number;
  readonly deadlineAt: number;
  readonly maxToolCalls: number;
  readonly budgetUnits: number;
  readonly toolCallsUsed: number;
  readonly costUnitsUsed: number;
  /** New runs count proposals independently from actual admitted Host execution. Absent in legacy records. */
  readonly toolAttemptsUsed?: number;
}
export interface ConversationAgentRuntimeModelCallV1 {
  readonly callId: string;
  readonly round: number;
  readonly status: 'prepared' | 'submitting' | 'completed' | 'failed' | 'unknown';
  readonly requestHash: string;
  readonly resultHash?: string;
}
export interface ConversationAgentRuntimeToolCallV1 {
  readonly stepRef: string;
  readonly round: number;
  readonly toolId: string;
  readonly argumentsHash: string;
  readonly status: 'prepared' | 'started' | 'observed' | 'failed' | 'unknown';
  readonly resultHash?: string;
  readonly observationHash?: string;
  /** Absence means a legacy conservative execution boundary; it never authorizes a replay. */
  readonly admissionPhase?: 'pending' | 'admitted' | 'rejected' | 'replayed' | 'unknown';
  readonly failureCode?: string;
}
export interface ConversationAgentRuntimeV1 {
  readonly schemaVersion: 1;
  readonly runId: ConversationAgentRunId;
  readonly projectId: ProjectId;
  readonly conversationId: ConversationId;
  readonly sourceMessageId: MessageId;
  readonly responseExecutionId: ConversationResponseExecutionId;
  readonly revision: number;
  readonly status: ConversationAgentRuntimeStatus;
  readonly stopReason?: typeof conversationAgentRuntimeStopReasons[number];
  readonly budget: ConversationAgentRuntimeBudgetV1;
  readonly checkpoint: { readonly sequence: number; readonly stage: typeof conversationAgentRuntimeStages[number]; readonly modelRound: number };
  readonly modelCalls: readonly ConversationAgentRuntimeModelCallV1[];
  readonly toolCalls: readonly ConversationAgentRuntimeToolCallV1[];
  readonly registeredWorkIds: readonly WorkId[];
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

/** Semantic facts only. Identifiers and hashes are host references, never model text. */
export type ConversationAgentRuntimeFacts = Readonly<Record<string, string | number | boolean>>;
export interface ConversationAgentRuntimePublicEventV1 {
  readonly code: typeof publicCodes[number];
  readonly status: 'started' | 'progress' | 'completed' | 'failed' | 'cancelled';
  readonly operationId?: string;
  readonly assistantMessageId?: string;
  readonly traceId?: string;
  readonly clientCommandId?: string;
  readonly facts?: ConversationAgentRuntimeFacts;
}
export interface ConversationAgentRuntimeEventV1 {
  readonly eventId: string;
  readonly eventKey: string;
  readonly runId: ConversationAgentRunId;
  readonly sequence: number;
  readonly kind: typeof conversationAgentRuntimeEventKinds[number];
  readonly at: IsoTimestamp;
  readonly facts?: ConversationAgentRuntimeFacts;
  readonly publicEvent?: ConversationAgentRuntimePublicEventV1;
}
export interface ConversationAgentRuntimeOutboxEntryV1 {
  readonly eventId: string;
  readonly eventKey: string;
  readonly runId: ConversationAgentRunId;
  readonly sequence: number;
  readonly at: IsoTimestamp;
  readonly payload: ConversationAgentRuntimePublicEventV1;
  readonly projected: boolean;
}
export interface ConversationAgentRuntimeSnapshotV1 {
  readonly runtime: ConversationAgentRuntimeV1;
  readonly events: readonly ConversationAgentRuntimeEventV1[];
  readonly outbox: readonly ConversationAgentRuntimeOutboxEntryV1[];
}
export interface ConversationAgentRuntimeRepository {
  readonly projectId: ProjectId;
  get(runId: ConversationAgentRunId): Promise<ConversationAgentRuntimeSnapshotV1 | undefined>;
  list(): Promise<readonly ConversationAgentRuntimeSnapshotV1[]>;
  findByResponseExecutionId(responseExecutionId: ConversationResponseExecutionId): Promise<ConversationAgentRuntimeSnapshotV1 | undefined>;
  create(runtime: ConversationAgentRuntimeV1, event: ConversationAgentRuntimeEventV1): Promise<ConversationAgentRuntimeSnapshotV1>;
  commit(input: { readonly runId: ConversationAgentRunId; readonly expectedRevision: number; readonly runtime: ConversationAgentRuntimeV1; readonly event: ConversationAgentRuntimeEventV1 }): Promise<ConversationAgentRuntimeSnapshotV1>;
  listPendingOutbox(runId?: ConversationAgentRunId): Promise<readonly ConversationAgentRuntimeOutboxEntryV1[]>;
  acknowledgeOutbox(runId: ConversationAgentRunId, eventId: string): Promise<void>;
  acknowledgeOutboxMany?(runId: ConversationAgentRunId, eventIds: readonly string[]): Promise<void>;
}

export function createConversationAgentRuntime(input: {
  readonly runId: ConversationAgentRunId; readonly projectId: ProjectId; readonly conversationId: ConversationId;
  readonly sourceMessageId: MessageId; readonly responseExecutionId: ConversationResponseExecutionId;
  readonly budget: Omit<ConversationAgentRuntimeBudgetV1, 'toolCallsUsed' | 'costUnitsUsed'>; readonly createdAt: IsoTimestamp;
}): ConversationAgentRuntimeV1 {
  return parseConversationAgentRuntime({ ...input, schemaVersion: 1, revision: 0, status: 'running',
    budget: { ...input.budget, toolCallsUsed: 0, costUnitsUsed: 0, toolAttemptsUsed: 0 }, checkpoint: { sequence: 1, stage: 'prepared', modelRound: 0 },
    modelCalls: [], toolCalls: [], registeredWorkIds: [], updatedAt: input.createdAt });
}

export function updateConversationAgentRuntime(previous: ConversationAgentRuntimeV1, patch: Partial<Pick<ConversationAgentRuntimeV1, 'status' | 'stopReason' | 'budget' | 'checkpoint' | 'modelCalls' | 'toolCalls' | 'registeredWorkIds'>>, updatedAt: IsoTimestamp): ConversationAgentRuntimeV1 {
  const next = parseConversationAgentRuntime({ ...previous, ...patch, revision: previous.revision + 1,
    checkpoint: { ...previous.checkpoint, ...patch.checkpoint, sequence: previous.checkpoint.sequence + 1 }, updatedAt });
  assertConversationAgentRuntimeUpdate(previous, next);
  return next;
}

const publicCodes = ['request_received', 'source_context', 'model_request', 'model_response', 'plan_validation',
  'plan_decision', 'tool_authorization', 'tool_call', 'tool_result', 'document_compile', 'document_render',
  'document_structure_check', 'document_hash_check', 'document_check', 'document_register', 'document_publish', 'task_complete'] as const;
const factEnums: Readonly<Record<string, readonly string[]>> = {
  purpose: ['planning', 'content', 'repair', 'tool', 'source_summary'], documentKind: ['word', 'excel', 'ppt'],
  planKind: ['chat', 'document', 'unknown'], action: ['answer', 'create', 'revise', 'analyze'], sourcePolicy: ['none', 'internal', 'web', 'mixed'],
  errorCode: ['TOOL_PRECONDITION_FAILED', 'OUTLINE_INVALID'], tool: ['read_sources', 'search', 'analyze', 'write_document', 'render', 'check', 'publish', 'patch'],
  stopReason: conversationAgentRuntimeStopReasons, timeoutScope: ['execution', 'prepare', 'model', 'tool', 'design', 'repair', 'render', 'check', 'publish', 'register'],
  designPath: ['design-aware', 'legacy-fallback'], pageCountMode: ['target', 'exact', 'max', 'range'], pageCountBasis: ['total', 'content'],
  artDirectionStatus: ['validated', 'invalid', 'missing'], designIrStatus: ['validated', 'invalid', 'missing'], layoutStatus: ['success', 'failed', 'skipped'],
  renderPlanStatus: ['valid', 'invalid', 'skipped'], repairAction: ['reduce_gap', 'rebalance_regions', 'reduce_font_size', 'compatible_composition'],
  pageRole: ['hero', 'statement', 'comparison', 'metric', 'process', 'evidence', 'section', 'content', 'closing'],
  composition: ['single-focus', 'comparison', 'evidence-led', 'sequence', 'structured'], selectedLayout: ['weighted-regions', 'adaptive-grid', 'flow-track'],
  density: ['sparse', 'balanced', 'dense'], whitespace: ['minimal', 'balanced', 'generous'], primaryRegion: ['left', 'center', 'right', 'top', 'bottom', 'leading', 'trailing', 'supporting'],
  resultStatus: ['ok', 'failed', 'unknown_result'], finishReason: ['stop', 'tool_calls', 'length', 'content_filter', 'unknown'],
  admissionPhase: ['pending', 'admitted', 'rejected', 'replayed', 'unknown'],
  runtimeStatus: conversationAgentRuntimeStatuses, stage: conversationAgentRuntimeStages
};
const countFacts = ['count', 'pageNumber', 'totalPages', 'requestedPages', 'bytes', 'missingCount', 'sectionCount', 'contentCharacters', 'elementCount', 'repairCount',
  'parentElapsedMs', 'parentRemainingMs', 'childElapsedMs', 'childRemainingMs', 'toolCallsUsed', 'costUnitsUsed', 'toolAttemptsUsed', 'round', 'messageCount', 'toolCount', 'contentLength', 'toolCallCount'];
const referenceFacts = ['callId', 'stepRef', 'toolId', 'observationRef', 'workId'];
const hashFacts = ['requestHash', 'resultHash', 'argumentsHash', 'observationHash'];
const publicFactKeys = new Set([
  ...Object.keys(factEnums).filter(key => !['resultStatus', 'finishReason', 'admissionPhase', 'runtimeStatus', 'stage'].includes(key)),
  ...countFacts.filter(key => !['round', 'messageCount', 'toolCount', 'contentLength', 'toolCallCount'].includes(key)),
  'fallback', 'fallbackReason', 'diagnosticCode', 'pageIntentDigest', 'geometrySignature'
]);

export function parseConversationAgentRuntimeFacts(value: unknown, publicOnly = false): ConversationAgentRuntimeFacts {
  const item = record(value, 'runtime facts');
  const parsed: Record<string, string | number | boolean> = {};
  for (const key of Object.keys(item).sort()) {
    if (publicOnly && !publicFactKeys.has(key)) throw new TypeError('Runtime public facts contain an internal field');
    const value = item[key];
    if (factEnums[key]?.includes(value as string)) parsed[key] = value as string;
    else if (countFacts.includes(key)) parsed[key] = integer(value, 0, 1_000_000_000, 'runtime fact');
    else if (key === 'fallback' && typeof value === 'boolean') parsed[key] = value;
    else if (['fallbackReason', 'diagnosticCode', ...(!publicOnly ? ['failureCode'] : [])].includes(key) && typeof value === 'string' && /^[a-z0-9_-]{1,80}$/i.test(value)) parsed[key] = value;
    else if (['pageIntentDigest', 'geometrySignature'].includes(key) && typeof value === 'string' && /^sha256:[a-f0-9]{20}$/.test(value)) parsed[key] = value;
    else if (!publicOnly && referenceFacts.includes(key)) parsed[key] = identifier(value);
    else if (!publicOnly && hashFacts.includes(key)) parsed[key] = hash(value);
    else throw new TypeError('Runtime facts contain an unsupported field');
  }
  return parsed;
}

export function parseConversationAgentRuntime(value: unknown): ConversationAgentRuntimeV1 {
  const item = exactRecord(value, ['schemaVersion', 'runId', 'projectId', 'conversationId', 'sourceMessageId', 'responseExecutionId', 'revision', 'status', 'budget', 'checkpoint', 'modelCalls', 'toolCalls', 'registeredWorkIds', 'createdAt', 'updatedAt'], ['stopReason']);
  if (item.schemaVersion !== 1) throw new TypeError('Unsupported runtime schema');
  const budget = exactRecord(item.budget, ['startedAt', 'deadlineAt', 'maxToolCalls', 'budgetUnits', 'toolCallsUsed', 'costUnitsUsed'], ['toolAttemptsUsed']);
  const startedAt = integer(budget.startedAt, 0, Number.MAX_SAFE_INTEGER, 'startedAt');
  const deadlineAt = integer(budget.deadlineAt, 1, Number.MAX_SAFE_INTEGER, 'deadlineAt');
  if (deadlineAt <= startedAt || deadlineAt - startedAt > 900_000) throw new TypeError('Invalid fixed runtime deadline');
  const maxToolCalls = integer(budget.maxToolCalls, 1, 256, 'maxToolCalls');
  const budgetUnits = integer(budget.budgetUnits, 1, 1_000_000, 'budgetUnits');
  const checkpoint = exactRecord(item.checkpoint, ['sequence', 'stage', 'modelRound']);
  const modelCalls = array(item.modelCalls, 256).map(parseModelCall);
  const toolCalls = array(item.toolCalls, 256).map(parseToolCall);
  const registeredWorkIds = array(item.registeredWorkIds, 256).map(id => toWorkId(identifier(id)));
  unique(modelCalls.map(call => call.callId)); unique(modelCalls.map(call => call.round)); unique(toolCalls.map(call => call.stepRef)); unique(registeredWorkIds);
  const createdAt = timestamp(item.createdAt), updatedAt = timestamp(item.updatedAt);
  if (updatedAt < createdAt || Date.parse(createdAt) !== startedAt) throw new TypeError('Invalid runtime timestamps');
  const status = enumValue(item.status, conversationAgentRuntimeStatuses);
  if (status !== 'needs_reconciliation' && (modelCalls.some(call => call.status === 'unknown') || toolCalls.some(call => call.status === 'unknown'))) throw new TypeError('Unknown calls require a frozen parent runtime');
  if (status === 'settled' && (modelCalls.some(call => !['completed', 'failed'].includes(call.status)) || toolCalls.some(call => !['observed', 'failed'].includes(call.status)))) throw new TypeError('An unsettled runtime cannot be settled');
  return {
    schemaVersion: 1, runId: toConversationAgentRunId(identifier(item.runId)), projectId: toProjectId(identifier(item.projectId)),
    conversationId: toConversationId(identifier(item.conversationId)), sourceMessageId: toMessageId(identifier(item.sourceMessageId)),
    responseExecutionId: toConversationResponseExecutionId(identifier(item.responseExecutionId)), revision: integer(item.revision, 0, 4095, 'revision'), status,
    ...(item.stopReason !== undefined ? { stopReason: enumValue(item.stopReason, conversationAgentRuntimeStopReasons) } : {}),
    budget: { startedAt, deadlineAt, maxToolCalls, budgetUnits, toolCallsUsed: integer(budget.toolCallsUsed, 0, maxToolCalls, 'toolCallsUsed'), costUnitsUsed: integer(budget.costUnitsUsed, 0, budgetUnits, 'costUnitsUsed'), ...(budget.toolAttemptsUsed !== undefined ? { toolAttemptsUsed: integer(budget.toolAttemptsUsed, 0, maxToolCalls, 'toolAttemptsUsed') } : {}) },
    checkpoint: { sequence: integer(checkpoint.sequence, 1, 4096, 'checkpoint sequence'), stage: enumValue(checkpoint.stage, conversationAgentRuntimeStages), modelRound: integer(checkpoint.modelRound, 0, 255, 'model round') },
    modelCalls, toolCalls, registeredWorkIds, createdAt, updatedAt
  };
}

export function parseConversationAgentRuntimeEvent(value: unknown): ConversationAgentRuntimeEventV1 {
  const item = exactRecord(value, ['eventId', 'eventKey', 'runId', 'sequence', 'kind', 'at'], ['facts', 'publicEvent']);
  return { eventId: identifier(item.eventId), eventKey: identifier(item.eventKey), runId: toConversationAgentRunId(identifier(item.runId)),
    sequence: integer(item.sequence, 1, 4096, 'event sequence'), kind: enumValue(item.kind, conversationAgentRuntimeEventKinds), at: timestamp(item.at),
    ...(item.facts !== undefined ? { facts: parseConversationAgentRuntimeFacts(item.facts) } : {}),
    ...(item.publicEvent !== undefined ? { publicEvent: parsePublicEvent(item.publicEvent) } : {}) };
}

export function parseConversationAgentRuntimeSnapshot(value: unknown): ConversationAgentRuntimeSnapshotV1 {
  const item = exactRecord(value, ['runtime', 'events', 'outbox']);
  const runtime = parseConversationAgentRuntime(item.runtime);
  const events = array(item.events, 4096).map(parseConversationAgentRuntimeEvent);
  if (events.length < 1 || events[0].kind !== 'run_created' || events.length !== runtime.checkpoint.sequence || runtime.revision !== events.length - 1) throw new TypeError('Runtime event checkpoint is inconsistent');
  unique(events.map(event => event.eventId)); unique(events.map(event => event.eventKey));
  events.forEach((event, index) => {
    if (event.runId !== runtime.runId || event.sequence !== index + 1 || event.at < (index === 0 ? runtime.createdAt : events[index - 1].at) || event.at > runtime.updatedAt) throw new TypeError('Runtime event ordering is invalid');
  });
  const outbox = array(item.outbox, 4096).map(parseOutbox);
  const publicEvents = events.filter(event => event.publicEvent);
  if (outbox.length !== publicEvents.length || outbox.some((entry, index) => {
    const event = publicEvents[index];
    return entry.runId !== event.runId || entry.eventId !== event.eventId || entry.eventKey !== event.eventKey || entry.sequence !== event.sequence || entry.at !== event.at || JSON.stringify(entry.payload) !== JSON.stringify(event.publicEvent);
  })) throw new TypeError('Runtime outbox does not match committed events');
  return { runtime, events, outbox };
}

export function assertConversationAgentRuntimeUpdate(previous: ConversationAgentRuntimeV1, next: ConversationAgentRuntimeV1): void {
  for (const field of ['runId', 'projectId', 'conversationId', 'sourceMessageId', 'responseExecutionId', 'createdAt'] as const) if (previous[field] !== next[field]) throw new TypeError('Runtime ownership is immutable');
  for (const field of ['startedAt', 'deadlineAt', 'maxToolCalls', 'budgetUnits'] as const) if (previous.budget[field] !== next.budget[field]) throw new TypeError('Runtime budget policy is immutable');
  if (next.revision !== previous.revision + 1 || next.checkpoint.sequence !== previous.checkpoint.sequence + 1 || next.checkpoint.modelRound < previous.checkpoint.modelRound || next.updatedAt < previous.updatedAt || next.budget.toolCallsUsed < previous.budget.toolCallsUsed || next.budget.costUnitsUsed < previous.budget.costUnitsUsed || (next.budget.toolAttemptsUsed ?? next.toolCalls.length) < (previous.budget.toolAttemptsUsed ?? previous.toolCalls.length)) throw new TypeError('Runtime checkpoint or counters regressed');
  if (previous.budget.toolAttemptsUsed !== undefined && next.budget.toolAttemptsUsed === undefined) throw new TypeError('Runtime proposal accounting cannot be removed');
  if (previous.stopReason !== undefined && previous.stopReason !== next.stopReason) throw new TypeError('Runtime stop reason is immutable');
  if (previous.status !== 'running' && previous.status !== next.status && !(previous.status === 'stopped' && ['settled', 'needs_reconciliation'].includes(next.status)) && !(previous.status === 'settled' && next.status === 'needs_reconciliation')) throw new TypeError('A stopped runtime cannot reopen or clear reconciliation');
  if (previous.status !== 'running' && (next.modelCalls.length !== previous.modelCalls.length || next.toolCalls.length !== previous.toolCalls.length)) throw new TypeError('A stopped runtime cannot admit new calls');
  if (previous.status !== 'running' && (previous.modelCalls.some((call, index) => call.status === 'prepared' && !['prepared', 'failed'].includes(next.modelCalls[index]?.status)) || previous.toolCalls.some((call, index) => call.status === 'prepared' && !['prepared', 'failed'].includes(next.toolCalls[index]?.status)))) throw new TypeError('A stopped runtime cannot start a prepared call');
  assertCallUpdates(previous.modelCalls, next.modelCalls, 'callId', ['callId', 'round', 'requestHash'], { prepared: ['submitting', 'failed'], submitting: ['completed', 'failed', 'unknown'], completed: [], failed: [], unknown: ['completed', 'failed'] });
  assertCallUpdates(previous.toolCalls, next.toolCalls, 'stepRef', ['stepRef', 'round', 'toolId', 'argumentsHash'], { prepared: ['started', 'observed', 'failed', 'unknown'], started: ['observed', 'failed', 'unknown'], observed: [], failed: [], unknown: ['observed', 'failed'] });
  previous.toolCalls.forEach((call, index) => {
    const update = next.toolCalls[index];
    if (call.admissionPhase === undefined && update.admissionPhase !== undefined || call.admissionPhase !== undefined && (update.admissionPhase === undefined || call.admissionPhase !== 'pending' && call.admissionPhase !== update.admissionPhase) || call.failureCode !== undefined && call.failureCode !== update.failureCode) throw new TypeError('Runtime tool admission evidence is immutable');
    if (call.status === 'prepared' && call.admissionPhase === 'pending' && update.status === 'started' && update.admissionPhase !== 'admitted') throw new TypeError('A proposal cannot start without durable admission');
    if (call.status === 'prepared' && update.status === 'observed' && !['rejected', 'replayed'].includes(update.admissionPhase ?? '')) throw new TypeError('An unadmitted proposal can only observe a known refusal or replay');
  });
  if (next.modelCalls.slice(previous.modelCalls.length).some(call => call.status !== 'prepared') || next.toolCalls.slice(previous.toolCalls.length).some(call => !['prepared', 'started'].includes(call.status))) throw new TypeError('Runtime calls require a pre-execution checkpoint');
  if (previous.registeredWorkIds.some((id, index) => next.registeredWorkIds[index] !== id)) throw new TypeError('Registered work evidence cannot be removed');
}

function assertCallUpdates<T extends { readonly status: string }>(previous: readonly T[], next: readonly T[], key: keyof T, identity: readonly (keyof T)[], transitions: Readonly<Record<string, readonly string[]>>): void {
  if (next.length < previous.length) throw new TypeError('Runtime calls cannot be removed');
  previous.forEach((call, index) => {
    const update = next[index];
    if (call[key] !== update[key] || identity.some(field => call[field] !== update[field]) || call.status !== update.status && !transitions[call.status]?.includes(update.status)) throw new TypeError('Runtime call identity or state is invalid');
    for (const field of ['resultHash', 'observationHash'] as const) if (field in call && (call as Record<string, unknown>)[field] !== (update as Record<string, unknown>)[field]) throw new TypeError('Runtime observation evidence is immutable');
  });
}
function parseModelCall(value: unknown): ConversationAgentRuntimeModelCallV1 {
  const item = exactRecord(value, ['callId', 'round', 'status', 'requestHash'], ['resultHash']);
  if (item.status === 'completed' && item.resultHash === undefined) throw new TypeError('Completed model call requires result evidence');
  return { callId: identifier(item.callId), round: integer(item.round, 0, 255, 'model round'), status: enumValue(item.status, ['prepared', 'submitting', 'completed', 'failed', 'unknown'] as const), requestHash: hash(item.requestHash), ...(item.resultHash !== undefined ? { resultHash: hash(item.resultHash) } : {}) };
}
function parseToolCall(value: unknown): ConversationAgentRuntimeToolCallV1 {
  const item = exactRecord(value, ['stepRef', 'round', 'toolId', 'argumentsHash', 'status'], ['resultHash', 'observationHash', 'admissionPhase', 'failureCode']);
  const status = enumValue(item.status, ['prepared', 'started', 'observed', 'failed', 'unknown'] as const);
  if (status === 'observed' && (item.resultHash === undefined || item.observationHash === undefined)) throw new TypeError('Observed tool requires result and Observation evidence');
  if (item.failureCode !== undefined && (typeof item.failureCode !== 'string' || !/^[a-z0-9_-]{1,80}$/i.test(item.failureCode))) throw new TypeError('Invalid runtime failure code');
  return { stepRef: identifier(item.stepRef), round: integer(item.round, 0, 255, 'tool round'), toolId: identifier(item.toolId), argumentsHash: hash(item.argumentsHash), status, ...(item.resultHash !== undefined ? { resultHash: hash(item.resultHash) } : {}), ...(item.observationHash !== undefined ? { observationHash: hash(item.observationHash) } : {}), ...(item.admissionPhase !== undefined ? { admissionPhase: enumValue(item.admissionPhase, ['pending', 'admitted', 'rejected', 'replayed', 'unknown'] as const) } : {}), ...(item.failureCode !== undefined ? { failureCode: item.failureCode } : {}) };
}
function parsePublicEvent(value: unknown): ConversationAgentRuntimePublicEventV1 {
  const item = exactRecord(value, ['code', 'status'], ['operationId', 'assistantMessageId', 'traceId', 'clientCommandId', 'facts']);
  return { code: enumValue(item.code, publicCodes), status: enumValue(item.status, ['started', 'progress', 'completed', 'failed', 'cancelled'] as const), ...(item.operationId !== undefined ? { operationId: identifier(item.operationId) } : {}), ...(item.assistantMessageId !== undefined ? { assistantMessageId: identifier(item.assistantMessageId) } : {}), ...(item.traceId !== undefined ? { traceId: identifier(item.traceId) } : {}), ...(item.clientCommandId !== undefined ? { clientCommandId: identifier(item.clientCommandId) } : {}), ...(item.facts !== undefined ? { facts: parseConversationAgentRuntimeFacts(item.facts, true) } : {}) };
}
function parseOutbox(value: unknown): ConversationAgentRuntimeOutboxEntryV1 {
  const item = exactRecord(value, ['eventId', 'eventKey', 'runId', 'sequence', 'at', 'payload', 'projected']);
  if (typeof item.projected !== 'boolean') throw new TypeError('Invalid outbox projection receipt');
  return { eventId: identifier(item.eventId), eventKey: identifier(item.eventKey), runId: toConversationAgentRunId(identifier(item.runId)), sequence: integer(item.sequence, 1, 4096, 'outbox sequence'), at: timestamp(item.at), payload: parsePublicEvent(item.payload), projected: item.projected };
}
function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError(`Invalid ${label}`);
  return value as Record<string, unknown>;
}
function exactRecord(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  const item = record(value, 'runtime record'), allowed = [...required, ...optional];
  if (required.some(key => !(key in item)) || Object.keys(item).some(key => !allowed.includes(key))) throw new TypeError('Runtime record contains missing or unexpected fields');
  return item;
}
function integer(value: unknown, min: number, max: number, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) throw new TypeError(`Invalid runtime ${label}`);
  return Number(value);
}
function identifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value)) throw new TypeError('Invalid runtime reference');
  return value;
}
function hash(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new TypeError('Invalid runtime semantic hash');
  return value;
}
function timestamp(value: unknown): IsoTimestamp {
  if (typeof value !== 'string') throw new TypeError('Invalid runtime timestamp');
  return toIsoTimestamp(value);
}
function enumValue<const T extends readonly string[]>(value: unknown, choices: T): T[number] {
  if (!choices.includes(value as string)) throw new TypeError('Unsupported runtime enum');
  return value as T[number];
}
function array(value: unknown, max: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new TypeError('Invalid or unbounded runtime collection');
  return value;
}
function unique(values: readonly unknown[]): void {
  if (new Set(values).size !== values.length) throw new TypeError('Duplicate runtime reference');
}
