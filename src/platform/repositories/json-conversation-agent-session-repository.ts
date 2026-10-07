import {
  acknowledgeConversationAgentSessionAfterChild, acknowledgeConversationAgentSessionWithoutResponse,
  settleConversationAgentSessionVerifiedLocalProjection,
  recordConversationAgentSessionVerifiedResponseBinding, parseConversationAgentRun, parseConversationResponseExecution,
  parseConversationAgentSession, parseConversationAgentSessionSegment, parseControlledConversationInputReference,
  updateConversationAgentSession, assertConversationAgentSessionUpdate, toIsoTimestamp,
  type ConversationAgentSessionV1, type ConversationAgentSessionRepository, type ConversationAgentRunId,
  type ConversationAgentExecutionFence, type ConversationAgentExecutionLeaseV1, type ConversationAgentSessionBeginResumeInput,
  type ProjectId, type WorkId, type ConversationAgentSessionSegmentV1, type ControlledConversationInputReferenceV1, type ConversationAgentRunV1,
  type ConversationResponseExecutionId
} from '../../domain';
import { createHash } from 'node:crypto';
import { parseCompletionIntent } from './json-conversation-completion-journal';
import { ProjectMetadataUnitOfWork, type ProjectMetadataDraft } from '../storage/project-metadata-unit-of-work';
import { parseProjectMetadataDocument, ProjectMetadataDraft as MetadataDraft } from '../storage/project-metadata-unit-of-work';
import { projectStoragePaths } from '../storage/project-paths';
import { parseConversationDocument } from './json-conversation-repository';
import { JsonRevisionConflictError, type JsonValue } from '../storage/json-document';
import type { ProjectStorageAdapter } from '../storage/storage-adapter';

const metadataKey = 'conversation-agent-sessions-v1';
interface SessionCollectionV1 { readonly schemaVersion: 1; readonly projectId: ProjectId; readonly sessions: readonly ConversationAgentSessionV1[] }
export class ConversationAgentSessionConflictError extends Error {
  constructor(readonly sessionId: ConversationAgentRunId, readonly code: 'revision_conflict' | 'lease_busy' | 'lease_lost' | 'resume_conflict' | 'session_unavailable') {
    super(`conversation_agent_session_${code}`); this.name = 'ConversationAgentSessionConflictError';
  }
}
export class ConversationAgentSessionStorageReconciliationError extends Error {
  constructor() { super('conversation_agent_session_storage_reconciliation_required'); this.name = 'ConversationAgentSessionStorageReconciliationError'; }
}
/** All continuation claims and fencing facts share the project metadata CAS with the existing completion WAL. */
export class JsonConversationAgentSessionRepository implements ConversationAgentSessionRepository {
  private readonly unit: ProjectMetadataUnitOfWork;
  constructor(private readonly storage: ProjectStorageAdapter, readonly projectId: ProjectId, private readonly now: () => string = () => new Date().toISOString()) {
    this.unit = new ProjectMetadataUnitOfWork(storage, now);
  }
  async get(sessionId: ConversationAgentRunId): Promise<ConversationAgentSessionV1 | undefined> { return structuredClone((await this.loadAuthoritative()).collection.sessions.find(session => session.id === sessionId)); }
  async list(): Promise<readonly ConversationAgentSessionV1[]> { return structuredClone((await this.loadAuthoritative()).collection.sessions); }
  async findByRunId(runId: ConversationAgentRunId): Promise<ConversationAgentSessionV1 | undefined> { return (await this.list()).find(session => session.childSegments.some(segment => segment.runId === runId)); }
  /** Backup metadata is only evidence; it cannot authorize a lease, continuation or replacement write. */
  async inspect(sessionId: ConversationAgentRunId) {
    const loaded = await this.unit.load(), collection = this.parseCollection(loaded.document.entries.find(entry => entry.key === metadataKey)?.value);
    return { session: structuredClone(collection.sessions.find(session => session.id === sessionId)), source: loaded.source, readOnly: loaded.source === 'backup' };
  }
  async create(session: ConversationAgentSessionV1): Promise<ConversationAgentSessionV1> {
    const next = this.requireScope(session);
    if (next.revision !== 0 || next.status !== 'active' || next.leaseEpoch || next.lease || next.waitingVersion || next.waiting || next.resumeReceipts.length || next.childSegments.length !== 1 || next.childSegments[0].status !== 'active' || next.childSegments[0].planningBoundary !== 'not_started' || next.planningBoundary !== 'not_started' || next.registeredWorkIds.length || next.budget.toolCallsUsed || next.budget.costUnitsUsed || next.budget.toolAttemptsUsed || next.createdAt !== next.updatedAt) throw new TypeError('Invalid initial session');
    return this.mutate(collection => {
      const previous = collection.sessions.find(item => item.id === next.id);
      if (previous) {
        if (previous.projectId !== next.projectId || previous.conversationId !== next.conversationId || previous.sourceMessageId !== next.sourceMessageId || previous.createdAt !== next.createdAt || JSON.stringify(previous.inputReferences.slice(0, next.inputReferences.length)) !== JSON.stringify(next.inputReferences) || JSON.stringify(previous.childSegments[0]) !== JSON.stringify(next.childSegments[0]) || JSON.stringify(policy(previous)) !== JSON.stringify(policy(next))) throw new ConversationAgentSessionConflictError(next.id, 'revision_conflict');
        return { collection, result: previous, changed: false };
      }
      this.assertUniqueSegmentOwnership(collection, next);
      return { collection: { ...collection, sessions: [...collection.sessions, next] }, result: next, changed: true };
    });
  }
  async commit(input: { readonly sessionId: ConversationAgentRunId; readonly expectedRevision: number; readonly session: ConversationAgentSessionV1; readonly fence?: ConversationAgentExecutionFence }): Promise<ConversationAgentSessionV1> {
    const next = this.requireScope(input.session);
    if (next.id !== input.sessionId) throw new TypeError('Session commit scope mismatch');
    return this.update(input.sessionId, input.expectedRevision, previous => {
      if (previous.lease && !input.fence) throw new ConversationAgentSessionConflictError(previous.id, 'lease_lost');
      if (input.fence) this.requireLease(previous, input.fence);
      assertConversationAgentSessionUpdate(previous, next);
      if (previous.childSegments.some((segment, index) => segment.responseExecutionId !== next.childSegments[index]?.responseExecutionId &&
        (segment.status !== 'active' || previous.status !== 'active' || !input.fence))) throw new TypeError('Quiescent response receipts require primary verified binding repair');
      if (JSON.stringify(previous.lease) !== JSON.stringify(next.lease) && next.lease !== undefined || next.leaseEpoch !== previous.leaseEpoch) throw new TypeError('Lease changes require fenced repository methods');
      if (next.childSegments.length !== previous.childSegments.length || next.resumeReceipts.length !== previous.resumeReceipts.length || previous.waiting && !next.waiting && next.status === 'active') throw new TypeError('Resume requires an atomic nonce claim');
      return next;
    });
  }
  async acquireLease(input: { readonly sessionId: ConversationAgentRunId; readonly ownerId: string; readonly ttlMs: number; readonly expectedRevision?: number }) {
    const ownerId = safeIdentifier(input.ownerId), ttlMs = leaseTtl(input.ttlMs);
    const session = await this.update(input.sessionId, input.expectedRevision, previous => {
      const now = this.clock(); this.requireAvailable(previous, now);
      if (previous.lease && previous.lease.expiresAt > now) throw new ConversationAgentSessionConflictError(previous.id, 'lease_busy');
      const lease = { ownerId, epoch: previous.leaseEpoch + 1, acquiredAt: now, expiresAt: Math.min(now + ttlMs, previous.budget.deadlineAt) };
      return updateConversationAgentSession(previous, { lease, leaseEpoch: lease.epoch }, this.at(previous, now));
    });
    return { session, lease: session.lease! };
  }
  async renewLease(input: { readonly sessionId: ConversationAgentRunId; readonly fence: ConversationAgentExecutionFence; readonly ttlMs: number }) {
    const ttlMs = leaseTtl(input.ttlMs);
    const session = await this.update(input.sessionId, undefined, previous => {
      const now = this.clock(); const lease = this.requireLease(previous, input.fence, now);
      this.requireAvailable(previous, now);
      return updateConversationAgentSession(previous, { lease: { ...lease, acquiredAt: now, expiresAt: Math.min(now + ttlMs, previous.budget.deadlineAt) } }, this.at(previous, now));
    });
    return { session, lease: session.lease! };
  }
  async releaseLease(input: { readonly sessionId: ConversationAgentRunId; readonly fence: ConversationAgentExecutionFence }) {
    return this.update(input.sessionId, undefined, previous => {
      this.requireLease(previous, input.fence);
      return updateConversationAgentSession(previous, { lease: undefined }, this.at(previous));
    });
  }
  async assertLease(input: { readonly sessionId: ConversationAgentRunId; readonly fence: ConversationAgentExecutionFence }) {
    const session = await this.get(input.sessionId);
    if (!session) throw new ConversationAgentSessionConflictError(input.sessionId, 'session_unavailable');
    this.requireAvailable(session, this.clock()); this.requireLease(session, input.fence);
    return session;
  }
  async beginInitialSegment(input: { readonly sessionId: ConversationAgentRunId; readonly expectedRevision: number; readonly fence: ConversationAgentExecutionFence; readonly segment: ConversationAgentSessionSegmentV1; readonly inputReference: ControlledConversationInputReferenceV1 }) {
    const segment = freshPlanningSegment(input.segment), reference = parseControlledConversationInputReference(input.inputReference);
    if (segment.runId === input.sessionId || segment.status !== 'active' || segment.toolCallsUsed || segment.costUnitsUsed || segment.toolAttemptsUsed || reference.kind === 'message' && reference.id !== segment.sourceMessageId) throw new TypeError('Invalid initial executable segment');
    return this.mutate(collection => {
      const index = collection.sessions.findIndex(item => item.id === input.sessionId), previous = collection.sessions[index];
      if (!previous) throw new ConversationAgentSessionConflictError(input.sessionId, 'session_unavailable');
      const replay = previous.childSegments[1];
      if (replay?.runId === segment.runId) {
        if (replay.sourceMessageId !== segment.sourceMessageId || replay.inputReferenceHash !== segment.inputReferenceHash || replay.responseExecutionId !== segment.responseExecutionId || !previous.inputReferences.some(item => JSON.stringify(item) === JSON.stringify(reference)) || !previous.lease) throw new ConversationAgentSessionConflictError(previous.id, 'resume_conflict');
        return { collection, result: { session: previous, lease: previous.lease, replayed: true }, changed: false };
      }
      const now = this.clock(); this.requireAvailable(previous, now); const lease = this.requireLease(previous, input.fence, now);
      if (previous.revision !== input.expectedRevision || previous.status !== 'active' || previous.waiting || previous.childSegments.length !== 1 || previous.childSegments[0].responseExecutionId || previous.budget.toolCallsUsed || previous.budget.toolAttemptsUsed || previous.budget.costUnitsUsed) throw new ConversationAgentSessionConflictError(previous.id, 'resume_conflict');
      const next = updateConversationAgentSession(previous, {
        childSegments: [{ ...previous.childSegments[0], status: 'settled' }, segment],
        inputReferences: previous.inputReferences.some(item => JSON.stringify(item) === JSON.stringify(reference)) ? previous.inputReferences : [...previous.inputReferences, reference]
      }, this.at(previous, now));
      this.assertUniqueSegmentOwnership(collection, next); const sessions = [...collection.sessions]; sessions[index] = next;
      return { collection: { ...collection, sessions }, result: { session: next, lease, replayed: false }, changed: true };
    });
  }
  /** Receipts of already verified local Works are evidence, never authority to restart any step. */
  async recordVerifiedWorks(input: { readonly sessionId: ConversationAgentRunId; readonly workIds: readonly WorkId[] }): Promise<ConversationAgentSessionV1> {
    if (input.workIds.length > 256 || input.workIds.some(id => !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(id))) throw new TypeError('Invalid verified work reference');
    return this.mutate(collection => {
      const index = collection.sessions.findIndex(item => item.id === input.sessionId), previous = collection.sessions[index];
      if (!previous) throw new ConversationAgentSessionConflictError(input.sessionId, 'session_unavailable');
      const ids = [...new Set([...previous.registeredWorkIds, ...input.workIds])];
      if (ids.length === previous.registeredWorkIds.length) return { collection, result: previous, changed: false };
      const next = updateConversationAgentSession(previous, { registeredWorkIds: ids }, this.at(previous));
      const sessions = [...collection.sessions]; sessions[index] = next;
      return { collection: { ...collection, sessions }, result: next, changed: true };
    });
  }
  async recordVerifiedResponseBinding(input: { readonly sessionId: ConversationAgentRunId; readonly runId: ConversationAgentRunId;
    readonly responseExecutionId: ConversationResponseExecutionId; readonly expectedRevision: number; readonly expectedLeaseEpoch: number;
    readonly fence?: ConversationAgentExecutionFence }): Promise<ConversationAgentSessionV1> {
    await this.loadAuthoritative();
    let result: ConversationAgentSessionV1 | undefined;
    await this.storage.mutateJsonAtomically(projectStoragePaths.entities.metadataUnit, async current => {
      if (current === undefined) throw new ConversationAgentSessionStorageReconciliationError();
      const document = parseProjectMetadataDocument(current), draft = new MetadataDraft(document.entries);
      const collection = this.parseCollection(draft.get(metadataKey));
      const index = collection.sessions.findIndex(item => item.id === input.sessionId), previous = collection.sessions[index];
      if (!previous || previous.revision !== input.expectedRevision || previous.leaseEpoch !== input.expectedLeaseEpoch) throw new ConversationAgentSessionConflictError(input.sessionId, 'revision_conflict');
      // Read primary identity while the metadata CAS is held. A backup or a
      // missing canonical WAL cannot manufacture a binding or prove no effect.
      const [runDocument, responseDocument, conversationDocument] = await Promise.all([
        this.storage.readJsonWithBackup(projectStoragePaths.entities.conversationAgentRuns, value => value as { runs: readonly unknown[] }),
        this.storage.readJsonWithBackup(projectStoragePaths.entities.conversationResponseExecutions, value => value as { executions: readonly unknown[] }),
        this.storage.readJsonWithBackup(projectStoragePaths.entities.conversations, parseConversationDocument)
      ]);
      if (!runDocument || runDocument.source !== 'primary' || !Array.isArray(runDocument.value.runs) ||
        !responseDocument || responseDocument.source !== 'primary' || !Array.isArray(responseDocument.value.executions) ||
        !conversationDocument || conversationDocument.source !== 'primary') throw new ConversationAgentSessionStorageReconciliationError();
      const run = runDocument.value.runs.map(parseConversationAgentRun).find(item => item.id === input.runId);
      const parent = runDocument.value.runs.map(parseConversationAgentRun).find(item => item.id === previous.id);
      const response = responseDocument.value.executions.map(parseConversationResponseExecution).find(item => item.id === input.responseExecutionId);
      const conversation = conversationDocument.value.conversations.find(item => item.id === previous.conversationId);
      if (!run || !response || !parent || parent.responseExecutionId || parent.projectId !== previous.projectId ||
        parent.conversationId !== previous.conversationId || parent.sourceMessageId !== previous.sourceMessageId ||
        !conversation || conversation.projectId !== previous.projectId || conversation.status !== 'active') throw new TypeError('Invalid primary binding ownership');
      for (const reference of previous.inputReferences) {
        const message = conversation.messages.find(item => item.id === reference.id && item.role === 'user' && item.state === 'completed');
        if (reference.kind !== 'message' || !message || message.revision !== reference.version ||
          createHash('sha256').update(JSON.stringify([message.content, message.displayContent, message.attachments])).digest('hex') !== reference.contentHash) throw new TypeError('Primary binding source pin changed');
      }
      const reference = previous.inputReferences.find(item => item.kind === 'message' && item.id === run.sourceMessageId && item.version === response.snapshot.userMessageRevision);
      if (!reference) throw new TypeError('Primary binding source pin missing');
      const segment = previous.childSegments.find(item => item.runId === run.id);
      if (!segment || createHash('sha256').update(JSON.stringify(reference)).digest('hex') !== segment.inputReferenceHash) throw new TypeError('Primary binding segment pin changed');
      const now = this.clock();
      if (input.fence) { this.requireAvailable(previous, now); this.requireLease(previous, input.fence, now); }
      else if (previous.lease && previous.lease.expiresAt > now) throw new ConversationAgentSessionConflictError(previous.id, 'lease_busy');
      result = recordConversationAgentSessionVerifiedResponseBinding(previous, { run, response, sourceReference: reference }, this.at(previous, now));
      this.assertUniqueSegmentOwnership(collection, result);
      if (result === previous) return document;
      const sessions = [...collection.sessions]; sessions[index] = result;
      draft.set(metadataKey, JSON.parse(JSON.stringify({ ...collection, sessions })) as JsonValue);
      return parseProjectMetadataDocument({ ...document, revision: document.revision + 1, updatedAt: this.at(previous, now), entries: draft.entries() });
    }, { backup: true });
    return structuredClone(result!);
  }
  /** A passed root deadline revokes every lease; this local close never dispatches or resets a step. */
  async expireSession(input: { readonly sessionId: ConversationAgentRunId }): Promise<ConversationAgentSessionV1> {
    return this.mutate(collection => {
      const index = collection.sessions.findIndex(item => item.id === input.sessionId), previous = collection.sessions[index];
      if (!previous) throw new ConversationAgentSessionConflictError(input.sessionId, 'session_unavailable');
      if (['expired', 'closed', 'needs_reconciliation'].includes(previous.status)) return { collection, result: previous, changed: false };
      const now = this.clock();
      if (now < previous.budget.deadlineAt) throw new ConversationAgentSessionConflictError(previous.id, 'session_unavailable');
      const next = updateConversationAgentSession(previous, { status: 'expired', lease: undefined, waiting: undefined,
        childSegments: previous.childSegments.map(segment => ['active', 'waiting'].includes(segment.status) ? { ...segment, status: 'settled' as const } : segment) }, this.at(previous, now));
      const sessions = [...collection.sessions]; sessions[index] = next;
      return { collection: { ...collection, sessions }, result: next, changed: true };
    });
  }
  /** Only observed uncertainty may upgrade a quiescent session. This grants no lease or replay authority. */
  async markUnknownObserved(input: { readonly sessionId: ConversationAgentRunId; readonly expectedRevision?: number; readonly workIds?: readonly WorkId[] }): Promise<ConversationAgentSessionV1> {
    const workIds = input.workIds ?? [];
    if (workIds.length > 256 || workIds.some(id => !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(id))) throw new TypeError('Invalid observed work references');
    return this.mutate(collection => {
      const index = collection.sessions.findIndex(item => item.id === input.sessionId), previous = collection.sessions[index];
      if (!previous) throw new ConversationAgentSessionConflictError(input.sessionId, 'session_unavailable');
      if (input.expectedRevision !== undefined && previous.revision !== input.expectedRevision) throw new ConversationAgentSessionConflictError(previous.id, 'revision_conflict');
      const now = this.clock();
      if (previous.lease && previous.lease.expiresAt > now) throw new ConversationAgentSessionConflictError(previous.id, 'lease_busy');
      const registeredWorkIds = [...new Set([...previous.registeredWorkIds, ...workIds])];
      if (previous.reconciliationAcknowledgement) {
        if (registeredWorkIds.length === previous.registeredWorkIds.length) return { collection, result: previous, changed: false };
        const next = updateConversationAgentSession(previous, { registeredWorkIds }, this.at(previous, now));
        const sessions = [...collection.sessions]; sessions[index] = next;
        return { collection: { ...collection, sessions }, result: next, changed: true };
      }
      if (previous.status === 'needs_reconciliation' && !previous.lease && registeredWorkIds.length === previous.registeredWorkIds.length) return { collection, result: previous, changed: false };
      const next = updateConversationAgentSession(previous, { status: 'needs_reconciliation', lease: undefined, waiting: undefined, registeredWorkIds,
        childSegments: previous.childSegments.map(segment => ['active', 'waiting'].includes(segment.status) ? { ...segment, status: 'unknown' as const } : segment) }, this.at(previous, now));
      const sessions = [...collection.sessions]; sessions[index] = next;
      return { collection: { ...collection, sessions }, result: next, changed: true };
    });
  }
  /** The already-authorized child acknowledgement WAL is checked in the same metadata CAS. */
  async acknowledgeReconciliationAfterChild(input: { readonly sessionId: ConversationAgentRunId; readonly targetChild: ConversationAgentRunV1 }): Promise<ConversationAgentSessionV1> {
    return this.mutate(collection => {
      const index = collection.sessions.findIndex(item => item.id === input.sessionId), previous = collection.sessions[index];
      if (!previous) throw new ConversationAgentSessionConflictError(input.sessionId, 'session_unavailable');
      const next = acknowledgeConversationAgentSessionAfterChild(previous, input.targetChild, this.at(previous));
      if (next === previous) return { collection, result: previous, changed: false };
      const sessions = [...collection.sessions]; sessions[index] = next;
      return { collection: { ...collection, sessions }, result: next, changed: true };
    }, draft => {
      const responseId = input.targetChild.responseExecutionId;
      if (!responseId) throw new TypeError('Acknowledged child requires a response');
      const intent = parseCompletionIntent(draft.get('conversation.completion.' + createHash('sha256').update(responseId).digest('hex')), this.projectId);
      if (!['prepared', 'acknowledged', 'needs_reconciliation'].includes(intent.stage) || JSON.stringify(intent.targetRun) !== JSON.stringify(input.targetChild) ||
        intent.decision.canReplay !== false || intent.decision.status !== 'cancelled' || intent.targetRun.reconciliationAcknowledgement?.kind !== 'closed_without_replay') throw new TypeError('Child acknowledgement requires its primary authorized WAL');
    });
  }
  async acknowledgeWithoutResponse(input: { readonly sessionId: ConversationAgentRunId; readonly expectedRevision: number; readonly confirmed: true }): Promise<ConversationAgentSessionV1> {
    return this.mutate(collection => {
      const index = collection.sessions.findIndex(item => item.id === input.sessionId), previous = collection.sessions[index];
      if (!previous) throw new ConversationAgentSessionConflictError(input.sessionId, 'session_unavailable');
      if (input.confirmed !== true || previous.revision !== input.expectedRevision) throw new ConversationAgentSessionConflictError(previous.id, 'revision_conflict');
      const next = acknowledgeConversationAgentSessionWithoutResponse(previous, input.confirmed, this.at(previous));
      if (next === previous) return { collection, result: previous, changed: false };
      const sessions = [...collection.sessions]; sessions[index] = next;
      return { collection: { ...collection, sessions }, result: next, changed: true };
    });
  }
  async settleVerifiedLocalProjectionAfterChild(input: { readonly sessionId: ConversationAgentRunId; readonly targetChild: ConversationAgentRunV1 }): Promise<ConversationAgentSessionV1> {
    return this.mutate(collection => {
      const index = collection.sessions.findIndex(item => item.id === input.sessionId), previous = collection.sessions[index];
      if (!previous) throw new ConversationAgentSessionConflictError(input.sessionId, 'session_unavailable');
      const next = settleConversationAgentSessionVerifiedLocalProjection(previous, input.targetChild, this.at(previous));
      if (next === previous) return { collection, result: previous, changed: false };
      const sessions = [...collection.sessions]; sessions[index] = next;
      return { collection: { ...collection, sessions }, result: next, changed: true };
    }, draft => {
      const responseId = input.targetChild.responseExecutionId;
      if (!responseId) throw new TypeError('A local projection requires its response');
      const intent = parseCompletionIntent(draft.get('conversation.completion.' + createHash('sha256').update(responseId).digest('hex')), this.projectId);
      if (!['prepared', 'applied', 'run_applied'].includes(intent.stage) || intent.freezeOrigin !== 'local_projection' ||
        JSON.stringify(intent.targetRun) !== JSON.stringify(input.targetChild) || intent.decision.canReplay !== false ||
        !['completed', 'failed', 'cancelled'].includes(intent.decision.status) || intent.decision.status !== input.targetChild.status) throw new TypeError('Local root settlement requires its primary validated projection WAL');
    });
  }
  async beginResume(input: ConversationAgentSessionBeginResumeInput) {
    const ownerId = safeIdentifier(input.ownerId), commandId = safeIdentifier(input.commandId), ttlMs = leaseTtl(input.ttlMs);
    const segment = freshPlanningSegment(input.segment), reference = parseControlledConversationInputReference(input.inputReference);
    if (input.projectId !== this.projectId || !/^[a-f0-9]{64}$/.test(input.nonceHash) || !/^[a-f0-9]{64}$/.test(input.expectedInputReferenceHash)) throw new TypeError('Resume scope or hash is invalid');
    if (segment.runId === input.sessionId || segment.status !== 'active' || segment.toolCallsUsed || segment.costUnitsUsed || segment.toolAttemptsUsed) throw new TypeError('A resumed child must have fresh immutable ownership');
    return this.mutate(collection => {
      const index = collection.sessions.findIndex(session => session.id === input.sessionId), previous = collection.sessions[index];
      if (!previous || previous.projectId !== input.projectId || previous.conversationId !== input.conversationId) throw new ConversationAgentSessionConflictError(input.sessionId, 'session_unavailable');
      const replay = previous.resumeReceipts.find(receipt => receipt.commandId === commandId);
      if (replay) {
        const existingSegment = previous.childSegments.find(item => item.runId === replay.childRunId);
        if (replay.nonceHash !== input.nonceHash || replay.waitingVersion !== input.waitingVersion || replay.childRunId !== segment.runId || !existingSegment || existingSegment.sourceMessageId !== segment.sourceMessageId || existingSegment.inputReferenceHash !== segment.inputReferenceHash || !previous.inputReferences.some(item => JSON.stringify(item) === JSON.stringify(reference)) || !previous.lease) throw new ConversationAgentSessionConflictError(previous.id, 'resume_conflict');
        return { collection, result: { session: previous, lease: previous.lease, replayed: true }, changed: false };
      }
      const now = this.clock(); this.requireAvailable(previous, now);
      const waiting = previous.waiting;
      if (previous.revision !== input.expectedRevision || !waiting || waiting.version !== input.waitingVersion || waiting.resumeNonceHash !== input.nonceHash || waiting.inputReferenceHash !== input.expectedInputReferenceHash || !waiting.allowedActions.includes(input.action)) throw new ConversationAgentSessionConflictError(previous.id, 'resume_conflict');
      if (previous.lease && previous.lease.expiresAt > now) throw new ConversationAgentSessionConflictError(previous.id, 'lease_busy');
      if (previous.budget.toolAttemptsUsed >= previous.budget.maxToolCalls || previous.budget.costUnitsUsed >= previous.budget.budgetUnits) throw new ConversationAgentSessionConflictError(previous.id, 'session_unavailable');
      if (reference.kind === 'message' && reference.id !== segment.sourceMessageId) throw new TypeError('Resume source reference mismatch');
      const lease: ConversationAgentExecutionLeaseV1 = { ownerId, epoch: previous.leaseEpoch + 1, acquiredAt: now, expiresAt: Math.min(now + ttlMs, previous.budget.deadlineAt) };
      const at = this.at(previous, now), next = updateConversationAgentSession(previous, { status: 'active', waiting: undefined, lease, leaseEpoch: lease.epoch,
        childSegments: [...previous.childSegments.map(item => ['active', 'waiting'].includes(item.status) ? { ...item, status: 'settled' as const } : item), segment],
        inputReferences: previous.inputReferences.some(item => JSON.stringify(item) === JSON.stringify(reference)) ? previous.inputReferences : [...previous.inputReferences, reference],
        resumeReceipts: [...previous.resumeReceipts, { commandId, nonceHash: input.nonceHash, waitingVersion: input.waitingVersion, childRunId: segment.runId, at }] }, at);
      this.assertUniqueSegmentOwnership(collection, next);
      const sessions = [...collection.sessions]; sessions[index] = next;
      return { collection: { ...collection, sessions }, result: { session: next, lease, replayed: false }, changed: true };
    });
  }
  private requireScope(session: ConversationAgentSessionV1) {
    const parsed = parseConversationAgentSession(session);
    if (parsed.projectId !== this.projectId) throw new TypeError('Session belongs to another project');
    return parsed;
  }
  private clock(): number { const now = Date.parse(this.now()); if (!Number.isSafeInteger(now)) throw new TypeError('Invalid Host clock'); return now; }
  private at(previous: ConversationAgentSessionV1, now = this.clock()) { return toIsoTimestamp(new Date(Math.max(now, Date.parse(previous.updatedAt))).toISOString()); }
  private requireAvailable(session: ConversationAgentSessionV1, now: number) {
    if (['closed', 'expired', 'needs_reconciliation'].includes(session.status) || now >= session.budget.deadlineAt) throw new ConversationAgentSessionConflictError(session.id, 'session_unavailable');
  }
  private requireLease(session: ConversationAgentSessionV1, fence: ConversationAgentExecutionFence, now = this.clock()) {
    const lease = session.lease;
    if (!lease || lease.ownerId !== fence.ownerId || lease.epoch !== fence.epoch || lease.expiresAt <= now || now >= session.budget.deadlineAt) throw new ConversationAgentSessionConflictError(session.id, 'lease_lost');
    return lease;
  }
  private assertUniqueSegmentOwnership(collection: SessionCollectionV1, next: ConversationAgentSessionV1) {
    const runIds = new Set(next.childSegments.map(segment => segment.runId)), responseIds = new Set(next.childSegments.flatMap(segment => segment.responseExecutionId ? [segment.responseExecutionId] : []));
    if (collection.sessions.some(session => session.id !== next.id && session.childSegments.some(segment => runIds.has(segment.runId) || segment.responseExecutionId && responseIds.has(segment.responseExecutionId)))) throw new TypeError('A child segment already belongs to another root session');
  }
  private async update(sessionId: ConversationAgentRunId, expectedRevision: number | undefined, operation: (previous: ConversationAgentSessionV1) => ConversationAgentSessionV1) {
    return this.mutate(collection => {
      const index = collection.sessions.findIndex(item => item.id === sessionId), previous = collection.sessions[index];
      if (!previous) throw new ConversationAgentSessionConflictError(sessionId, 'session_unavailable');
      if (expectedRevision !== undefined && previous.revision !== expectedRevision) throw new ConversationAgentSessionConflictError(sessionId, 'revision_conflict');
      const next = this.requireScope(operation(previous)); assertConversationAgentSessionUpdate(previous, next); this.assertUniqueSegmentOwnership(collection, next);
      const sessions = [...collection.sessions]; sessions[index] = next;
      return { collection: { ...collection, sessions }, result: next, changed: true };
    });
  }
  private async loadAuthoritative() {
    const loaded = await this.unit.load(); if (loaded.source === 'backup') throw new ConversationAgentSessionStorageReconciliationError();
    const value = loaded.document.entries.find(entry => entry.key === metadataKey)?.value;
    return { revision: loaded.document.revision, signature: JSON.stringify(value), collection: this.parseCollection(value) };
  }
  private async mutate<T>(operation: (collection: SessionCollectionV1) => { readonly collection: SessionCollectionV1; readonly result: T; readonly changed: boolean }, validate?: (draft: ProjectMetadataDraft) => void): Promise<T> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const loaded = await this.loadAuthoritative(), next = operation(loaded.collection);
      if (!next.changed) return structuredClone(next.result);
      try {
        let committed = next;
        await this.unit.transact(loaded.revision, draft => {
          if (JSON.stringify(draft.get(metadataKey)) !== loaded.signature) throw new ConversationAgentSessionStorageReconciliationError();
          validate?.(draft);
          // The pure operation rechecks the authoritative clock and fence after entering the write lock.
          // A lease that expired while this CAS was queued cannot authorize a late state transition.
          committed = operation(loaded.collection);
          draft.set(metadataKey, JSON.parse(JSON.stringify(committed.collection)) as JsonValue);
        });
        return structuredClone(committed.result);
      } catch (error) { if (!(error instanceof JsonRevisionConflictError) || attempt === 7) throw error; }
    }
    throw new TypeError('Session metadata CAS exhausted');
  }
  private parseCollection(value: unknown): SessionCollectionV1 {
    if (value === undefined) return { schemaVersion: 1, projectId: this.projectId, sessions: [] };
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('Invalid session collection');
    const item = value as Record<string, unknown>;
    if (Object.keys(item).length !== 3 || item.schemaVersion !== 1 || item.projectId !== this.projectId || !Array.isArray(item.sessions) || item.sessions.length > 4096) throw new TypeError('Invalid session collection');
    const sessions = item.sessions.map(parseConversationAgentSession);
    if (new Set(sessions.map(session => session.id)).size !== sessions.length || sessions.some(session => session.projectId !== this.projectId)) throw new TypeError('Duplicate or foreign session');
    const runIds = sessions.flatMap(session => session.childSegments.map(segment => segment.runId)), responses = sessions.flatMap(session => session.childSegments.flatMap(segment => segment.responseExecutionId ? [segment.responseExecutionId] : []));
    if (new Set(runIds).size !== runIds.length || new Set(responses).size !== responses.length) throw new TypeError('Duplicate root segment ownership');
    return { schemaVersion: 1, projectId: this.projectId, sessions };
  }
}
function safeIdentifier(value: string): string { if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value)) throw new TypeError('Invalid Host session identifier'); return value; }
function leaseTtl(value: number): number { if (!Number.isSafeInteger(value) || value < 1000 || value > 60_000) throw new TypeError('Invalid bounded lease duration'); return value; }
function policy(session: ConversationAgentSessionV1) { const { startedAt, deadlineAt, maxToolCalls, budgetUnits } = session.budget; return { startedAt, deadlineAt, maxToolCalls, budgetUnits }; }
function freshPlanningSegment(value: ConversationAgentSessionSegmentV1): ConversationAgentSessionSegmentV1 {
  const segment = parseConversationAgentSessionSegment(value);
  if (segment.planningBoundary !== undefined && segment.planningBoundary !== 'not_started') throw new TypeError('A fresh child cannot inherit an old planning submission');
  return { ...segment, planningBoundary: 'not_started' };
}
