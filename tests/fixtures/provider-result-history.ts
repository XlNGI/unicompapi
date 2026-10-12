import {
  addExecutionToTask,
  createDraft,
  createExecution,
  createProviderExecutionRouteSnapshot,
  createProviderOperationRecord,
  createTaskFromDraft,
  toConnectionId,
  toDraftId,
  toExecutionId,
  toIsoTimestamp,
  toModelId,
  toProjectId,
  toProtocolBindingId,
  toProviderExecutionRouteSnapshotId,
  toProviderId,
  toProviderInvocationAttemptId,
  toProviderInvocationEventId,
  toProviderOperationRecordId,
  toSubmissionIntentId,
  toTaskId,
  toUsageSchemaId,
  transitionExecution,
  type ProjectId,
  type ProviderImmediateResultReference,
  type ProviderOperationRecord
} from '../../src/domain';
import type { JsonValue } from '../../src/platform/storage/json-document';
import type { ProjectMetadataDocumentV1 } from '../../src/platform/storage/project-metadata-unit-of-work';
import {
  parseProjectSubmissionAcceptance,
  type ProjectSubmissionAcceptanceV1
} from '../../src/platform/storage/project-submission-acceptance';

export const acceptanceMetadataKey = 'provider.submission.acceptances.v1';
export const historyCreatedAt = toIsoTimestamp('2026-10-01T08:00:00.000Z');
export const historyUpdatedAt = toIsoTimestamp('2026-10-01T08:01:00.000Z');
export const historyImageBase64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWhsAAAAASUVORK5CYII=';

export function createAcceptance(index = 0, options: {
  readonly projectId?: ProjectId;
  readonly results?: readonly ProviderImmediateResultReference[];
  readonly includeResult?: boolean;
} = {}): ProjectSubmissionAcceptanceV1 {
  const projectId = options.projectId ?? toProjectId('project-result-history');
  const draft = createDraft({
    id: toDraftId(`draft-history-${index}`),
    projectId,
    kind: 'image_generation',
    state: 'saved',
    prompt: { originalInput: 'Fixture image', systemSupplements: [], finalPrompt: 'Fixture image' },
    selectedAssetIds: [],
    createdAt: historyCreatedAt,
    updatedAt: historyCreatedAt
  });
  const task = createTaskFromDraft({
    id: toTaskId(`task-history-${index}`), draft, confirmedAt: historyCreatedAt
  });
  const submitting = transitionExecution(createExecution({
    id: toExecutionId(`execution-history-${index}`),
    taskId: task.id,
    createdAt: historyCreatedAt
  }), 'submitting', historyCreatedAt);
  const includeResult = options.includeResult !== false;
  const record = createProviderOperationRecord({
    id: toProviderOperationRecordId(`receipt-history-${index}`),
    taskId: task.id,
    executionId: submitting.id,
    mediaKind: 'image',
    executionLifecycle: 'synchronous_completed',
    outcome: {
      kind: 'completed_sync',
      providerOperationId: `operation-history-${index}`,
      results: options.results ?? [{ kind: 'base64', value: historyImageBase64, mimeType: 'image/png' }]
    },
    createdAt: historyCreatedAt,
    updatedAt: historyUpdatedAt
  });
  const execution = includeResult
    ? transitionExecution(submitting, 'remote_completed', historyUpdatedAt, {
        providerOperationRecordId: record.id, submissionOutcome: 'completed_sync'
      })
    : submitting;
  const routeSnapshot = createProviderExecutionRouteSnapshot({
    id: toProviderExecutionRouteSnapshotId(`route-history-${index}`),
    projectId,
    packageId: 'fixture.images',
    packageVersion: '1.0.0',
    adapterKey: 'fixture-images',
    adapterVersion: '1.0.0',
    providerId: toProviderId('provider-history'),
    connectionId: toConnectionId('connection-history'),
    connectionRevision: 1,
    connectionConfigVersionId: 'config-history',
    endpointPolicyId: 'endpoint-history',
    endpointPolicyRevision: 1,
    credentialVersionId: 'credential-version-fixture',
    modelId: toModelId('model-history'),
    modelRevision: 1,
    profileId: 'profile-history',
    profileRevision: 1,
    protocolBindingId: toProtocolBindingId('binding-history'),
    protocolBindingRevision: 1,
    productFeature: 'text_to_image',
    internalPurpose: 'image_generation',
    featureMappingVersion: 1,
    parameterSchemaId: 'parameters-history',
    parameterSchemaRevision: 1,
    resultSchemaId: 'results-history',
    resultSchemaRevision: 1,
    usageSchemaId: toUsageSchemaId('usage-history'),
    usageSchemaRevision: 1,
    constraintSetId: 'constraints-history',
    constraintSetRevision: 1,
    runtimePolicyId: 'policy-history',
    runtimePolicyRevision: 1,
    runtimeAuthorizationClaimId: `claim-history-${index}`,
    createdAt: historyCreatedAt
  });
  const attemptId = toProviderInvocationAttemptId(`attempt-history-${index}`);
  return parseProjectSubmissionAcceptance({
    schemaVersion: 1,
    intent: {
      schemaVersion: 1,
      id: toSubmissionIntentId(`intent-history-${index}`),
      projectId,
      subject: { kind: 'draft', draftId: draft.id, draftRevision: 0 },
      routeSnapshotId: routeSnapshot.id,
      providerInvocationAttemptId: attemptId,
      idempotencyKey: `idempotency-history-${index}`,
      authorizationClaimId: routeSnapshot.runtimeAuthorizationClaimId,
      status: includeResult ? 'provider_accepted' : 'request_started',
      ...(includeResult ? { providerOperationId: `operation-history-${index}` } : {}),
      createdAt: historyCreatedAt,
      updatedAt: includeResult ? historyUpdatedAt : historyCreatedAt
    },
    routeSnapshot,
    invocationAttempt: {
      schemaVersion: 1,
      id: attemptId,
      projectId,
      subject: { kind: 'media', taskId: task.id, executionId: execution.id },
      routeSnapshotId: routeSnapshot.id,
      state: includeResult ? 'accepted' : 'submitting',
      createdAt: historyCreatedAt
    },
    invocationEvents: [
      {
        schemaVersion: 1,
        id: toProviderInvocationEventId(`event-started-${index}`),
        invocationAttemptId: attemptId,
        sequence: 1,
        type: 'submission_started',
        occurredAt: historyCreatedAt
      },
      ...(includeResult ? [{
        schemaVersion: 1,
        id: toProviderInvocationEventId(`event-accepted-${index}`),
        invocationAttemptId: attemptId,
        sequence: 2,
        type: 'provider_accepted',
        occurredAt: historyUpdatedAt
      }] : [])
    ],
    subjectArtifacts: { kind: 'media', task: addExecutionToTask(task, execution), execution },
    ...(includeResult ? { providerOperationRecord: record } : {})
  });
}

export function createProviderResultHistoryFixture(options: {
  readonly operationCount?: number;
  readonly acceptanceCount?: number;
  readonly base64?: string;
  readonly projectId?: ProjectId;
} = {}) {
  const operationCount = options.operationCount ?? 52;
  const acceptanceCount = options.acceptanceCount ?? 267;
  if (!Number.isSafeInteger(operationCount) || !Number.isSafeInteger(acceptanceCount) ||
      operationCount < 0 || acceptanceCount < operationCount) {
    throw new TypeError('History counts must be integers with 0 <= operations <= acceptances');
  }
  const acceptances = Array.from({ length: acceptanceCount }, (_, index) => createAcceptance(index, {
    projectId: options.projectId,
    includeResult: index < operationCount,
    results: [{ kind: 'base64', value: options.base64 ?? historyImageBase64, mimeType: 'image/png' }]
  }));
  const operations = acceptances.flatMap((acceptance) => acceptance.providerOperationRecord
    ? [acceptance.providerOperationRecord] : []);
  const operationDocument: { schemaVersion: 2; revision: number; records: ProviderOperationRecord[] } = {
    schemaVersion: 2, revision: 7, records: operations
  };
  const metadataDocument: ProjectMetadataDocumentV1 = {
    schemaVersion: 1,
    revision: 11,
    updatedAt: historyUpdatedAt,
    entries: [
      { key: acceptanceMetadataKey, value: JSON.parse(JSON.stringify(acceptances)) as JsonValue },
      { key: 'fixture.unrelated', value: { title: 'Keep this metadata', enabled: false, count: 23 } }
    ]
  };
  return { acceptances, operations, operationDocument, metadataDocument };
}
