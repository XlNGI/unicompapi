import { InvariantViolationError } from '../errors';
import {
  toConversationId,
  toConversationResponseExecutionId,
  toExecutionId,
  toMessageId,
  toProjectId,
  toProviderExecutionRouteSnapshotId,
  toProviderInvocationAttemptId,
  toProviderInvocationEventId,
  toTaskId,
  type ConversationId,
  type ConversationResponseExecutionId,
  type ExecutionId,
  type MessageId,
  type ProjectId,
  type ProviderExecutionRouteSnapshotId,
  type ProviderInvocationAttemptId,
  type ProviderInvocationEventId,
  type TaskId
} from '../ids';
import { assertTimestampNotBefore, toIsoTimestamp, type IsoTimestamp } from '../timestamps';
import {
  parseLocalResultObservation,
  parseProviderUsageSummary,
  type LocalResultObservationV1,
  type ProviderUsageSummaryV1
} from './provider-usage';

export const providerInvocationStates = [
  'submitting',
  'failed_before_submission',
  'accepted',
  'running',
  'completed',
  'failed',
  'cancelled',
  'unknown_outcome'
] as const;
export type ProviderInvocationState = (typeof providerInvocationStates)[number];

export const providerInvocationEventTypes = [
  'submission_started',
  'submission_failed_before_request',
  'provider_accepted',
  'provider_progressed',
  'cancel_requested',
  'cancelled',
  'result_received',
  'completed',
  'failed',
  'outcome_unknown'
] as const;
export type ProviderInvocationEventType =
  (typeof providerInvocationEventTypes)[number];

export type ProviderInvocationSubjectV1 =
  | {
      readonly kind: 'media';
      readonly taskId: TaskId;
      readonly executionId: ExecutionId;
    }
  | {
      readonly kind: 'conversation';
      readonly conversationId: ConversationId;
      readonly userMessageId: MessageId;
      readonly responseExecutionId: ConversationResponseExecutionId;
    }
  | {
      readonly kind: 'prompt_once';
      readonly subjectId: string;
    };

export interface ProviderInvocationAttemptV1 {
  readonly schemaVersion: 1;
  readonly id: ProviderInvocationAttemptId;
  readonly projectId: ProjectId;
  readonly subject: ProviderInvocationSubjectV1;
  readonly routeSnapshotId: ProviderExecutionRouteSnapshotId;
  readonly retryOfInvocationAttemptId?: ProviderInvocationAttemptId;
  readonly state: ProviderInvocationState;
  readonly createdAt: IsoTimestamp;
}

export interface ProviderInvocationEventV1 {
  readonly schemaVersion: 1;
  readonly id: ProviderInvocationEventId;
  readonly invocationAttemptId: ProviderInvocationAttemptId;
  readonly sequence: number;
  readonly type: ProviderInvocationEventType;
  readonly safeCode?: string;
  readonly occurredAt: IsoTimestamp;
}

export interface ProviderInvocationReadModelV1 {
  readonly schemaVersion: 1;
  readonly invocationAttemptId: ProviderInvocationAttemptId;
  readonly projectId: ProjectId;
  readonly subject: ProviderInvocationSubjectV1;
  readonly retryOfInvocationAttemptId?: ProviderInvocationAttemptId;
  readonly state: ProviderInvocationState;
  readonly createdAt: IsoTimestamp;
  readonly timeline: readonly {
    readonly sequence: number;
    readonly type: ProviderInvocationEventType;
    readonly safeCode?: string;
    readonly occurredAt: IsoTimestamp;
  }[];
  readonly usage: ProviderUsageSummaryV1;
  readonly localResults: readonly LocalResultObservationV1[];
}

export function createProviderInvocationAttempt(input: {
  readonly id: ProviderInvocationAttemptId;
  readonly projectId: ProjectId;
  readonly subject: ProviderInvocationSubjectV1;
  readonly routeSnapshotId: ProviderExecutionRouteSnapshotId;
  readonly retryOfInvocationAttemptId?: ProviderInvocationAttemptId;
  readonly createdAt: IsoTimestamp;
}): ProviderInvocationAttemptV1 {
  return parseProviderInvocationAttempt({
    schemaVersion: 1,
    ...input,
    state: 'submitting'
  });
}

export function createProviderInvocationEvent(input: Omit<
  ProviderInvocationEventV1,
  'schemaVersion'
>): ProviderInvocationEventV1 {
  return parseProviderInvocationEvent({ schemaVersion: 1, ...input });
}

export function parseProviderInvocationAttempt(
  value: unknown
): ProviderInvocationAttemptV1 {
  const item = exactRecord(
    value,
    [
      'schemaVersion',
      'id',
      'projectId',
      'subject',
      'routeSnapshotId',
      'state',
      'createdAt'
    ],
    ['retryOfInvocationAttemptId'],
    'provider invocation attempt'
  );
  if (
    item.schemaVersion !== 1 ||
    !providerInvocationStates.includes(item.state as ProviderInvocationState)
  ) {
    throw new InvariantViolationError('provider invocation attempt is invalid');
  }
  const id = toProviderInvocationAttemptId(nonBlank(item.id, 'attempt.id'));
  const retryOfInvocationAttemptId = item.retryOfInvocationAttemptId === undefined
    ? undefined
    : toProviderInvocationAttemptId(
        nonBlank(item.retryOfInvocationAttemptId, 'attempt.retryOfInvocationAttemptId')
      );
  if (retryOfInvocationAttemptId === id) {
    throw new InvariantViolationError('provider invocation attempt cannot retry itself');
  }
  return {
    schemaVersion: 1,
    id,
    projectId: toProjectId(nonBlank(item.projectId, 'attempt.projectId')),
    subject: parseProviderInvocationSubject(item.subject),
    routeSnapshotId: toProviderExecutionRouteSnapshotId(
      nonBlank(item.routeSnapshotId, 'attempt.routeSnapshotId')
    ),
    ...(retryOfInvocationAttemptId ? { retryOfInvocationAttemptId } : {}),
    state: item.state as ProviderInvocationState,
    createdAt: toIsoTimestamp(String(item.createdAt))
  };
}

export function parseProviderInvocationEvent(
  value: unknown
): ProviderInvocationEventV1 {
  const item = exactRecord(
    value,
    [
      'schemaVersion',
      'id',
      'invocationAttemptId',
      'sequence',
      'type',
      'occurredAt'
    ],
    ['safeCode'],
    'provider invocation event'
  );
  if (
    item.schemaVersion !== 1 ||
    !Number.isSafeInteger(item.sequence) ||
    Number(item.sequence) < 1 ||
    !providerInvocationEventTypes.includes(item.type as ProviderInvocationEventType)
  ) {
    throw new InvariantViolationError('provider invocation event is invalid');
  }
  const safeCode = item.safeCode === undefined
    ? undefined
    : parseSafeCode(item.safeCode);
  return {
    schemaVersion: 1,
    id: toProviderInvocationEventId(nonBlank(item.id, 'event.id')),
    invocationAttemptId: toProviderInvocationAttemptId(
      nonBlank(item.invocationAttemptId, 'event.invocationAttemptId')
    ),
    sequence: Number(item.sequence),
    type: item.type as ProviderInvocationEventType,
    ...(safeCode ? { safeCode } : {}),
    occurredAt: toIsoTimestamp(String(item.occurredAt))
  };
}

export function projectProviderInvocationState(
  attempt: ProviderInvocationAttemptV1,
  events: readonly ProviderInvocationEventV1[]
): ProviderInvocationState {
  const validatedAttempt = parseProviderInvocationAttempt(attempt);
  if (events.length === 0) {
    throw new InvariantViolationError('provider invocation requires an event timeline');
  }
  const sorted = events.map(parseProviderInvocationEvent).sort(
    (left, right) => left.sequence - right.sequence
  );
  const eventIds = new Set<string>();
  let state: ProviderInvocationState = 'submitting';
  let previousAt = validatedAttempt.createdAt;
  for (let index = 0; index < sorted.length; index += 1) {
    const event = sorted[index];
    if (
      event.invocationAttemptId !== validatedAttempt.id ||
      event.sequence !== index + 1 ||
      eventIds.has(event.id)
    ) {
      throw new InvariantViolationError(
        'provider invocation event timeline is not contiguous and unique'
      );
    }
    eventIds.add(event.id);
    assertTimestampNotBefore(event.occurredAt, previousAt, 'invocationEvent.occurredAt');
    previousAt = event.occurredAt;
    state = applyInvocationEvent(state, event.type, index === 0);
  }
  return state;
}

export function buildProviderInvocationReadModel(input: {
  readonly attempt: ProviderInvocationAttemptV1;
  readonly events: readonly ProviderInvocationEventV1[];
  readonly usage: ProviderUsageSummaryV1;
  readonly localResults: readonly LocalResultObservationV1[];
}): ProviderInvocationReadModelV1 {
  const attempt = parseProviderInvocationAttempt(input.attempt);
  const events = input.events.map(parseProviderInvocationEvent).sort(
    (left, right) => left.sequence - right.sequence
  );
  const projectedState = projectProviderInvocationState(attempt, events);
  if (projectedState !== attempt.state) {
    throw new InvariantViolationError(
      'provider invocation attempt state does not match its event timeline'
    );
  }
  const usage = parseProviderUsageSummary(input.usage);
  const localResults = input.localResults.map(parseLocalResultObservation);
  if (
    usage.invocationAttemptId !== attempt.id ||
    localResults.some((item) => item.invocationAttemptId !== attempt.id)
  ) {
    throw new InvariantViolationError(
      'provider invocation read model facts belong to another attempt'
    );
  }
  return {
    schemaVersion: 1,
    invocationAttemptId: attempt.id,
    projectId: attempt.projectId,
    subject: cloneSubject(attempt.subject),
    ...(attempt.retryOfInvocationAttemptId
      ? { retryOfInvocationAttemptId: attempt.retryOfInvocationAttemptId }
      : {}),
    state: attempt.state,
    createdAt: attempt.createdAt,
    timeline: events.map(({ sequence, type, safeCode, occurredAt }) => ({
      sequence,
      type,
      ...(safeCode ? { safeCode } : {}),
      occurredAt
    })),
    usage: structuredClone(usage),
    localResults: structuredClone(localResults)
  };
}

function parseProviderInvocationSubject(value: unknown): ProviderInvocationSubjectV1 {
  const item = record(value, 'provider invocation subject');
  if (item.kind === 'media') {
    requireExactKeys(item, ['kind', 'taskId', 'executionId'], 'media invocation subject');
    return {
      kind: 'media',
      taskId: toTaskId(nonBlank(item.taskId, 'subject.taskId')),
      executionId: toExecutionId(nonBlank(item.executionId, 'subject.executionId'))
    };
  }
  if (item.kind === 'conversation') {
    requireExactKeys(
      item,
      ['kind', 'conversationId', 'userMessageId', 'responseExecutionId'],
      'conversation invocation subject'
    );
    return {
      kind: 'conversation',
      conversationId: toConversationId(
        nonBlank(item.conversationId, 'subject.conversationId')
      ),
      userMessageId: toMessageId(nonBlank(item.userMessageId, 'subject.userMessageId')),
      responseExecutionId: toConversationResponseExecutionId(
        nonBlank(item.responseExecutionId, 'subject.responseExecutionId')
      )
    };
  }
  if (item.kind === 'prompt_once') {
    requireExactKeys(item, ['kind', 'subjectId'], 'prompt once invocation subject');
    return {
      kind: 'prompt_once',
      subjectId: nonBlank(item.subjectId, 'subject.subjectId')
    };
  }
  throw new InvariantViolationError('provider invocation subject kind is invalid');
}

function applyInvocationEvent(
  state: ProviderInvocationState,
  type: ProviderInvocationEventType,
  first: boolean
): ProviderInvocationState {
  if (first) {
    if (type !== 'submission_started') {
      throw new InvariantViolationError('provider invocation must start with submission_started');
    }
    return 'submitting';
  }
  if (type === 'submission_started') {
    throw new InvariantViolationError('submission_started can only be the first event');
  }
  if (state === 'submitting') {
    if (type === 'submission_failed_before_request') return 'failed_before_submission';
    if (type === 'provider_accepted') return 'accepted';
    if (type === 'outcome_unknown') return 'unknown_outcome';
  } else if (state === 'accepted' || state === 'running') {
    if (type === 'provider_progressed' || type === 'result_received') return 'running';
    if (type === 'cancel_requested') return state;
    if (type === 'cancelled') return 'cancelled';
    if (type === 'completed') return 'completed';
    if (type === 'failed') return 'failed';
    if (type === 'outcome_unknown') return 'unknown_outcome';
  }
  throw new InvariantViolationError(
    `provider invocation event ${type} is invalid from ${state}`
  );
}

function cloneSubject(subject: ProviderInvocationSubjectV1): ProviderInvocationSubjectV1 {
  return { ...subject };
}

function parseSafeCode(value: unknown): string {
  const code = nonBlank(value, 'event.safeCode');
  if (!/^[a-z0-9][a-z0-9_.-]{0,127}$/.test(code)) {
    throw new InvariantViolationError('provider invocation safe code is invalid');
  }
  return code;
}

function exactRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  label: string
): Record<string, unknown> {
  const item = record(value, label);
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(item);
  if (
    required.some((key) => !(key in item)) ||
    keys.some((key) => !allowed.has(key))
  ) {
    throw new InvariantViolationError(`${label} contains unsupported fields`);
  }
  return item;
}

function requireExactKeys(
  item: Record<string, unknown>,
  keys: readonly string[],
  label: string
): void {
  const allowed = new Set(keys);
  if (
    Object.keys(item).length !== allowed.size ||
    Object.keys(item).some((key) => !allowed.has(key))
  ) {
    throw new InvariantViolationError(`${label} contains unsupported fields`);
  }
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
