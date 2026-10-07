import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import {
  toConversationResponseExecutionId, toWorkId, type ConversationAgentRunId, type ConversationAgentRunRepository,
  type ConversationAgentSessionRepository, type ConversationAgentSessionV1, type ConversationAgentRuntimeRepository,
  type ConversationResponseExecutionId, type ConversationResponseExecutionRepository, type ProjectId
} from '../../domain';
import { parseDocumentVersionPin } from '../../domain/entities/document-version-pin';
import { ConversationAgentRecoveryCoordinator, type ConversationAgentRecoveryCandidate, type ConversationAgentRecoveryClaim,
  type ConversationAgentRecoveryFacts, type ConversationAgentRecoveryReport } from '../../application/conversation-agent-recovery-coordinator';
import type { ConversationAgentSessionService } from '../../application/conversation-agent-session-service';
import type { ConversationCompletionJournal } from '../../application/conversation-completion-coordinator';
import type { ConversationResponseDocumentFacts } from '../documents/conversation-document-tool-session';
import { RegisteredPresentationReader } from '../documents/registered-presentation-reader';
import { JsonWorkRepository, JsonFileReferenceRepository } from '../repositories/json-repositories';
import { JsonDocumentTaskRuntimeRepository } from '../repositories/json-document-task-runtime-repository';
import { ProjectMetadataUnitOfWork, projectStoragePaths, toProjectRelativePath, type NodeProjectStorage } from '../storage';
import { ProjectSubmissionAcceptanceStore } from '../storage/project-submission-acceptance';
import { assertNoSymbolicLinkTraversal, resolveInsideRoot } from '../storage/path-security';

export interface ConversationAgentRecoveryRuntimeOptions {
  readonly rootDirectory: string; readonly projectId: ProjectId; readonly storage: NodeProjectStorage;
  readonly sessions: ConversationAgentSessionRepository; readonly sessionService: ConversationAgentSessionService;
  readonly runtimeRepository: ConversationAgentRuntimeRepository; readonly agentRuns: ConversationAgentRunRepository;
  readonly responses: ConversationResponseExecutionRepository; readonly completionJournal: ConversationCompletionJournal;
  readonly documentTools: { collectResponseFacts(responseExecutionId: string): Promise<ConversationResponseDocumentFacts> };
  /** Existing recovery projections only. Do not inject Provider submission or document-generation actions. */
  readonly recoverLocal: (input: { readonly session: ConversationAgentSessionV1; readonly claim: ConversationAgentRecoveryClaim; readonly responseExecutionIds: readonly ConversationResponseExecutionId[] }) => Promise<void>;
  readonly onWaitingChallenge: (input: { readonly session: ConversationAgentSessionV1; readonly resumeToken: string }) => void | Promise<void>;
  readonly onSessionChanged?: (session: ConversationAgentSessionV1) => void | Promise<void>;
  readonly onSafeContinuation?: (input: { readonly session: ConversationAgentSessionV1; readonly claim: ConversationAgentRecoveryClaim; readonly responseExecutionIds: readonly ConversationResponseExecutionId[] }) => void | Promise<void>;
  readonly now?: () => number;
  readonly onError?: (error: unknown) => void;
}
interface RecoveryOwnership extends ConversationAgentRecoveryClaim { readonly observed: boolean }
interface MutationEvidence { readonly state: string; readonly workIds: readonly string[] }

/** Adapts actual primary repositories to the single Application recovery owner. It never replays a side effect. */
export class ConversationAgentRecoveryRuntime {
  private readonly claims = new Map<ConversationAgentRunId, RecoveryOwnership>();
  private readonly coordinator: ConversationAgentRecoveryCoordinator;
  private readonly metadata: ProjectMetadataUnitOfWork;
  private readonly acceptances: ProjectSubmissionAcceptanceStore;
  private readonly reader: RegisteredPresentationReader;
  private mutationEvidence?: Promise<readonly MutationEvidence[]>;
  private recoveryTail: Promise<unknown> = Promise.resolve();
  private specificRootIds?: ReadonlySet<ConversationAgentRunId>;
  constructor(private readonly options: ConversationAgentRecoveryRuntimeOptions) {
    this.metadata = new ProjectMetadataUnitOfWork(options.storage);
    this.acceptances = new ProjectSubmissionAcceptanceStore(this.metadata);
    this.reader = new RegisteredPresentationReader(options);
    this.coordinator = new ConversationAgentRecoveryCoordinator({
      // Match the bounded session collection; completed history is filtered before inspection.
      maxCandidates: 4096, listCandidates: () => this.listCandidates(),
      claim: candidate => this.claim(candidate), inspect: candidate => this.inspect(candidate),
      freeze: async (candidate, claim, _reason, works) => {
        const owned = claim as RecoveryOwnership;
        if (!owned.observed && _reason !== 'metadata_untrusted') {
          try { await this.restoreAccounting(candidate.sessionId, claim); }
          catch (error) { await claim.assertCurrent(); options.onError?.(error); }
        }
        const current = await options.sessions.get(candidate.sessionId);
        if (!current) throw new Error('recovery_session_missing');
        const result = owned.observed ? await options.sessionService.freezeObserved({ sessionId: candidate.sessionId, expectedRevision: current.revision, registeredWorkIds: works })
          : await options.sessionService.freeze(candidate.sessionId, works);
        await options.onSessionChanged?.(result);
      },
      settleKnown: async (candidate, claim, status, works) => {
        if ((claim as RecoveryOwnership).observed) { await this.expireObserved(candidate); return; }
        await this.restoreAccounting(candidate.sessionId, claim);
        if (works.length) await options.sessionService.recordVerifiedWorks(candidate.sessionId, works);
        const result = await options.sessionService.settle(candidate.sessionId, status); await options.onSessionChanged?.(result);
      },
      preserveWaiting: async (candidate, claim) => {
        if ((claim as RecoveryOwnership).observed) { await this.expireObserved(candidate); return; }
        await this.restoreAccounting(candidate.sessionId, claim);
        const session = await this.requireSession(candidate.sessionId);
        if (!session.waiting) throw new Error('waiting_checkpoint_missing');
        const challenge = await options.sessionService.wait(session.id, { reason: session.waiting.reason, allowedActions: session.waiting.allowedActions });
        await options.onWaitingChallenge(challenge); await options.onSessionChanged?.(challenge.session);
      },
      offerContinuation: async (candidate, claim) => {
        if ((claim as RecoveryOwnership).observed) { await this.expireObserved(candidate); return; }
        await this.restoreAccounting(candidate.sessionId, claim);
        const session = await this.requireSession(candidate.sessionId);
        await claim.assertCurrent();
        await options.onSafeContinuation?.({ session, claim, responseExecutionIds: await this.responseIds(session) });
        await claim.assertCurrent();
        const waiting = await options.sessionService.wait(session.id, { reason: 'safe_continuation', allowedActions: ['continue'] });
        await options.onWaitingChallenge(waiting); await options.onSessionChanged?.(waiting.session);
      },
      release: async (candidate, claim) => {
        this.claims.delete(candidate.sessionId);
        const session = await options.sessions.get(candidate.sessionId);
        if (!session?.lease || session.lease.ownerId !== claim.ownerId || session.lease.epoch !== claim.epoch || session.lease.expiresAt <= this.now()) return;
        await options.sessionService.releaseOwnership(candidate.sessionId);
      },
      onIssue: error => options.onError?.(error)
    });
  }
  recover(signal?: AbortSignal): Promise<ConversationAgentRecoveryReport> { return this.queueRecovery(undefined, signal); }
  /** A bounded local refresh never rotates waits outside the selected roots. */
  recoverSpecificRootIds(rootIds: readonly ConversationAgentRunId[], signal?: AbortSignal): Promise<ConversationAgentRecoveryReport> {
    if (rootIds.length > 4096 || rootIds.some(id => !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(id))) throw new TypeError('recovery_scope_invalid');
    return this.queueRecovery(new Set(rootIds), signal);
  }
  private queueRecovery(rootIds: ReadonlySet<ConversationAgentRunId> | undefined, signal?: AbortSignal): Promise<ConversationAgentRecoveryReport> {
    const operation = this.recoveryTail.then(async () => {
      this.specificRootIds = rootIds; this.mutationEvidence = undefined;
      try { return await this.coordinator.recover(signal); }
      finally { this.specificRootIds = undefined; }
    });
    this.recoveryTail = operation.catch(() => undefined); return operation;
  }
  private async listCandidates(): Promise<readonly ConversationAgentRecoveryCandidate[]> {
    const sessions = await this.options.sessions.list();
    if (this.specificRootIds) return sessions.filter(session => this.specificRootIds!.has(session.id) && session.status === 'active').map(this.candidate);
    // Read each primary collection once. Historical tasks must not cause one file/hash
    // check each, but cancellation or expiry alone is never proof of a settled effect.
    const evidence = await Promise.allSettled([this.options.runtimeRepository.list(), this.options.agentRuns.list(),
      this.options.responses.list(), this.options.completionJournal.listPending(),
      new JsonDocumentTaskRuntimeRepository(this.options.storage, this.options.projectId).list()] as const);
    const failed = evidence.find(result => result.status === 'rejected');
    if (failed?.status === 'rejected') {
      this.options.onError?.(failed.reason);
      // Unreadable evidence cannot justify dropping a task from the recovery scan.
      return sessions.filter(session => !session.reconciliationAcknowledgement).map(this.candidate);
    }
    const [snapshots, runs, responses, intents, documentTasks] = evidence.map(result => {
      if (result.status !== 'fulfilled') throw new Error('recovery_candidate_evidence_missing');
      return result.value;
    }) as [Awaited<ReturnType<ConversationAgentRuntimeRepository['list']>>, Awaited<ReturnType<ConversationAgentRunRepository['list']>>,
      Awaited<ReturnType<ConversationResponseExecutionRepository['list']>>, Awaited<ReturnType<ConversationCompletionJournal['listPending']>>,
      Awaited<ReturnType<JsonDocumentTaskRuntimeRepository['list']>>];
    const runtimesByRun = new Map(snapshots.map(snapshot => [snapshot.runtime.runId, snapshot.runtime]));
    const runsById = new Map(runs.map(run => [run.id, run]));
    const responsesById = new Map(responses.map(response => [response.id, response]));
    const responsesBySource = new Map<string, typeof responses[number][]>();
    for (const response of responses) {
      const key = JSON.stringify([response.projectId, response.snapshot.conversationId, response.snapshot.userMessageId]);
      const existing = responsesBySource.get(key);
      if (existing) existing.push(response); else responsesBySource.set(key, [response]);
    }
    const pendingResponses = new Set(intents.map(intent => intent.responseExecutionId));
    const pendingRuns = new Set(intents.map(intent => intent.targetRun.id));
    const pendingDocumentResponses = new Set(documentTasks.filter(task => task.status === 'needs_reconciliation' ||
      task.toolCalls.some(call => call.status === 'started' || call.status === 'unknown')).map(task => task.executionId));
    return sessions.filter(session => {
      // Explicit closure preserves its unknown receipt. Legacy WAL projection may
      // finish locally, but startup must not re-freeze that acknowledged Root.
      if (session.reconciliationAcknowledgement) return false;
      if (session.status !== 'closed' && session.status !== 'expired') return true;
      if (session.planningBoundary === undefined || session.planningBoundary === 'submitted') return true;
      return session.childSegments.some(segment => {
        if (segment.planningBoundary === undefined || segment.planningBoundary === 'submitted' || segment.status === 'unknown') return true;
        const run = runsById.get(segment.runId), runtime = runtimesByRun.get(segment.runId);
        if (!run || run.projectId !== session.projectId || run.conversationId !== session.conversationId || run.sourceMessageId !== segment.sourceMessageId ||
          segment.runId !== session.id && run.parentRunId !== session.id) return true;
        if (pendingRuns.has(segment.runId) || runtime && (runtime.projectId !== session.projectId || runtime.conversationId !== session.conversationId ||
          runtime.sourceMessageId !== segment.sourceMessageId || ['running', 'needs_reconciliation'].includes(runtime.status) ||
          runtime.modelCalls.some(call => call.status === 'submitting' || call.status === 'unknown') ||
          runtime.toolCalls.some(call => call.status === 'unknown' || call.status === 'started'))) return true;
        if (runtime && runtime.responseExecutionId !== (segment.responseExecutionId ?? run.responseExecutionId)) return true;
        // The initial Root run can remain a response-free planning container.
        // Every later actual child must have a known terminal binding.
        if ((segment.runId !== session.id || run.responseExecutionId) && !['completed', 'failed', 'cancelled'].includes(run.status)) return true;
        if (segment.responseExecutionId && segment.responseExecutionId !== run.responseExecutionId) return true;
        const responseId = segment.responseExecutionId ?? run.responseExecutionId;
        if (responseId) {
          const response = responsesById.get(responseId);
          return pendingResponses.has(responseId) || pendingDocumentResponses.has(responseId) || !response || response.projectId !== session.projectId ||
            response.snapshot.conversationId !== session.conversationId || response.snapshot.userMessageId !== segment.sourceMessageId ||
            ['pending', 'streaming', 'interrupted'].includes(response.state);
        }
        if (segment.runId !== session.id) return true;
        return (responsesBySource.get(JSON.stringify([session.projectId, session.conversationId, segment.sourceMessageId])) ?? [])
          .some(response => pendingResponses.has(response.id) || pendingDocumentResponses.has(response.id) || ['pending', 'streaming', 'interrupted'].includes(response.state));
      });
    }).map(this.candidate);
  }
  private candidate(session: ConversationAgentSessionV1): ConversationAgentRecoveryCandidate {
    return { sessionId: session.id, projectId: session.projectId, conversationId: session.conversationId };
  }
  async canRecoverResponse(responseExecutionId: string): Promise<boolean> {
    const responseId = toConversationResponseExecutionId(responseExecutionId);
    const run = await this.options.agentRuns.findByResponseExecutionId(responseId);
    const sessions = await this.options.sessions.list();
    const response = run ? undefined : await this.options.responses.get(responseId);
    const matched = sessions.filter(item => item.childSegments.some(segment => segment.responseExecutionId === responseId || run && segment.runId === run.id ||
      response && response.projectId === item.projectId && response.snapshot.conversationId === item.conversationId && response.snapshot.userMessageId === segment.sourceMessageId));
    if (matched.length > 1) return false;
    return matched[0] ? this.canRecoverSession(matched[0]) : true;
  }
  async canRecoverRun(runId: ConversationAgentRunId): Promise<boolean> {
    const session = await this.options.sessions.findByRunId(runId); return session ? this.canRecoverSession(session) : true;
  }
  async inspectSession(sessionId: ConversationAgentRunId): Promise<ConversationAgentRecoveryFacts> {
    const session = await this.requireSession(sessionId); return this.readFacts(session);
  }
  private async canRecoverSession(session: ConversationAgentSessionV1): Promise<boolean> {
    const claim = this.claims.get(session.id);
    if (claim) { await claim.assertCurrent(); return true; }
    if (session.lease && session.lease.expiresAt > this.now()) return false;
    // A no-effect checkpoint must keep its original evidence until explicit continuation consumes it.
    if (session.waiting?.reason === 'safe_continuation') return false;
    return ['closed', 'expired', 'needs_reconciliation', 'waiting_user', 'waiting_authorization'].includes(session.status);
  }
  private async claim(candidate: ConversationAgentRecoveryCandidate): Promise<RecoveryOwnership | undefined> {
    const session = await this.requireSession(candidate.sessionId);
    if (session.projectId !== candidate.projectId || session.conversationId !== candidate.conversationId || candidate.projectId !== this.options.projectId) throw new Error('recovery_scope_invalid');
    if (session.lease && session.lease.expiresAt > this.now()) return undefined;
    let claim: RecoveryOwnership;
    if (session.budget.deadlineAt <= this.now() || ['closed', 'expired', 'needs_reconciliation'].includes(session.status)) {
      const epoch = session.leaseEpoch;
      claim = { ownerId: 'local-observation', epoch, observed: true, assertCurrent: async () => {
        const current = await this.requireSession(session.id);
        if (current.leaseEpoch !== epoch || current.lease && current.lease.expiresAt > this.now()) throw new Error('recovery_lease_lost');
      } };
    } else {
      const owned = await this.options.sessionService.claimRecovery(session.id);
      claim = { ownerId: owned.lease.ownerId, epoch: owned.lease.epoch, observed: false, assertCurrent: () => this.options.sessionService.assertSessionOwnership(session.id) };
    }
    this.claims.set(session.id, claim); return claim;
  }
  private async inspect(candidate: ConversationAgentRecoveryCandidate): Promise<ConversationAgentRecoveryFacts> {
    const claim = this.claims.get(candidate.sessionId)!;
    let session = await this.requireSession(candidate.sessionId), facts = await this.readFacts(session);
    if (claim.observed && session.budget.deadlineAt <= this.now() && facts.noEffectProven && facts.modelBoundary === 'not_started' &&
      facts.response === 'pending' && facts.mutationJournal === 'none' && facts.registeredWorks.length === 0) {
      // Expiry grants no continuation authority. Retire a primary response that
      // is independently proven unsubmitted using the existing local receipt
      // path before the legacy orphan sweep could label it interrupted/unknown.
      await claim.assertCurrent();
      await this.options.onSafeContinuation?.({ session, claim, responseExecutionIds: await this.responseIds(session) });
      await claim.assertCurrent(); session = await this.requireSession(candidate.sessionId); facts = await this.readFacts(session);
    }
    if (claim.observed && session.budget.deadlineAt <= this.now() && !this.hasUnknown(facts) && facts.registrationComplete && facts.registeredWorks.every(work => work.validation === 'valid') && !['closed', 'expired', 'needs_reconciliation'].includes(session.status)) {
      session = await this.options.sessionService.expire(session.id); await this.options.onSessionChanged?.(session); facts = await this.readFacts(session);
    }
    if (facts.metadata === 'primary' && facts.session === 'active' && !facts.noEffectProven && !this.hasUnknown(facts) && !(claim as RecoveryOwnership).observed) {
      await claim.assertCurrent();
      await this.options.recoverLocal({ session, claim, responseExecutionIds: await this.responseIds(session) });
      await claim.assertCurrent(); session = await this.requireSession(candidate.sessionId); facts = await this.readFacts(session);
    }
    return facts;
  }
  private async readFacts(session: ConversationAgentSessionV1): Promise<ConversationAgentRecoveryFacts> {
    const metadata = await this.metadata.load();
    if (metadata.source !== 'primary') throw new Error('recovery_metadata_untrusted');
    for (const location of [projectStoragePaths.entities.conversationAgentRuns, projectStoragePaths.entities.conversationResponseExecutions,
      projectStoragePaths.entities.documentTaskRuntimes, projectStoragePaths.entities.works, projectStoragePaths.entities.fileReferences]) {
      const loaded = await this.options.storage.readJsonWithBackup(location, value => value);
      if (loaded?.source === 'backup') throw new Error('recovery_entity_backup_untrusted');
    }
    const claim = this.claims.get(session.id);
    if (claim) {
      for (const segment of session.childSegments) {
        const run = await this.options.agentRuns.get(segment.runId);
        if (!run?.responseExecutionId || segment.responseExecutionId === run.responseExecutionId) continue;
        await claim.assertCurrent();
        session = await this.options.sessionService.recordVerifiedResponseBinding({ sessionId: session.id, runId: segment.runId,
          responseExecutionId: run.responseExecutionId, expectedRevision: session.revision, expectedLeaseEpoch: session.leaseEpoch,
          observed: claim.observed });
        await claim.assertCurrent();
      }
    }
    const [runs, acceptances] = await Promise.all([this.options.agentRuns.list(session.conversationId), this.acceptances.list()]);
    const parent = runs.find(run => run.id === session.id);
    if (!parent || parent.projectId !== session.projectId || parent.sourceMessageId !== session.sourceMessageId) throw new Error('recovery_parent_identity_invalid');
    const responseIds = await this.responseIds(session);
    const runtimeSnapshots = await Promise.all(session.childSegments.map(segment => this.options.runtimeRepository.get(segment.runId)));
    const executions = await Promise.all(responseIds.map(id => this.options.responses.get(id)));
    const responseEvents = await Promise.all(responseIds.map(id => this.options.responses.listEvents(id)));
    const documentFacts = await Promise.all(responseIds.map(id => this.options.documentTools.collectResponseFacts(id)));
    const intents = await Promise.all(responseIds.map(id => this.options.completionJournal.get(id)));
    for (const snapshot of runtimeSnapshots) {
      if (!snapshot) continue;
      const segment = session.childSegments.find(item => item.runId === snapshot.runtime.runId);
      const expectedResponse = segment?.responseExecutionId ?? runs.find(run => run.id === segment?.runId)?.responseExecutionId;
      if (!segment || !expectedResponse || snapshot.runtime.responseExecutionId !== expectedResponse ||
        snapshot.runtime.projectId !== session.projectId || snapshot.runtime.conversationId !== session.conversationId ||
        snapshot.runtime.sourceMessageId !== segment.sourceMessageId) throw new Error('recovery_runtime_identity_invalid');
    }
    for (const execution of executions) if (execution && (execution.projectId !== session.projectId || execution.snapshot.conversationId !== session.conversationId || !session.childSegments.some(segment => segment.sourceMessageId === execution.snapshot.userMessageId))) throw new Error('recovery_response_identity_invalid');
    const responseSourceIds = new Set(session.childSegments.map(segment => segment.sourceMessageId));
    const ownedAcceptances = acceptances.filter(item => item.subjectArtifacts.kind === 'conversation' && item.subjectArtifacts.responseExecution.projectId === session.projectId &&
      item.subjectArtifacts.responseExecution.snapshot.conversationId === session.conversationId && responseSourceIds.has(item.subjectArtifacts.responseExecution.snapshot.userMessageId));
    const canonical = runtimeSnapshots.filter(item => item !== undefined);
    const startedModels = canonical.some(snapshot => snapshot.events.some(event => event.kind === 'model_call_submitting'));
    const unknownRuntime = canonical.some(snapshot => snapshot.runtime.status === 'needs_reconciliation' || snapshot.runtime.modelCalls.some(call => ['submitting', 'unknown'].includes(call.status)) ||
      snapshot.runtime.toolCalls.some(call => call.status === 'unknown' || call.status === 'started' && call.admissionPhase !== 'pending'));
    let modelBoundary: ConversationAgentRecoveryFacts['modelBoundary'] = unknownRuntime ? 'unknown' : startedModels ? 'received' : 'not_started';
    const planningUncertain = session.planningBoundary === undefined || session.planningBoundary === 'submitted' ||
      session.childSegments.some(segment => segment.planningBoundary === 'submitted' || ['active', 'waiting'].includes(segment.status) && segment.planningBoundary === undefined);
    if (planningUncertain) modelBoundary = 'unknown';
    if (ownedAcceptances.some(item => item.intent.status === 'unknown_outcome')) modelBoundary = 'unknown';
    const streamedResponse = responseEvents.some(events => events.some(event =>
      ['stream_started', 'content_delta', 'reasoning_delta'].includes(event.type)));
    // A missing canonical WAL cannot erase evidence that a Provider already
    // started or streamed a response. Such a record is never a zero-effect proof.
    if (streamedResponse && !startedModels) modelBoundary = 'unknown';
    if (ownedAcceptances.some(item => item.intent.status === 'request_started') && !executions.every(execution => execution?.state === 'completed') && !startedModels) modelBoundary = 'submitted';
    const tasks = documentFacts.flatMap(facts => facts.documentTasks);
    const knownWorks = [...new Set([...session.registeredWorkIds, ...canonical.flatMap(snapshot => snapshot.runtime.registeredWorkIds), ...tasks.flatMap(task => task.registeredWork ? [task.registeredWork.id] : [])])];
    const workRepository = new JsonWorkRepository(this.options.storage, this.options.projectId), files = new JsonFileReferenceRepository(this.options.storage, this.options.projectId);
    const registeredWorks: ConversationAgentRecoveryFacts['registeredWorks'][number][] = [];
    for (const workId of knownWorks) {
      const work = await workRepository.get(workId), file = work ? await files.get(work.fileId) : undefined;
      if (!work || !file || work.projectId !== session.projectId || file.projectId !== session.projectId || file.sourceExecutionId !== work.sourceExecutionId) { registeredWorks.push({ workId, validation: 'unknown' }); continue; }
      try { await this.reader.read(workId); registeredWorks.push({ workId, validation: 'valid' }); }
      catch { registeredWorks.push({ workId, validation: 'invalid' }); }
    }
    const mutationWorkRefs = new Set([...knownWorks, ...tasks.flatMap(task => task.runtime.workRef?.kind === 'registered' ? [task.runtime.workRef.ref] : [])]);
    const records = (await this.readMutationEvidence()).filter(record => record.workIds.some(id => mutationWorkRefs.has(toWorkId(id))));
    const mutationJournal: ConversationAgentRecoveryFacts['mutationJournal'] = records.some(record => ['unknown', 'reconciliation_required'].includes(record.state)) ? 'unknown'
      : records.some(record => !['session_refreshed', 'committed', 'committed_pending_refresh', 'cancelled', 'failed', 'revision_conflict'].includes(record.state)) ? 'uncommitted'
      : records.length ? 'committed' : 'none';
    const hasAcceptedRequest = ownedAcceptances.some(item => !['authorization_pending', 'authorization_claimed', 'authorization_released'].includes(item.intent.status));
    const missingBoundResponse = executions.some(execution => execution === undefined);
    const noEffectProven = !missingBoundResponse && !planningUncertain && !startedModels && !streamedResponse && !hasAcceptedRequest && !unknownRuntime && mutationJournal === 'none' && registeredWorks.length === 0 &&
      canonical.every(snapshot => snapshot.runtime.toolCalls.every(call => call.admissionPhase === 'pending' || call.admissionPhase === 'rejected' || call.admissionPhase === 'replayed')) &&
      tasks.every(task => task.runtime.toolCalls.length === 0 && !task.runtime.workRef);
    const last = executions.at(-1);
    const unknownJournal = intents.some(intent => intent?.freezeOrigin === 'unknown_result' || intent?.stage === 'needs_reconciliation' && intent.freezeOrigin === undefined);
    const response: ConversationAgentRecoveryFacts['response'] = missingBoundResponse || unknownJournal ? 'unknown' : last?.state === 'completed' ? 'completed' : last?.state === 'cancelled' ? 'cancelled'
      : last?.state === 'failed' ? 'failed' : last?.state === 'interrupted' && !noEffectProven ? 'unknown' : last ? 'pending' : 'missing';
    const documentTasks: ConversationAgentRecoveryFacts['documentTasks'] = tasks.map(task => task.runtime.status === 'needs_reconciliation' || task.runtime.toolCalls.some(call => call.status === 'unknown') ? 'unknown'
      : task.runtime.toolCalls.some(call => call.status === 'started') ? 'running' : task.registeredWork && task.readBackConfirmed ? 'registered'
      : task.runtime.status === 'failed' ? 'failed' : task.runtime.status === 'cancelled' ? 'cancelled' : task.runtime.toolCalls.length ? 'running' : 'prepared');
    const terminalIntent = intents.at(-1);
    const knownTerminal = ['waiting_user', 'waiting_authorization'].includes(session.status) ? undefined
      : terminalIntent && ['applied', 'acknowledged'].includes(terminalIntent.stage) && ['completed', 'failed', 'cancelled'].includes(terminalIntent.decision.status)
        ? terminalIntent.decision.status as 'completed' | 'failed' | 'cancelled' : last?.state === 'completed' && !unknownRuntime ? 'completed' : last?.state === 'cancelled' ? 'cancelled' : undefined;
    return { metadata: 'primary', session: session.status, modelBoundary, response, documentTasks, mutationJournal, registeredWorks,
      ...(session.reconciliationAcknowledgement ? { acknowledgedClosed: true } : {}),
      registrationComplete: registeredWorks.every(work => work.validation === 'valid') && tasks.every(task => !task.required || !task.active || task.runtime.operation === 'analyze' || task.registeredWork && task.readBackConfirmed),
      noEffectProven, ...(knownTerminal ? { knownTerminal } : {}) };
  }
  private async responseIds(session: ConversationAgentSessionV1): Promise<readonly ConversationResponseExecutionId[]> {
    const ids = session.childSegments.flatMap(segment => segment.responseExecutionId ? [segment.responseExecutionId] : []);
    for (const segment of session.childSegments) {
      const run = await this.options.agentRuns.get(segment.runId);
      if (run?.responseExecutionId) ids.push(run.responseExecutionId);
    }
    return [...new Set(ids)];
  }
  /** Recover only persisted Host counters; absent legacy costs are never guessed or refunded. */
  private async restoreAccounting(sessionId: ConversationAgentRunId, claim: ConversationAgentRecoveryClaim): Promise<void> {
    const session = await this.requireSession(sessionId);
    for (const segment of session.childSegments) {
      await claim.assertCurrent();
      const snapshot = await this.options.runtimeRepository.get(segment.runId);
      const runtime = snapshot?.runtime;
      if (runtime && (runtime.projectId !== session.projectId || runtime.conversationId !== session.conversationId || runtime.sourceMessageId !== segment.sourceMessageId)) throw new Error('recovery_accounting_scope_invalid');
      const facts = segment.responseExecutionId ? await this.options.documentTools.collectResponseFacts(segment.responseExecutionId) : undefined;
      const tasks = [...new Map((facts?.documentTasks ?? []).map(task => [task.runtime.id, task.runtime])).values()];
      if (tasks.some(task => task.projectId !== session.projectId || task.conversationId !== session.conversationId ||
        task.sourceMessageId !== segment.sourceMessageId || task.executionId !== segment.responseExecutionId)) throw new Error('recovery_document_accounting_scope_invalid');
      // Root and document WALs describe overlapping execution. Use the greater
      // persisted total, never add the same admitted call twice or price an old call.
      const toolCallsUsed = Math.max(runtime?.budget.toolCallsUsed ?? 0, tasks.reduce((sum, task) => sum + task.checkpoint.step, 0));
      const costUnitsUsed = Math.max(runtime?.budget.costUnitsUsed ?? 0, tasks.reduce((sum, task) => sum + task.checkpoint.costUnits, 0));
      const attempts = Math.max(runtime?.budget.toolAttemptsUsed ?? runtime?.budget.toolCallsUsed ?? 0, toolCallsUsed);
      if (toolCallsUsed <= segment.toolCallsUsed && costUnitsUsed <= segment.costUnitsUsed && attempts <= segment.toolAttemptsUsed) continue;
      await this.options.sessionService.recordSegment({ runId: segment.runId, toolCallsUsed, costUnitsUsed, toolAttemptsUsed: attempts });
      await claim.assertCurrent();
    }
  }
  private readMutationEvidence(): Promise<readonly MutationEvidence[]> {
    if (this.mutationEvidence) return this.mutationEvidence;
    return this.mutationEvidence = (async () => {
      const directory = resolveInsideRoot(this.options.rootDirectory, 'entities/document-mutations');
      await assertNoSymbolicLinkTraversal(this.options.rootDirectory, directory);
      let names: string[];
      try { names = await readdir(directory); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
      const calls = names.filter(name => /^call-[a-f0-9]{64}\.json$/.test(name));
      if (calls.length > 4096) throw new Error('mutation_recovery_scan_limit_exceeded');
      const records: MutationEvidence[] = [];
      for (const name of calls) {
        const value = await this.options.storage.readJson<Record<string, unknown>>(toProjectRelativePath(`entities/document-mutations/${name}`));
        if (!value || value.schemaVersion !== 1 || typeof value.state !== 'string' || typeof value.idempotencyKey !== 'string' || `call-${createHash('sha256').update(value.idempotencyKey).digest('hex')}.json` !== name) throw new Error('mutation_recovery_record_invalid');
        const base = parseDocumentVersionPin(value.basePin), candidate = value.candidatePin === undefined ? undefined : parseDocumentVersionPin(value.candidatePin);
        records.push({ state: value.state, workIds: [...new Set([base.headWorkId, ...(candidate ? [candidate.headWorkId] : []), ...(typeof value.candidateWorkId === 'string' ? [value.candidateWorkId] : [])])] });
      }
      return records;
    })();
  }
  private hasUnknown(facts: ConversationAgentRecoveryFacts): boolean { return facts.modelBoundary === 'unknown' || facts.modelBoundary === 'submitted' || facts.response === 'unknown' || facts.documentTasks.some(status => status === 'unknown' || status === 'running') || ['unknown', 'uncommitted'].includes(facts.mutationJournal); }
  private async expireObserved(candidate: ConversationAgentRecoveryCandidate): Promise<void> { const session = await this.options.sessionService.expire(candidate.sessionId); await this.options.onSessionChanged?.(session); }
  private async requireSession(sessionId: ConversationAgentRunId): Promise<ConversationAgentSessionV1> { const session = await this.options.sessions.get(sessionId); if (!session) throw new Error('recovery_session_missing'); return session; }
  private now(): number { return this.options.now?.() ?? Date.now(); }
}
export function createConversationAgentRecoveryRuntime(options: ConversationAgentRecoveryRuntimeOptions): ConversationAgentRecoveryRuntime { return new ConversationAgentRecoveryRuntime(options); }
