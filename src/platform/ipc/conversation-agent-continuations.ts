import { createHash, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  createConversationAgentRun, toConversationAgentRunId,
  toConversationResponseExecutionId, toIsoTimestamp,
  type Conversation, type ConversationAgentRunRepository,
  type ConversationAgentSessionRepository, type ConversationAgentSessionV1,
  type ControlledConversationInputReferenceV1, type ProjectId, type Message, type ConversationWorkflowV1
} from '../../domain';
import { ConversationAgentSessionError, type ConversationAgentSessionService } from '../../application/conversation-agent-session-service';
import { ConversationWorkflowService } from '../../application/conversation-workflow-service';
import { ConversationIntentOrchestrator, type ConversationIntentClassifierPort, type ConversationSemanticContext } from '../../application/conversation-intent-orchestrator';
import type { ConversationApplicationService } from '../../application/conversation-service';
import { JsonConversationWorkflowRepository } from '../repositories/json-conversation-workflow-repository';
import type { ProjectStorageAdapter } from '../storage/storage-adapter';
import type { ConversationResponseControllerRuntime } from './conversation-response-controller';
import type { ConversationAgentSessionDto, ConversationAgentResponseStartDto, StartResponseRequest } from '../../shared/chat-context-ipc';
import type { ExecutionBudgetPolicy } from '../../application/execution-budget';

const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const messageReference = (message: Message): ControlledConversationInputReferenceV1 => ({ kind: 'message', id: message.id,
  version: message.revision, contentHash: digest([message.content, message.displayContent, message.attachments]) });

/** Bridges the existing Agent entry to stable Host tasks. No original tool argument is reconstructed from a Hash. */
export class ConversationAgentContinuationRuntime {
  private readonly tokens = new Map<string, { version: number; hash: string; token: string }>();
  private readonly preparations = new Map<string, { signal: AbortSignal; workflow?: ConversationWorkflowV1 }>();
  private readonly workflowRepository: JsonConversationWorkflowRepository;
  private readonly workflows: ConversationWorkflowService;
  private readonly planning = new AsyncLocalStorage<{ readonly sessionId: string; readonly runId: string }>();

  constructor(private readonly options: {
    readonly storage: ProjectStorageAdapter; readonly projectId: ProjectId;
    readonly sessions: ConversationAgentSessionRepository; readonly sessionService: ConversationAgentSessionService;
    readonly agentRuns: ConversationAgentRunRepository; readonly conversations: ConversationApplicationService;
    readonly isCurrent: () => boolean; readonly now: () => string;
    readonly classifier?: ConversationIntentClassifierPort;
    readonly supportsGeneration: boolean;
    readonly supportsMutation?: boolean;
    readonly replayExecution: (responseExecutionId: string) => Promise<ConversationAgentResponseStartDto>;
    readonly cancelExecution: (responseExecutionId: string) => Promise<void>;
  }) {
    this.workflowRepository = new JsonConversationWorkflowRepository(options.storage, options.projectId, options.now);
    this.workflows = new ConversationWorkflowService(this.workflowRepository, new ConversationIntentOrchestrator({
      routingMode: 'local_compat', ...(options.classifier ? { classifier: { classify: async input => {
        const scope = this.planning.getStore();
        if (!scope) throw new ConversationAgentSessionError('lease_lost');
        const { sessionId, runId } = scope;
        await options.sessionService.markPlanningBoundary(toConversationAgentRunId(sessionId), 'submitted', toConversationAgentRunId(runId));
        await options.sessionService.assertSessionOwnership(toConversationAgentRunId(sessionId));
        const leaseSignal = await options.sessionService.signalForRun(toConversationAgentRunId(sessionId));
        const result = await options.classifier!.classify({ ...input,
          signal: leaseSignal && input.signal ? AbortSignal.any([leaseSignal, input.signal]) : leaseSignal ?? input.signal });
        await options.sessionService.markPlanningBoundary(toConversationAgentRunId(sessionId), 'received', toConversationAgentRunId(runId));
        return result;
      } } } : {})
    }), options.now);
  }

  readonly controller: NonNullable<ConversationResponseControllerRuntime['continuations']> = {
    validate: input => this.validate(input), prepare: input => this.prepare(input),
    bindRun: async input => {
      const run = await this.options.agentRuns.get(toConversationAgentRunId(input.runId));
      if (!run || run.parentRunId !== input.sessionId) throw new ConversationAgentSessionError('scope_mismatch');
      const existing = await this.options.sessions.findByRunId(run.id);
      if (existing?.childSegments.some(segment => segment.runId === run.id)) {
        if (existing.id !== input.sessionId || existing.projectId !== run.projectId || existing.conversationId !== run.conversationId) throw new ConversationAgentSessionError('scope_mismatch');
        this.preparations.delete(input.sessionId); return;
      }
      const conversation = await this.options.conversations.get(run.conversationId);
      const message = conversation.messages.find(item => item.id === run.sourceMessageId && item.role === 'user');
      if (!message) throw new ConversationAgentSessionError('reference_changed');
      await this.options.sessionService.admitInitialSegment({ sessionId: toConversationAgentRunId(input.sessionId), run,
        inputReference: messageReference(message), signal: this.preparations.get(input.sessionId)?.signal });
      this.preparations.delete(input.sessionId);
    },
    bindExecution: async input => {
      const session = await this.options.sessions.findByRunId(toConversationAgentRunId(input.runId));
      const segment = session?.childSegments.find(item => item.runId === input.runId);
      if (!session || session.id !== input.sessionId) throw new ConversationAgentSessionError('scope_mismatch');
      if (segment?.responseExecutionId === input.responseExecutionId) return;
      await this.options.sessionService.bindExecution(toConversationAgentRunId(input.runId), toConversationResponseExecutionId(input.responseExecutionId));
    },
    cancel: async input => {
      const session = await this.require(input.sessionId);
      this.assertCurrent();
      if (session.revision !== input.expectedRevision) throw new ConversationAgentSessionError('continuation_invalid');
      if (input.closeUnknown) {
        if (session.status !== 'needs_reconciliation' || session.childSegments.some(segment => segment.responseExecutionId)) throw new ConversationAgentSessionError('continuation_invalid');
        const runs = await this.options.agentRuns.list(session.conversationId);
        const childIds = new Set(session.childSegments.map(segment => segment.runId));
        if (runs.some(run => (childIds.has(run.id) || run.parentRunId === session.id) && run.responseExecutionId)) throw new ConversationAgentSessionError('continuation_invalid');
        const conversation = await this.options.conversations.get(session.conversationId);
        if (conversation.projectId !== session.projectId || conversation.status !== 'active') throw new ConversationAgentSessionError('scope_mismatch');
        this.assertCurrent();
        const acknowledged = await this.options.sessionService.acknowledgeWithoutResponse({ sessionId: session.id,
          expectedRevision: input.expectedRevision, confirmed: true });
        this.discardPreparation(session.id); return this.toDto(acknowledged);
      }
      if (session.status === 'needs_reconciliation') throw new ConversationAgentSessionError('unknown_result');
      const result = session.status === 'active' && session.childSegments.some(segment => segment.planningBoundary === 'submitted')
        ? await this.options.sessionService.freeze(session.id, [])
        : await this.options.sessionService.cancel({ sessionId: session.id, projectId: this.options.projectId,
          conversationId: session.conversationId, expectedRevision: input.expectedRevision });
      for (const segment of session.childSegments) if (segment.status === 'active' && segment.responseExecutionId) {
        await this.options.cancelExecution(segment.responseExecutionId);
      }
      this.discardPreparation(session.id);
      return this.toDto(result);
    },
    abandon: async input => {
      const session = await this.require(input.sessionId);
      const active = session.childSegments.find(segment => segment.status === 'active');
      if (session.status === 'active' && active && !active.responseExecutionId) {
        if (active.planningBoundary === 'submitted') await this.options.sessionService.freeze(session.id, []);
        else await this.options.sessionService.settle(session.id, input.cancelled ? 'cancelled' : 'failed');
      }
      this.discardPreparation(session.id);
    }
  };

  async validateReferences(session: ConversationAgentSessionV1, incoming?: ControlledConversationInputReferenceV1): Promise<void> {
    this.assertCurrent();
    if (session.projectId !== this.options.projectId) throw new ConversationAgentSessionError('scope_mismatch');
    const conversation = await this.options.conversations.get(session.conversationId);
    if (conversation.projectId !== session.projectId || conversation.status !== 'active') throw new ConversationAgentSessionError('scope_mismatch');
    for (const reference of [...session.inputReferences, ...(incoming ? [incoming] : [])]) {
      // Root tasks presently resume from pinned user messages. Unsupported inputs are never guessed.
      if (reference.kind !== 'message') throw new ConversationAgentSessionError('reference_changed');
      const message = conversation.messages.find(item => item.id === reference.id && item.role === 'user' && item.state === 'completed');
      if (!message || JSON.stringify(messageReference(message)) !== JSON.stringify(reference)) throw new ConversationAgentSessionError('reference_changed');
    }
    this.assertCurrent();
  }

  async list(conversationId: string): Promise<readonly ConversationAgentSessionDto[]> {
    this.assertCurrent();
    const sessions = (await this.options.sessions.list()).filter(session => session.conversationId === conversationId);
    return sessions.map(session => this.toDto(session));
  }
  cacheChallenge(input: { readonly session: ConversationAgentSessionV1; readonly resumeToken: string }): void {
    this.assertCurrent();
    if (input.session.projectId !== this.options.projectId) throw new ConversationAgentSessionError('scope_mismatch');
    if (!input.session.waiting || !['waiting_user', 'waiting_authorization'].includes(input.session.status)) throw new ConversationAgentSessionError('session_not_waiting');
    if (digest(input.resumeToken) !== input.session.waiting.resumeNonceHash) throw new ConversationAgentSessionError('continuation_invalid');
    this.tokens.set(input.session.id, { version: input.session.waiting.version,
      hash: input.session.waiting.resumeNonceHash, token: input.resumeToken });
  }
  discardPreparation(sessionId: string): void {
    this.preparations.delete(sessionId); this.tokens.delete(sessionId);
  }
  async executionContext(responseId: string): Promise<{ readonly policy: ExecutionBudgetPolicy; readonly signal?: AbortSignal } | undefined> {
    const run = await this.options.agentRuns.findByResponseExecutionId(toConversationResponseExecutionId(responseId));
    if (!run) return undefined;
    this.assertCurrent();
    return this.options.sessionService.executionContextForRun(run.id);
  }

  private async validate(input: { readonly conversation: Conversation; readonly input: StartResponseRequest; readonly signal: AbortSignal }): Promise<ConversationAgentResponseStartDto | undefined> {
    this.assertCurrent(); input.signal.throwIfAborted();
    const request = input.input.continuation;
    if (!request) {
      const now = Date.parse(this.options.now());
      for (const session of await this.options.sessions.list()) {
        if (session.conversationId !== input.conversation.id || session.projectId !== this.options.projectId ||
          session.status === 'closed' && session.reconciliationAcknowledgement) continue;
        const uncertain = session.status === 'needs_reconciliation' || this.hasUncertainPlanning(session);
        if (uncertain) {
          // A passed deadline revokes authority; it never proves that a paid
          // planning request or a tool had no effect. A primary CAS may record
          // uncertainty, but cannot overwrite a live successor's lease.
          if (!session.lease || session.lease.expiresAt <= now) await this.options.sessionService.freezeObserved({
            sessionId: session.id, expectedRevision: session.revision, registeredWorkIds: session.registeredWorkIds
          });
          throw new ConversationAgentSessionError('unknown_result');
        }
        if (session.status === 'closed') continue;
        if (session.status === 'expired') continue;
        if (now >= session.budget.deadlineAt && ['waiting_user', 'waiting_authorization'].includes(session.status)) {
          // A persisted wait has already relinquished execution ownership. Its
          // known planning receipt can expire without replaying any request.
          await this.options.sessionService.expire(session.id);
          continue;
        }
        // Active expired tasks still require the recovery coordinator's full
        // no-effect evidence before a new task can be admitted.
        throw new ConversationAgentSessionError('session_not_waiting');
      }
      return;
    }
    const session = await this.require(request.sessionId);
    if (session.conversationId !== input.conversation.id) throw new ConversationAgentSessionError('scope_mismatch');
    await this.validateReferences(session);
    const receipt = session.resumeReceipts.find(item => item.commandId === input.input.clientCommandId);
    if (receipt) {
      const segment = session.childSegments.find(item => item.runId === receipt.childRunId);
      const message = input.conversation.messages.find(item => item.id === segment?.sourceMessageId);
      if (receipt.nonceHash !== digest(request.resumeToken) || !message || message.content !== input.input.content ||
        message.displayContent !== input.input.displayContent || !segment?.responseExecutionId) throw new ConversationAgentSessionError('continuation_invalid');
      return this.options.replayExecution(segment.responseExecutionId);
    }
    this.assertContinuable(session, request);
  }

  private async prepare(input: { readonly conversation: Conversation; readonly userMessageId: string; readonly input: StartResponseRequest; readonly signal: AbortSignal }) {
    this.assertCurrent(); input.signal.throwIfAborted();
    const message = input.conversation.messages.find(item => item.id === input.userMessageId && item.role === 'user' && item.state === 'completed');
    if (!message) throw new ConversationAgentSessionError('reference_changed');
    const reference = messageReference(message), request = input.input.continuation;
    let session: ConversationAgentSessionV1, reservedRunId: string | undefined;
    if (request) {
      const current = await this.require(request.sessionId);
      this.assertContinuable(current, request);
      reservedRunId = `agent-child-${digest([current.id, input.input.clientCommandId])}`;
      const admission = await this.options.sessionService.resume({ sessionId: current.id, projectId: this.options.projectId,
        conversationId: input.conversation.id, expectedRevision: request.expectedRevision, resumeToken: request.resumeToken,
        commandId: input.input.clientCommandId, action: request.action, childRunId: toConversationAgentRunId(reservedRunId),
        sourceMessageId: message.id, inputReference: reference, signal: input.signal });
      if (admission.replayed) throw new ConversationAgentSessionError('continuation_invalid');
      session = admission.session;
      this.tokens.delete(session.id);
    } else {
      const root = createConversationAgentRun({ id: toConversationAgentRunId(`agent-root-${randomUUID()}`),
        projectId: this.options.projectId, conversationId: input.conversation.id, sourceMessageId: message.id,
        createdAt: toIsoTimestamp(this.options.now()) });
      await this.options.agentRuns.create(root);
      const budget = this.initialPolicy(input.conversation);
      session = (await this.options.sessionService.open({ run: root, budget, inputReferences: [reference],
        goalHash: digest(reference), signal: input.signal })).session;
    }
    this.preparations.set(session.id, { signal: input.signal });
    try {
      let workflow: ConversationWorkflowV1 | undefined;
      const pinnedMessages = new Set(session.inputReferences.filter(ref => ref.kind === 'message').map(ref => ref.id));
      const previous = (await this.workflowRepository.list(input.conversation.id)).find(item =>
        pinnedMessages.has(item.sourceMessageId) && (['needs_clarification', 'needs_confirmation'].includes(item.status) ||
          request?.action === 'continue' && item.status === 'ready'));
      const leaseSignal = await this.options.sessionService.signalForRun(session.id);
      const signal = leaseSignal ? AbortSignal.any([leaseSignal, input.signal]) : input.signal;
      const context = { ...this.semanticContext(input.conversation, session), semanticCandidate: {
        candidateId: input.input.candidateId, productFeature: input.input.productFeature
      } };
      workflow = await this.planning.run({ sessionId: session.id, runId: reservedRunId ?? session.id }, async () => {
        if (previous?.status === 'ready' && request?.action === 'continue') return previous;
        if (previous && request) return this.workflows.answer({ workflowId: previous.id, expectedRevision: previous.revision,
          rawText: request.action === 'authorize' ? '确认执行' : message.content, sourceMessageId: message.id, context, signal });
        if (!request || request.action !== 'continue') return this.workflows.create({ projectId: this.options.projectId,
          conversationId: input.conversation.id, sourceMessageId: message.id, rawText: message.content, context, signal });
        return undefined;
      });
      input.signal.throwIfAborted(); this.assertCurrent();
      if (workflow?.status === 'failed') {
        const latest = await this.require(session.id);
        if (latest.childSegments.some(segment => segment.planningBoundary === 'submitted')) await this.options.sessionService.freeze(session.id, []);
        else await this.options.sessionService.settle(session.id, 'failed');
        throw new ConversationAgentSessionError('continuation_invalid');
      }
      if (workflow && ['needs_clarification', 'needs_confirmation'].includes(workflow.status)) {
        const waiting = await this.options.sessionService.wait(session.id, { reason: workflow.status === 'needs_confirmation' ? 'authorization' : 'clarification',
          allowedActions: [workflow.status === 'needs_confirmation' ? 'authorize' : 'reply'] });
        this.cacheChallenge(waiting);
        const question = workflow.status === 'needs_confirmation' ? '已保存当前任务规划。确认后将在原任务剩余额度内执行。'
          : workflow.pendingQuestions.map(item => item.question).join('\n') || '请补充当前任务需要的信息。';
        await this.options.conversations.ensureLocalReply(input.conversation.id,
          `agent-wait-${session.id}-${waiting.session.waitingVersion}`, question);
        input.signal.throwIfAborted();
        this.preparations.delete(session.id);
        return { agentSession: this.toDto(waiting.session), waiting: true, parentRunId: session.id, workflow };
      }
      this.preparations.set(session.id, { signal: input.signal, ...(workflow ? { workflow } : {}) });
      return { agentSession: this.toDto(await this.require(session.id)), waiting: false, parentRunId: session.id,
        ...(reservedRunId ? { reservedRunId } : {}), ...(previous && request && workflow ? { workflow } : {}) };
    } catch (error) {
      const latest = await this.require(session.id);
      if (latest.status !== 'needs_reconciliation' && !(latest.status === 'closed' && latest.reconciliationAcknowledgement)) {
        const now = Date.parse(this.options.now());
        if (this.hasUncertainPlanning(latest) && (!latest.lease || latest.lease.expiresAt <= now)) {
          // Losing the execution lease also loses authority to call freeze().
          // The observer receipt is fenced by the exact primary revision and
          // by the repository's check that no live successor owns the task.
          try {
            await this.options.sessionService.freezeObserved({ sessionId: latest.id, expectedRevision: latest.revision,
              registeredWorkIds: latest.registeredWorkIds });
          } catch {
            // A competing claim or storage failure grants no replay authority.
            // validate() continues to block the unchanged uncertain task.
          }
        } else if (input.signal.aborted && !['expired', 'closed'].includes(latest.status)) {
          if (this.hasUncertainPlanning(latest)) await this.options.sessionService.freeze(latest.id, []);
          else await this.options.sessionService.cancel({ sessionId: latest.id, projectId: latest.projectId,
            conversationId: latest.conversationId, expectedRevision: latest.revision });
        }
      }
      this.discardPreparation(session.id);
      throw error;
    }
  }
  private semanticContext(conversation: Conversation, session: ConversationAgentSessionV1): ConversationSemanticContext {
    const documents = conversation.messages.flatMap(message => message.state === 'completed' && message.documentResult
      ? [{ messageId: message.id, kind: message.documentResult.kind, fileName: message.documentResult.fileName }] : []);
    const pinned = new Set(session.inputReferences.filter(reference => reference.kind === 'message').map(reference => reference.id));
    return { documents, ...(documents.length ? { latestDocumentKind: documents.at(-1)!.kind } : {}),
      recentUserMessages: conversation.messages.filter(message => message.role === 'user' && pinned.has(message.id)).map(message => message.content) };
  }
  private initialPolicy(conversation: Conversation): ExecutionBudgetPolicy {
    const hasPpt = this.options.supportsMutation !== false && conversation.messages.some(message => message.documentResult?.kind === 'ppt');
    const profile = !this.options.supportsGeneration ? { calls: 64, units: 1_000_000, duration: 900_000 }
      : hasPpt ? { calls: 12, units: 32, duration: 540_000 } : { calls: 8, units: 24, duration: 360_000 };
    const startedAt = Date.parse(this.options.now());
    return { startedAt, deadlineAt: startedAt + profile.duration, maxToolCalls: profile.calls, budgetUnits: profile.units };
  }
  private assertContinuable(session: ConversationAgentSessionV1, request: NonNullable<StartResponseRequest['continuation']>): void {
    if (session.status === 'needs_reconciliation') throw new ConversationAgentSessionError('unknown_result');
    if (Date.parse(this.options.now()) >= session.budget.deadlineAt || session.status === 'expired') throw new ConversationAgentSessionError('expired');
    if (session.status === 'closed') throw new ConversationAgentSessionError('closed');
    if (!session.waiting || session.revision !== request.expectedRevision || session.waiting.resumeNonceHash !== digest(request.resumeToken) ||
      !session.waiting.allowedActions.includes(request.action)) throw new ConversationAgentSessionError('continuation_invalid');
  }
  private async require(id: string): Promise<ConversationAgentSessionV1> {
    const session = await this.options.sessions.get(toConversationAgentRunId(id));
    if (!session) throw new ConversationAgentSessionError('session_not_found');
    if (session.projectId !== this.options.projectId) throw new ConversationAgentSessionError('scope_mismatch'); return session;
  }
  private toDto(session: ConversationAgentSessionV1): ConversationAgentSessionDto {
    const expired = Date.parse(this.options.now()) >= session.budget.deadlineAt;
    const uncertain = !(session.status === 'closed' && session.reconciliationAcknowledgement) &&
      (session.status === 'needs_reconciliation' || (expired || session.status === 'closed') && this.hasUncertainPlanning(session));
    const state = uncertain ? 'needs_reconciliation' : session.status === 'closed' ? session.closedReason! : expired ? 'expired'
      : session.status === 'active' ? 'running' : session.status;
    const cached = this.tokens.get(session.id);
    return { sessionId: session.id, revision: session.revision, sourceMessageId: session.sourceMessageId, state,
      deadlineAt: new Date(session.budget.deadlineAt).toISOString(), registeredWorkCount: session.registeredWorkIds.length,
      ...(session.status === 'needs_reconciliation' && !session.childSegments.some(segment => segment.responseExecutionId) ? { canCloseUnknown: true } : {}),
      ...(session.waiting && ['waiting_user', 'waiting_authorization'].includes(state) ? { waiting: {
        reason: session.waiting.reason === 'authorization' ? 'authorization_required' : session.waiting.reason === 'safe_continuation' ? 'continuation_required' : 'input_required',
        allowedActions: session.waiting.allowedActions }, ...(cached && cached.version === session.waiting.version && cached.hash === session.waiting.resumeNonceHash
          ? { resumeToken: cached.token } : {}) } : {}) };
  }
  private hasUncertainPlanning(session: ConversationAgentSessionV1): boolean {
    return session.planningBoundary === undefined || session.planningBoundary === 'submitted' || session.childSegments.some(segment =>
      segment.status === 'unknown' || segment.planningBoundary === undefined || segment.planningBoundary === 'submitted');
  }
  private assertCurrent(): void { if (!this.options.isCurrent()) throw new ConversationAgentSessionError('scope_mismatch'); }
}
