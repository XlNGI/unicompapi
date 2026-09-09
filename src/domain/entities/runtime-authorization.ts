export const runtimeAccessStates = [
  'blocked',
  'validation_only',
  'interactive_allowed'
] as const;
export type RuntimeAccessState = (typeof runtimeAccessStates)[number];

export const runtimeAuthorizationOperations = [
  'submit',
  'query',
  'cancel',
  'receive_result'
] as const;
export type RuntimeAuthorizationOperation =
  (typeof runtimeAuthorizationOperations)[number];

export const runtimeAuthorizationClaimStates = [
  'claimed',
  'request_started',
  'outcome_recorded',
  'released_before_request'
] as const;
export type RuntimeAuthorizationClaimState =
  (typeof runtimeAuthorizationClaimStates)[number];

export interface RuntimeAccessPolicy {
  readonly policyId: string;
  readonly providerPackageId: string;
  readonly connectionId?: string;
  readonly adapterKey?: string;
  readonly state: RuntimeAccessState;
  readonly revision: number;
  readonly allowedOperations: readonly RuntimeAuthorizationOperation[];
  readonly approvedScope?: string;
  readonly maximumSubmissions?: number;
  readonly expiresAt?: string;
}

export interface RuntimeAuthorizationClaim {
  readonly claimId: string;
  readonly policyId: string;
  readonly policyRevision: number;
  readonly routeSelectionNonce: string;
  readonly idempotencyKey: string;
  readonly allowedContinuationOperations: readonly Exclude<
    RuntimeAuthorizationOperation,
    'submit'
  >[];
  readonly state: RuntimeAuthorizationClaimState;
  readonly claimedAt: string;
  readonly requestStartedAt?: string;
}
