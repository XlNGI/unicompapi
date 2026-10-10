import {
  parseConversationResponseExecution,
  parseConversationResponseStreamEvent,
  parseProviderExecutionRouteSnapshot,
  parseProviderInvocationAttempt,
  parseProviderInvocationEvent,
  parseSubmissionIntent,
  projectConversationResponseExecutionState,
  projectProviderInvocationState,
  type ConversationResponseExecutionV1,
  type ConversationResponseStreamEventV1,
  type Execution,
  type ProviderExecutionRouteSnapshotV1,
  type ProviderInvocationAttemptV1,
  type ProviderInvocationEventV1,
  type ProviderOperationRecord,
  type SubmissionIntentId,
  type SubmissionIntentV1,
  type Task
} from '../../domain';
import {
  assertSafeJsonValue,
  JsonRevisionConflictError,
  type JsonValue
} from './json-document';
import type { ProjectMetadataUnitOfWork } from './project-metadata-unit-of-work';

const acceptanceMetadataKey = 'provider.submission.acceptances.v1';

export type SubmissionSubjectArtifactsV1 =
  | {
      readonly kind: 'media';
      readonly task: Task;
      readonly execution: Execution;
    }
  | {
      readonly kind: 'conversation';
      readonly responseExecution: ConversationResponseExecutionV1;
      readonly responseStreamEvents: readonly ConversationResponseStreamEventV1[];
    };

export interface ProjectSubmissionAcceptanceV1 {
  readonly schemaVersion: 1;
  readonly intent: SubmissionIntentV1;
  readonly routeSnapshot: ProviderExecutionRouteSnapshotV1;
  readonly invocationAttempt: ProviderInvocationAttemptV1;
  readonly invocationEvents: readonly ProviderInvocationEventV1[];
  readonly subjectArtifacts: SubmissionSubjectArtifactsV1;
  readonly providerOperationRecord?: ProviderOperationRecord;
}

export class ProjectSubmissionAcceptanceError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'ProjectSubmissionAcceptanceError';
  }
}

export class ProjectSubmissionAcceptanceStore {
  constructor(private readonly metadata: ProjectMetadataUnitOfWork) {}

  async list(): Promise<readonly ProjectSubmissionAcceptanceV1[]> {
    const loaded = await this.metadata.load();
    return parseAcceptanceList(
      loaded.document.entries.find((entry) => entry.key === acceptanceMetadataKey)?.value
    );
  }

  async get(intentId: SubmissionIntentId): Promise<ProjectSubmissionAcceptanceV1 | undefined> {
    return (await this.list()).find((acceptance) => acceptance.intent.id === intentId);
  }

  async getByIdempotencyKey(
    idempotencyKey: string
  ): Promise<ProjectSubmissionAcceptanceV1 | undefined> {
    return (await this.list()).find(
      (acceptance) => acceptance.intent.idempotencyKey === idempotencyKey
    );
  }

  async getByInvocationAttemptId(
    providerInvocationAttemptId: ProviderInvocationAttemptV1['id']
  ): Promise<ProjectSubmissionAcceptanceV1 | undefined> {
    return (await this.list()).find(
      (acceptance) => acceptance.invocationAttempt.id === providerInvocationAttemptId
    );
  }

  async scanRecovery(): Promise<readonly ProjectSubmissionRecoveryDecision[]> {
    const decisions: ProjectSubmissionRecoveryDecision[] = [];
    for (const acceptance of await this.list()) {
      const base = {
        submissionIntentId: acceptance.intent.id,
        idempotencyKey: acceptance.intent.idempotencyKey,
        authorizationClaimId: acceptance.intent.authorizationClaimId
      };
      if (acceptance.intent.status === 'authorization_pending') {
        decisions.push({ ...base, action: 'reconcile_unclaimed_authorization' });
        continue;
      }
      if (acceptance.intent.status === 'authorization_claimed') {
        decisions.push({ ...base, action: 'release_authorization_claim' });
        continue;
      }
      if (acceptance.intent.status === 'request_started') {
        decisions.push({ ...base, action: 'mark_unknown_outcome', retryAllowed: false });
        continue;
      }
      if (acceptance.intent.status === 'provider_accepted') {
        decisions.push({
          ...base,
          action: 'resume_provider_operation',
          routeSnapshotId: acceptance.routeSnapshot.id,
          providerOperationId: acceptance.intent.providerOperationId!,
          allowedActions: ['query', 'cancel', 'receive_result']
        });
      }
    }
    return decisions;
  }

  async accept(acceptance: ProjectSubmissionAcceptanceV1): Promise<void> {
    const validated = parseProjectSubmissionAcceptance(acceptance);
    await this.transact((current) => {
      const sameIntent = current.find((item) => item.intent.id === validated.intent.id);
      const sameIdempotency = current.find(
        (item) => item.intent.idempotencyKey === validated.intent.idempotencyKey
      );
      if (sameIntent || sameIdempotency) {
        if (
          sameIntent &&
          sameIdempotency &&
          sameIntent.intent.id === sameIdempotency.intent.id &&
          sameJson(sameIntent, validated)
        ) {
          return current;
        }
        throw new ProjectSubmissionAcceptanceError(
          'Submission acceptance identity or idempotency key already exists'
        );
      }
      return [...current, validated];
    });
  }

  async advance(input: {
    readonly intent: SubmissionIntentV1;
    readonly invocationEvent?: ProviderInvocationEventV1;
    readonly providerOperationRecord?: ProviderOperationRecord;
  }): Promise<ProjectSubmissionAcceptanceV1> {
    const intent = parseSubmissionIntent(input.intent);
    let result: ProjectSubmissionAcceptanceV1 | undefined;
    await this.transact((current) => {
      const index = current.findIndex((item) => item.intent.id === intent.id);
      if (index < 0) {
        throw new ProjectSubmissionAcceptanceError('Submission acceptance does not exist');
      }
      const existing = current[index];
      if (
        intent.projectId !== existing.intent.projectId ||
        intent.routeSnapshotId !== existing.intent.routeSnapshotId ||
        intent.providerInvocationAttemptId !== existing.intent.providerInvocationAttemptId ||
        intent.idempotencyKey !== existing.intent.idempotencyKey ||
        intent.authorizationClaimId !== existing.intent.authorizationClaimId
      ) {
        throw new ProjectSubmissionAcceptanceError(
          'Submission intent immutable fields changed'
        );
      }
      let invocationEvents = existing.invocationEvents;
      let invocationAttempt = existing.invocationAttempt;
      if (input.invocationEvent) {
        const event = parseProviderInvocationEvent(input.invocationEvent);
        if (event.invocationAttemptId !== invocationAttempt.id) {
          throw new ProjectSubmissionAcceptanceError(
            'Submission invocation event belongs to another attempt'
          );
        }
        const duplicate = invocationEvents.find((item) => item.id === event.id);
        if (duplicate) {
          if (!sameJson(duplicate, event)) {
            throw new ProjectSubmissionAcceptanceError(
              'Submission invocation event identity conflict'
            );
          }
        } else {
          if (event.sequence !== invocationEvents.length + 1) {
            throw new ProjectSubmissionAcceptanceError(
              'Submission invocation event sequence must be contiguous'
            );
          }
          invocationEvents = [...invocationEvents, event];
        }
        invocationAttempt = {
          ...invocationAttempt,
          state: projectProviderInvocationState(invocationAttempt, invocationEvents)
        };
      }
      const updated = parseProjectSubmissionAcceptance({
        ...existing,
        intent,
        invocationAttempt,
        invocationEvents,
        ...(input.providerOperationRecord
          ? { providerOperationRecord: input.providerOperationRecord }
          : {})
      });
      const next = [...current];
      next[index] = updated;
      result = updated;
      return next;
    });
    return result!;
  }

  private async transact(
    mutate: (
      current: readonly ProjectSubmissionAcceptanceV1[]
    ) => readonly ProjectSubmissionAcceptanceV1[]
  ): Promise<void> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const loaded = await this.metadata.load();
      const current = parseAcceptanceList(
        loaded.document.entries.find((entry) => entry.key === acceptanceMetadataKey)?.value
      );
      const next = mutate(current);
      try {
        await this.metadata.transact(loaded.document.revision, (draft) => {
          draft.set(acceptanceMetadataKey, toJsonValue(next));
        });
        return;
      } catch (error) {
        if (error instanceof JsonRevisionConflictError && attempt < 4) continue;
        throw error;
      }
    }
  }
}

export function parseProjectSubmissionAcceptance(
  value: unknown
): ProjectSubmissionAcceptanceV1 {
  const item = exactRecordWithOptional(
    value,
    [
      'schemaVersion',
      'intent',
      'routeSnapshot',
      'invocationAttempt',
      'invocationEvents',
      'subjectArtifacts'
    ],
    ['providerOperationRecord']
  );
  if (
    item.schemaVersion !== 1 ||
    !Array.isArray(item.invocationEvents)
  ) {
    throw invalidAcceptance();
  }
  const intent = parseSubmissionIntent(item.intent);
  const routeSnapshot = parseProviderExecutionRouteSnapshot(item.routeSnapshot);
  const invocationAttempt = parseProviderInvocationAttempt(item.invocationAttempt);
  const invocationEvents = item.invocationEvents.map(parseProviderInvocationEvent);
  const subjectArtifacts = parseSubjectArtifacts(item.subjectArtifacts);
  const projectedState = projectProviderInvocationState(invocationAttempt, invocationEvents);
  if (
    routeSnapshot.projectId !== intent.projectId ||
    routeSnapshot.id !== intent.routeSnapshotId ||
    routeSnapshot.runtimeAuthorizationClaimId !== intent.authorizationClaimId ||
    invocationAttempt.projectId !== intent.projectId ||
    invocationAttempt.id !== intent.providerInvocationAttemptId ||
    invocationAttempt.routeSnapshotId !== routeSnapshot.id ||
    invocationAttempt.state !== projectedState
  ) {
    throw invalidAcceptance();
  }
  if (subjectArtifacts.kind === 'media') {
    if (
      intent.subject.kind !== 'draft' ||
      subjectArtifacts.task.projectId !== intent.projectId ||
      subjectArtifacts.task.sourceDraftId !== intent.subject.draftId ||
      subjectArtifacts.execution.taskId !== subjectArtifacts.task.id ||
      !subjectArtifacts.task.executionIds.includes(subjectArtifacts.execution.id) ||
      invocationAttempt.subject.kind !== 'media' ||
      invocationAttempt.subject.taskId !== subjectArtifacts.task.id ||
      invocationAttempt.subject.executionId !== subjectArtifacts.execution.id
    ) {
      throw invalidAcceptance();
    }
  } else if (
    intent.subject.kind !== 'conversation_response_draft' ||
    subjectArtifacts.responseExecution.projectId !== intent.projectId ||
    subjectArtifacts.responseExecution.snapshot.conversationId !== intent.subject.conversationId ||
    subjectArtifacts.responseExecution.snapshot.responseDraftId !== intent.subject.responseDraftId ||
    subjectArtifacts.responseExecution.providerInvocationAttemptId !== invocationAttempt.id ||
    subjectArtifacts.responseExecution.snapshot.routeSnapshotId !== routeSnapshot.id ||
    invocationAttempt.subject.kind !== 'conversation' ||
    invocationAttempt.subject.responseExecutionId !== subjectArtifacts.responseExecution.id ||
    invocationAttempt.subject.conversationId !== intent.subject.conversationId ||
    invocationAttempt.subject.userMessageId !== intent.subject.userMessageId ||
    projectConversationResponseExecutionState(
      subjectArtifacts.responseExecution,
      subjectArtifacts.responseStreamEvents
    ) !== subjectArtifacts.responseExecution.state
  ) {
    throw invalidAcceptance();
  }
  const providerOperationRecord = item.providerOperationRecord === undefined
    ? undefined
    : parseProviderOperationRecord(item.providerOperationRecord, subjectArtifacts);
  if (
    subjectArtifacts.kind === 'media' &&
    ['provider_accepted', 'completed'].includes(intent.status) &&
    !providerOperationRecord
  ) {
    throw invalidAcceptance();
  }
  return {
    schemaVersion: 1,
    intent,
    routeSnapshot,
    invocationAttempt,
    invocationEvents,
    subjectArtifacts,
    ...(providerOperationRecord ? { providerOperationRecord } : {})
  };
}

export type ProjectSubmissionRecoveryDecision =
  | {
      readonly action: 'reconcile_unclaimed_authorization';
      readonly submissionIntentId: SubmissionIntentId;
      readonly idempotencyKey: string;
      readonly authorizationClaimId: string;
    }
  | {
      readonly action: 'release_authorization_claim';
      readonly submissionIntentId: SubmissionIntentId;
      readonly idempotencyKey: string;
      readonly authorizationClaimId: string;
    }
  | {
      readonly action: 'mark_unknown_outcome';
      readonly submissionIntentId: SubmissionIntentId;
      readonly idempotencyKey: string;
      readonly authorizationClaimId: string;
      readonly retryAllowed: false;
    }
  | {
      readonly action: 'resume_provider_operation';
      readonly submissionIntentId: SubmissionIntentId;
      readonly idempotencyKey: string;
      readonly authorizationClaimId: string;
      readonly routeSnapshotId: ProviderExecutionRouteSnapshotV1['id'];
      readonly providerOperationId: string;
      readonly allowedActions: readonly ['query', 'cancel', 'receive_result'];
    };

function parseAcceptanceList(value: JsonValue | undefined): readonly ProjectSubmissionAcceptanceV1[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw invalidAcceptance();
  const acceptances = value.map(parseProjectSubmissionAcceptance);
  if (
    new Set(acceptances.map((item) => item.intent.id)).size !== acceptances.length ||
    new Set(acceptances.map((item) => item.intent.idempotencyKey)).size !== acceptances.length
  ) {
    throw invalidAcceptance();
  }
  return acceptances;
}

function parseSubjectArtifacts(value: unknown): SubmissionSubjectArtifactsV1 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalidAcceptance();
  }
  const normalized = JSON.parse(JSON.stringify(value)) as JsonValue;
  assertSafeJsonValue(normalized, 'submission subject artifacts');
  const item = normalized as Record<string, unknown>;
  if (item.kind === 'media') {
    const exact = exactRecord(normalized, ['kind', 'task', 'execution']);
    return {
      kind: 'media',
      task: exact.task as unknown as Task,
      execution: exact.execution as unknown as Execution
    };
  }
  if (item.kind === 'conversation') {
    const exact = exactRecord(
      normalized,
      ['kind', 'responseExecution', 'responseStreamEvents']
    );
    if (!Array.isArray(exact.responseStreamEvents)) throw invalidAcceptance();
    return {
      kind: 'conversation',
      responseExecution: parseConversationResponseExecution(exact.responseExecution),
      responseStreamEvents: exact.responseStreamEvents.map(parseConversationResponseStreamEvent)
    };
  }
  throw invalidAcceptance();
}

function parseProviderOperationRecord(
  value: unknown,
  artifacts: SubmissionSubjectArtifactsV1
): ProviderOperationRecord {
  if (artifacts.kind !== 'media') throw invalidAcceptance();
  assertSafeJsonValue(value, 'provider operation record');
  const record = value as unknown as ProviderOperationRecord;
  if (
    record.schemaVersion !== 2 ||
    record.taskId !== artifacts.task.id ||
    record.executionId !== artifacts.execution.id
  ) {
    throw invalidAcceptance();
  }
  return structuredClone(record);
}

function toJsonValue(value: unknown): JsonValue {
  const normalized = JSON.parse(JSON.stringify(value)) as JsonValue;
  assertSafeJsonValue(normalized, 'project submission acceptances');
  return normalized;
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const item = value as Record<string, unknown>;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalidAcceptance();
  }
  const allowed = new Set(keys);
  if (
    Object.keys(item).length !== allowed.size ||
    Object.keys(item).some((key) => !allowed.has(key))
  ) {
    throw invalidAcceptance();
  }
  return item;
}

function exactRecordWithOptional(
  value: unknown,
  required: readonly string[],
  optional: readonly string[]
): Record<string, unknown> {
  const item = value as Record<string, unknown>;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalidAcceptance();
  }
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !(key in item)) ||
    Object.keys(item).some((key) => !allowed.has(key))
  ) {
    throw invalidAcceptance();
  }
  return item;
}

function invalidAcceptance(): ProjectSubmissionAcceptanceError {
  return new ProjectSubmissionAcceptanceError('Project submission acceptance is invalid');
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
