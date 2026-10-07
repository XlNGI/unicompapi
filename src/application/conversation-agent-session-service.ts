import {
  createConversationAgentSession, parseControlledConversationInputReference, toIsoTimestamp, updateConversationAgentSession,
  type ConversationAgentRunId, type ConversationAgentRunV1, type ConversationAgentSessionRepository, type ConversationAgentSessionV1,
  type ConversationAgentSessionSegmentV1, type ConversationAgentResumeAction, type ControlledConversationInputReferenceV1,
  type ConversationAgentExecutionFence, type ConversationAgentExecutionLeaseV1, type ConversationResponseExecutionId,
  type MessageId, type ProjectId, type ConversationId, type WorkId
} from '../domain';
import { ExecutionBudgetError, type ExecutionBudgetPolicy } from './execution-budget';

export interface ConversationAgentContinuationRequest {
  readonly sessionId: ConversationAgentRunId; readonly projectId: ProjectId; readonly conversationId: ConversationId;
  readonly expectedRevision: number; readonly resumeToken: string; readonly commandId: string; readonly action: ConversationAgentResumeAction;
  readonly childRunId: ConversationAgentRunId; readonly sourceMessageId: MessageId; readonly inputReference: ControlledConversationInputReferenceV1;
  readonly responseExecutionId?: ConversationResponseExecutionId;
  readonly signal?: AbortSignal;
}
export interface ConversationAgentSessionServiceOptions {
  readonly repository: ConversationAgentSessionRepository;
  readonly ownerId: string;
  readonly now?: () => number;
  readonly hash: (safeSerializedValue: string) => string | Promise<string>;
  readonly nextResumeToken: () => string;
  readonly leaseTtlMs?: number;
  readonly recheckContinuation: (input: { readonly session: ConversationAgentSessionV1; readonly action: ConversationAgentResumeAction; readonly inputReference: ControlledConversationInputReferenceV1 }) => Promise<void>;
  readonly onLeaseLost?: (sessionId: ConversationAgentRunId, error: unknown) => void;
}
export class ConversationAgentSessionError extends Error {
  constructor(readonly code: 'session_not_found' | 'scope_mismatch' | 'continuation_invalid' | 'session_not_waiting' | 'reference_changed' | 'lease_lost' | 'unknown_result' | 'closed' | 'expired') {
    super(code); this.name = 'ConversationAgentSessionError';
  }
}
export interface ConversationAgentSessionAdmission {
  readonly session: ConversationAgentSessionV1;
  readonly segment: ConversationAgentSessionSegmentV1;
  readonly replayed: boolean;
  readonly lease?: ConversationAgentExecutionLeaseV1;
  /** Absent for an already consumed command, which authorizes no new execution. */
  readonly policy?: ExecutionBudgetPolicy;
}
interface TrackedOwnership { readonly fence: ConversationAgentExecutionFence; readonly controller: AbortController; readonly timer: ReturnType<typeof setInterval>; expiryTimer: ReturnType<typeof setTimeout> }

/** Versioned Host continuation and lease ownership; the existing Provider loop remains the only executor. */
export class ConversationAgentSessionService {
  private readonly operations = new Map<ConversationAgentRunId, Promise<unknown>>();
  private readonly ownership = new Map<ConversationAgentRunId, TrackedOwnership>();
  /** Identity index only. Current lease, status and budget always come from the primary fenced read. */
  private readonly ownedRunSessions = new Map<ConversationAgentRunId, ConversationAgentRunId>();
  private readonly ttlMs: number;
  constructor(private readonly options: ConversationAgentSessionServiceOptions) {
    this.ttlMs = options.leaseTtlMs ?? 30_000;
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(options.ownerId) || !Number.isSafeInteger(this.ttlMs) || this.ttlMs < 1000 || this.ttlMs > 60_000) throw new TypeError('invalid_session_owner_policy');
  }
  async open(input: { readonly run: ConversationAgentRunV1; readonly budget: ExecutionBudgetPolicy; readonly inputReferences: readonly ControlledConversationInputReferenceV1[]; readonly goalHash?: string; readonly semanticPlanHash?: string; readonly signal?: AbortSignal }): Promise<ConversationAgentSessionAdmission> {
    return this.exclusive(input.run.id, async () => {
      this.assertSignal(input.signal);
      const references = input.inputReferences.map(parseControlledConversationInputReference);
      const segment: ConversationAgentSessionSegmentV1 = { runId: input.run.id, sourceMessageId: input.run.sourceMessageId,
        inputReferenceHash: await this.digest(references), status: 'active', toolCallsUsed: 0, costUnitsUsed: 0, toolAttemptsUsed: 0, planningBoundary: 'not_started',
        ...(input.run.responseExecutionId ? { responseExecutionId: input.run.responseExecutionId } : {}) };
      const created = createConversationAgentSession({ id: input.run.id, projectId: input.run.projectId, conversationId: input.run.conversationId,
        sourceMessageId: input.run.sourceMessageId, budget: input.budget, initialSegment: segment, inputReferences: references,
        ...(input.goalHash ? { goalHash: input.goalHash } : {}), ...(input.semanticPlanHash ? { semanticPlanHash: input.semanticPlanHash } : {}), createdAt: toIsoTimestamp(new Date(input.budget.startedAt).toISOString()) });
      const existing = await this.options.repository.get(created.id);
      if (existing) {
        this.assertScope(existing, created);
        if (existing.sourceMessageId !== created.sourceMessageId || existing.goalHash !== created.goalHash || existing.semanticPlanHash !== created.semanticPlanHash ||
          existing.createdAt !== created.createdAt || JSON.stringify(existing.inputReferences.slice(0, references.length)) !== JSON.stringify(references) ||
          JSON.stringify({ startedAt: existing.budget.startedAt, deadlineAt: existing.budget.deadlineAt, maxToolCalls: existing.budget.maxToolCalls, budgetUnits: existing.budget.budgetUnits }) !== JSON.stringify(input.budget)) throw new ConversationAgentSessionError('continuation_invalid');
        return { session: existing, segment: existing.childSegments[0], replayed: true };
      }
      const session = await this.options.repository.create(created);
      await this.cancelIfAborted(session, input.signal);
      this.assertNotTerminal(session);
      const claimed = await this.options.repository.acquireLease({ sessionId: session.id, ownerId: this.options.ownerId, ttlMs: this.ttlMs, expectedRevision: session.revision });
      this.track(claimed.session, claimed.lease);
      await this.cancelIfAborted(claimed.session, input.signal);
      return { ...claimed, segment: claimed.session.childSegments[0], replayed: false, policy: this.remainingPolicy(claimed.session) };
    });
  }
  find(sessionId: ConversationAgentRunId): Promise<ConversationAgentSessionV1 | undefined> { return this.options.repository.get(sessionId); }
  findByRunId(runId: ConversationAgentRunId): Promise<ConversationAgentSessionV1 | undefined> { return this.options.repository.findByRunId(runId); }
  /** Acquires ownership for local recovery inspection only. The caller still has to classify durable effects. */
  async claimRecovery(sessionId: ConversationAgentRunId): Promise<{ readonly session: ConversationAgentSessionV1; readonly lease: ConversationAgentExecutionLeaseV1 }> {
    return this.exclusive(sessionId, async () => {
      const session = await this.require(sessionId); this.assertNotTerminal(session);
      const result = await this.options.repository.acquireLease({ sessionId, ownerId: this.options.ownerId, ttlMs: this.ttlMs, expectedRevision: session.revision });
      this.track(result.session, result.lease); return result;
    });
  }
  async releaseOwnership(sessionId: ConversationAgentRunId): Promise<void> {
    return this.exclusive(sessionId, async () => {
      const fence = this.fence(sessionId);
      try { await this.options.repository.releaseLease({ sessionId, fence }); }
      finally { this.untrack(sessionId, new ConversationAgentSessionError('lease_lost')); }
    });
  }
  async assertSessionOwnership(sessionId: ConversationAgentRunId): Promise<void> { await this.requireOwned(sessionId); }
  async markPlanningBoundary(sessionId: ConversationAgentRunId, state: 'submitted' | 'received', runId?: ConversationAgentRunId): Promise<ConversationAgentSessionV1> {
    return this.exclusive(sessionId, async () => {
      const session = await this.requireOwned(sessionId);
      const segment = session.childSegments.find(item => item.status === 'active' && (runId === undefined || item.runId === runId));
      if (!segment) throw new ConversationAgentSessionError('continuation_invalid');
      if (segment.planningBoundary === state) return session;
      const result = await this.commitOwned(session, { ...(segment.runId === session.id ? { planningBoundary: state } : {}),
        childSegments: session.childSegments.map(item => item.runId === segment.runId ? { ...item, planningBoundary: state } : item) });
      // The planning transport also receives this lease signal through the Root caller.
      await this.requireOwned(sessionId); return result;
    });
  }
  async admitInitialSegment(input: { readonly sessionId: ConversationAgentRunId; readonly run: ConversationAgentRunV1; readonly inputReference: ControlledConversationInputReferenceV1; readonly signal?: AbortSignal }): Promise<ConversationAgentSessionAdmission> {
    return this.exclusive(input.sessionId, async () => {
      this.assertSignal(input.signal);
      let session = await this.require(input.sessionId);
      const reference = parseControlledConversationInputReference(input.inputReference), inputReferenceHash = await this.digest(reference);
      const existing = session.childSegments.find(segment => segment.runId === input.run.id);
      if (existing && input.run.id !== session.id) {
        if (input.run.parentRunId !== session.id || input.run.projectId !== session.projectId || input.run.conversationId !== session.conversationId || existing.sourceMessageId !== input.run.sourceMessageId || existing.inputReferenceHash !== inputReferenceHash ||
          input.run.responseExecutionId && input.run.responseExecutionId !== existing.responseExecutionId) throw new ConversationAgentSessionError('continuation_invalid');
        return { session, segment: existing, replayed: true };
      }
      session = await this.requireOwned(input.sessionId); this.assertNotTerminal(session);
      if (input.run.parentRunId !== session.id || input.run.projectId !== session.projectId || input.run.conversationId !== session.conversationId || session.childSegments.length !== 1 ||
        session.childSegments[0].responseExecutionId || session.waitingVersion !== 0 || session.childSegments[0].status !== 'active' || session.budget.toolCallsUsed || session.budget.toolAttemptsUsed) throw new ConversationAgentSessionError('continuation_invalid');
      const segment: ConversationAgentSessionSegmentV1 = { runId: input.run.id, sourceMessageId: input.run.sourceMessageId, inputReferenceHash,
        status: 'active', toolCallsUsed: 0, costUnitsUsed: 0, toolAttemptsUsed: 0, planningBoundary: 'not_started', ...(input.run.responseExecutionId ? { responseExecutionId: input.run.responseExecutionId } : {}) };
      const result = await this.options.repository.beginInitialSegment({ sessionId: session.id, expectedRevision: session.revision, fence: this.fence(session.id), segment, inputReference: reference });
      this.rememberOwnedRuns(result.session);
      await this.cancelIfAborted(result.session, input.signal);
      return { ...result, segment, ...(result.replayed ? {} : { policy: this.remainingPolicy(result.session) }) };
    });
  }
  async wait(sessionId: ConversationAgentRunId, input: { readonly reason: 'clarification' | 'authorization' | 'safe_continuation'; readonly allowedActions: readonly ConversationAgentResumeAction[] }): Promise<{ readonly session: ConversationAgentSessionV1; readonly resumeToken: string }> {
    return this.exclusive(sessionId, async () => {
      const session = await this.requireOwned(sessionId); this.assertNotTerminal(session);
      const action = input.reason === 'authorization' ? 'authorize' : input.reason === 'safe_continuation' ? 'continue' : 'reply';
      if (input.allowedActions.length !== 1 || input.allowedActions[0] !== action) throw new ConversationAgentSessionError('continuation_invalid');
      const resumeToken = this.options.nextResumeToken();
      if (!/^[A-Za-z0-9_-]{24,200}$/.test(resumeToken)) throw new TypeError('invalid_resume_token');
      const at = this.timestamp(session), version = session.waitingVersion + 1;
      const next = updateConversationAgentSession(session, { status: input.reason === 'authorization' ? 'waiting_authorization' : 'waiting_user', lease: undefined,
        childSegments: session.childSegments.map(segment => segment.status === 'active' ? { ...segment, status: 'waiting' } : segment), waitingVersion: version,
        waiting: { version, reason: input.reason, allowedActions: input.allowedActions, resumeNonceHash: await this.digest(resumeToken), inputReferenceHash: await this.digest(session.inputReferences), preparedAt: at } }, at);
      const committed = await this.options.repository.commit({ sessionId, expectedRevision: session.revision, session: next, fence: this.fence(sessionId) });
      this.untrack(sessionId, new ConversationAgentSessionError('session_not_waiting'));
      return { session: committed, resumeToken };
    });
  }
  async resume(input: ConversationAgentContinuationRequest): Promise<ConversationAgentSessionAdmission> {
    return this.exclusive(input.sessionId, async () => {
      this.assertSignal(input.signal);
      const session = await this.require(input.sessionId);
      this.assertScope(session, input); this.assertNotTerminal(session);
      const inputReference = parseControlledConversationInputReference(input.inputReference);
      const nonceHash = await this.digest(input.resumeToken), inputReferenceHash = await this.digest(inputReference);
      const receipt = session.resumeReceipts.find(item => item.commandId === input.commandId);
      if (receipt) {
        const segment = session.childSegments.find(item => item.runId === receipt.childRunId)!;
        if (receipt.nonceHash !== nonceHash || segment.sourceMessageId !== input.sourceMessageId || segment.inputReferenceHash !== inputReferenceHash) throw new ConversationAgentSessionError('continuation_invalid');
        return { session, segment, replayed: true };
      }
      if (!session.waiting || !['waiting_user', 'waiting_authorization'].includes(session.status)) throw new ConversationAgentSessionError('session_not_waiting');
      if (session.revision !== input.expectedRevision || session.waiting.resumeNonceHash !== nonceHash || !session.waiting.allowedActions.includes(input.action)) throw new ConversationAgentSessionError('continuation_invalid');
      if (input.childRunId === session.id || session.childSegments.some(segment => segment.runId === input.childRunId)) throw new ConversationAgentSessionError('continuation_invalid');
      if (session.waiting.inputReferenceHash !== await this.digest(session.inputReferences)) throw new ConversationAgentSessionError('reference_changed');
      this.remainingPolicy(session);
      // Re-read versions, permission, source scope and model candidates through Host ports before consuming authorization.
      await this.options.recheckContinuation({ session, action: input.action, inputReference });
      this.assertSignal(input.signal);
      const segment: ConversationAgentSessionSegmentV1 = { runId: input.childRunId, sourceMessageId: input.sourceMessageId, inputReferenceHash,
        status: 'active', toolCallsUsed: 0, costUnitsUsed: 0, toolAttemptsUsed: 0, planningBoundary: 'not_started', ...(input.responseExecutionId ? { responseExecutionId: input.responseExecutionId } : {}) };
      const result = await this.options.repository.beginResume({ sessionId: session.id, projectId: input.projectId, conversationId: input.conversationId,
        expectedRevision: input.expectedRevision, waitingVersion: session.waiting.version, nonceHash, expectedInputReferenceHash: session.waiting.inputReferenceHash,
        commandId: input.commandId, action: input.action, segment, inputReference, ownerId: this.options.ownerId, ttlMs: this.ttlMs });
      if (!result.replayed) this.track(result.session, result.lease);
      if (!result.replayed) await this.cancelIfAborted(result.session, input.signal);
      return { ...result, segment: result.session.childSegments.find(item => item.runId === input.childRunId)!, ...(result.replayed ? {} : { policy: this.remainingPolicy(result.session) }) };
    });
  }
  async bindExecution(runId: ConversationAgentRunId, responseExecutionId: ConversationResponseExecutionId): Promise<ConversationAgentSessionV1> {
    const found = await this.requireByRunId(runId);
    return this.exclusive(found.id, async () => {
      const session = await this.requireOwned(found.id), segment = session.childSegments.find(item => item.runId === runId)!;
      if (segment.responseExecutionId === responseExecutionId) return session;
      if (segment.status !== 'active' || segment.responseExecutionId) throw new ConversationAgentSessionError('continuation_invalid');
      return this.commitOwned(session, { childSegments: session.childSegments.map(item => item.runId === runId ? { ...item, responseExecutionId } : item) });
    });
  }
  async recordVerifiedResponseBinding(input: { readonly sessionId: ConversationAgentRunId; readonly runId: ConversationAgentRunId;
    readonly responseExecutionId: ConversationResponseExecutionId; readonly expectedRevision: number; readonly expectedLeaseEpoch: number;
    readonly observed: boolean }): Promise<ConversationAgentSessionV1> {
    return this.exclusive(input.sessionId, async () => {
      if (!input.observed) await this.requireOwned(input.sessionId);
      return this.options.repository.recordVerifiedResponseBinding({ sessionId: input.sessionId, runId: input.runId,
        responseExecutionId: input.responseExecutionId, expectedRevision: input.expectedRevision, expectedLeaseEpoch: input.expectedLeaseEpoch,
        ...(input.observed ? {} : { fence: this.fence(input.sessionId) }) });
    });
  }
  async recordSegment(input: { readonly runId: ConversationAgentRunId; readonly toolCallsUsed: number; readonly costUnitsUsed: number; readonly toolAttemptsUsed: number; readonly status?: ConversationAgentSessionSegmentV1['status']; readonly registeredWorkIds?: readonly WorkId[] }): Promise<ConversationAgentSessionV1> {
    const found = await this.requireByRunId(input.runId);
    return this.exclusive(found.id, async () => {
      const session = await this.requireOwned(found.id), childSegments = session.childSegments.map(segment => segment.runId === input.runId ? { ...segment,
        toolCallsUsed: Math.max(segment.toolCallsUsed, input.toolCallsUsed), costUnitsUsed: Math.max(segment.costUnitsUsed, input.costUnitsUsed), toolAttemptsUsed: Math.max(segment.toolAttemptsUsed, input.toolAttemptsUsed), ...(input.status ? { status: input.status } : {}) } : segment);
      const budget = { ...session.budget, toolCallsUsed: childSegments.reduce((sum, segment) => sum + segment.toolCallsUsed, 0), costUnitsUsed: childSegments.reduce((sum, segment) => sum + segment.costUnitsUsed, 0), toolAttemptsUsed: childSegments.reduce((sum, segment) => sum + segment.toolAttemptsUsed, 0) };
      return this.commitOwned(session, { childSegments, budget, registeredWorkIds: [...new Set([...session.registeredWorkIds, ...(input.registeredWorkIds ?? [])])],
        ...(input.status === 'unknown' ? { status: 'needs_reconciliation', waiting: undefined, lease: undefined } : {}) });
    });
  }
  async settle(sessionId: ConversationAgentRunId, status: 'completed' | 'failed' | 'cancelled'): Promise<ConversationAgentSessionV1> {
    return this.exclusive(sessionId, async () => {
      const session = await this.requireOwned(sessionId); this.assertNotTerminal(session);
      const result = await this.commitOwned(session, { status: 'closed', closedReason: status, waiting: undefined, lease: undefined,
        childSegments: session.childSegments.map(segment => ['active', 'waiting'].includes(segment.status) ? { ...segment, status: 'settled' } : segment) });
      this.untrack(sessionId, new ConversationAgentSessionError('closed')); return result;
    });
  }
  /** Append independently verified formal Work evidence. This receipt grants no lease, budget or execution authority. */
  async recordVerifiedWorks(runId: ConversationAgentRunId, registeredWorkIds: readonly WorkId[]): Promise<ConversationAgentSessionV1> {
    const found = await this.requireByRunId(runId);
    return this.exclusive(found.id, async () => {
      const session = await this.require(found.id), works = [...new Set([...session.registeredWorkIds, ...registeredWorkIds])];
      if (works.length === session.registeredWorkIds.length) return session;
      return this.options.repository.recordVerifiedWorks({ sessionId: session.id, workIds: works });
    });
  }
  async freeze(sessionId: ConversationAgentRunId, registeredWorkIds: readonly WorkId[] = []): Promise<ConversationAgentSessionV1> {
    return this.exclusive(sessionId, async () => {
      const session = await this.requireOwned(sessionId);
      return this.commitOwned(session, { status: 'needs_reconciliation', waiting: undefined, lease: undefined,
        registeredWorkIds: [...new Set([...session.registeredWorkIds, ...registeredWorkIds])],
        childSegments: session.childSegments.map(segment => ['active', 'waiting'].includes(segment.status) ? { ...segment, status: 'unknown' } : segment) });
    });
  }
  async expire(sessionId: ConversationAgentRunId): Promise<ConversationAgentSessionV1> {
    return this.exclusive(sessionId, async () => {
      const session = await this.options.repository.expireSession({ sessionId });
      if (session.status === 'expired') this.untrack(sessionId, new ExecutionBudgetError('timeout'));
      return session;
    });
  }
  async freezeObserved(input: { readonly sessionId: ConversationAgentRunId; readonly expectedRevision?: number; readonly registeredWorkIds?: readonly WorkId[] }): Promise<ConversationAgentSessionV1> {
    return this.exclusive(input.sessionId, async () => {
      const session = await this.options.repository.markUnknownObserved({ sessionId: input.sessionId, ...(input.expectedRevision !== undefined ? { expectedRevision: input.expectedRevision } : {}), workIds: input.registeredWorkIds });
      this.untrack(session.id, new ConversationAgentSessionError('unknown_result')); return session;
    });
  }
  /** Only an existing Host-authorized child acknowledgement can close a bound unknown outcome. */
  async acknowledgeReconciliationAfterChild(targetChild: ConversationAgentRunV1): Promise<ConversationAgentSessionV1 | undefined> {
    const found = await this.options.repository.findByRunId(targetChild.id);
    if (!found) return undefined;
    return this.exclusive(found.id, async () => {
      const result = await this.options.repository.acknowledgeReconciliationAfterChild({ sessionId: found.id, targetChild });
      this.untrack(result.id, new ConversationAgentSessionError('closed')); return result;
    });
  }
  /** Explicit Host user confirmation closes a lost planner reply; it does not prove that its request was absent. */
  async acknowledgeWithoutResponse(input: { readonly sessionId: ConversationAgentRunId; readonly expectedRevision: number; readonly confirmed: true }): Promise<ConversationAgentSessionV1> {
    return this.exclusive(input.sessionId, async () => {
      const result = await this.options.repository.acknowledgeWithoutResponse(input);
      this.untrack(result.id, new ConversationAgentSessionError('closed')); return result;
    });
  }
  async settleVerifiedLocalProjectionAfterChild(targetChild: ConversationAgentRunV1): Promise<ConversationAgentSessionV1 | undefined> {
    const found = await this.options.repository.findByRunId(targetChild.id);
    if (!found || found.status !== 'needs_reconciliation' && !found.reconciliationAcknowledgement) return undefined;
    return this.exclusive(found.id, async () => {
      const result = await this.options.repository.settleVerifiedLocalProjectionAfterChild({ sessionId: found.id, targetChild });
      this.untrack(result.id, new ConversationAgentSessionError('closed')); return result;
    });
  }
  async cancel(input: { readonly sessionId: ConversationAgentRunId; readonly projectId: ProjectId; readonly conversationId: ConversationId; readonly expectedRevision: number }): Promise<ConversationAgentSessionV1> {
    return this.exclusive(input.sessionId, async () => {
      let session = await this.require(input.sessionId); this.assertScope(session, input);
      if (session.revision !== input.expectedRevision) throw new ConversationAgentSessionError('continuation_invalid');
      if (session.status === 'closed' || session.status === 'expired') return session;
      if (session.status === 'needs_reconciliation') throw new ConversationAgentSessionError('unknown_result');
      let fence: ConversationAgentExecutionFence | undefined;
      if (session.lease) { session = await this.requireOwned(session.id); fence = this.fence(session.id); }
      const next = updateConversationAgentSession(session, { status: 'closed', closedReason: 'cancelled', waiting: undefined, lease: undefined,
        childSegments: session.childSegments.map(segment => ['active', 'waiting'].includes(segment.status) ? { ...segment, status: 'settled' } : segment) }, this.timestamp(session));
      const result = await this.options.repository.commit({ sessionId: session.id, expectedRevision: session.revision, session: next, ...(fence ? { fence } : {}) });
      this.untrack(session.id, new ExecutionBudgetError('cancelled')); return result;
    });
  }
  async assertExecutionOwnership(runId: ConversationAgentRunId): Promise<void> {
    if (!await this.ownedSessionForRun(runId)) throw new ConversationAgentSessionError('session_not_found');
  }
  /** Single lookup followed by a fresh fenced read; legacy responses have no root session. */
  async assertExecutionOwnershipIfPresent(runId: ConversationAgentRunId): Promise<void> {
    await this.ownedSessionForRun(runId);
  }
  async executionContextForRun(runId: ConversationAgentRunId): Promise<{ readonly policy: ExecutionBudgetPolicy; readonly signal?: AbortSignal } | undefined> {
    const session = await this.ownedSessionForRun(runId);
    if (!session) return undefined;
    return { policy: this.remainingPolicy(session), signal: this.ownership.get(session.id)?.controller.signal };
  }
  async signalForRun(runId: ConversationAgentRunId): Promise<AbortSignal | undefined> {
    const ownedSessionId = this.ownedRunSessions.get(runId);
    if (ownedSessionId) return this.ownership.get(ownedSessionId)?.controller.signal;
    const session = await this.options.repository.findByRunId(runId); return session ? this.ownership.get(session.id)?.controller.signal : undefined;
  }
  async renew(sessionId: ConversationAgentRunId): Promise<void> {
    return this.exclusive(sessionId, async () => {
      const fence = this.fence(sessionId);
      try {
        const result = await this.options.repository.renewLease({ sessionId, fence, ttlMs: this.ttlMs });
        const entry = this.ownership.get(sessionId);
        if (entry && entry.fence.epoch === fence.epoch && entry.fence.ownerId === fence.ownerId) { clearTimeout(entry.expiryTimer); entry.expiryTimer = this.expiryTimer(sessionId, result.lease); }
      }
      catch (error) { this.untrack(sessionId, error); this.options.onLeaseLost?.(sessionId, error); throw error; }
    });
  }
  dispose(): void { for (const sessionId of [...this.ownership.keys()]) this.untrack(sessionId, new ExecutionBudgetError('cancelled')); }
  remainingPolicy(session: ConversationAgentSessionV1): ExecutionBudgetPolicy {
    if (this.now() >= session.budget.deadlineAt || session.status === 'expired') throw new ExecutionBudgetError('timeout');
    const maxToolCalls = session.budget.maxToolCalls - Math.max(session.budget.toolCallsUsed, session.budget.toolAttemptsUsed), budgetUnits = session.budget.budgetUnits - session.budget.costUnitsUsed;
    if (maxToolCalls <= 0) throw new ExecutionBudgetError('tool_call_limit');
    if (budgetUnits <= 0) throw new ExecutionBudgetError('budget_exceeded');
    return { startedAt: session.budget.startedAt, deadlineAt: session.budget.deadlineAt, maxToolCalls, budgetUnits };
  }
  private async commitOwned(session: ConversationAgentSessionV1, patch: Parameters<typeof updateConversationAgentSession>[1]): Promise<ConversationAgentSessionV1> {
    const result = await this.options.repository.commit({ sessionId: session.id, expectedRevision: session.revision, session: updateConversationAgentSession(session, patch, this.timestamp(session)), fence: this.fence(session.id) });
    if (['needs_reconciliation', 'closed', 'expired'].includes(result.status)) this.untrack(session.id, new ConversationAgentSessionError(result.status === 'needs_reconciliation' ? 'unknown_result' : result.status === 'expired' ? 'expired' : 'closed'));
    else this.rememberOwnedRuns(result);
    return result;
  }
  private async cancelIfAborted(session: ConversationAgentSessionV1, signal?: AbortSignal): Promise<void> {
    if (!signal?.aborted) return;
    const owned = this.ownership.get(session.id);
    if (session.lease && !owned) throw new ExecutionBudgetError('cancelled');
    const next = updateConversationAgentSession(session, { status: 'closed', closedReason: 'cancelled', lease: undefined, waiting: undefined,
      childSegments: session.childSegments.map(segment => ['active', 'waiting'].includes(segment.status) ? { ...segment, status: 'settled' } : segment) }, this.timestamp(session));
    await this.options.repository.commit({ sessionId: session.id, expectedRevision: session.revision, session: next, ...(owned ? { fence: owned.fence } : {}) });
    this.untrack(session.id, new ExecutionBudgetError('cancelled'));
    throw new ExecutionBudgetError('cancelled');
  }
  private assertSignal(signal?: AbortSignal): void { if (signal?.aborted) throw new ExecutionBudgetError('cancelled'); }
  private async requireOwned(sessionId: ConversationAgentRunId): Promise<ConversationAgentSessionV1> {
    try { return await this.options.repository.assertLease({ sessionId, fence: this.fence(sessionId) }); }
    catch (error) { this.untrack(sessionId, error); this.options.onLeaseLost?.(sessionId, error); throw error; }
  }
  private async require(sessionId: ConversationAgentRunId): Promise<ConversationAgentSessionV1> {
    const session = await this.options.repository.get(sessionId); if (!session) throw new ConversationAgentSessionError('session_not_found'); return session;
  }
  private async requireByRunId(runId: ConversationAgentRunId): Promise<ConversationAgentSessionV1> {
    const session = await this.options.repository.findByRunId(runId); if (!session) throw new ConversationAgentSessionError('session_not_found'); return session;
  }
  private fence(sessionId: ConversationAgentRunId): ConversationAgentExecutionFence { const entry = this.ownership.get(sessionId); if (!entry) throw new ConversationAgentSessionError('lease_lost'); return entry.fence; }
  private async ownedSessionForRun(runId: ConversationAgentRunId): Promise<ConversationAgentSessionV1 | undefined> {
    const indexed = this.ownedRunSessions.get(runId);
    const sessionId = indexed ?? (await this.options.repository.findByRunId(runId))?.id;
    if (!sessionId) return undefined;
    const session = await this.requireOwned(sessionId);
    if (!session.childSegments.some(segment => segment.runId === runId && segment.status === 'active')) throw new ConversationAgentSessionError('lease_lost');
    this.rememberOwnedRuns(session);
    return session;
  }
  private rememberOwnedRuns(session: ConversationAgentSessionV1): void {
    if (!this.ownership.has(session.id)) return;
    for (const segment of session.childSegments) this.ownedRunSessions.set(segment.runId, session.id);
  }
  private track(session: ConversationAgentSessionV1, lease: ConversationAgentExecutionLeaseV1): void {
    const sessionId = session.id;
    this.untrack(sessionId, new ConversationAgentSessionError('lease_lost'));
    const controller = new AbortController(), timer = setInterval(() => { void this.renew(sessionId).catch(() => undefined); }, Math.max(250, Math.floor(this.ttlMs / 3)));
    timer.unref?.(); this.ownership.set(sessionId, { fence: { ownerId: lease.ownerId, epoch: lease.epoch }, controller, timer, expiryTimer: this.expiryTimer(sessionId, lease) });
    this.rememberOwnedRuns(session);
  }
  private expiryTimer(sessionId: ConversationAgentRunId, lease: ConversationAgentExecutionLeaseV1): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      const entry = this.ownership.get(sessionId);
      if (entry?.fence.epoch === lease.epoch && entry.fence.ownerId === lease.ownerId) {
        const error = new ConversationAgentSessionError('lease_lost'); this.untrack(sessionId, error); this.options.onLeaseLost?.(sessionId, error);
      }
    }, Math.max(1, lease.expiresAt - this.now()));
    timer.unref?.(); return timer;
  }
  private untrack(sessionId: ConversationAgentRunId, reason: unknown): void {
    for (const [runId, indexedSessionId] of this.ownedRunSessions) if (indexedSessionId === sessionId) this.ownedRunSessions.delete(runId);
    const entry = this.ownership.get(sessionId); if (!entry) return;
    clearInterval(entry.timer); clearTimeout(entry.expiryTimer); entry.controller.abort(reason); this.ownership.delete(sessionId);
  }
  private assertScope(session: ConversationAgentSessionV1, scope: { readonly projectId: ProjectId; readonly conversationId: ConversationId }): void {
    if (session.projectId !== scope.projectId || session.conversationId !== scope.conversationId) throw new ConversationAgentSessionError('scope_mismatch');
  }
  private assertNotTerminal(session: ConversationAgentSessionV1): void {
    if (session.status === 'needs_reconciliation') throw new ConversationAgentSessionError('unknown_result');
    if (session.status === 'closed') throw new ConversationAgentSessionError('closed');
    if (session.status === 'expired' || this.now() >= session.budget.deadlineAt) throw new ConversationAgentSessionError('expired');
  }
  private async digest(value: unknown): Promise<string> {
    const result = await this.options.hash(JSON.stringify(value)); if (!/^[a-f0-9]{64}$/.test(result)) throw new TypeError('invalid_session_digest'); return result;
  }
  private now(): number { return this.options.now?.() ?? Date.now(); }
  private timestamp(session: ConversationAgentSessionV1): ReturnType<typeof toIsoTimestamp> { return toIsoTimestamp(new Date(Math.max(this.now(), Date.parse(session.updatedAt))).toISOString()); }
  private exclusive<T>(sessionId: ConversationAgentRunId, work: () => Promise<T>): Promise<T> {
    const previous = this.operations.get(sessionId) ?? Promise.resolve(), operation = previous.then(work, work); this.operations.set(sessionId, operation);
    void operation.finally(() => { if (this.operations.get(sessionId) === operation) this.operations.delete(sessionId); }).catch(() => undefined); return operation;
  }
}
