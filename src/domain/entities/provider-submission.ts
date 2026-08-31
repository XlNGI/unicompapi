import { InvariantViolationError } from '../errors';
import {
  toConversationId,
  toConversationResponseDraftId,
  toDraftId,
  toMessageId,
  toProjectId,
  toProviderExecutionRouteSnapshotId,
  toProviderInvocationAttemptId,
  toSubmissionIntentId,
  type ConversationId,
  type ConversationResponseDraftId,
  type DraftId,
  type MessageId,
  type ProjectId,
  type ProviderExecutionRouteSnapshotId,
  type ProviderInvocationAttemptId,
  type SubmissionIntentId
} from '../ids';
import { assertTimestampNotBefore, toIsoTimestamp, type IsoTimestamp } from '../timestamps';
import type { ParameterSchemaV2, ProductFeature } from './product-feature';
import { parseProductFeature, validateParameterSchemaV2 } from './product-feature';

export type FeatureCandidateSubjectV1 =
  | {
      readonly kind: 'draft';
      readonly draftId: DraftId;
      readonly draftRevision: number;
    }
  | {
      readonly kind: 'conversation_response_draft';
      readonly conversationId: ConversationId;
      readonly conversationRevision: number;
      readonly responseDraftId: ConversationResponseDraftId;
      readonly responseDraftRevision: number;
      readonly userMessageId: MessageId;
    };

export const featureCandidateAvailabilityReasons = [
  'model_disabled',
  'model_not_present',
  'connection_unavailable',
  'profile_unavailable',
  'feature_unsupported',
  'binding_unavailable',
  'runtime_not_allowed',
  'subject_constraints_unsatisfied',
  'schema_unsupported'
] as const;
export type FeatureCandidateAvailabilityReason =
  (typeof featureCandidateAvailabilityReasons)[number];

export const featureCandidateCostStates = ['known', 'unknown', 'not_applicable'] as const;
export type FeatureCandidateCostState = (typeof featureCandidateCostStates)[number];

export interface FeatureCandidateCostFactV1 {
  readonly state: FeatureCandidateCostState;
  readonly summary?: string;
}

export interface FeatureCandidateDtoV1 {
  readonly schemaVersion: 1;
  readonly candidateId: string;
  readonly providerName: string;
  readonly connectionName: string;
  readonly modelName: string;
  readonly parameterSchema: ParameterSchemaV2;
  readonly usageSchema: {
    readonly schemaVersion: 1;
    readonly schemaId: string;
    readonly revision: number;
  };
  readonly cost: FeatureCandidateCostFactV1;
  readonly available: boolean;
  readonly unavailableReasons: readonly FeatureCandidateAvailabilityReason[];
}

export interface SubmissionConfirmationDtoV1 {
  readonly schemaVersion: 1;
  readonly confirmationId: string;
  readonly productFeature: ProductFeature;
  readonly providerName: string;
  readonly connectionName: string;
  readonly modelName: string;
  readonly recipientName: string;
  readonly outboundScope: 'external_service' | 'local_network' | 'local_device' | 'unknown';
  readonly contentCategories: readonly string[];
  readonly parameterFieldCount: number;
  readonly materialCount: number;
  readonly contextCount: number;
  readonly cost: FeatureCandidateCostFactV1;
}

export interface SubmissionPreparationV1 {
  readonly schemaVersion: 1;
  readonly routeSelectionToken: string;
  readonly expiresAt: IsoTimestamp;
  readonly confirmation: SubmissionConfirmationDtoV1;
}

export interface SubmissionUserConfirmationV1 {
  readonly schemaVersion: 1;
  readonly confirmationId: string;
  readonly confirmed: true;
}

export const submissionIntentStatuses = [
  'authorization_pending',
  'authorization_not_claimed',
  'authorization_claimed',
  'request_started',
  'provider_accepted',
  'completed',
  'failed',
  'failed_before_submission',
  'cancelled',
  'unknown_outcome'
] as const;
export type SubmissionIntentStatus = (typeof submissionIntentStatuses)[number];

export interface SubmissionIntentV1 {
  readonly schemaVersion: 1;
  readonly id: SubmissionIntentId;
  readonly projectId: ProjectId;
  readonly subject: FeatureCandidateSubjectV1;
  readonly routeSnapshotId: ProviderExecutionRouteSnapshotId;
  readonly providerInvocationAttemptId: ProviderInvocationAttemptId;
  readonly idempotencyKey: string;
  readonly authorizationClaimId: string;
  readonly status: SubmissionIntentStatus;
  readonly providerOperationId?: string;
  readonly safeCode?: string;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

export function parseFeatureCandidateSubject(value: unknown): FeatureCandidateSubjectV1 {
  const item = record(value, 'feature candidate subject');
  if (item.kind === 'draft') {
    requireExactKeys(item, ['kind', 'draftId', 'draftRevision'], 'draft subject');
    return {
      kind: 'draft',
      draftId: toDraftId(nonBlank(item.draftId, 'subject.draftId')),
      draftRevision: nonNegativeInteger(item.draftRevision, 'subject.draftRevision')
    };
  }
  if (item.kind === 'conversation_response_draft') {
    requireExactKeys(
      item,
      [
        'kind',
        'conversationId',
        'conversationRevision',
        'responseDraftId',
        'responseDraftRevision',
        'userMessageId'
      ],
      'conversation response subject'
    );
    return {
      kind: 'conversation_response_draft',
      conversationId: toConversationId(nonBlank(item.conversationId, 'subject.conversationId')),
      conversationRevision: nonNegativeInteger(
        item.conversationRevision,
        'subject.conversationRevision'
      ),
      responseDraftId: toConversationResponseDraftId(
        nonBlank(item.responseDraftId, 'subject.responseDraftId')
      ),
      responseDraftRevision: nonNegativeInteger(
        item.responseDraftRevision,
        'subject.responseDraftRevision'
      ),
      userMessageId: toMessageId(nonBlank(item.userMessageId, 'subject.userMessageId'))
    };
  }
  throw new InvariantViolationError('feature candidate subject kind is invalid');
}

export function parseFeatureCandidateDto(value: unknown): FeatureCandidateDtoV1 {
  const item = exactRecord(
    value,
    [
      'schemaVersion',
      'candidateId',
      'providerName',
      'connectionName',
      'modelName',
      'parameterSchema',
      'usageSchema',
      'cost',
      'available',
      'unavailableReasons'
    ],
    'feature candidate DTO'
  );
  if (
    item.schemaVersion !== 1 ||
    typeof item.available !== 'boolean' ||
    !Array.isArray(item.unavailableReasons)
  ) {
    throw new InvariantViolationError('feature candidate DTO is invalid');
  }
  const unavailableReasons = item.unavailableReasons.map((reason) =>
    oneOf(reason, featureCandidateAvailabilityReasons, 'candidate unavailable reason')
  );
  if (
    new Set(unavailableReasons).size !== unavailableReasons.length ||
    item.available === (unavailableReasons.length > 0)
  ) {
    throw new InvariantViolationError('feature candidate availability is inconsistent');
  }
  const usage = exactRecord(
    item.usageSchema,
    ['schemaVersion', 'schemaId', 'revision'],
    'candidate usage schema'
  );
  if (usage.schemaVersion !== 1) {
    throw new InvariantViolationError('candidate usage schema is invalid');
  }
  return {
    schemaVersion: 1,
    candidateId: opaqueId(item.candidateId, 'candidate.candidateId'),
    providerName: displayName(item.providerName, 'candidate.providerName'),
    connectionName: displayName(item.connectionName, 'candidate.connectionName'),
    modelName: displayName(item.modelName, 'candidate.modelName'),
    parameterSchema: validateParameterSchemaV2(item.parameterSchema as ParameterSchemaV2),
    usageSchema: {
      schemaVersion: 1,
      schemaId: opaqueId(usage.schemaId, 'candidate.usageSchema.schemaId'),
      revision: positiveInteger(usage.revision, 'candidate.usageSchema.revision')
    },
    cost: parseFeatureCandidateCostFact(item.cost),
    available: item.available,
    unavailableReasons
  };
}

export function parseSubmissionPreparation(value: unknown): SubmissionPreparationV1 {
  const item = exactRecord(
    value,
    ['schemaVersion', 'routeSelectionToken', 'expiresAt', 'confirmation'],
    'submission preparation'
  );
  if (item.schemaVersion !== 1) {
    throw new InvariantViolationError('submission preparation is invalid');
  }
  return {
    schemaVersion: 1,
    routeSelectionToken: routeSelectionToken(item.routeSelectionToken),
    expiresAt: toIsoTimestamp(String(item.expiresAt)),
    confirmation: parseSubmissionConfirmationDto(item.confirmation)
  };
}

export function parseSubmissionConfirmationDto(
  value: unknown
): SubmissionConfirmationDtoV1 {
  const item = exactRecord(
    value,
    [
      'schemaVersion',
      'confirmationId',
      'productFeature',
      'providerName',
      'connectionName',
      'modelName',
      'recipientName',
      'outboundScope',
      'contentCategories',
      'parameterFieldCount',
      'materialCount',
      'contextCount',
      'cost'
    ],
    'submission confirmation DTO'
  );
  if (item.schemaVersion !== 1 || !Array.isArray(item.contentCategories)) {
    throw new InvariantViolationError('submission confirmation DTO is invalid');
  }
  const contentCategories = item.contentCategories.map((category) =>
    opaqueId(category, 'confirmation content category')
  );
  if (new Set(contentCategories).size !== contentCategories.length) {
    throw new InvariantViolationError('submission confirmation categories must be unique');
  }
  return {
    schemaVersion: 1,
    confirmationId: opaqueId(item.confirmationId, 'confirmation.confirmationId'),
    productFeature: parseProductFeature(item.productFeature),
    providerName: displayName(item.providerName, 'confirmation.providerName'),
    connectionName: displayName(item.connectionName, 'confirmation.connectionName'),
    modelName: displayName(item.modelName, 'confirmation.modelName'),
    recipientName: displayName(item.recipientName, 'confirmation.recipientName'),
    outboundScope: oneOf(
      item.outboundScope,
      ['external_service', 'local_network', 'local_device', 'unknown'] as const,
      'confirmation.outboundScope'
    ),
    contentCategories,
    parameterFieldCount: nonNegativeInteger(
      item.parameterFieldCount,
      'confirmation.parameterFieldCount'
    ),
    materialCount: nonNegativeInteger(item.materialCount, 'confirmation.materialCount'),
    contextCount: nonNegativeInteger(item.contextCount, 'confirmation.contextCount'),
    cost: parseFeatureCandidateCostFact(item.cost)
  };
}

export function parseSubmissionUserConfirmation(
  value: unknown
): SubmissionUserConfirmationV1 {
  const item = exactRecord(
    value,
    ['schemaVersion', 'confirmationId', 'confirmed'],
    'submission user confirmation'
  );
  if (item.schemaVersion !== 1 || item.confirmed !== true) {
    throw new InvariantViolationError('submission user confirmation is invalid');
  }
  return {
    schemaVersion: 1,
    confirmationId: opaqueId(item.confirmationId, 'confirmation.confirmationId'),
    confirmed: true
  };
}

export function createSubmissionIntent(
  input: Omit<SubmissionIntentV1, 'schemaVersion' | 'status' | 'updatedAt'>
): SubmissionIntentV1 {
  return parseSubmissionIntent({
    schemaVersion: 1,
    ...input,
    status: 'authorization_pending',
    updatedAt: input.createdAt
  });
}

export function transitionSubmissionIntent(
  intent: SubmissionIntentV1,
  nextStatus: SubmissionIntentStatus,
  updatedAt: IsoTimestamp,
  details: { readonly providerOperationId?: string; readonly safeCode?: string } = {}
): SubmissionIntentV1 {
  const current = parseSubmissionIntent(intent);
  const transitions: Record<SubmissionIntentStatus, readonly SubmissionIntentStatus[]> = {
    authorization_pending: ['authorization_not_claimed', 'authorization_claimed'],
    authorization_not_claimed: [],
    authorization_claimed: ['request_started', 'failed_before_submission', 'cancelled'],
    request_started: ['provider_accepted', 'completed', 'failed', 'failed_before_submission', 'unknown_outcome'],
    provider_accepted: ['completed', 'failed', 'cancelled', 'unknown_outcome'],
    completed: [],
    failed: [],
    failed_before_submission: [],
    cancelled: [],
    unknown_outcome: []
  };
  if (!transitions[current.status].includes(nextStatus)) {
    throw new InvariantViolationError(
      `submission intent cannot transition from ${current.status} to ${nextStatus}`
    );
  }
  return parseSubmissionIntent({
    ...current,
    status: nextStatus,
    ...details,
    updatedAt
  });
}

export function parseSubmissionIntent(value: unknown): SubmissionIntentV1 {
  const item = exactRecordWithOptional(
    value,
    [
      'schemaVersion',
      'id',
      'projectId',
      'subject',
      'routeSnapshotId',
      'providerInvocationAttemptId',
      'idempotencyKey',
      'authorizationClaimId',
      'status',
      'createdAt',
      'updatedAt'
    ],
    ['providerOperationId', 'safeCode'],
    'submission intent'
  );
  if (
    item.schemaVersion !== 1 ||
    !submissionIntentStatuses.includes(item.status as SubmissionIntentStatus)
  ) {
    throw new InvariantViolationError('submission intent is invalid');
  }
  const createdAt = toIsoTimestamp(String(item.createdAt));
  const updatedAt = toIsoTimestamp(String(item.updatedAt));
  assertTimestampNotBefore(updatedAt, createdAt, 'submissionIntent.updatedAt');
  const status = item.status as SubmissionIntentStatus;
  const providerOperationId = item.providerOperationId === undefined
    ? undefined
    : opaqueId(item.providerOperationId, 'intent.providerOperationId');
  const safeCodeValue = item.safeCode === undefined
    ? undefined
    : safeCode(item.safeCode, 'intent.safeCode');
  if (
    ['provider_accepted', 'completed'].includes(status) && !providerOperationId
  ) {
    throw new InvariantViolationError(`${status} submission intent requires an operation ID`);
  }
  if (
    ['authorization_not_claimed', 'failed', 'failed_before_submission', 'unknown_outcome'].includes(status) &&
    !safeCodeValue
  ) {
    throw new InvariantViolationError(`${status} submission intent requires a safe code`);
  }
  return {
    schemaVersion: 1,
    id: toSubmissionIntentId(nonBlank(item.id, 'intent.id')),
    projectId: toProjectId(nonBlank(item.projectId, 'intent.projectId')),
    subject: parseFeatureCandidateSubject(item.subject),
    routeSnapshotId: toProviderExecutionRouteSnapshotId(
      nonBlank(item.routeSnapshotId, 'intent.routeSnapshotId')
    ),
    providerInvocationAttemptId: toProviderInvocationAttemptId(
      nonBlank(item.providerInvocationAttemptId, 'intent.providerInvocationAttemptId')
    ),
    idempotencyKey: opaqueId(item.idempotencyKey, 'intent.idempotencyKey'),
    authorizationClaimId: opaqueId(
      item.authorizationClaimId,
      'intent.authorizationClaimId'
    ),
    status,
    ...(providerOperationId ? { providerOperationId } : {}),
    ...(safeCodeValue ? { safeCode: safeCodeValue } : {}),
    createdAt,
    updatedAt
  };
}

function parseFeatureCandidateCostFact(value: unknown): FeatureCandidateCostFactV1 {
  const item = exactRecordWithOptional(
    value,
    ['state'],
    ['summary'],
    'candidate cost fact'
  );
  const state = oneOf(item.state, featureCandidateCostStates, 'candidate.cost.state');
  const summary = item.summary === undefined
    ? undefined
    : displayName(item.summary, 'candidate.cost.summary');
  if ((state === 'known') !== (summary !== undefined)) {
    throw new InvariantViolationError('candidate cost fact is inconsistent');
  }
  return { state, ...(summary ? { summary } : {}) };
}

function routeSelectionToken(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^rst1_[A-Za-z0-9_-]{32,256}$/.test(value)
  ) {
    throw new InvariantViolationError('route selection token is invalid');
  }
  return value;
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  label: string
): Record<string, unknown> {
  const item = record(value, label);
  requireExactKeys(item, keys, label);
  return item;
}

function exactRecordWithOptional(
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

function displayName(value: unknown, label: string): string {
  const result = nonBlank(value, label);
  if (result.length > 200) throw new InvariantViolationError(`${label} is too long`);
  return result;
}

function opaqueId(value: unknown, label: string): string {
  const id = nonBlank(value, label);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(id)) {
    throw new InvariantViolationError(`${label} is invalid`);
  }
  return id;
}

function safeCode(value: unknown, label: string): string {
  const code = nonBlank(value, label);
  if (!/^[a-z0-9][a-z0-9_.-]{0,127}$/.test(code)) {
    throw new InvariantViolationError(`${label} is invalid`);
  }
  return code;
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

function oneOf<T extends string>(value: unknown, values: readonly T[], label: string): T {
  if (!values.includes(value as T)) {
    throw new InvariantViolationError(`${label} is invalid`);
  }
  return value as T;
}
