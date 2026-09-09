import {
  createProviderInvocationEvent,
  toIsoTimestamp,
  transitionSubmissionIntent,
  type ProviderInvocationAttemptId,
  type ProviderInvocationEventId,
  type RuntimeAuthorizationClaim,
  type SubmissionIntentId
} from '../../domain';
import type {
  ProjectSubmissionAcceptanceStore,
  ProjectSubmissionAcceptanceV1
} from '../storage/project-submission-acceptance';
import type {
  ProviderAsyncOperationStatus,
  ProviderCancelOutcome
} from './provider-execution-lifecycle';
import type { ProviderExecutionRouteDispatcher } from './provider-execution-route-dispatcher';
import type { RuntimeAuthorizationDecision } from './runtime-authorization-ledger';

export interface InvocationSupervisorAuthorizationPort {
  getClaim(claimId: string): Promise<RuntimeAuthorizationClaim | undefined>;
  releaseBeforeRequest(claimId: string, now?: string): Promise<RuntimeAuthorizationClaim>;
  recordOutcome(claimId: string, now?: string): Promise<RuntimeAuthorizationClaim>;
  authorizeContinuation(input: {
    readonly claimId: string;
    readonly operation: 'query' | 'cancel' | 'receive_result';
    readonly now?: string;
  }): Promise<RuntimeAuthorizationDecision>;
}

export interface InvocationSupervisorIdFactory {
  nextProviderInvocationEventId(): ProviderInvocationEventId;
}

export interface InvocationRecoveryResultV1 {
  readonly submissionIntentId: SubmissionIntentId;
  readonly outcome:
    | 'authorization_reconciled'
    | 'claim_released'
    | 'unknown_outcome_recorded'
    | 'provider_operation_attached';
}

export type InvocationSupervisorErrorCode =
  | 'submission_not_found'
  | 'submission_not_active'
  | 'continuation_denied'
  | 'recovery_inconsistent';

export class InvocationSupervisorError extends Error {
  constructor(readonly code: InvocationSupervisorErrorCode, message: string) {
    super(message);
    this.name = 'InvocationSupervisorError';
  }
}

export class InvocationSupervisor<TResultReference, TReceiveResult> {
  private readonly queues = new Map<string, Promise<void>>();

  constructor(
    private readonly acceptances: ProjectSubmissionAcceptanceStore,
    private readonly authorization: InvocationSupervisorAuthorizationPort,
    private readonly dispatcher: ProviderExecutionRouteDispatcher<
      unknown,
      unknown,
      ProviderAsyncOperationStatus,
      ProviderCancelOutcome,
      TResultReference,
      TReceiveResult
    >,
    private readonly ids: InvocationSupervisorIdFactory,
    private readonly now: () => string = () => new Date().toISOString()
  ) {}

  async recover(): Promise<readonly InvocationRecoveryResultV1[]> {
    const results: InvocationRecoveryResultV1[] = [];
    for (const decision of await this.acceptances.scanRecovery()) {
      results.push(await this.serial(decision.submissionIntentId, async () => {
        let acceptance = await this.requireAcceptance(decision.submissionIntentId);
        const claim = await this.authorization.getClaim(
          acceptance.intent.authorizationClaimId
        );
        if (decision.action === 'reconcile_unclaimed_authorization') {
          if (!claim) {
            await this.failBeforeRequest(
              acceptance,
              'authorization.claim_not_found'
            );
            return {
              submissionIntentId: decision.submissionIntentId,
              outcome: 'authorization_reconciled' as const
            };
          }
          if (claim.state === 'claimed' || claim.state === 'released_before_request') {
            if (claim.state === 'claimed') {
              await this.authorization.releaseBeforeRequest(
                claim.claimId,
                this.timestamp()
              );
            }
            await this.failBeforeRequest(
              acceptance,
              'authorization.recovered_before_request'
            );
            return {
              submissionIntentId: decision.submissionIntentId,
              outcome: 'authorization_reconciled' as const
            };
          }
          acceptance = await this.promoteToRequestStarted(acceptance);
          await this.markUnknown(acceptance, 'transport.recovered_unknown_outcome');
          return {
            submissionIntentId: decision.submissionIntentId,
            outcome: 'unknown_outcome_recorded' as const
          };
        }
        if (decision.action === 'release_authorization_claim') {
          if (claim?.state === 'request_started' || claim?.state === 'outcome_recorded') {
            acceptance = await this.promoteToRequestStarted(acceptance);
            await this.markUnknown(acceptance, 'transport.recovered_unknown_outcome');
            return {
              submissionIntentId: decision.submissionIntentId,
              outcome: 'unknown_outcome_recorded' as const
            };
          }
          if (claim?.state === 'claimed') {
            await this.authorization.releaseBeforeRequest(
              claim.claimId,
              this.timestamp()
            );
          }
          await this.failBeforeRequest(
            acceptance,
            claim ? 'authorization.released_during_recovery' : 'authorization.claim_not_found'
          );
          return {
            submissionIntentId: decision.submissionIntentId,
            outcome: 'claim_released' as const
          };
        }
        if (decision.action === 'mark_unknown_outcome') {
          await this.markUnknown(acceptance, 'transport.recovered_unknown_outcome');
          return {
            submissionIntentId: decision.submissionIntentId,
            outcome: 'unknown_outcome_recorded' as const
          };
        }
        if (claim?.state !== 'request_started') {
          await this.markUnknown(
            acceptance,
            'transport.recovered_terminal_fact_incomplete',
            claim?.state === 'outcome_recorded'
          );
          return {
            submissionIntentId: decision.submissionIntentId,
            outcome: 'unknown_outcome_recorded' as const
          };
        }
        await this.dispatcher.attachOperation(
          acceptance.routeSnapshot,
          decision.providerOperationId,
          acceptance.invocationAttempt.id
        );
        return {
          submissionIntentId: decision.submissionIntentId,
          outcome: 'provider_operation_attached' as const
        };
      }));
    }
    return results;
  }

  query(submissionIntentId: SubmissionIntentId): Promise<ProviderAsyncOperationStatus> {
    return this.serial(submissionIntentId, async () => {
      const acceptance = await this.requireActive(submissionIntentId);
      await this.authorize(acceptance, 'query');
      await this.attach(acceptance);
      const status = await this.dispatcher.query(
        acceptance.routeSnapshot,
        acceptance.intent.providerOperationId!
      );
      await this.recordQueryStatus(acceptance, status);
      return status;
    });
  }

  cancel(submissionIntentId: SubmissionIntentId): Promise<ProviderCancelOutcome> {
    return this.serial(submissionIntentId, async () => {
      let acceptance = await this.requireActive(submissionIntentId);
      await this.authorize(acceptance, 'cancel');
      await this.attach(acceptance);
      if (!acceptance.invocationEvents.some((event) => event.type === 'cancel_requested')) {
        acceptance = await this.appendEvent(acceptance, 'cancel_requested');
      }
      const outcome = await this.dispatcher.cancel(
        acceptance.routeSnapshot,
        acceptance.intent.providerOperationId!
      );
      if (outcome.state === 'cancelled') {
        await this.finish(acceptance, 'cancelled', 'cancelled');
      }
      return outcome;
    });
  }

  receiveResult(
    submissionIntentId: SubmissionIntentId,
    reference: TResultReference
  ): Promise<TReceiveResult> {
    return this.serial(submissionIntentId, async () => {
      const acceptance = await this.requireActive(submissionIntentId);
      await this.authorize(acceptance, 'receive_result');
      await this.attach(acceptance);
      const result = await this.dispatcher.receiveResult(
        acceptance.routeSnapshot,
        reference
      );
      await this.finish(acceptance, 'completed', 'completed');
      return result;
    });
  }

  private async recordQueryStatus(
    acceptance: ProjectSubmissionAcceptanceV1,
    status: ProviderAsyncOperationStatus
  ): Promise<void> {
    if (status.state === 'queued' || status.state === 'processing') {
      if (acceptance.invocationAttempt.state === 'accepted') {
        await this.appendEvent(acceptance, 'provider_progressed');
      }
      return;
    }
    if (status.state === 'completed') {
      if (!acceptance.invocationEvents.some((event) => event.type === 'result_received')) {
        await this.appendEvent(acceptance, 'result_received');
      }
      return;
    }
    if (status.state === 'cancelled') {
      await this.finish(acceptance, 'cancelled', 'cancelled');
      return;
    }
    await this.finish(
      acceptance,
      'failed',
      'failed',
      status.state === 'expired'
        ? 'provider.operation_expired'
        : 'provider.operation_failed'
    );
  }

  private async authorize(
    acceptance: ProjectSubmissionAcceptanceV1,
    operation: 'query' | 'cancel' | 'receive_result'
  ): Promise<void> {
    const decision = await this.authorization.authorizeContinuation({
      claimId: acceptance.intent.authorizationClaimId,
      operation,
      now: this.timestamp()
    });
    if (!decision.allowed) {
      throw new InvocationSupervisorError(
        'continuation_denied',
        `Provider continuation was denied: ${decision.reason}`
      );
    }
  }

  private attach(acceptance: ProjectSubmissionAcceptanceV1): Promise<void> {
    return this.dispatcher.attachOperation(
      acceptance.routeSnapshot,
      acceptance.intent.providerOperationId!,
      acceptance.invocationAttempt.id
    );
  }

  private async requireAcceptance(
    submissionIntentId: SubmissionIntentId
  ): Promise<ProjectSubmissionAcceptanceV1> {
    const acceptance = await this.acceptances.get(submissionIntentId);
    if (!acceptance) {
      throw new InvocationSupervisorError(
        'submission_not_found',
        'The provider submission does not exist'
      );
    }
    return acceptance;
  }

  private async requireActive(
    submissionIntentId: SubmissionIntentId
  ): Promise<ProjectSubmissionAcceptanceV1> {
    const acceptance = await this.requireAcceptance(submissionIntentId);
    if (acceptance.intent.status !== 'provider_accepted') {
      throw new InvocationSupervisorError(
        'submission_not_active',
        'The provider submission is not an active remote operation'
      );
    }
    return acceptance;
  }

  private async failBeforeRequest(
    acceptance: ProjectSubmissionAcceptanceV1,
    safeCode: string
  ): Promise<ProjectSubmissionAcceptanceV1> {
    const status = acceptance.intent.status === 'authorization_pending'
      ? 'authorization_not_claimed'
      : 'failed_before_submission';
    const occurredAt = this.timestamp();
    return this.acceptances.advance({
      intent: transitionSubmissionIntent(
        acceptance.intent,
        status,
        occurredAt,
        { safeCode }
      ),
      invocationEvent: this.event(
        acceptance.invocationAttempt.id,
        acceptance.invocationEvents.length + 1,
        'submission_failed_before_request',
        occurredAt,
        safeCode
      )
    });
  }

  private async promoteToRequestStarted(
    acceptance: ProjectSubmissionAcceptanceV1
  ): Promise<ProjectSubmissionAcceptanceV1> {
    let current = acceptance;
    if (current.intent.status === 'authorization_pending') {
      current = await this.acceptances.advance({
        intent: transitionSubmissionIntent(
          current.intent,
          'authorization_claimed',
          this.timestamp()
        )
      });
    }
    if (current.intent.status === 'authorization_claimed') {
      current = await this.acceptances.advance({
        intent: transitionSubmissionIntent(
          current.intent,
          'request_started',
          this.timestamp()
        )
      });
    }
    if (current.intent.status !== 'request_started') {
      throw new InvocationSupervisorError(
        'recovery_inconsistent',
        'The recovered provider submission cannot be marked request-started'
      );
    }
    return current;
  }

  private async markUnknown(
    acceptance: ProjectSubmissionAcceptanceV1,
    safeCode: string,
    recordAuthorization = true
  ): Promise<ProjectSubmissionAcceptanceV1> {
    if (recordAuthorization) {
      await this.authorization.recordOutcome(
        acceptance.intent.authorizationClaimId,
        this.timestamp()
      );
    }
    const occurredAt = this.timestamp();
    return this.acceptances.advance({
      intent: transitionSubmissionIntent(
        acceptance.intent,
        'unknown_outcome',
        occurredAt,
        { safeCode }
      ),
      invocationEvent: this.event(
        acceptance.invocationAttempt.id,
        acceptance.invocationEvents.length + 1,
        'outcome_unknown',
        occurredAt,
        safeCode
      )
    });
  }

  private async appendEvent(
    acceptance: ProjectSubmissionAcceptanceV1,
    type: 'provider_progressed' | 'cancel_requested' | 'result_received'
  ): Promise<ProjectSubmissionAcceptanceV1> {
    const occurredAt = this.timestamp();
    return this.acceptances.advance({
      intent: acceptance.intent,
      invocationEvent: this.event(
        acceptance.invocationAttempt.id,
        acceptance.invocationEvents.length + 1,
        type,
        occurredAt
      )
    });
  }

  private async finish(
    acceptance: ProjectSubmissionAcceptanceV1,
    status: 'completed' | 'failed' | 'cancelled',
    eventType: 'completed' | 'failed' | 'cancelled',
    safeCode?: string
  ): Promise<ProjectSubmissionAcceptanceV1> {
    await this.authorization.recordOutcome(
      acceptance.intent.authorizationClaimId,
      this.timestamp()
    );
    const occurredAt = this.timestamp();
    return this.acceptances.advance({
      intent: transitionSubmissionIntent(
        acceptance.intent,
        status,
        occurredAt,
        safeCode ? { safeCode } : {}
      ),
      invocationEvent: this.event(
        acceptance.invocationAttempt.id,
        acceptance.invocationEvents.length + 1,
        eventType,
        occurredAt,
        safeCode
      )
    });
  }

  private event(
    attemptId: ProviderInvocationAttemptId,
    sequence: number,
    type:
      | 'submission_failed_before_request'
      | 'provider_progressed'
      | 'cancel_requested'
      | 'cancelled'
      | 'result_received'
      | 'completed'
      | 'failed'
      | 'outcome_unknown',
    occurredAt: ReturnType<typeof toIsoTimestamp>,
    safeCode?: string
  ) {
    return createProviderInvocationEvent({
      id: this.ids.nextProviderInvocationEventId(),
      invocationAttemptId: attemptId,
      sequence,
      type,
      ...(safeCode ? { safeCode } : {}),
      occurredAt
    });
  }

  private timestamp() {
    return toIsoTimestamp(this.now());
  }

  private serial<T>(key: SubmissionIntentId, action: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(action);
    const tail = current.then(() => undefined, () => undefined);
    this.queues.set(key, tail);
    void tail.finally(() => {
      if (this.queues.get(key) === tail) this.queues.delete(key);
    });
    return current;
  }
}
