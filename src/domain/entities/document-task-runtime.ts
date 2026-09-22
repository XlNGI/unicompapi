import {
  toConversationId,
  toDocumentTaskRuntimeId,
  toMessageId,
  toProjectId,
  type ConversationId,
  type DocumentTaskRuntimeId,
  type MessageId,
  type ProjectId
} from '../ids';
import { toIsoTimestamp, type IsoTimestamp } from '../timestamps';
import {
  createDocumentToolRegistry,
  documentToolIds,
  type DocumentToolId,
  type DocumentToolObservation
} from './document-agent';
import {
  documentWorkspaceKinds,
  type DocumentWorkspaceKind
} from './document-generation';

export const documentTaskRuntimeStatuses = [
  'planning',
  'running',
  'waiting_input',
  'paused',
  'cancelled',
  'failed',
  'completed',
  'needs_reconciliation'
] as const;
export type DocumentTaskRuntimeStatus = (typeof documentTaskRuntimeStatuses)[number];

export const documentTaskRuntimeCheckpointStages = [
  'planning',
  'tool',
  'reconcile',
  'complete'
] as const;
export type DocumentTaskRuntimeCheckpointStage =
  (typeof documentTaskRuntimeCheckpointStages)[number];

export interface DocumentTaskRuntimePageRef {
  readonly pageId: string;
  readonly pageRevision: number;
}

export interface DocumentTaskRuntimeWorkRef {
  readonly kind: 'candidate' | 'registered';
  readonly ref: string;
  readonly revision?: number;
}

export interface DocumentTaskRuntimeToolCall {
  readonly id: string;
  readonly toolId: DocumentToolId;
  readonly inputHash: string;
  readonly step: number;
  readonly status: 'started' | 'completed' | 'failed' | 'unknown';
}

export interface DocumentTaskRuntimeCheckpoint {
  readonly stage: DocumentTaskRuntimeCheckpointStage;
  readonly step: number;
  readonly costUnits: number;
  readonly lastToolCallId?: string;
}

export interface DocumentTaskRuntimeBudget {
  readonly maxSteps: number;
  readonly budgetUnits: number;
  readonly timeoutMs: number;
}

export interface DocumentTaskRuntime {
  readonly schemaVersion: 1;
  readonly id: DocumentTaskRuntimeId;
  readonly projectId: ProjectId;
  readonly conversationId: ConversationId;
  readonly sourceMessageId: MessageId;
  readonly executionId: string;
  readonly revision: number;
  readonly status: DocumentTaskRuntimeStatus;
  readonly documentKind: DocumentWorkspaceKind;
  readonly attachmentRefs: readonly string[];
  readonly workRef?: DocumentTaskRuntimeWorkRef;
  readonly pageRefs: readonly DocumentTaskRuntimePageRef[];
  readonly checkpoint: DocumentTaskRuntimeCheckpoint;
  readonly toolCalls: readonly DocumentTaskRuntimeToolCall[];
  readonly observations: readonly DocumentToolObservation[];
  readonly budget: DocumentTaskRuntimeBudget;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

const limits = {
  maxAttachments: 64,
  maxPages: 100,
  maxToolCalls: 128,
  maxObservations: 128,
  maxObservationBytes: 16_384,
  maxReferenceLength: 256,
  maxExecutionIdLength: 256
} as const;

export function createDocumentTaskRuntime(input: {
  readonly id: DocumentTaskRuntimeId;
  readonly projectId: ProjectId;
  readonly conversationId: ConversationId;
  readonly sourceMessageId: MessageId;
  readonly executionId: string;
  readonly documentKind: DocumentWorkspaceKind;
  readonly attachmentRefs?: readonly string[];
  readonly workRef?: DocumentTaskRuntimeWorkRef;
  readonly pageRefs?: readonly DocumentTaskRuntimePageRef[];
  readonly budget: DocumentTaskRuntimeBudget;
  readonly createdAt: IsoTimestamp;
}): DocumentTaskRuntime {
  return parseDocumentTaskRuntime({
    schemaVersion: 1,
    id: input.id,
    projectId: input.projectId,
    conversationId: input.conversationId,
    sourceMessageId: input.sourceMessageId,
    executionId: input.executionId,
    revision: 0,
    status: 'planning',
    documentKind: input.documentKind,
    attachmentRefs: input.attachmentRefs ?? [],
    ...(input.workRef !== undefined ? { workRef: input.workRef } : {}),
    pageRefs: input.pageRefs ?? [],
    checkpoint: { stage: 'planning', step: 0, costUnits: 0 },
    toolCalls: [],
    observations: [],
    budget: input.budget,
    createdAt: input.createdAt,
    updatedAt: input.createdAt
  });
}

export function parseDocumentTaskRuntime(value: unknown): DocumentTaskRuntime {
  const record = requireRecord(value, 'DocumentTaskRuntime');
  requireExactKeys(record, [
    'schemaVersion', 'id', 'projectId', 'conversationId', 'sourceMessageId',
    'executionId', 'revision', 'status', 'documentKind', 'attachmentRefs',
    'workRef', 'pageRefs', 'checkpoint', 'toolCalls', 'observations', 'budget',
    'createdAt', 'updatedAt'
  ]);
  if (record.schemaVersion !== 1) throw new TypeError('Document task runtime schemaVersion is invalid');
  const revision = nonNegativeInteger(record.revision, 'revision');
  const createdAt = toIsoTimestamp(String(record.createdAt));
  const updatedAt = toIsoTimestamp(String(record.updatedAt));
  if (updatedAt < createdAt) throw new TypeError('Document task runtime updatedAt is stale');
  const attachmentRefs = parseReferenceList(record.attachmentRefs, 'attachmentRefs', limits.maxAttachments);
  const pageRefs = parsePageRefs(record.pageRefs);
  const checkpoint = parseCheckpoint(record.checkpoint);
  const toolCalls = parseToolCalls(record.toolCalls);
  const observations = parseObservations(record.observations);
  const workRef = record.workRef === undefined ? undefined : parseWorkRef(record.workRef);
  const budget = parseBudget(record.budget);
  const status = requireEnum(record.status, documentTaskRuntimeStatuses, 'status');
  const registry = createDocumentToolRegistry();
  if (checkpoint.step !== toolCalls.length || toolCalls.length > budget.maxSteps ||
      checkpoint.costUnits !== toolCalls.reduce((sum, call) => sum + registry.get(call.toolId)!.maxCostUnits, 0) ||
      checkpoint.costUnits > budget.budgetUnits ||
      checkpoint.lastToolCallId !== toolCalls.at(-1)?.id) {
    throw new TypeError('Document task runtime checkpoint does not match calls or budget');
  }
  if (toolCalls.some((call, index) => call.step !== index + 1 ||
      (index < toolCalls.length - 1 && ['started', 'unknown'].includes(call.status)))) {
    throw new TypeError('Document task runtime calls are not sequential');
  }
  const settled = toolCalls.filter(call => call.status === 'completed' || call.status === 'failed');
  if (settled.length !== observations.length || settled.some((call, index) =>
    call.step !== observations[index].step || call.toolId !== observations[index].toolId ||
    (call.status === 'completed') !== observations[index].ok)) {
    throw new TypeError('Document task runtime observations do not match calls');
  }
  const pending = toolCalls.at(-1)?.status;
  if ((pending === 'started' && status !== 'running') ||
      (pending === 'unknown' && status !== 'needs_reconciliation') ||
      (status === 'needs_reconciliation' && checkpoint.stage !== 'reconcile') ||
      (status === 'completed' && (checkpoint.stage !== 'complete' || workRef?.kind !== 'registered')) ||
      (status !== 'completed' && checkpoint.stage === 'complete')) {
    throw new TypeError('Document task runtime status is inconsistent');
  }
  return {
    schemaVersion: 1,
    id: toDocumentTaskRuntimeId(safeReference(record.id, 'id')),
    projectId: toProjectId(safeReference(record.projectId, 'projectId')),
    conversationId: toConversationId(safeReference(record.conversationId, 'conversationId')),
    sourceMessageId: toMessageId(safeReference(record.sourceMessageId, 'sourceMessageId')),
    executionId: safeReference(record.executionId, 'executionId', limits.maxExecutionIdLength),
    revision,
    status,
    documentKind: requireEnum(record.documentKind, documentWorkspaceKinds, 'documentKind'),
    attachmentRefs,
    ...(workRef !== undefined ? { workRef } : {}),
    pageRefs,
    checkpoint,
    toolCalls,
    observations,
    budget,
    createdAt,
    updatedAt
  };
}

export function updateDocumentTaskRuntime(
  runtime: DocumentTaskRuntime,
  input: Partial<Pick<DocumentTaskRuntime, 'status' | 'checkpoint' | 'toolCalls' | 'observations'>> & {
    readonly updatedAt: IsoTimestamp;
  }
): DocumentTaskRuntime {
  const next = parseDocumentTaskRuntime({
    ...runtime,
    ...input,
    revision: runtime.revision + 1,
    updatedAt: input.updatedAt
  });
  assertDocumentTaskRuntimeUpdate(runtime, next);
  return next;
}

/** Repositories enforce this too; object spreads cannot bypass lifecycle checks. */
export function assertDocumentTaskRuntimeUpdate(previous: DocumentTaskRuntime, next: DocumentTaskRuntime): void {
  for (const field of ['id', 'projectId', 'conversationId', 'sourceMessageId', 'executionId',
    'documentKind', 'attachmentRefs', 'workRef', 'pageRefs', 'budget', 'createdAt'] as const) {
    if (JSON.stringify(previous[field]) !== JSON.stringify(next[field])) throw new TypeError('Runtime binding is immutable');
  }
  const transitions: Readonly<Record<DocumentTaskRuntimeStatus, readonly DocumentTaskRuntimeStatus[]>> = {
    planning: ['planning', 'running', 'waiting_input', 'paused', 'cancelled', 'failed'],
    running: ['running', 'waiting_input', 'paused', 'cancelled', 'failed', 'needs_reconciliation'],
    waiting_input: ['waiting_input', 'running', 'paused', 'cancelled', 'failed'],
    paused: ['paused', 'running', 'cancelled', 'failed'],
    failed: [], cancelled: [], completed: [], needs_reconciliation: []
  };
  if (!transitions[previous.status].includes(next.status) || next.revision !== previous.revision + 1 ||
      next.updatedAt < previous.updatedAt || next.checkpoint.step < previous.checkpoint.step ||
      next.checkpoint.costUnits < previous.checkpoint.costUnits ||
      next.toolCalls.length < previous.toolCalls.length || next.toolCalls.length > previous.toolCalls.length + 1 ||
      next.observations.length < previous.observations.length ||
      previous.observations.some((item, index) => JSON.stringify(item) !== JSON.stringify(next.observations[index]))) {
    throw new TypeError('Invalid document task runtime transition');
  }
  previous.toolCalls.forEach((call, index) => {
    const replacement = next.toolCalls[index];
    if (call.status !== 'started') {
      if (JSON.stringify(call) !== JSON.stringify(replacement)) throw new TypeError('Settled call is immutable');
    } else if (call.id !== replacement.id || call.inputHash !== replacement.inputHash ||
        call.step !== replacement.step || call.toolId !== replacement.toolId) {
      throw new TypeError('Pending call identity is immutable');
    }
  });
  if (next.toolCalls.length > previous.toolCalls.length &&
      (next.toolCalls.at(-1)?.status !== 'started' ||
       previous.toolCalls.at(-1)?.status === 'started' ||
       next.observations.length !== previous.observations.length)) {
    throw new TypeError('A tool call must be persisted before it can settle');
  }
}

function parseBudget(value: unknown): DocumentTaskRuntimeBudget {
  const record = requireRecord(value, 'budget');
  requireExactKeys(record, ['maxSteps', 'budgetUnits', 'timeoutMs']);
  const maxSteps = positiveInteger(record.maxSteps, 'budget.maxSteps');
  const budgetUnits = positiveInteger(record.budgetUnits, 'budget.budgetUnits');
  const timeoutMs = positiveInteger(record.timeoutMs, 'budget.timeoutMs');
  if (maxSteps > 32 || budgetUnits > 10_000 || timeoutMs > 900_000) throw new TypeError('Document task runtime budget exceeds limits');
  return { maxSteps, budgetUnits, timeoutMs };
}

function parseCheckpoint(value: unknown): DocumentTaskRuntimeCheckpoint {
  const record = requireRecord(value, 'checkpoint');
  requireExactKeys(record, ['stage', 'step', 'costUnits', 'lastToolCallId']);
  return {
    stage: requireEnum(record.stage, documentTaskRuntimeCheckpointStages, 'checkpoint.stage'),
    step: nonNegativeInteger(record.step, 'checkpoint.step'),
    costUnits: nonNegativeInteger(record.costUnits, 'checkpoint.costUnits'),
    ...(record.lastToolCallId !== undefined ? { lastToolCallId: safeReference(record.lastToolCallId, 'checkpoint.lastToolCallId') } : {})
  };
}

function parsePageRefs(value: unknown): readonly DocumentTaskRuntimePageRef[] {
  const list = requireArray(value, 'pageRefs');
  if (list.length > limits.maxPages) throw new TypeError('pageRefs exceeds the maximum item count');
  const refs = list.map((item, index) => {
    const record = requireRecord(item, `pageRefs[${index}]`);
    requireExactKeys(record, ['pageId', 'pageRevision']);
    return {
      pageId: safeReference(record.pageId, `pageRefs[${index}].pageId`),
      pageRevision: nonNegativeInteger(record.pageRevision, `pageRefs[${index}].pageRevision`)
    };
  });
  if (new Set(refs.map((item) => item.pageId)).size !== refs.length) throw new TypeError('pageRefs contains duplicates');
  return refs;
}

function parseWorkRef(value: unknown): DocumentTaskRuntimeWorkRef {
  const record = requireRecord(value, 'workRef');
  requireExactKeys(record, ['kind', 'ref', 'revision']);
  return {
    kind: requireEnum(record.kind, ['candidate', 'registered'] as const, 'workRef.kind'),
    ref: safeReference(record.ref, 'workRef.ref'),
    ...(record.revision !== undefined ? { revision: nonNegativeInteger(record.revision, 'workRef.revision') } : {})
  };
}

function parseToolCalls(value: unknown): readonly DocumentTaskRuntimeToolCall[] {
  const list = requireArray(value, 'toolCalls');
  if (list.length > limits.maxToolCalls) throw new TypeError('toolCalls exceeds the maximum item count');
  const calls = list.map((item, index) => {
    const record = requireRecord(item, `toolCalls[${index}]`);
    requireExactKeys(record, ['id', 'toolId', 'inputHash', 'step', 'status']);
    if (typeof record.inputHash !== 'string' || !/^[a-f0-9]{64}$/.test(record.inputHash)) throw new TypeError('Invalid tool input hash');
    return {
      id: safeReference(record.id, `toolCalls[${index}].id`),
      toolId: requireEnum(record.toolId, documentToolIds, `toolCalls[${index}].toolId`),
      inputHash: safeReference(record.inputHash, `toolCalls[${index}].inputHash`),
      step: positiveInteger(record.step, `toolCalls[${index}].step`),
      status: requireEnum(record.status, ['started', 'completed', 'failed', 'unknown'] as const, `toolCalls[${index}].status`)
    };
  });
  if (new Set(calls.map((item) => item.id)).size !== calls.length) throw new TypeError('toolCalls contains duplicate IDs');
  return calls;
}

function parseObservations(value: unknown): readonly DocumentToolObservation[] {
  const list = requireArray(value, 'observations');
  if (list.length > limits.maxObservations) throw new TypeError('observations exceeds the maximum item count');
  return list.map((item, index) => {
    const record = requireRecord(item, `observations[${index}]`);
    requireExactKeys(record, ['step', 'toolId', 'ok', 'data', 'diagnostic']);
    const data = parseObservationData(record.data, `observations[${index}].data`);
    const diagnostic = record.diagnostic === undefined ? undefined : safeDiagnostic(record.diagnostic, `observations[${index}].diagnostic`);
    return {
      step: positiveInteger(record.step, `observations[${index}].step`),
      toolId: requireEnum(record.toolId, documentToolIds, `observations[${index}].toolId`),
      ok: requireBoolean(record.ok, `observations[${index}].ok`),
      data,
      ...(diagnostic !== undefined ? { diagnostic } : {})
    };
  });
}

function parseObservationData(value: unknown, label: string): Readonly<Record<string, unknown>> {
  const record = requireRecord(value, label);
  const parsed = validateSafeValue(record, label, 0) as Readonly<Record<string, unknown>>;
  if (new TextEncoder().encode(JSON.stringify(parsed)).length > limits.maxObservationBytes) throw new TypeError('Observation is too large');
  return parsed;
}

function validateSafeValue(value: unknown, label: string, depth: number): unknown {
  if (depth > 4) throw new TypeError(`${label} is too deeply nested`);
  if (typeof value === 'string') {
    if (value.length > 2_000 || isPathOrUrl(value) || /(?:token|secret|password|credential|api[_-]?key)\s*[:=]/i.test(value)) throw new TypeError('Observation contains unsafe text');
    return value;
  }
  if ((typeof value === 'number' && Number.isFinite(value)) || typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value)) {
    if (value.length > 32) throw new TypeError(`${label} has too many items`);
    return value.map((item, index) => validateSafeValue(item, `${label}[${index}]`, depth + 1));
  }
  if (typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
    const record = value as Record<string, unknown>;
    if (Object.keys(record).length > 64) throw new TypeError(`${label} has too many fields`);
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(record)) {
      if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(key) || /(?:path|url|token|secret|password|credential|api[_-]?key|content|body|prompt|__proto__|constructor|prototype)/i.test(key)) throw new TypeError('Observation contains a protected field');
      result[key] = validateSafeValue(item, `${label}.${key}`, depth + 1);
    }
    return result;
  }
  throw new TypeError(`${label} contains an unsupported value`);
}

function parseReferenceList(value: unknown, label: string, max: number): readonly string[] {
  const list = requireArray(value, label);
  if (list.length > max) throw new TypeError(`${label} exceeds the maximum item count`);
  const refs = list.map((item, index) => safeReference(item, `${label}[${index}]`));
  if (new Set(refs).size !== refs.length) throw new TypeError(`${label} contains duplicates`);
  return refs;
}

function safeDiagnostic(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 300) throw new TypeError(`${label} is invalid`);
  const diagnostic = value;
  if (isPathOrUrl(diagnostic) || /(?:token|secret|password|credential|api[_-]?key)/i.test(diagnostic)) {
    throw new TypeError(`${label} contains protected data`);
  }
  return diagnostic;
}

function safeReference(value: unknown, label: string, max: number = limits.maxReferenceLength): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max) throw new TypeError(`${label} is invalid`);
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) throw new TypeError('Reference must be an opaque ID');
  return value;
}

function isPathOrUrl(value: string): boolean {
  return /(?:[a-z]+:\/\/|[a-z]:[\\/]|\\\\|\/)/i.test(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function requireExactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const unsupported = Object.keys(value).find((key) => !allowed.includes(key));
  if (unsupported) throw new TypeError(`unsupported field: ${unsupported}`);
}

function requireArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  return value;
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new TypeError(`${label} must be a boolean`);
  return value;
}

function requireEnum<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) throw new TypeError(`${label} is invalid`);
  return value as T;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new TypeError(`${label} must be a positive integer`);
  return Number(value);
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new TypeError(`${label} must be a non-negative integer`);
  return Number(value);
}
