import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import {
  runtimeAccessStates,
  runtimeAuthorizationClaimStates,
  runtimeAuthorizationOperations,
  toIsoTimestamp,
  type RuntimeAccessPolicy,
  type RuntimeAccessState,
  type RuntimeAuthorizationClaim,
  type RuntimeAuthorizationClaimState,
  type RuntimeAuthorizationOperation
} from '../../domain';
import { sharedFileWriteCoordinator } from '../storage';

export interface RuntimeAuthorizationRevocation {
  readonly claimId: string;
  readonly revokedAt: string;
  readonly reason: string;
}

export interface RuntimeAuthorizationLedgerDocumentV1 {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly updatedAt: string;
  readonly policies: readonly RuntimeAccessPolicy[];
  readonly claims: readonly RuntimeAuthorizationClaim[];
  readonly revocations: readonly RuntimeAuthorizationRevocation[];
}

export type RuntimeAuthorizationDecisionReason =
  | 'allowed'
  | 'no_matching_policy'
  | 'policy_blocked'
  | 'policy_expired'
  | 'operation_not_allowed'
  | 'policy_revision_stale'
  | 'submissions_exhausted'
  | 'nonce_reused'
  | 'idempotency_reused'
  | 'claim_not_found'
  | 'claim_revoked'
  | 'claim_not_active'
  | 'continuation_not_allowed';

export interface RuntimeAuthorizationScope {
  readonly providerPackageId: string;
  readonly connectionId?: string;
  readonly adapterKey?: string;
}

export interface RuntimeAccessRequest extends RuntimeAuthorizationScope {
  readonly operation: RuntimeAuthorizationOperation;
  readonly policyRevision?: number;
  readonly now?: string;
}

export interface RuntimeAuthorizationDecision {
  readonly allowed: boolean;
  readonly operation: RuntimeAuthorizationOperation;
  readonly reason: RuntimeAuthorizationDecisionReason;
  readonly policyId?: string;
  readonly policyRevision?: number;
}

export interface RuntimeAuthorizationClaimInput extends RuntimeAuthorizationScope {
  readonly policyRevision: number;
  readonly routeSelectionNonce: string;
  readonly idempotencyKey: string;
  readonly claimId?: string;
  readonly now?: string;
}

export interface RuntimeAuthorizationContinuationInput {
  readonly claimId: string;
  readonly operation: Exclude<RuntimeAuthorizationOperation, 'submit'>;
  readonly now?: string;
}

export type RuntimeAuthorizationErrorCode =
  | RuntimeAuthorizationDecisionReason
  | 'invalid_policy'
  | 'invalid_claim'
  | 'ledger_conflict'
  | 'policy_revision_conflict'
  | 'claim_state_conflict'
  | 'revocation_conflict';

export class RuntimeAuthorizationError extends Error {
  constructor(
    readonly code: RuntimeAuthorizationErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'RuntimeAuthorizationError';
  }
}

export class RuntimeAuthorizationDeniedError extends RuntimeAuthorizationError {
  constructor(
    readonly denialCode: RuntimeAuthorizationDecisionReason,
    message: string,
    readonly policyId?: string,
    readonly policyRevision?: number
  ) {
    super(denialCode, message);
    this.name = 'RuntimeAuthorizationDeniedError';
  }
}

export class RuntimeAuthorizationLedgerConflictError extends Error {
  readonly code = 'ledger_conflict' as const;

  constructor(
    readonly expectedRevision: number,
    readonly actualRevision: number
  ) {
    super(
      `Runtime authorization ledger changed before the requested update was applied: expected ${expectedRevision}, actual ${actualRevision}`
    );
    this.name = 'RuntimeAuthorizationLedgerConflictError';
  }
}

export class JsonRuntimeAuthorizationLedgerStore {
  constructor(
    private readonly ledgerPath: string,
    private readonly now: () => string = () => new Date().toISOString()
  ) {
    if (!path.isAbsolute(ledgerPath)) {
      throw new TypeError('Runtime authorization ledger path must be absolute');
    }
  }

  async load(): Promise<RuntimeAuthorizationLedgerDocumentV1> {
    return (await this.readDisk()) ?? emptyLedger(this.now());
  }

  async save(
    document: RuntimeAuthorizationLedgerDocumentV1,
    expectedRevision = document.revision
  ): Promise<void> {
    const validated = parseRuntimeAuthorizationLedger(document);
    await sharedFileWriteCoordinator.runExclusive(this.ledgerPath, async () => {
      const current = await this.readDisk();
      const actualRevision = current?.revision ?? 0;
      if (actualRevision !== expectedRevision) {
        throw new RuntimeAuthorizationLedgerConflictError(
          expectedRevision,
          actualRevision
        );
      }
      const next = {
        ...validated,
        revision: current ? actualRevision + 1 : validated.revision,
        updatedAt: toIsoTimestamp(this.now())
      } satisfies RuntimeAuthorizationLedgerDocumentV1;
      await this.write(next, current);
    });
  }

  async mutate<T>(
    mutator: (
      document: RuntimeAuthorizationLedgerDocumentV1
    ) => { readonly document: RuntimeAuthorizationLedgerDocumentV1; readonly result: T } | Promise<{
      readonly document: RuntimeAuthorizationLedgerDocumentV1;
      readonly result: T;
    }>
  ): Promise<T> {
    return sharedFileWriteCoordinator.runExclusive(this.ledgerPath, async () => {
      const current = await this.readDisk();
      const base = current ?? emptyLedger(this.now());
      const mutation = await mutator(base);
      const validated = parseRuntimeAuthorizationLedger({
        ...mutation.document,
        revision: current ? current.revision + 1 : base.revision + 1,
        updatedAt: toIsoTimestamp(this.now())
      });
      await this.write(validated, current);
      return mutation.result;
    });
  }

  private async readDisk(): Promise<RuntimeAuthorizationLedgerDocumentV1 | undefined> {
    let primaryError: unknown;
    try {
      return parseRuntimeAuthorizationLedger(
        JSON.parse(await readFile(this.ledgerPath, 'utf8'))
      );
    } catch (error) {
      if (!(isNodeError(error) && error.code === 'ENOENT')) primaryError = error;
    }

    try {
      return parseRuntimeAuthorizationLedger(
        JSON.parse(await readFile(backupPath(this.ledgerPath), 'utf8'))
      );
    } catch (backupError) {
      if (isNodeError(backupError) && backupError.code === 'ENOENT') {
        if (primaryError !== undefined) throw primaryError;
        return undefined;
      }
      throw new RuntimeAuthorizationError(
        'invalid_claim',
        'Runtime authorization ledger primary and backup are invalid'
      );
    }
  }

  private async write(
    document: RuntimeAuthorizationLedgerDocumentV1,
    current: RuntimeAuthorizationLedgerDocumentV1 | undefined
  ): Promise<void> {
    const parent = path.dirname(this.ledgerPath);
    await mkdir(parent, { recursive: true });
    if (current) await writeJsonAtomically(backupPath(this.ledgerPath), current);
    await writeJsonAtomically(this.ledgerPath, document);
  }
}

export class RuntimeAuthorizationLedger {
  constructor(
    private readonly store: JsonRuntimeAuthorizationLedgerStore,
    private readonly now: () => string = () => new Date().toISOString()
  ) {}

  load(): Promise<RuntimeAuthorizationLedgerDocumentV1> {
    return this.store.load();
  }

  async upsertPolicy(
    policy: RuntimeAccessPolicy,
    expectedRevision?: number
  ): Promise<RuntimeAccessPolicy> {
    const validated = parseRuntimeAccessPolicy(policy);
    return this.store.mutate((current) => {
      const existing = current.policies.find(
        (item) => item.policyId === validated.policyId
      );
      if (
        expectedRevision !== undefined &&
        ((existing === undefined && expectedRevision !== 0) ||
          (existing !== undefined && existing.revision !== expectedRevision))
      ) {
        throw new RuntimeAuthorizationError(
          'policy_revision_conflict',
          `Policy ${validated.policyId} revision does not match the expected revision`
        );
      }
      if (existing && validated.revision < existing.revision) {
        throw new RuntimeAuthorizationError(
          'policy_revision_conflict',
          `Policy ${validated.policyId} revision cannot move backwards`
        );
      }
      if (
        existing &&
        validated.revision === existing.revision &&
        stableJson(existing) !== stableJson(validated)
      ) {
        throw new RuntimeAuthorizationError(
          'policy_revision_conflict',
          `Policy ${validated.policyId} revision already contains a different policy`
        );
      }
      const policies = existing
        ? current.policies.map((item) =>
            item.policyId === validated.policyId ? validated : item
          )
        : [...current.policies, validated];
      return {
        document: { ...current, policies },
        result: validated
      };
    });
  }

  async checkAccess(input: RuntimeAccessRequest): Promise<RuntimeAuthorizationDecision> {
    const request = parseRuntimeAccessRequest(input);
    const document = await this.store.load();
    return evaluateAccess(document.policies, request, request.now!);
  }

  async claimSubmission(
    input: RuntimeAuthorizationClaimInput
  ): Promise<RuntimeAuthorizationClaim> {
    const request = parseRuntimeAuthorizationClaimInput(input);
    return this.store.mutate((current) => {
      const sameIdempotency = current.claims.find(
        (claim) => claim.idempotencyKey === request.idempotencyKey
      );
      const sameNonce = current.claims.find(
        (claim) => claim.routeSelectionNonce === request.routeSelectionNonce
      );
      if (sameIdempotency || sameNonce) {
        if (
          sameIdempotency &&
          sameNonce &&
          sameIdempotency.claimId === sameNonce.claimId
        ) {
          return { document: current, result: sameIdempotency };
        }
        if (sameIdempotency) {
          throw new RuntimeAuthorizationDeniedError(
            'idempotency_reused',
            'The idempotency key already belongs to a different authorization claim'
          );
        }
        throw new RuntimeAuthorizationDeniedError(
          'nonce_reused',
          'The route selection nonce has already been consumed'
        );
      }

      const access = evaluateAccess(
        current.policies,
        {
          ...request,
          operation: 'submit'
        },
        request.now
      );
      if (!access.allowed) {
        throw new RuntimeAuthorizationDeniedError(
          access.reason,
          `Runtime authorization denied: ${access.reason}`,
          access.policyId,
          access.policyRevision
        );
      }
      if (access.policyRevision !== request.policyRevision) {
        throw new RuntimeAuthorizationDeniedError(
          'policy_revision_stale',
          'The authorization policy revision is stale',
          access.policyId,
          access.policyRevision
        );
      }
      const policy = current.policies.find(
        (item) => item.policyId === access.policyId
      );
      if (!policy) {
        throw new RuntimeAuthorizationDeniedError(
          'no_matching_policy',
          'The selected authorization policy no longer exists'
        );
      }
      const used = current.claims.filter(
        (claim) =>
          claim.policyId === policy.policyId &&
          claim.state !== 'released_before_request'
      ).length;
      if (policy.maximumSubmissions !== undefined && used >= policy.maximumSubmissions) {
        throw new RuntimeAuthorizationDeniedError(
          'submissions_exhausted',
          'The runtime authorization submission limit has been reached',
          policy.policyId,
          policy.revision
        );
      }
      const claim: RuntimeAuthorizationClaim = {
        claimId: request.claimId ?? `claim-${randomUUID()}`,
        policyId: policy.policyId,
        policyRevision: policy.revision,
        routeSelectionNonce: request.routeSelectionNonce,
        idempotencyKey: request.idempotencyKey,
        allowedContinuationOperations: policy.allowedOperations.filter(
          (operation): operation is Exclude<RuntimeAuthorizationOperation, 'submit'> =>
            operation !== 'submit'
        ),
        state: 'claimed',
        claimedAt: request.now
      };
      return {
        document: { ...current, claims: [...current.claims, claim] },
        result: claim
      };
    });
  }

  claim(input: RuntimeAuthorizationClaimInput): Promise<RuntimeAuthorizationClaim> {
    return this.claimSubmission(input);
  }

  async markRequestStarted(claimId: string, now = this.now()): Promise<RuntimeAuthorizationClaim> {
    const id = opaqueId(claimId, 'claimId');
    const recordedAt = canonicalTimestamp(now, 'now');
    return this.store.mutate((current) => {
      const claim = requireClaim(current, id);
      if (claim.state === 'request_started') return { document: current, result: claim };
      if (claim.state !== 'claimed') {
        throw new RuntimeAuthorizationError(
          'claim_state_conflict',
          'Only a claimed authorization can start a request'
        );
      }
      const updated = { ...claim, state: 'request_started' as const, requestStartedAt: recordedAt };
      return {
        document: {
          ...current,
          claims: current.claims.map((item) => (item.claimId === id ? updated : item))
        },
        result: updated
      };
    });
  }

  startRequest(claimId: string, now = this.now()): Promise<RuntimeAuthorizationClaim> {
    return this.markRequestStarted(claimId, now);
  }

  async recordOutcome(claimId: string, now = this.now()): Promise<RuntimeAuthorizationClaim> {
    const id = opaqueId(claimId, 'claimId');
    canonicalTimestamp(now, 'now');
    return this.store.mutate((current) => {
      const claim = requireClaim(current, id);
      if (claim.state === 'outcome_recorded') return { document: current, result: claim };
      if (claim.state !== 'request_started') {
        throw new RuntimeAuthorizationError(
          'claim_state_conflict',
          'Only a started authorization can record an outcome'
        );
      }
      const updated = { ...claim, state: 'outcome_recorded' as const };
      return {
        document: {
          ...current,
          claims: current.claims.map((item) => (item.claimId === id ? updated : item))
        },
        result: updated
      };
    });
  }

  async releaseBeforeRequest(
    claimId: string,
    now = this.now()
  ): Promise<RuntimeAuthorizationClaim> {
    const id = opaqueId(claimId, 'claimId');
    canonicalTimestamp(now, 'now');
    return this.store.mutate((current) => {
      const claim = requireClaim(current, id);
      if (claim.state === 'released_before_request') return { document: current, result: claim };
      if (claim.state !== 'claimed') {
        throw new RuntimeAuthorizationError(
          'claim_state_conflict',
          'A request-started authorization cannot be released'
        );
      }
      const updated = { ...claim, state: 'released_before_request' as const };
      return {
        document: {
          ...current,
          claims: current.claims.map((item) => (item.claimId === id ? updated : item))
        },
        result: updated
      };
    });
  }

  releaseClaim(claimId: string, now = this.now()): Promise<RuntimeAuthorizationClaim> {
    return this.releaseBeforeRequest(claimId, now);
  }

  async authorizeContinuation(
    input: RuntimeAuthorizationContinuationInput
  ): Promise<RuntimeAuthorizationDecision> {
    const request = parseContinuationInput(input);
    const document = await this.store.load();
    const claim = document.claims.find((item) => item.claimId === request.claimId);
    if (!claim) {
      return {
        allowed: false,
        operation: request.operation,
        reason: 'claim_not_found'
      };
    }
    if (document.revocations.some((item) => item.claimId === claim.claimId)) {
      return {
        allowed: false,
        operation: request.operation,
        reason: 'claim_revoked',
        policyId: claim.policyId,
        policyRevision: claim.policyRevision
      };
    }
    if (claim.state !== 'request_started') {
      return {
        allowed: false,
        operation: request.operation,
        reason: 'claim_not_active',
        policyId: claim.policyId,
        policyRevision: claim.policyRevision
      };
    }
    if (!claim.allowedContinuationOperations.includes(request.operation)) {
      return {
        allowed: false,
        operation: request.operation,
        reason: 'continuation_not_allowed',
        policyId: claim.policyId,
        policyRevision: claim.policyRevision
      };
    }
    return {
      allowed: true,
      operation: request.operation,
      reason: 'allowed',
      policyId: claim.policyId,
      policyRevision: claim.policyRevision
    };
  }

  async revokeClaim(
    claimId: string,
    reason: string,
    now = this.now()
  ): Promise<void> {
    const id = opaqueId(claimId, 'claimId');
    const normalizedReason = opaqueText(reason, 'revocation reason');
    const revokedAt = canonicalTimestamp(now, 'now');
    await this.store.mutate((current) => {
      requireClaim(current, id);
      const existing = current.revocations.find((item) => item.claimId === id);
      if (existing) {
        if (existing.reason !== normalizedReason) {
          throw new RuntimeAuthorizationError(
            'revocation_conflict',
            'The authorization claim was already revoked for a different reason'
          );
        }
        return { document: current, result: undefined };
      }
      return {
        document: {
          ...current,
          revocations: [
            ...current.revocations,
            { claimId: id, revokedAt, reason: normalizedReason }
          ]
        },
        result: undefined
      };
    });
  }

  async revokePolicy(
    policyId: string,
    reason: string,
    now = this.now()
  ): Promise<number> {
    const id = opaqueId(policyId, 'policyId');
    const normalizedReason = opaqueText(reason, 'revocation reason');
    const revokedAt = canonicalTimestamp(now, 'now');
    return this.store.mutate((current) => {
      if (!current.policies.some((item) => item.policyId === id)) {
        throw new RuntimeAuthorizationError(
          'no_matching_policy',
          `Authorization policy ${id} was not found`
        );
      }
      const existing = new Set(current.revocations.map((item) => item.claimId));
      const claimsToRevoke = current.claims.filter(
        (claim) => claim.policyId === id && claim.state === 'request_started' && !existing.has(claim.claimId)
      );
      if (claimsToRevoke.length === 0) return { document: current, result: 0 };
      return {
        document: {
          ...current,
          revocations: [
            ...current.revocations,
            ...claimsToRevoke.map((claim) => ({
              claimId: claim.claimId,
              revokedAt,
              reason: normalizedReason
            }))
          ]
        },
        result: claimsToRevoke.length
      };
    });
  }
}

export const RuntimeAccessPolicyService = RuntimeAuthorizationLedger;

export function parseRuntimeAuthorizationLedger(
  value: unknown
): RuntimeAuthorizationLedgerDocumentV1 {
  const item = record(value, 'runtime authorization ledger');
  const keys = new Set(['schemaVersion', 'revision', 'updatedAt', 'policies', 'claims', 'revocations']);
  if (
    Object.keys(item).length !== keys.size ||
    Object.keys(item).some((key) => !keys.has(key)) ||
    item.schemaVersion !== 1 ||
    !Number.isSafeInteger(item.revision) ||
    Number(item.revision) < 0 ||
    !Array.isArray(item.policies) ||
    !Array.isArray(item.claims) ||
    !Array.isArray(item.revocations)
  ) {
    throw new RuntimeAuthorizationError('invalid_claim', 'Runtime authorization ledger metadata is invalid');
  }
  const policies = item.policies.map(parseRuntimeAccessPolicy);
  const claims = item.claims.map(parseRuntimeAuthorizationClaim);
  const revocations = item.revocations.map(parseRevocation);
  assertUnique(policies.map((policy) => policy.policyId), 'policy ID');
  assertUnique(claims.map((claim) => claim.claimId), 'claim ID');
  assertUnique(claims.map((claim) => claim.routeSelectionNonce), 'route selection nonce');
  assertUnique(claims.map((claim) => claim.idempotencyKey), 'idempotency key');
  assertUnique(revocations.map((revocation) => revocation.claimId), 'revocation claim ID');
  return {
    schemaVersion: 1,
    revision: Number(item.revision),
    updatedAt: canonicalTimestamp(item.updatedAt, 'updatedAt'),
    policies,
    claims,
    revocations
  };
}

export function parseRuntimeAccessPolicy(value: unknown): RuntimeAccessPolicy {
  const item = record(value, 'runtime access policy');
  const keys = new Set([
    'policyId',
    'providerPackageId',
    'connectionId',
    'adapterKey',
    'state',
    'revision',
    'allowedOperations',
    'approvedScope',
    'maximumSubmissions',
    'expiresAt'
  ]);
  if (Object.keys(item).some((key) => !keys.has(key))) {
    throw invalidPolicy();
  }
  const state = item.state;
  if (!runtimeAccessStates.includes(state as RuntimeAccessState)) throw invalidPolicy();
  if (!Array.isArray(item.allowedOperations)) throw invalidPolicy();
  const allowedOperations = item.allowedOperations.map((operation) => {
    if (!runtimeAuthorizationOperations.includes(operation as RuntimeAuthorizationOperation)) {
      throw invalidPolicy();
    }
    return operation as RuntimeAuthorizationOperation;
  });
  assertUnique(allowedOperations, 'allowed operation');
  const policy: RuntimeAccessPolicy = {
    policyId: opaqueId(item.policyId, 'policyId'),
    providerPackageId: opaqueId(item.providerPackageId, 'providerPackageId'),
    connectionId: optionalOpaqueId(item.connectionId, 'connectionId'),
    adapterKey: optionalOpaqueId(item.adapterKey, 'adapterKey'),
    state: state as RuntimeAccessState,
    revision: positiveInteger(item.revision, 'policy revision'),
    allowedOperations,
    approvedScope: item.approvedScope === undefined ? undefined : opaqueText(item.approvedScope, 'approvedScope'),
    maximumSubmissions: item.maximumSubmissions === undefined
      ? undefined
      : nonNegativeInteger(item.maximumSubmissions, 'maximumSubmissions'),
    expiresAt: item.expiresAt === undefined ? undefined : canonicalTimestamp(item.expiresAt, 'expiresAt')
  };
  if (policy.state !== 'blocked' && policy.allowedOperations.length === 0) throw invalidPolicy();
  return policy;
}

function parseRuntimeAuthorizationClaim(value: unknown): RuntimeAuthorizationClaim {
  const item = record(value, 'runtime authorization claim');
  const keys = new Set([
    'claimId',
    'policyId',
    'policyRevision',
    'routeSelectionNonce',
    'idempotencyKey',
    'allowedContinuationOperations',
    'state',
    'claimedAt',
    'requestStartedAt'
  ]);
  if (Object.keys(item).some((key) => !keys.has(key)) || !Array.isArray(item.allowedContinuationOperations)) {
    throw invalidClaim();
  }
  const continuation = item.allowedContinuationOperations.map((operation) => {
    if (!runtimeAuthorizationOperations.includes(operation as RuntimeAuthorizationOperation) || operation === 'submit') {
      throw invalidClaim();
    }
    return operation as Exclude<RuntimeAuthorizationOperation, 'submit'>;
  });
  assertUnique(continuation, 'continuation operation');
  const state = item.state;
  if (!runtimeAuthorizationClaimStates.includes(state as RuntimeAuthorizationClaimState)) throw invalidClaim();
  const requestStartedAt = item.requestStartedAt === undefined
    ? undefined
    : canonicalTimestamp(item.requestStartedAt, 'requestStartedAt');
  if (
    (state === 'request_started' || state === 'outcome_recorded') &&
    requestStartedAt === undefined
  ) throw invalidClaim();
  if (state === 'claimed' && requestStartedAt !== undefined) throw invalidClaim();
  if (state === 'released_before_request' && requestStartedAt !== undefined) throw invalidClaim();
  const claimedAt = canonicalTimestamp(item.claimedAt, 'claimedAt');
  if (requestStartedAt !== undefined && requestStartedAt < claimedAt) throw invalidClaim();
  return {
    claimId: opaqueId(item.claimId, 'claimId'),
    policyId: opaqueId(item.policyId, 'policyId'),
    policyRevision: positiveInteger(item.policyRevision, 'policy revision'),
    routeSelectionNonce: opaqueId(item.routeSelectionNonce, 'routeSelectionNonce'),
    idempotencyKey: opaqueId(item.idempotencyKey, 'idempotencyKey'),
    allowedContinuationOperations: continuation,
    state: state as RuntimeAuthorizationClaimState,
    claimedAt,
    requestStartedAt
  };
}

function parseRevocation(value: unknown): RuntimeAuthorizationRevocation {
  const item = record(value, 'runtime authorization revocation');
  const keys = new Set(['claimId', 'revokedAt', 'reason']);
  if (Object.keys(item).length !== keys.size || Object.keys(item).some((key) => !keys.has(key))) {
    throw new RuntimeAuthorizationError('invalid_claim', 'Runtime authorization revocation is invalid');
  }
  return {
    claimId: opaqueId(item.claimId, 'claimId'),
    revokedAt: canonicalTimestamp(item.revokedAt, 'revokedAt'),
    reason: opaqueText(item.reason, 'revocation reason')
  };
}

function evaluateAccess(
  policies: readonly RuntimeAccessPolicy[],
  request: RuntimeAccessRequest,
  now: string
): RuntimeAuthorizationDecision {
  const matching = policies
    .filter((policy) => matchesScope(policy, request))
    .sort((left, right) => {
      const specificity = policySpecificity(right) - policySpecificity(left);
      if (specificity !== 0) return specificity;
      if (left.revision !== right.revision) return right.revision - left.revision;
      return left.policyId.localeCompare(right.policyId);
    });
  if (matching.length === 0) {
    return { allowed: false, operation: request.operation, reason: 'no_matching_policy' };
  }
  const specificity = policySpecificity(matching[0]);
  const mostSpecific = matching.filter((policy) => policySpecificity(policy) === specificity);
  const blocked = mostSpecific.find((policy) => policy.state === 'blocked');
  const policy = mostSpecific[0];
  if (blocked) {
    return {
      allowed: false,
      operation: request.operation,
      reason: 'policy_blocked',
      policyId: blocked.policyId,
      policyRevision: blocked.revision
    };
  }
  if (policy.expiresAt !== undefined && policy.expiresAt <= now) {
    return {
      allowed: false,
      operation: request.operation,
      reason: 'policy_expired',
      policyId: policy.policyId,
      policyRevision: policy.revision
    };
  }
  if (request.policyRevision !== undefined && request.policyRevision !== policy.revision) {
    return {
      allowed: false,
      operation: request.operation,
      reason: 'policy_revision_stale',
      policyId: policy.policyId,
      policyRevision: policy.revision
    };
  }
  if (!policy.allowedOperations.includes(request.operation)) {
    return {
      allowed: false,
      operation: request.operation,
      reason: 'operation_not_allowed',
      policyId: policy.policyId,
      policyRevision: policy.revision
    };
  }
  return {
    allowed: true,
    operation: request.operation,
    reason: 'allowed',
    policyId: policy.policyId,
    policyRevision: policy.revision
  };
}

function matchesScope(policy: RuntimeAccessPolicy, request: RuntimeAuthorizationScope): boolean {
  return (
    policy.providerPackageId === request.providerPackageId &&
    (policy.connectionId === undefined || policy.connectionId === request.connectionId) &&
    (policy.adapterKey === undefined || policy.adapterKey === request.adapterKey)
  );
}

function policySpecificity(policy: RuntimeAccessPolicy): number {
  return (policy.connectionId === undefined ? 0 : 1) + (policy.adapterKey === undefined ? 0 : 1);
}

function parseRuntimeAccessRequest(input: RuntimeAccessRequest): RuntimeAccessRequest {
  const request = input as RuntimeAccessRequest;
  return {
    providerPackageId: opaqueId(request.providerPackageId, 'providerPackageId'),
    connectionId: optionalOpaqueId(request.connectionId, 'connectionId'),
    adapterKey: optionalOpaqueId(request.adapterKey, 'adapterKey'),
    operation: parseOperation(request.operation),
    policyRevision: request.policyRevision === undefined
      ? undefined
      : positiveInteger(request.policyRevision, 'policy revision'),
    now: canonicalTimestamp(request.now ?? new Date().toISOString(), 'now')
  };
}

function parseRuntimeAuthorizationClaimInput(input: RuntimeAuthorizationClaimInput): RuntimeAuthorizationClaimInput & { readonly now: string } {
  return {
    providerPackageId: opaqueId(input.providerPackageId, 'providerPackageId'),
    connectionId: optionalOpaqueId(input.connectionId, 'connectionId'),
    adapterKey: optionalOpaqueId(input.adapterKey, 'adapterKey'),
    policyRevision: positiveInteger(input.policyRevision, 'policy revision'),
    routeSelectionNonce: opaqueId(input.routeSelectionNonce, 'routeSelectionNonce'),
    idempotencyKey: opaqueId(input.idempotencyKey, 'idempotencyKey'),
    claimId: input.claimId === undefined ? undefined : opaqueId(input.claimId, 'claimId'),
    now: canonicalTimestamp(input.now ?? new Date().toISOString(), 'now')
  };
}

function parseContinuationInput(input: RuntimeAuthorizationContinuationInput): RuntimeAuthorizationContinuationInput & { readonly now: string } {
  return {
    claimId: opaqueId(input.claimId, 'claimId'),
    operation: parseOperation(input.operation) as Exclude<RuntimeAuthorizationOperation, 'submit'>,
    now: canonicalTimestamp(input.now ?? new Date().toISOString(), 'now')
  };
}

function parseOperation(value: unknown): RuntimeAuthorizationOperation {
  if (!runtimeAuthorizationOperations.includes(value as RuntimeAuthorizationOperation)) {
    throw new RuntimeAuthorizationError('invalid_claim', 'Runtime authorization operation is invalid');
  }
  return value as RuntimeAuthorizationOperation;
}

function requireClaim(
  document: RuntimeAuthorizationLedgerDocumentV1,
  claimId: string
): RuntimeAuthorizationClaim {
  const claim = document.claims.find((item) => item.claimId === claimId);
  if (!claim) throw new RuntimeAuthorizationError('claim_not_found', `Authorization claim ${claimId} was not found`);
  return claim;
}

function emptyLedger(now: string): RuntimeAuthorizationLedgerDocumentV1 {
  return {
    schemaVersion: 1,
    revision: 0,
    updatedAt: canonicalTimestamp(now, 'updatedAt'),
    policies: [],
    claims: [],
    revocations: []
  };
}

function invalidPolicy(): RuntimeAuthorizationError {
  return new RuntimeAuthorizationError('invalid_policy', 'Runtime access policy is invalid');
}

function invalidClaim(): RuntimeAuthorizationError {
  return new RuntimeAuthorizationError('invalid_claim', 'Runtime authorization claim is invalid');
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new RuntimeAuthorizationError('invalid_claim', `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function opaqueId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value)) {
    throw new RuntimeAuthorizationError('invalid_claim', `${label} is invalid`);
  }
  return value;
}

function optionalOpaqueId(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : opaqueId(value, label);
}

function opaqueText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 1024) {
    throw new RuntimeAuthorizationError('invalid_claim', `${label} is invalid`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new RuntimeAuthorizationError('invalid_claim', `${label} must be a positive integer`);
  }
  return Number(value);
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new RuntimeAuthorizationError('invalid_claim', `${label} must be a non-negative integer`);
  }
  return Number(value);
}

function canonicalTimestamp(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new RuntimeAuthorizationError('invalid_claim', `${label} is invalid`);
  }
  try {
    return toIsoTimestamp(value);
  } catch {
    throw new RuntimeAuthorizationError('invalid_claim', `${label} is invalid`);
  }
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new RuntimeAuthorizationError('invalid_claim', `Duplicate ${label} is not allowed`);
  }
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, Object.keys(value as Record<string, unknown>).sort());
}

function backupPath(target: string): string {
  return `${target}.bak`;
}

async function writeJsonAtomically(target: string, value: unknown): Promise<void> {
  const parent = path.dirname(target);
  const temporary = path.join(parent, `.${path.basename(target)}.${randomUUID()}.tmp`);
  await mkdir(parent, { recursive: true });
  try {
    const handle = await open(temporary, 'wx');
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
