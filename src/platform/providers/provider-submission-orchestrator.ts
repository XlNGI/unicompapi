import {
  createProviderExecutionRouteSnapshot,
  createProviderInvocationAttempt,
  createProviderInvocationEvent,
  createSubmissionIntent,
  parseFeatureCandidateSubject,
  parseSubmissionUserConfirmation,
  toIsoTimestamp,
  transitionSubmissionIntent,
  type FeatureCandidateSubjectV1,
  type IsoTimestamp,
  type ProviderExecutionRouteSnapshotId,
  type ProviderInvocationAttemptId,
  type ProviderInvocationEventId,
  type ProviderInvocationEventV1,
  type ProviderOperationRecord,
  type SubmissionIntentId,
  type SubmissionIntentStatus,
  type SubmissionUserConfirmationV1
} from '../../domain';
import type {
  ProjectSubmissionAcceptanceStore,
  ProjectSubmissionAcceptanceV1,
  SubmissionSubjectArtifactsV1
} from '../storage/project-submission-acceptance';
import type {
  RuntimeAuthorizationClaim
} from '../../domain';
import type {
  ResolvedFeatureCandidateV1,
  ResolvedFeatureSubjectV1
} from './provider-feature-candidates';
import type { ProviderFeatureCandidateService } from './provider-feature-candidates';
import type {
  RuntimeAuthorizationClaimInput,
  RuntimeAuthorizationDecision
} from './runtime-authorization-ledger';
import type {
  SubmissionIntentJournal,
  SubmissionIntentJournalEventV1
} from '../storage/submission-intent-journal';

export interface ProviderSubmissionOrchestrationIdFactory {
  nextSubmissionIntentId(): SubmissionIntentId;
  nextRouteSnapshotId(): ProviderExecutionRouteSnapshotId;
  nextProviderInvocationAttemptId(): ProviderInvocationAttemptId;
  nextProviderInvocationEventId(): ProviderInvocationEventId;
  nextAuthorizationClaimId(): string;
  nextJournalEventId(): string;
}

export interface RuntimeAuthorizationOrchestrationPort {
  claimSubmission(input: RuntimeAuthorizationClaimInput): Promise<RuntimeAuthorizationClaim>;
  markRequestStarted(claimId: string, now?: string): Promise<RuntimeAuthorizationClaim>;
  releaseBeforeRequest(claimId: string, now?: string): Promise<RuntimeAuthorizationClaim>;
  recordOutcome(claimId: string, now?: string): Promise<RuntimeAuthorizationClaim>;
  authorizeContinuation?(input: {
    readonly claimId: string;
    readonly operation: 'query' | 'cancel' | 'receive_result';
    readonly now?: string;
  }): Promise<RuntimeAuthorizationDecision>;
}

export interface SubmissionArtifactFactoryPort {
  create(input: {
    readonly subject: ResolvedFeatureSubjectV1;
    readonly candidate: ResolvedFeatureCandidateV1;
    readonly routeSnapshotId: ProviderExecutionRouteSnapshotId;
    readonly invocationAttemptId: ProviderInvocationAttemptId;
    readonly authorizationClaimId: string;
    readonly createdAt: IsoTimestamp;
  }): Promise<{
    readonly subjectArtifacts: SubmissionSubjectArtifactsV1;
    readonly dispatchRequest: unknown;
  }>;
}

export type SubmissionDispatchOutcome =
  | {
      readonly kind: 'failed_before_submission';
      readonly safeCode: string;
    }
  | {
      readonly kind: 'accepted_async';
      readonly providerOperationId: string;
      readonly providerOperationRecord?: ProviderOperationRecord;
    }
  | {
      readonly kind: 'completed_sync';
      readonly providerOperationId: string;
      readonly providerOperationRecord?: ProviderOperationRecord;
    }
  | {
      readonly kind: 'unknown_outcome';
      readonly providerOperationId?: string;
      readonly safeCode: string;
    };

export interface SubmissionDispatchPort {
  submit(input: {
    readonly routeSnapshot: ProjectSubmissionAcceptanceV1['routeSnapshot'];
    readonly request: unknown;
    readonly beforeRequestStarted: () => Promise<void>;
  }): Promise<SubmissionDispatchOutcome>;
}

export interface SubmissionOrchestrationResultV1 {
  readonly schemaVersion: 1;
  readonly submissionIntentId: string;
  readonly status: SubmissionIntentStatus;
  readonly retryAllowed: false;
}

export type SubmissionOrchestrationErrorCode =
  | 'subject_kind_mismatch'
  | 'authorization_not_claimed'
  | 'submission_failed_before_request'
  | 'submission_outcome_unknown'
  | 'adapter_contract_invalid';

export class SubmissionOrchestrationError extends Error {
  constructor(
    readonly code: SubmissionOrchestrationErrorCode,
    message: string,
    readonly result?: SubmissionOrchestrationResultV1,
    readonly cause?: unknown
  ) {
    super(message);
    this.name = 'SubmissionOrchestrationError';
  }
}

export class ProviderSubmissionOrchestrator {
  constructor(
    private readonly candidates: ProviderFeatureCandidateService,
    private readonly acceptances: ProjectSubmissionAcceptanceStore,
    private readonly authorization: RuntimeAuthorizationOrchestrationPort,
    private readonly journal: SubmissionIntentJournal,
    private readonly artifacts: SubmissionArtifactFactoryPort,
    private readonly dispatch: SubmissionDispatchPort,
    private readonly ids: ProviderSubmissionOrchestrationIdFactory,
    private readonly now: () => string = () => new Date().toISOString()
  ) {}

  submitDraft(input: {
    readonly subject: FeatureCandidateSubjectV1;
    readonly routeSelectionToken: string;
    readonly confirmation: SubmissionUserConfirmationV1;
  }): Promise<SubmissionOrchestrationResultV1> {
    const subject = parseFeatureCandidateSubject(input.subject);
    if (subject.kind !== 'draft') {
      throw new SubmissionOrchestrationError(
        'subject_kind_mismatch',
        'Media submission requires a persisted draft subject'
      );
    }
    return this.submit({ ...input, subject });
  }

  submitConversationResponse(input: {
    readonly subject: FeatureCandidateSubjectV1;
    readonly routeSelectionToken: string;
    readonly confirmation: SubmissionUserConfirmationV1;
  }): Promise<SubmissionOrchestrationResultV1> {
    const subject = parseFeatureCandidateSubject(input.subject);
    if (subject.kind !== 'conversation_response_draft') {
      throw new SubmissionOrchestrationError(
        'subject_kind_mismatch',
        'Conversation response submission requires a response draft subject'
      );
    }
    return this.submit({ ...input, subject });
  }

  private async submit(input: {
    readonly subject: FeatureCandidateSubjectV1;
    readonly routeSelectionToken: string;
    readonly confirmation: SubmissionUserConfirmationV1;
  }): Promise<SubmissionOrchestrationResultV1> {
    const inspected = this.candidates.inspectPreparedSubmission(input.routeSelectionToken);
    const existing = await this.acceptances.getByIdempotencyKey(inspected.idempotencyKey);
    if (existing) return result(existing);

    const prepared = await this.candidates.validatePreparedSubmission({
      subject: input.subject,
      routeSelectionToken: input.routeSelectionToken,
      confirmation: parseSubmissionUserConfirmation(input.confirmation)
    });
    const createdAt = toIsoTimestamp(this.now());
    const claimId = this.ids.nextAuthorizationClaimId();
    const routeSnapshotId = this.ids.nextRouteSnapshotId();
    const invocationAttemptId = this.ids.nextProviderInvocationAttemptId();
    const intentId = this.ids.nextSubmissionIntentId();
    const routeSnapshot = createProviderExecutionRouteSnapshot({
      id: routeSnapshotId,
      projectId: prepared.subject.projectId,
      ...prepared.candidate.routeTemplate,
      runtimeAuthorizationClaimId: claimId,
      createdAt
    });
    const built = await this.artifacts.create({
      subject: prepared.subject,
      candidate: prepared.candidate,
      routeSnapshotId,
      invocationAttemptId,
      authorizationClaimId: claimId,
      createdAt
    });
    const invocationSubject = built.subjectArtifacts.kind === 'media'
      ? {
          kind: 'media' as const,
          taskId: built.subjectArtifacts.task.id,
          executionId: built.subjectArtifacts.execution.id
        }
      : {
          kind: 'conversation' as const,
          conversationId: built.subjectArtifacts.responseExecution.snapshot.conversationId,
          userMessageId: built.subjectArtifacts.responseExecution.snapshot.userMessageId,
          responseExecutionId: built.subjectArtifacts.responseExecution.id
        };
    const invocationAttempt = createProviderInvocationAttempt({
      id: invocationAttemptId,
      projectId: prepared.subject.projectId,
      subject: invocationSubject,
      routeSnapshotId,
      createdAt
    });
    const initialInvocationEvent = this.invocationEvent(
      invocationAttemptId,
      1,
      'submission_started',
      createdAt
    );
    let intent = createSubmissionIntent({
      id: intentId,
      projectId: prepared.subject.projectId,
      subject: prepared.subject.subject,
      routeSnapshotId,
      providerInvocationAttemptId: invocationAttemptId,
      idempotencyKey: prepared.tokenRecord.idempotencyKey,
      authorizationClaimId: claimId,
      createdAt
    });
    const acceptance: ProjectSubmissionAcceptanceV1 = {
      schemaVersion: 1,
      intent,
      routeSnapshot,
      invocationAttempt,
      invocationEvents: [initialInvocationEvent],
      subjectArtifacts: built.subjectArtifacts
    };
    try {
      await this.acceptances.accept(acceptance);
    } catch (error) {
      const concurrent = await this.acceptances.getByIdempotencyKey(
        prepared.tokenRecord.idempotencyKey
      );
      if (concurrent) return result(concurrent);
      throw error;
    }
    await this.appendJournal(intent, 'intent_recorded');

    try {
      await this.authorization.claimSubmission({
        providerPackageId: routeSnapshot.packageId,
        connectionId: routeSnapshot.connectionId,
        adapterKey: routeSnapshot.adapterKey,
        policyRevision: routeSnapshot.runtimePolicyRevision,
        routeSelectionNonce: prepared.tokenRecord.nonce,
        idempotencyKey: prepared.tokenRecord.idempotencyKey,
        claimId,
        now: createdAt
      });
    } catch (error) {
      const failedAt = toIsoTimestamp(this.now());
      const safeCode = authorizationSafeCode(error);
      intent = transitionSubmissionIntent(
        intent,
        'authorization_not_claimed',
        failedAt,
        { safeCode }
      );
      const updated = await this.acceptances.advance({
        intent,
        invocationEvent: this.invocationEvent(
          invocationAttemptId,
          2,
          'submission_failed_before_request',
          failedAt,
          safeCode
        )
      });
      await this.appendJournal(intent, 'failed_before_request');
      throw new SubmissionOrchestrationError(
        'authorization_not_claimed',
        'Runtime authorization could not be claimed; no request was sent',
        result(updated),
        error
      );
    }

    this.candidates.consumePreparedSubmission(input.routeSelectionToken);
    intent = transitionSubmissionIntent(intent, 'authorization_claimed', toIsoTimestamp(this.now()));
    await this.acceptances.advance({ intent });
    await this.appendJournal(intent, 'authorization_claimed');

    let requestStarted = false;
    const beforeRequestStarted = async () => {
      if (requestStarted) return;
      const startedAt = toIsoTimestamp(this.now());
      await this.authorization.markRequestStarted(claimId, startedAt);
      intent = transitionSubmissionIntent(intent, 'request_started', startedAt);
      await this.acceptances.advance({ intent });
      await this.appendJournal(intent, 'request_started');
      requestStarted = true;
    };

    let outcome: SubmissionDispatchOutcome;
    try {
      outcome = await this.dispatch.submit({
        routeSnapshot,
        request: built.dispatchRequest,
        beforeRequestStarted
      });
    } catch (error) {
      if (requestStarted) {
        return this.recordUnknown(intent, 'transport.outcome_unknown', undefined, error);
      }
      return this.recordFailedBeforeRequest(intent, 'transport.failed_before_request', error);
    }

    if (outcome.kind === 'failed_before_submission') {
      if (requestStarted) {
        return this.recordUnknown(intent, 'adapter.invalid_failed_before_request', undefined);
      }
      return this.recordFailedBeforeRequest(intent, outcome.safeCode);
    }
    if (!requestStarted) {
      return this.recordFailedBeforeRequest(intent, 'adapter.request_start_hook_missing');
    }
    if (outcome.kind === 'unknown_outcome') {
      return this.recordUnknown(
        intent,
        outcome.safeCode,
        outcome.providerOperationId
      );
    }
    if (outcome.kind === 'accepted_async') {
      return this.recordAccepted(intent, outcome.providerOperationId, outcome.providerOperationRecord);
    }
    return this.recordCompleted(intent, outcome.providerOperationId, outcome.providerOperationRecord);
  }

  private async recordFailedBeforeRequest(
    intent: ProjectSubmissionAcceptanceV1['intent'],
    safeCode: string,
    cause?: unknown
  ): Promise<SubmissionOrchestrationResultV1> {
    const occurredAt = toIsoTimestamp(this.now());
    const event = this.invocationEvent(
      intent.providerInvocationAttemptId,
      2,
      'submission_failed_before_request',
      occurredAt,
      safeCode
    );
    const next = transitionSubmissionIntent(
      intent,
      'failed_before_submission',
      occurredAt,
      { safeCode }
    );
    const updated = await this.acceptances.advance({ intent: next, invocationEvent: event });
    await this.appendJournal(next, 'failed_before_request');
    await this.authorization.releaseBeforeRequest(intent.authorizationClaimId, occurredAt);
    throw new SubmissionOrchestrationError(
      'submission_failed_before_request',
      'The submission failed before any request bytes were sent',
      result(updated),
      cause
    );
  }

  private async recordUnknown(
    intent: ProjectSubmissionAcceptanceV1['intent'],
    safeCode: string,
    providerOperationId?: string,
    cause?: unknown
  ): Promise<SubmissionOrchestrationResultV1> {
    const occurredAt = toIsoTimestamp(this.now());
    const event = this.invocationEvent(
      intent.providerInvocationAttemptId,
      2,
      'outcome_unknown',
      occurredAt,
      safeCode
    );
    const next = transitionSubmissionIntent(intent, 'unknown_outcome', occurredAt, {
      ...(providerOperationId ? { providerOperationId } : {}),
      safeCode
    });
    const updated = await this.acceptances.advance({ intent: next, invocationEvent: event });
    await this.appendJournal(next, 'unknown_outcome');
    await this.authorization.recordOutcome(intent.authorizationClaimId, occurredAt);
    throw new SubmissionOrchestrationError(
      'submission_outcome_unknown',
      'The provider submission outcome is unknown and automatic retry is forbidden',
      result(updated),
      cause
    );
  }

  private async recordAccepted(
    intent: ProjectSubmissionAcceptanceV1['intent'],
    providerOperationId: string,
    providerOperationRecord?: ProviderOperationRecord
  ): Promise<SubmissionOrchestrationResultV1> {
    const occurredAt = toIsoTimestamp(this.now());
    const event = this.invocationEvent(
      intent.providerInvocationAttemptId,
      2,
      'provider_accepted',
      occurredAt
    );
    const next = transitionSubmissionIntent(intent, 'provider_accepted', occurredAt, {
      providerOperationId
    });
    const updated = await this.acceptances.advance({
      intent: next,
      invocationEvent: event,
      ...(providerOperationRecord ? { providerOperationRecord } : {})
    });
    await this.appendJournal(next, 'provider_accepted');
    return result(updated);
  }

  private async recordCompleted(
    intent: ProjectSubmissionAcceptanceV1['intent'],
    providerOperationId: string,
    providerOperationRecord?: ProviderOperationRecord
  ): Promise<SubmissionOrchestrationResultV1> {
    const acceptedAt = toIsoTimestamp(this.now());
    const acceptedIntent = transitionSubmissionIntent(intent, 'provider_accepted', acceptedAt, {
      providerOperationId
    });
    const accepted = await this.acceptances.advance({
      intent: acceptedIntent,
      invocationEvent: this.invocationEvent(
        intent.providerInvocationAttemptId,
        2,
        'provider_accepted',
        acceptedAt
      ),
      ...(providerOperationRecord ? { providerOperationRecord } : {})
    });
    await this.appendJournal(acceptedIntent, 'provider_accepted');
    const completedAt = toIsoTimestamp(this.now());
    const completedIntent = transitionSubmissionIntent(
      accepted.intent,
      'completed',
      completedAt,
      { providerOperationId }
    );
    const completed = await this.acceptances.advance({
      intent: completedIntent,
      invocationEvent: this.invocationEvent(
        intent.providerInvocationAttemptId,
        3,
        'completed',
        completedAt
      )
    });
    await this.appendJournal(completedIntent, 'completed');
    await this.authorization.recordOutcome(intent.authorizationClaimId, completedAt);
    return result(completed);
  }

  private invocationEvent(
    attemptId: ProviderInvocationAttemptId,
    sequence: number,
    type: ProviderInvocationEventV1['type'],
    occurredAt: IsoTimestamp,
    safeCode?: string
  ): ProviderInvocationEventV1 {
    return createProviderInvocationEvent({
      id: this.ids.nextProviderInvocationEventId(),
      invocationAttemptId: attemptId,
      sequence,
      type,
      ...(safeCode ? { safeCode } : {}),
      occurredAt
    });
  }

  private appendJournal(
    intent: ProjectSubmissionAcceptanceV1['intent'],
    stage: SubmissionIntentJournalEventV1['stage']
  ): Promise<void> {
    return this.journal.append({
      schemaVersion: 1,
      eventId: this.ids.nextJournalEventId(),
      intentId: intent.id,
      idempotencyKey: intent.idempotencyKey,
      stage,
      recordedAt: intent.updatedAt,
      ...(['authorization_claimed', 'request_started', 'provider_accepted', 'completed'].includes(stage)
        ? { claimId: intent.authorizationClaimId }
        : {}),
      ...(['request_started', 'provider_accepted', 'completed'].includes(stage)
        ? { routeSnapshotId: intent.routeSnapshotId }
        : {}),
      ...(['provider_accepted', 'completed'].includes(stage)
        ? { providerOperationId: intent.providerOperationId }
        : {})
    });
  }
}

function result(
  acceptance: ProjectSubmissionAcceptanceV1
): SubmissionOrchestrationResultV1 {
  return {
    schemaVersion: 1,
    submissionIntentId: acceptance.intent.id,
    status: acceptance.intent.status,
    retryAllowed: false
  };
}

function authorizationSafeCode(error: unknown): string {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof (error as { code?: unknown }).code === 'string'
  ) {
    const code = (error as { code: string }).code.toLowerCase().replace(/[^a-z0-9_.-]/g, '_');
    if (/^[a-z0-9][a-z0-9_.-]{0,127}$/.test(code)) return `authorization.${code}`;
  }
  return 'authorization.claim_failed';
}
