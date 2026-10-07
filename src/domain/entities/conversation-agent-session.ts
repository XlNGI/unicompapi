import { toConversationAgentRunId, toConversationId, toConversationResponseExecutionId, toMessageId, toProjectId, toWorkId,
  type ConversationAgentRunId, type ConversationId, type ConversationResponseExecutionId, type MessageId, type ProjectId, type WorkId } from '../ids';
import { toIsoTimestamp, type IsoTimestamp } from '../timestamps';
import { parseConversationAgentRun, type ConversationAgentRunV1 } from './conversation-agent-run';
import { parseConversationResponseExecution, type ConversationResponseExecutionV1 } from './conversation-response-execution';

export const conversationAgentSessionStatuses = ['active', 'waiting_user', 'waiting_authorization', 'needs_reconciliation', 'expired', 'closed'] as const;
export type ConversationAgentSessionStatus = typeof conversationAgentSessionStatuses[number];
export type ConversationAgentResumeAction = 'reply' | 'authorize' | 'continue';
/** References resolve through Host repositories. No raw prompt, attachment, path or provider credential is stored here. */
export interface ControlledConversationInputReferenceV1 {
  readonly kind: 'message' | 'response_draft' | 'document_draft';
  readonly id: string;
  readonly version: number;
  readonly contentHash: string;
}
export interface ConversationAgentSessionBudgetV1 {
  readonly startedAt: number; readonly deadlineAt: number;
  readonly maxToolCalls: number; readonly budgetUnits: number;
  readonly toolCallsUsed: number; readonly costUnitsUsed: number; readonly toolAttemptsUsed: number;
}
export interface ConversationAgentSessionSegmentV1 {
  readonly runId: ConversationAgentRunId;
  readonly responseExecutionId?: ConversationResponseExecutionId;
  readonly sourceMessageId: MessageId;
  readonly inputReferenceHash: string;
  readonly status: 'active' | 'waiting' | 'settled' | 'unknown';
  readonly planningBoundary?: 'not_started' | 'submitted' | 'received';
  readonly toolCallsUsed: number; readonly costUnitsUsed: number; readonly toolAttemptsUsed: number;
}
export interface ConversationAgentExecutionLeaseV1 {
  readonly ownerId: string; readonly epoch: number; readonly acquiredAt: number; readonly expiresAt: number;
}
export interface ConversationAgentExecutionFence { readonly ownerId: string; readonly epoch: number }
export interface ConversationAgentSessionWaitingV1 {
  readonly version: number;
  readonly reason: 'clarification' | 'authorization' | 'safe_continuation';
  readonly allowedActions: readonly ConversationAgentResumeAction[];
  readonly resumeNonceHash: string; readonly inputReferenceHash: string; readonly preparedAt: IsoTimestamp;
}
export interface ConversationAgentSessionResumeReceiptV1 {
  readonly commandId: string; readonly nonceHash: string; readonly waitingVersion: number;
  readonly childRunId: ConversationAgentRunId; readonly at: IsoTimestamp;
}
export type ConversationAgentSessionReconciliationAcknowledgementV1 = {
  readonly kind: 'closed_without_replay'; readonly source: 'child_acknowledgement' | 'verified_local_projection';
  readonly childRunId: ConversationAgentRunId; readonly responseExecutionId: ConversationResponseExecutionId;
  readonly childRunRevision: number; readonly confirmedAt: IsoTimestamp;
} | { readonly kind: 'closed_without_replay'; readonly source: 'user_confirmation'; readonly confirmedAt: IsoTimestamp };
export interface ConversationAgentSessionV1 {
  readonly schemaVersion: 1; readonly id: ConversationAgentRunId;
  readonly projectId: ProjectId; readonly conversationId: ConversationId; readonly sourceMessageId: MessageId;
  readonly revision: number; readonly status: ConversationAgentSessionStatus;
  readonly budget: ConversationAgentSessionBudgetV1;
  readonly inputReferences: readonly ControlledConversationInputReferenceV1[];
  readonly childSegments: readonly ConversationAgentSessionSegmentV1[];
  readonly registeredWorkIds: readonly WorkId[];
  /** Initial semantic planning can incur an external request before a response segment exists. */
  readonly planningBoundary?: 'not_started' | 'submitted' | 'received';
  readonly goalHash?: string; readonly semanticPlanHash?: string;
  readonly waitingVersion: number; readonly waiting?: ConversationAgentSessionWaitingV1;
  readonly leaseEpoch: number; readonly lease?: ConversationAgentExecutionLeaseV1;
  readonly resumeReceipts: readonly ConversationAgentSessionResumeReceiptV1[];
  readonly closedReason?: 'completed' | 'failed' | 'cancelled';
  readonly reconciliationAcknowledgement?: ConversationAgentSessionReconciliationAcknowledgementV1;
  readonly createdAt: IsoTimestamp; readonly updatedAt: IsoTimestamp;
}
export interface ConversationAgentSessionRepository {
  get(sessionId: ConversationAgentRunId): Promise<ConversationAgentSessionV1 | undefined>;
  list(): Promise<readonly ConversationAgentSessionV1[]>;
  findByRunId(runId: ConversationAgentRunId): Promise<ConversationAgentSessionV1 | undefined>;
  create(session: ConversationAgentSessionV1): Promise<ConversationAgentSessionV1>;
  commit(input: { readonly sessionId: ConversationAgentRunId; readonly expectedRevision: number; readonly session: ConversationAgentSessionV1; readonly fence?: ConversationAgentExecutionFence }): Promise<ConversationAgentSessionV1>;
  acquireLease(input: { readonly sessionId: ConversationAgentRunId; readonly ownerId: string; readonly ttlMs: number; readonly expectedRevision?: number }): Promise<{ readonly session: ConversationAgentSessionV1; readonly lease: ConversationAgentExecutionLeaseV1 }>;
  renewLease(input: { readonly sessionId: ConversationAgentRunId; readonly fence: ConversationAgentExecutionFence; readonly ttlMs: number }): Promise<{ readonly session: ConversationAgentSessionV1; readonly lease: ConversationAgentExecutionLeaseV1 }>;
  releaseLease(input: { readonly sessionId: ConversationAgentRunId; readonly fence: ConversationAgentExecutionFence }): Promise<ConversationAgentSessionV1>;
  assertLease(input: { readonly sessionId: ConversationAgentRunId; readonly fence: ConversationAgentExecutionFence }): Promise<ConversationAgentSessionV1>;
  beginInitialSegment(input: { readonly sessionId: ConversationAgentRunId; readonly expectedRevision: number; readonly fence: ConversationAgentExecutionFence; readonly segment: ConversationAgentSessionSegmentV1; readonly inputReference: ControlledConversationInputReferenceV1 }): Promise<{ readonly session: ConversationAgentSessionV1; readonly lease: ConversationAgentExecutionLeaseV1; readonly replayed: boolean }>;
  recordVerifiedWorks(input: { readonly sessionId: ConversationAgentRunId; readonly workIds: readonly WorkId[] }): Promise<ConversationAgentSessionV1>;
  expireSession(input: { readonly sessionId: ConversationAgentRunId }): Promise<ConversationAgentSessionV1>;
  markUnknownObserved(input: { readonly sessionId: ConversationAgentRunId; readonly expectedRevision?: number; readonly workIds?: readonly WorkId[] }): Promise<ConversationAgentSessionV1>;
  acknowledgeReconciliationAfterChild(input: { readonly sessionId: ConversationAgentRunId; readonly targetChild: ConversationAgentRunV1 }): Promise<ConversationAgentSessionV1>;
  settleVerifiedLocalProjectionAfterChild(input: { readonly sessionId: ConversationAgentRunId; readonly targetChild: ConversationAgentRunV1 }): Promise<ConversationAgentSessionV1>;
  acknowledgeWithoutResponse(input: { readonly sessionId: ConversationAgentRunId; readonly expectedRevision: number; readonly confirmed: true }): Promise<ConversationAgentSessionV1>;
  beginResume(input: ConversationAgentSessionBeginResumeInput): Promise<{ readonly session: ConversationAgentSessionV1; readonly lease: ConversationAgentExecutionLeaseV1; readonly replayed: boolean }>;
  /** Repair only a primary, already-owned response receipt; this grants no execution authority. */
  recordVerifiedResponseBinding(input: { readonly sessionId: ConversationAgentRunId; readonly runId: ConversationAgentRunId;
    readonly responseExecutionId: ConversationResponseExecutionId; readonly expectedRevision: number;
    readonly expectedLeaseEpoch: number; readonly fence?: ConversationAgentExecutionFence }): Promise<ConversationAgentSessionV1>;
}
export interface ConversationAgentSessionBeginResumeInput {
  readonly sessionId: ConversationAgentRunId; readonly projectId: ProjectId; readonly conversationId: ConversationId;
  readonly expectedRevision: number; readonly waitingVersion: number; readonly nonceHash: string;
  readonly expectedInputReferenceHash: string;
  readonly commandId: string; readonly action: ConversationAgentResumeAction;
  readonly segment: ConversationAgentSessionSegmentV1; readonly inputReference: ControlledConversationInputReferenceV1;
  readonly ownerId: string; readonly ttlMs: number;
}

export function createConversationAgentSession(input: {
  readonly id: ConversationAgentRunId; readonly projectId: ProjectId; readonly conversationId: ConversationId; readonly sourceMessageId: MessageId;
  readonly budget: Omit<ConversationAgentSessionBudgetV1, 'toolCallsUsed' | 'costUnitsUsed' | 'toolAttemptsUsed'>;
  readonly initialSegment: ConversationAgentSessionSegmentV1; readonly inputReferences: readonly ControlledConversationInputReferenceV1[];
  readonly goalHash?: string; readonly semanticPlanHash?: string; readonly createdAt: IsoTimestamp;
}): ConversationAgentSessionV1 {
  if (input.initialSegment.planningBoundary !== undefined && input.initialSegment.planningBoundary !== 'not_started') throw new TypeError('A new root cannot inherit a submitted planning request');
  return parseConversationAgentSession({ schemaVersion: 1, id: input.id, projectId: input.projectId, conversationId: input.conversationId,
    sourceMessageId: input.sourceMessageId, revision: 0, status: 'active', budget: { ...input.budget, toolCallsUsed: 0, costUnitsUsed: 0, toolAttemptsUsed: 0 },
    inputReferences: input.inputReferences, childSegments: [{ ...input.initialSegment, planningBoundary: 'not_started' }], registeredWorkIds: [],
    ...(input.goalHash ? { goalHash: input.goalHash } : {}), ...(input.semanticPlanHash ? { semanticPlanHash: input.semanticPlanHash } : {}),
    planningBoundary: 'not_started', waitingVersion: 0, leaseEpoch: 0, resumeReceipts: [], createdAt: input.createdAt, updatedAt: input.createdAt });
}
export function updateConversationAgentSession(previous: ConversationAgentSessionV1,
  patch: Partial<Omit<ConversationAgentSessionV1, 'schemaVersion' | 'id' | 'projectId' | 'conversationId' | 'sourceMessageId' | 'revision' | 'createdAt' | 'updatedAt'>>,
  at: IsoTimestamp): ConversationAgentSessionV1 {
  const next = parseConversationAgentSession({ ...previous, ...patch, revision: previous.revision + 1, updatedAt: at });
  assertConversationAgentSessionUpdate(previous, next);
  return next;
}
export function parseControlledConversationInputReference(value: unknown): ControlledConversationInputReferenceV1 {
  const item = exact(value, ['kind', 'id', 'version', 'contentHash']);
  return { kind: choice(item.kind, ['message', 'response_draft', 'document_draft'] as const), id: identifier(item.id),
    version: integer(item.version, 0, Number.MAX_SAFE_INTEGER), contentHash: hash(item.contentHash) };
}
export function parseConversationAgentSessionSegment(value: unknown): ConversationAgentSessionSegmentV1 {
  const item = exact(value, ['runId', 'sourceMessageId', 'inputReferenceHash', 'status', 'toolCallsUsed', 'costUnitsUsed', 'toolAttemptsUsed'], ['responseExecutionId', 'planningBoundary']);
  return { runId: toConversationAgentRunId(identifier(item.runId)), sourceMessageId: toMessageId(identifier(item.sourceMessageId)),
    inputReferenceHash: hash(item.inputReferenceHash), status: choice(item.status, ['active', 'waiting', 'settled', 'unknown'] as const),
    toolCallsUsed: integer(item.toolCallsUsed, 0, 256), costUnitsUsed: integer(item.costUnitsUsed, 0, 1_000_000), toolAttemptsUsed: integer(item.toolAttemptsUsed, 0, 256),
    ...(item.planningBoundary !== undefined ? { planningBoundary: choice(item.planningBoundary, ['not_started', 'submitted', 'received'] as const) } : {}),
    ...(item.responseExecutionId !== undefined ? { responseExecutionId: toConversationResponseExecutionId(identifier(item.responseExecutionId)) } : {}) };
}
export function parseConversationAgentExecutionLease(value: unknown): ConversationAgentExecutionLeaseV1 {
  const item = exact(value, ['ownerId', 'epoch', 'acquiredAt', 'expiresAt']);
  const acquiredAt = integer(item.acquiredAt, 0, Number.MAX_SAFE_INTEGER), expiresAt = integer(item.expiresAt, 1, Number.MAX_SAFE_INTEGER);
  if (expiresAt <= acquiredAt || expiresAt - acquiredAt > 60_000) throw new TypeError('Invalid bounded execution lease');
  return { ownerId: identifier(item.ownerId), epoch: integer(item.epoch, 1, Number.MAX_SAFE_INTEGER), acquiredAt, expiresAt };
}
export function parseConversationAgentSession(value: unknown): ConversationAgentSessionV1 {
  const item = exact(value, ['schemaVersion', 'id', 'projectId', 'conversationId', 'sourceMessageId', 'revision', 'status', 'budget', 'inputReferences', 'childSegments', 'registeredWorkIds', 'waitingVersion', 'leaseEpoch', 'resumeReceipts', 'createdAt', 'updatedAt'], ['goalHash', 'semanticPlanHash', 'waiting', 'lease', 'closedReason', 'planningBoundary', 'reconciliationAcknowledgement']);
  if (item.schemaVersion !== 1) throw new TypeError('Unsupported agent session schema');
  const b = exact(item.budget, ['startedAt', 'deadlineAt', 'maxToolCalls', 'budgetUnits', 'toolCallsUsed', 'costUnitsUsed', 'toolAttemptsUsed']);
  const startedAt = integer(b.startedAt, 0, Number.MAX_SAFE_INTEGER), deadlineAt = integer(b.deadlineAt, 1, Number.MAX_SAFE_INTEGER);
  if (deadlineAt <= startedAt || deadlineAt - startedAt > 900_000) throw new TypeError('Invalid fixed session deadline');
  const maxToolCalls = integer(b.maxToolCalls, 1, 256), budgetUnits = integer(b.budgetUnits, 1, 1_000_000);
  const budget = { startedAt, deadlineAt, maxToolCalls, budgetUnits, toolCallsUsed: integer(b.toolCallsUsed, 0, maxToolCalls), costUnitsUsed: integer(b.costUnitsUsed, 0, budgetUnits), toolAttemptsUsed: integer(b.toolAttemptsUsed, 0, maxToolCalls) };
  const status = choice(item.status, conversationAgentSessionStatuses), createdAt = timestamp(item.createdAt), updatedAt = timestamp(item.updatedAt);
  if (Date.parse(createdAt) !== startedAt || updatedAt < createdAt) throw new TypeError('Invalid session timestamps');
  const inputReferences = array(item.inputReferences, 256).map(parseControlledConversationInputReference), childSegments = array(item.childSegments, 128).map(parseConversationAgentSessionSegment);
  if (!inputReferences.length || !childSegments.length || new Set(childSegments.map(segment => segment.runId)).size !== childSegments.length || new Set(childSegments.flatMap(segment => segment.responseExecutionId ? [segment.responseExecutionId] : [])).size !== childSegments.filter(segment => segment.responseExecutionId).length) throw new TypeError('Invalid duplicate session segment');
  if (new Set(inputReferences.map(ref => `${ref.kind}:${ref.id}:${ref.version}`)).size !== inputReferences.length) throw new TypeError('Duplicate controlled input reference');
  if (childSegments[0].runId !== item.id || childSegments[0].sourceMessageId !== item.sourceMessageId || childSegments.filter(segment => segment.status === 'active').length > 1) throw new TypeError('Invalid session root ownership');
  for (const key of ['toolCallsUsed', 'costUnitsUsed', 'toolAttemptsUsed'] as const) if (childSegments.reduce((sum, segment) => sum + segment[key], 0) !== budget[key]) throw new TypeError('Session accounting must match immutable child segments');
  const reconciliationAcknowledgement = item.reconciliationAcknowledgement === undefined ? undefined : parseAcknowledgement(item.reconciliationAcknowledgement);
  if (childSegments.some(segment => segment.status === 'unknown') && status !== 'needs_reconciliation' && !(status === 'closed' && reconciliationAcknowledgement)) throw new TypeError('Unknown session effect must remain frozen');
  const waitingVersion = integer(item.waitingVersion, 0, 128);
  let waiting: ConversationAgentSessionWaitingV1 | undefined;
  if (item.waiting !== undefined) {
    const w = exact(item.waiting, ['version', 'reason', 'allowedActions', 'resumeNonceHash', 'inputReferenceHash', 'preparedAt']);
    const allowedActions = array(w.allowedActions, 3).map(action => choice(action, ['reply', 'authorize', 'continue'] as const));
    if (!allowedActions.length || new Set(allowedActions).size !== allowedActions.length) throw new TypeError('Invalid waiting actions');
    waiting = { version: integer(w.version, 1, 128), reason: choice(w.reason, ['clarification', 'authorization', 'safe_continuation'] as const), allowedActions, resumeNonceHash: hash(w.resumeNonceHash), inputReferenceHash: hash(w.inputReferenceHash), preparedAt: timestamp(w.preparedAt) };
    if (waiting.version !== waitingVersion || waiting.preparedAt < createdAt || waiting.preparedAt > updatedAt || !['waiting_user', 'waiting_authorization'].includes(status)) throw new TypeError('Invalid waiting boundary');
    if ((waiting.reason === 'authorization') !== (status === 'waiting_authorization')) throw new TypeError('Waiting reason and state conflict');
  }
  if (['waiting_user', 'waiting_authorization'].includes(status) && !waiting) throw new TypeError('Waiting session requires a durable checkpoint');
  const leaseEpoch = integer(item.leaseEpoch, 0, Number.MAX_SAFE_INTEGER), lease = item.lease === undefined ? undefined : parseConversationAgentExecutionLease(item.lease);
  if (lease && (lease.epoch !== leaseEpoch || lease.expiresAt > deadlineAt || ['expired', 'closed'].includes(status))) throw new TypeError('Invalid session lease scope');
  const registeredWorkIds = array(item.registeredWorkIds, 256).map(id => toWorkId(identifier(id)));
  if (new Set(registeredWorkIds).size !== registeredWorkIds.length) throw new TypeError('Duplicate registered work evidence');
  const resumeReceipts = array(item.resumeReceipts, 128).map(value => {
    const receipt = exact(value, ['commandId', 'nonceHash', 'waitingVersion', 'childRunId', 'at']);
    return { commandId: identifier(receipt.commandId), nonceHash: hash(receipt.nonceHash), waitingVersion: integer(receipt.waitingVersion, 1, waitingVersion), childRunId: toConversationAgentRunId(identifier(receipt.childRunId)), at: timestamp(receipt.at) };
  });
  if (new Set(resumeReceipts.map(receipt => receipt.commandId)).size !== resumeReceipts.length || new Set(resumeReceipts.map(receipt => receipt.waitingVersion)).size !== resumeReceipts.length || resumeReceipts.some(receipt => !childSegments.some(segment => segment.runId === receipt.childRunId) || receipt.at < createdAt || receipt.at > updatedAt)) throw new TypeError('Invalid resume receipt');
  const closedReason = item.closedReason === undefined ? undefined : choice(item.closedReason, ['completed', 'failed', 'cancelled'] as const);
  if (status === 'closed' && closedReason === undefined || closedReason !== undefined && !['closed', 'needs_reconciliation'].includes(status)) throw new TypeError('Closed session requires its cause');
  if (reconciliationAcknowledgement && (status !== 'closed' || reconciliationAcknowledgement.source !== 'verified_local_projection' && closedReason !== 'cancelled' || lease || waiting ||
    reconciliationAcknowledgement.confirmedAt < createdAt || reconciliationAcknowledgement.confirmedAt > updatedAt || !childSegments.some(segment => segment.status === 'unknown') ||
    reconciliationAcknowledgement.source !== 'user_confirmation' && !childSegments.some(segment => segment.status === 'unknown' && segment.runId === reconciliationAcknowledgement.childRunId && segment.responseExecutionId === reconciliationAcknowledgement.responseExecutionId))) throw new TypeError('Invalid closed reconciliation acknowledgement');
  return { schemaVersion: 1, id: toConversationAgentRunId(identifier(item.id)), projectId: toProjectId(identifier(item.projectId)), conversationId: toConversationId(identifier(item.conversationId)), sourceMessageId: toMessageId(identifier(item.sourceMessageId)), revision: integer(item.revision, 0, 4095), status, budget, inputReferences, childSegments, registeredWorkIds, waitingVersion, leaseEpoch, resumeReceipts, createdAt, updatedAt,
    ...(waiting ? { waiting } : {}), ...(lease ? { lease } : {}), ...(closedReason ? { closedReason } : {}), ...(reconciliationAcknowledgement ? { reconciliationAcknowledgement } : {}), ...(item.planningBoundary !== undefined ? { planningBoundary: choice(item.planningBoundary, ['not_started', 'submitted', 'received'] as const) } : {}), ...(item.goalHash !== undefined ? { goalHash: hash(item.goalHash) } : {}), ...(item.semanticPlanHash !== undefined ? { semanticPlanHash: hash(item.semanticPlanHash) } : {}) };
}

export function assertConversationAgentSessionUpdate(previous: ConversationAgentSessionV1, next: ConversationAgentSessionV1, options: { readonly reconciliationAcknowledged?: boolean } = {}): void {
  for (const key of ['id', 'projectId', 'conversationId', 'sourceMessageId', 'createdAt', 'goalHash', 'semanticPlanHash'] as const) if (previous[key] !== next[key]) throw new TypeError('Session identity is immutable');
  for (const key of ['startedAt', 'deadlineAt', 'maxToolCalls', 'budgetUnits'] as const) if (previous.budget[key] !== next.budget[key]) throw new TypeError('Session budget policy is immutable');
  if (next.revision !== previous.revision + 1 || next.updatedAt < previous.updatedAt || next.leaseEpoch < previous.leaseEpoch || next.waitingVersion < previous.waitingVersion || next.waitingVersion > previous.waitingVersion + 1) throw new TypeError('Session revision or epoch regressed');
  for (const key of ['toolCallsUsed', 'costUnitsUsed', 'toolAttemptsUsed'] as const) if (next.budget[key] < previous.budget[key]) throw new TypeError('Session consumption cannot reset');
  assertPlanningBoundaryUpdate(previous.planningBoundary, next.planningBoundary);
  const acknowledged = options.reconciliationAcknowledged === true && previous.status === 'needs_reconciliation' && !previous.reconciliationAcknowledgement && next.status === 'closed' && (next.closedReason === 'cancelled' || next.reconciliationAcknowledgement?.source === 'verified_local_projection') && next.reconciliationAcknowledgement?.confirmedAt === next.updatedAt && !next.lease && !next.waiting;
  if (JSON.stringify(previous.reconciliationAcknowledgement) !== JSON.stringify(next.reconciliationAcknowledgement) && !acknowledged) throw new TypeError('Reconciliation acknowledgement requires a dedicated Host command');
  if (previous.reconciliationAcknowledgement && next.status !== previous.status) throw new TypeError('An acknowledged session cannot reopen or refreeze');
  if (['closed', 'expired', 'needs_reconciliation'].includes(previous.status) && next.status !== previous.status && !acknowledged && !(previous.status !== 'needs_reconciliation' && next.status === 'needs_reconciliation')) throw new TypeError('A terminal or unknown session cannot reopen');
  if (previous.closedReason !== next.closedReason && previous.closedReason !== undefined && !acknowledged) throw new TypeError('Session close reason is immutable');
  if (acknowledged && ['budget', 'inputReferences', 'childSegments', 'registeredWorkIds', 'resumeReceipts', 'waitingVersion', 'leaseEpoch', 'planningBoundary'].some(key => JSON.stringify(previous[key as keyof ConversationAgentSessionV1]) !== JSON.stringify(next[key as keyof ConversationAgentSessionV1]))) throw new TypeError('Acknowledgement cannot change execution evidence or budgets');
  if (next.childSegments.length < previous.childSegments.length || next.childSegments.length > previous.childSegments.length + 1 || next.inputReferences.length < previous.inputReferences.length || next.resumeReceipts.length < previous.resumeReceipts.length) throw new TypeError('Session ownership cannot be removed');
  previous.childSegments.forEach((segment, index) => {
    const update = next.childSegments[index];
    for (const key of ['runId', 'sourceMessageId', 'inputReferenceHash'] as const) if (segment[key] !== update[key]) throw new TypeError('Child segment identity is immutable');
    if (segment.responseExecutionId !== undefined && segment.responseExecutionId !== update.responseExecutionId) throw new TypeError('Child response binding is immutable');
    assertPlanningBoundaryUpdate(segment.planningBoundary, update.planningBoundary);
    for (const key of ['toolCallsUsed', 'costUnitsUsed', 'toolAttemptsUsed'] as const) if (segment[key] > update[key]) throw new TypeError('Child consumption cannot reset');
    if (['settled', 'unknown', 'waiting'].includes(segment.status) && segment.status !== update.status && !(segment.status === 'waiting' && update.status === 'settled') && !(update.status === 'unknown')) throw new TypeError('A closed child segment cannot restart');
  });
  previous.inputReferences.forEach((reference, index) => { if (JSON.stringify(reference) !== JSON.stringify(next.inputReferences[index])) throw new TypeError('Controlled input pin is immutable'); });
  previous.resumeReceipts.forEach((receipt, index) => { if (JSON.stringify(receipt) !== JSON.stringify(next.resumeReceipts[index])) throw new TypeError('Resume receipt is immutable'); });
  if (previous.registeredWorkIds.some((id, index) => next.registeredWorkIds[index] !== id)) throw new TypeError('Work evidence cannot be removed');
  if (previous.waiting && next.waiting && previous.waiting.version === next.waiting.version && JSON.stringify(previous.waiting) !== JSON.stringify(next.waiting)) throw new TypeError('Waiting contract cannot change without a new version');
  if (next.waiting && !previous.waiting && next.waiting.version !== previous.waitingVersion + 1) throw new TypeError('A new waiting checkpoint requires a new version');
}
/** Receives primary Host evidence only. State, charges and lease are preserved even after expiry. */
export function recordConversationAgentSessionVerifiedResponseBinding(previous: ConversationAgentSessionV1,
  evidence: { readonly run: ConversationAgentRunV1; readonly response: ConversationResponseExecutionV1;
    readonly sourceReference: ControlledConversationInputReferenceV1 }, at: IsoTimestamp): ConversationAgentSessionV1 {
  const run = parseConversationAgentRun(evidence.run), response = parseConversationResponseExecution(evidence.response);
  const reference = parseControlledConversationInputReference(evidence.sourceReference);
  const segment = previous.childSegments.find(item => item.runId === run.id);
  if (!segment || run.id === previous.id || run.parentRunId !== previous.id || run.projectId !== previous.projectId ||
    run.conversationId !== previous.conversationId || run.sourceMessageId !== segment.sourceMessageId ||
    !run.responseExecutionId || run.responseExecutionId !== response.id || response.projectId !== previous.projectId ||
    response.snapshot.conversationId !== previous.conversationId || response.snapshot.userMessageId !== segment.sourceMessageId ||
    reference.kind !== 'message' || reference.id !== segment.sourceMessageId || reference.version !== response.snapshot.userMessageRevision ||
    !previous.inputReferences.some(item => JSON.stringify(item) === JSON.stringify(reference))) throw new TypeError('Invalid primary response binding evidence');
  if (segment.responseExecutionId !== undefined) {
    if (segment.responseExecutionId !== response.id) throw new TypeError('Conflicting immutable response binding');
    return previous;
  }
  return updateConversationAgentSession(previous, { childSegments: previous.childSegments.map(item => item.runId === run.id
    ? { ...item, responseExecutionId: response.id } : item) }, at);
}
/** This closes uncertainty without resolving its effect or restoring execution authority. */
export function acknowledgeConversationAgentSessionAfterChild(previous: ConversationAgentSessionV1, target: ConversationAgentRunV1, at: IsoTimestamp): ConversationAgentSessionV1 {
  const child = parseConversationAgentRun(target);
  const segment = previous.childSegments.find(item => item.runId === child.id);
  if (child.projectId !== previous.projectId || child.conversationId !== previous.conversationId || child.status !== 'cancelled' ||
    child.reconciliationAcknowledgement?.kind !== 'closed_without_replay' || !segment || segment.status !== 'unknown' || segment.sourceMessageId !== child.sourceMessageId ||
    !child.responseExecutionId || child.responseExecutionId !== segment.responseExecutionId || child.id !== previous.id && child.parentRunId !== previous.id) throw new TypeError('Invalid acknowledged child ownership');
  return acknowledgeSession(previous, { kind: 'closed_without_replay', source: 'child_acknowledgement', childRunId: child.id,
    responseExecutionId: child.responseExecutionId, childRunRevision: child.revision, confirmedAt: at }, at);
}
export function acknowledgeConversationAgentSessionWithoutResponse(previous: ConversationAgentSessionV1, confirmed: true, at: IsoTimestamp): ConversationAgentSessionV1 {
  const segment = previous.childSegments.at(-1);
  if (confirmed !== true || !segment || segment.status !== 'unknown' || segment.responseExecutionId) throw new TypeError('A response-bound outcome requires child reconciliation');
  return acknowledgeSession(previous, { kind: 'closed_without_replay', source: 'user_confirmation', confirmedAt: at }, at);
}
/** Host verifies the accepted local-projection WAL separately; uncertainty and charges remain immutable. */
export function settleConversationAgentSessionVerifiedLocalProjection(previous: ConversationAgentSessionV1, target: ConversationAgentRunV1, at: IsoTimestamp): ConversationAgentSessionV1 {
  const child = parseConversationAgentRun(target), segment = previous.childSegments.find(item => item.runId === child.id);
  if (child.projectId !== previous.projectId || child.conversationId !== previous.conversationId || !['completed', 'failed', 'cancelled'].includes(child.status) ||
    child.reconciliationAcknowledgement?.kind !== 'closed_without_replay' || !segment || segment.status !== 'unknown' || segment.sourceMessageId !== child.sourceMessageId ||
    !child.responseExecutionId || child.responseExecutionId !== segment.responseExecutionId || child.id !== previous.id && child.parentRunId !== previous.id) throw new TypeError('Invalid locally verified child ownership');
  return acknowledgeSession(previous, { kind: 'closed_without_replay', source: 'verified_local_projection', childRunId: child.id,
    responseExecutionId: child.responseExecutionId, childRunRevision: child.revision, confirmedAt: at }, at, child.status as 'completed' | 'failed' | 'cancelled');
}
function acknowledgeSession(previous: ConversationAgentSessionV1, reconciliationAcknowledgement: ConversationAgentSessionReconciliationAcknowledgementV1, at: IsoTimestamp, closedReason: 'completed' | 'failed' | 'cancelled' = 'cancelled'): ConversationAgentSessionV1 {
  if (previous.reconciliationAcknowledgement) return previous;
  if (previous.status !== 'needs_reconciliation' || previous.lease) throw new TypeError('Only quiescent unknown sessions can be acknowledged');
  const next = parseConversationAgentSession({ ...previous, status: 'closed', closedReason, lease: undefined, waiting: undefined,
    reconciliationAcknowledgement, revision: previous.revision + 1, updatedAt: at });
  assertConversationAgentSessionUpdate(previous, next, { reconciliationAcknowledged: true }); return next;
}
function parseAcknowledgement(value: unknown): ConversationAgentSessionReconciliationAcknowledgementV1 {
  const base = exact(value, ['kind', 'source', 'confirmedAt'], ['childRunId', 'responseExecutionId', 'childRunRevision']);
  if (base.kind !== 'closed_without_replay') throw new TypeError('Invalid reconciliation acknowledgement');
  const confirmedAt = timestamp(base.confirmedAt);
  if (base.source === 'user_confirmation') {
    if (['childRunId', 'responseExecutionId', 'childRunRevision'].some(key => base[key] !== undefined)) throw new TypeError('Invalid user acknowledgement');
    return { kind: 'closed_without_replay', source: 'user_confirmation', confirmedAt };
  }
  if (base.source !== 'child_acknowledgement' && base.source !== 'verified_local_projection') throw new TypeError('Invalid acknowledgement source');
  return { kind: 'closed_without_replay', source: base.source, confirmedAt,
    childRunId: toConversationAgentRunId(identifier(base.childRunId)), responseExecutionId: toConversationResponseExecutionId(identifier(base.responseExecutionId)), childRunRevision: integer(base.childRunRevision, 1, 4095) };
}
function assertPlanningBoundaryUpdate(previous: ConversationAgentSessionSegmentV1['planningBoundary'], next: ConversationAgentSessionSegmentV1['planningBoundary']): void {
  if (previous !== undefined && (next === undefined || ['not_started', 'submitted', 'received'].indexOf(next) < ['not_started', 'submitted', 'received'].indexOf(previous))) throw new TypeError('Planning boundary cannot regress or disappear');
  if (previous === undefined && next === 'not_started') throw new TypeError('Legacy planning absence cannot prove that a request was not started');
}

function exact(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError('Invalid agent session record');
  const item = value as Record<string, unknown>, allowed = [...required, ...optional];
  if (required.some(key => !(key in item)) || Object.keys(item).some(key => !allowed.includes(key))) throw new TypeError('Agent session contains missing or unsupported fields');
  return item;
}
function identifier(value: unknown): string { if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value)) throw new TypeError('Invalid controlled session reference'); return value; }
function hash(value: unknown): string { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new TypeError('Invalid session semantic hash'); return value; }
function timestamp(value: unknown): IsoTimestamp { if (typeof value !== 'string') throw new TypeError('Invalid session timestamp'); return toIsoTimestamp(value); }
function integer(value: unknown, min: number, max: number): number { if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) throw new TypeError('Invalid session bounded counter'); return Number(value); }
function choice<const T extends readonly string[]>(value: unknown, choices: T): T[number] { if (!choices.includes(value as string)) throw new TypeError('Unsupported session state'); return value as T[number]; }
function array(value: unknown, maximum: number): readonly unknown[] { if (!Array.isArray(value) || value.length > maximum) throw new TypeError('Unbounded session collection'); return value; }
