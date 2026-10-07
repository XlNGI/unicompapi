import {
  createCanonicalToolRegistry, createConversationAgentRuntime, parseConversationAgentRuntimeEvent,
  toIsoTimestamp, toWorkId, updateConversationAgentRuntime,
  type CanonicalToolId, type ConversationAgentRunId, type ConversationAgentRunV1,
  type ConversationAgentRuntimeRepository, type ConversationAgentRuntimeSnapshotV1,
  type ConversationAgentRuntimeV1, type ConversationAgentRuntimeFacts,
  type ConversationAgentRuntimeEventV1, type ConversationAgentRuntimePublicEventV1,
  type ConversationAgentRuntimeOutboxEntryV1, type ConversationResponseExecutionId
} from '../domain';
import type { ProductionEventFacts, ProductionEventCode, ProductionEventStatus } from '../shared/conversation-production-ipc';
import { ExecutionBudgetError, type ExecutionBudgetPolicy, type ExecutionStopReason } from './execution-budget';

export interface ConversationAgentRuntimeProviderLifecycle {
  modelPrepared(input: { readonly round: number; readonly requestHash: string; readonly messageCount: number; readonly toolCount: number }): Promise<void>;
  modelStarted(input: { readonly round: number }): Promise<void>;
  modelResult(input: { readonly round: number; readonly resultHash: string; readonly contentLength: number; readonly finishReason: string; readonly toolCallCount: number }): Promise<void>;
  modelFailed(input: { readonly round: number; readonly unknown: boolean; readonly code: 'cancelled' | 'timeout' | 'transport' | 'invalid_response' | 'journal_failed' | 'failed' }): Promise<void>;
  toolStarted(input: { readonly round: number; readonly stepRef: string; readonly toolId: string; readonly argumentsHash: string }): Promise<void>;
  toolAdmitted(input: { readonly round: number; readonly stepRef: string }): Promise<void>;
  toolResult(input: { readonly round: number; readonly stepRef: string; readonly resultHash: string; readonly status: 'success' | 'failed' | 'unknown'; readonly outcomeUnknown: boolean; readonly registeredWorkIds?: readonly string[]; readonly failureCode?: string; readonly admissionPhase?: 'rejected' | 'admitted' | 'replayed' | 'unknown' }): Promise<void>;
  observationCommitted(input: { readonly round: number; readonly stepRef: string; readonly observationHash: string }): Promise<void>;
}
export interface ConversationAgentRuntimeCanonicalEvent {
  readonly runId: string; readonly runEventId: string; readonly runSequence: number; readonly occurredAt: string;
  readonly publicEvent: { readonly code: ProductionEventCode; readonly status: ProductionEventStatus; readonly operationId?: string; readonly assistantMessageId?: string; readonly traceId?: string; readonly clientCommandId?: string; readonly facts?: ProductionEventFacts };
}
export interface ConversationAgentRuntimeCanonicalEvents {
  record(input: ConversationAgentRuntimeCanonicalEvent['publicEvent'] & { readonly occurredAt: string }): Promise<ConversationAgentRuntimeCanonicalEvent>;
  markProjected(runEventId: string): Promise<void>;
  replayPending(): Promise<readonly ConversationAgentRuntimeCanonicalEvent[]>;
}
export interface ConversationAgentRuntimeServiceOptions {
  readonly repository: ConversationAgentRuntimeRepository;
  readonly now?: () => string;
  readonly nextEventId: () => string;
  readonly hash?: (serializedSafeFacts: string) => string | Promise<string>;
  /** Host lease fence, checked immediately before each new execution admission. Receipts remain writable. */
  readonly executionOwnershipGuard?: (runId: ConversationAgentRunId, boundary: 'model_prepared' | 'model_started' | 'tool_prepared' | 'tool_admitted') => Promise<void>;
}
export class ConversationAgentRuntimeError extends Error {
  constructor(readonly code: 'run_not_found' | 'owner_invalid' | 'admission_replay_forbidden' | 'event_conflict' | 'observation_missing' | 'run_frozen' | 'invalid_tool' | 'round_out_of_order' | 'call_missing') { super(code); this.name = 'ConversationAgentRuntimeError'; }
}

/** Durable admission and receipts for the existing Provider loop; this class never executes a model or tool. */
export class ConversationAgentRuntimeService {
  private readonly operations = new Map<string, Promise<unknown>>();
  private readonly registry = createCanonicalToolRegistry();
  private readonly projectedReceipts = new Map<ConversationAgentRunId, Set<string>>();
  private projectionTimer?: ReturnType<typeof setTimeout>;
  private projectionFlush: Promise<void> = Promise.resolve();
  constructor(private readonly options: ConversationAgentRuntimeServiceOptions) {}

  open(run: ConversationAgentRunV1, policy: ExecutionBudgetPolicy): Promise<ConversationAgentRuntimeSnapshotV1> {
    return this.exclusive(run.id, async () => {
      if (!run.responseExecutionId || run.projectId !== this.options.repository.projectId) throw new ConversationAgentRuntimeError('owner_invalid');
      const runtime = createConversationAgentRuntime({ runId: run.id, projectId: run.projectId, conversationId: run.conversationId,
        sourceMessageId: run.sourceMessageId, responseExecutionId: run.responseExecutionId, budget: policy, createdAt: toIsoTimestamp(new Date(policy.startedAt).toISOString()) });
      const event = parseConversationAgentRuntimeEvent({ runId: run.id, eventId: this.options.nextEventId(), eventKey: 'run-created', sequence: 1, kind: 'run_created', at: runtime.createdAt });
      return this.options.repository.create(runtime, event);
    });
  }
  find(runId: ConversationAgentRunId): Promise<ConversationAgentRuntimeSnapshotV1 | undefined> { return this.options.repository.get(runId); }
  findByResponse(responseId: ConversationResponseExecutionId): Promise<ConversationAgentRuntimeSnapshotV1 | undefined> { return this.options.repository.findByResponseExecutionId(responseId); }

  providerLifecycle(runId: ConversationAgentRunId): ConversationAgentRuntimeProviderLifecycle {
    return {
      modelPrepared: input => this.exclusive(runId, async () => {
        const snapshot = await this.require(runId); await this.assertAdmission(snapshot, 'model_prepared');
        const existing = snapshot.runtime.modelCalls.find(call => call.round === input.round);
        if (existing && existing.status !== 'prepared') throw new ConversationAgentRuntimeError('admission_replay_forbidden');
        if (!existing && input.round !== snapshot.runtime.modelCalls.length) throw new ConversationAgentRuntimeError('round_out_of_order');
        if (snapshot.runtime.modelCalls.some(call => call.round < input.round && call.status !== 'completed') || snapshot.runtime.toolCalls.some(call => call.round < input.round && !['observed', 'failed'].includes(call.status))) throw new ConversationAgentRuntimeError('observation_missing');
        const facts = { round: input.round, requestHash: input.requestHash, messageCount: input.messageCount, toolCount: input.toolCount };
        await this.commit(snapshot, `model-${input.round}-prepared`, 'model_call_prepared', facts, {
          checkpoint: { ...snapshot.runtime.checkpoint, stage: 'model', modelRound: input.round },
          modelCalls: existing ? snapshot.runtime.modelCalls : [...snapshot.runtime.modelCalls, { callId: `model-${input.round}`, round: input.round, status: 'prepared', requestHash: input.requestHash }]
        });
      }),
      modelStarted: input => this.exclusive(runId, async () => {
        const snapshot = await this.require(runId); await this.assertAdmission(snapshot, 'model_started');
        const call = snapshot.runtime.modelCalls.find(call => call.round === input.round);
        if (!call) throw new ConversationAgentRuntimeError('call_missing');
        if (call.status !== 'prepared') throw new ConversationAgentRuntimeError('admission_replay_forbidden');
        await this.commit(snapshot, `model-${input.round}-submitting`, 'model_call_submitting', { round: input.round }, {
          modelCalls: snapshot.runtime.modelCalls.map(item => item.round === input.round ? { ...item, status: 'submitting' } : item)
        });
        await this.options.executionOwnershipGuard?.(runId, 'model_started');
      }),
      modelResult: input => this.exclusive(runId, async () => {
        const snapshot = await this.require(runId), call = snapshot.runtime.modelCalls.find(call => call.round === input.round);
        if (!call) throw new ConversationAgentRuntimeError('call_missing');
        if (!['submitting', 'unknown', 'completed'].includes(call.status)) throw new ConversationAgentRuntimeError('event_conflict');
        const finishReason = ['stop', 'tool_calls', 'length', 'content_filter'].includes(input.finishReason) ? input.finishReason : 'unknown';
        await this.commit(snapshot, `model-${input.round}-result`, 'model_call_completed', { round: input.round, resultHash: input.resultHash, contentLength: input.contentLength, finishReason, toolCallCount: input.toolCallCount }, {
          modelCalls: snapshot.runtime.modelCalls.map(item => item.round === input.round ? { ...item, status: 'completed', resultHash: input.resultHash } : item)
        });
      }),
      modelFailed: input => this.exclusive(runId, async () => {
        const snapshot = await this.require(runId), call = snapshot.runtime.modelCalls.find(call => call.round === input.round);
        if (!call || call.status === 'completed') return;
        const unknown = input.unknown && ['submitting', 'unknown'].includes(call.status);
        await this.commit(snapshot, `model-${input.round}-${unknown ? 'unknown' : 'failed'}`, unknown ? 'model_call_unknown' : 'model_call_failed', { round: input.round, failureCode: input.code }, {
          ...(unknown ? { status: 'needs_reconciliation', stopReason: snapshot.runtime.stopReason ?? 'unknown_result' } : {}),
          modelCalls: snapshot.runtime.modelCalls.map(item => item.round === input.round ? { ...item, status: unknown ? 'unknown' : 'failed' } : item)
        });
      }),
      toolStarted: input => this.exclusive(runId, async () => {
        const snapshot = await this.require(runId); await this.assertAdmission(snapshot, 'tool_prepared');
        if (snapshot.runtime.toolCalls.some(call => call.stepRef === input.stepRef)) throw new ConversationAgentRuntimeError('admission_replay_forbidden');
        const contract = this.registry.get(input.toolId as CanonicalToolId);
        if (!contract || contract.exposure !== 'provider') throw new ConversationAgentRuntimeError('invalid_tool');
        if (!snapshot.runtime.modelCalls.some(call => call.round === input.round && call.status === 'completed') || snapshot.runtime.modelCalls.at(-1)?.round !== input.round) throw new ConversationAgentRuntimeError('round_out_of_order');
        const budget = snapshot.runtime.budget;
        const toolAttemptsUsed = budget.toolAttemptsUsed ?? snapshot.runtime.toolCalls.length;
        if (toolAttemptsUsed >= budget.maxToolCalls) return this.deny(snapshot, 'tool_call_limit');
        const facts = { round: input.round, stepRef: input.stepRef, toolId: contract.toolId, argumentsHash: input.argumentsHash };
        await this.commit(snapshot, `${input.stepRef}-prepared`, 'tool_call_prepared', facts, {
          budget: { ...budget, toolAttemptsUsed: toolAttemptsUsed + 1 },
          checkpoint: { ...snapshot.runtime.checkpoint, stage: 'tool' },
          toolCalls: [...snapshot.runtime.toolCalls, { stepRef: input.stepRef, round: input.round, toolId: contract.toolId, argumentsHash: input.argumentsHash, status: 'prepared', admissionPhase: 'pending' }]
        });
      }),
      toolAdmitted: input => this.exclusive(runId, async () => {
        const snapshot = await this.require(runId); await this.assertAdmission(snapshot, 'tool_admitted');
        const call = snapshot.runtime.toolCalls.find(item => item.stepRef === input.stepRef && item.round === input.round);
        if (!call) throw new ConversationAgentRuntimeError('call_missing');
        if (!['prepared', 'started'].includes(call.status) || call.admissionPhase !== 'pending') throw new ConversationAgentRuntimeError('admission_replay_forbidden');
        const contract = this.registry.get(call.toolId as CanonicalToolId);
        if (!contract || contract.exposure !== 'provider') throw new ConversationAgentRuntimeError('invalid_tool');
        const budget = snapshot.runtime.budget;
        if (budget.toolCallsUsed >= budget.maxToolCalls) return this.deny(snapshot, 'tool_call_limit');
        if (budget.costUnitsUsed + contract.execution.budgetUnits > budget.budgetUnits) return this.deny(snapshot, 'budget_exceeded');
        await this.commit(snapshot, `${input.stepRef}-admitted`, 'tool_call_admitted', { round: input.round, stepRef: input.stepRef, admissionPhase: 'admitted' }, {
          budget: { ...budget, toolCallsUsed: budget.toolCallsUsed + 1, costUnitsUsed: budget.costUnitsUsed + contract.execution.budgetUnits },
          toolCalls: snapshot.runtime.toolCalls.map(item => item.stepRef === input.stepRef ? { ...item, status: 'started', admissionPhase: 'admitted' } : item)
        });
        await this.options.executionOwnershipGuard?.(runId, 'tool_admitted');
      }),
      toolResult: input => this.exclusive(runId, async () => {
        const snapshot = await this.require(runId), call = snapshot.runtime.toolCalls.find(call => call.stepRef === input.stepRef && call.round === input.round);
        if (!call) throw new ConversationAgentRuntimeError('call_missing');
        if (!['prepared', 'started', 'observed', 'unknown'].includes(call.status)) throw new ConversationAgentRuntimeError('event_conflict');
        const unknown = input.outcomeUnknown || input.status === 'unknown';
        // Admission comes exclusively from the awaited Host callback, never a tool-result declaration.
        if (input.admissionPhase === 'admitted' && call.admissionPhase !== 'admitted') throw new ConversationAgentRuntimeError('event_conflict');
        const admissionPhase = call.admissionPhase === 'admitted' ? 'admitted' : call.admissionPhase === undefined ? undefined
          : unknown ? 'unknown' : input.admissionPhase === 'replayed' ? 'replayed' : 'rejected';
        const works = [...new Set([...snapshot.runtime.registeredWorkIds, ...(input.registeredWorkIds ?? []).map(toWorkId)])];
        if (call.status === 'unknown' && call.resultHash && call.resultHash !== input.resultHash) {
          // A second receipt cannot rewrite the uncertain first receipt. Known Work is still retained.
          await this.commit(snapshot, `${input.stepRef}-late-result-${input.resultHash}`, 'work_registered', {
            round: input.round, stepRef: input.stepRef, resultHash: input.resultHash, count: works.length
          }, { registeredWorkIds: works });
          return;
        }
        await this.commit(snapshot, `${input.stepRef}-result`, unknown ? 'tool_call_unknown' : 'checkpoint_committed', { round: input.round, stepRef: input.stepRef, resultHash: input.resultHash, resultStatus: unknown ? 'unknown_result' : input.status === 'failed' ? 'failed' : 'ok', ...(admissionPhase ? { admissionPhase } : {}), ...(input.failureCode ? { failureCode: input.failureCode } : {}) }, {
          ...(unknown ? { status: 'needs_reconciliation', stopReason: snapshot.runtime.stopReason ?? 'unknown_result' } : {}),
          toolCalls: snapshot.runtime.toolCalls.map(item => item.stepRef === input.stepRef ? { ...item, resultHash: input.resultHash, status: unknown ? 'unknown' : item.status, ...(admissionPhase ? { admissionPhase } : {}), ...(input.failureCode ? { failureCode: input.failureCode } : {}) } : item), registeredWorkIds: works
        });
      }),
      observationCommitted: input => this.exclusive(runId, async () => {
        const snapshot = await this.require(runId), call = snapshot.runtime.toolCalls.find(call => call.stepRef === input.stepRef && call.round === input.round);
        if (!call || !call.resultHash) throw new ConversationAgentRuntimeError('observation_missing');
        await this.commit(snapshot, `${input.stepRef}-observation`, 'tool_call_observed', { round: input.round, stepRef: input.stepRef, observationHash: input.observationHash }, {
          checkpoint: { ...snapshot.runtime.checkpoint, stage: 'observation' },
          toolCalls: snapshot.runtime.toolCalls.map(item => item.stepRef === input.stepRef ? { ...item, observationHash: input.observationHash, status: item.status === 'unknown' ? 'unknown' : 'observed' } : item)
        });
      })
    };
  }

  canonicalEvents(runId: ConversationAgentRunId): ConversationAgentRuntimeCanonicalEvents {
    return {
      record: input => this.exclusive(runId, async () => {
        const snapshot = await this.require(runId);
        const parsed = parseConversationAgentRuntimeEvent({ eventId: this.options.nextEventId(), eventKey: 'validating-public-event', runId, sequence: snapshot.runtime.checkpoint.sequence + 1, kind: 'progress_recorded', at: this.timestamp(snapshot.runtime, input.occurredAt),
          publicEvent: { code: input.code, status: input.status, ...(input.operationId !== undefined ? { operationId: input.operationId } : {}), ...(input.assistantMessageId !== undefined ? { assistantMessageId: input.assistantMessageId } : {}), ...(input.traceId !== undefined ? { traceId: input.traceId } : {}), ...(input.clientCommandId !== undefined ? { clientCommandId: input.clientCommandId } : {}), ...(input.facts !== undefined ? { facts: input.facts } : {}) } });
        const phase = { modelRound: snapshot.runtime.checkpoint.modelRound, modelStatus: snapshot.runtime.modelCalls.at(-1)?.status, tool: snapshot.runtime.toolCalls.at(-1)?.stepRef, publicEvent: parsed.publicEvent };
        const eventKey = `progress-${await this.factKey(JSON.stringify(phase))}`;
        const committed = await this.commit(snapshot, eventKey, 'progress_recorded', undefined, {}, parsed.publicEvent, parsed.at, parsed.eventId);
        const event = committed.outbox.find(entry => entry.eventKey === eventKey)!;
        return this.projectedEvent(event);
      }),
      markProjected: async eventId => {
        let receipts = this.projectedReceipts.get(runId);
        if (!receipts) { receipts = new Set(); this.projectedReceipts.set(runId, receipts); }
        receipts.add(eventId);
        if (receipts.size >= 64) await this.flushProjectedEvents();
        else if (!this.projectionTimer) this.projectionTimer = setTimeout(() => {
          this.projectionTimer = undefined; void this.flushProjectedEvents().catch(() => undefined);
        }, 1000);
      },
      replayPending: async () => { await this.flushProjectedEvents().catch(() => undefined); return (await this.options.repository.listPendingOutbox(runId)).map(entry => this.projectedEvent(entry)); }
    };
  }

  async finish(responseId: ConversationResponseExecutionId, reason?: ExecutionStopReason): Promise<ConversationAgentRuntimeSnapshotV1 | undefined> {
    await this.flushProjectedEvents().catch(() => undefined);
    const snapshot = await this.findByResponse(responseId);
    return snapshot ? this.exclusive(snapshot.runtime.runId, async () => this.finishRun(await this.require(snapshot.runtime.runId), reason)) : undefined;
  }
  async recordRegisteredWorks(responseId: ConversationResponseExecutionId, workIds: readonly string[]): Promise<ConversationAgentRuntimeSnapshotV1 | undefined> {
    const snapshot = await this.findByResponse(responseId);
    if (!snapshot) return undefined;
    return this.exclusive(snapshot.runtime.runId, async () => {
      const current = await this.require(snapshot.runtime.runId), works = [...new Set([...current.runtime.registeredWorkIds, ...workIds.map(toWorkId)])];
      if (works.length === current.runtime.registeredWorkIds.length) return current;
      return this.commit(current, `work-receipt-${await this.factKey(JSON.stringify(workIds.slice().sort()))}`, 'work_registered', { count: works.length }, { registeredWorkIds: works });
    });
  }
  /** Host counters include local document steps. This never adds two views of the same charge. */
  async recordBudget(responseId: ConversationResponseExecutionId, counters: { readonly toolCallsUsed: number; readonly costUnitsUsed: number }): Promise<ConversationAgentRuntimeSnapshotV1 | undefined> {
    const snapshot = await this.findByResponse(responseId);
    if (!snapshot) return undefined;
    return this.exclusive(snapshot.runtime.runId, async () => {
      const current = await this.require(snapshot.runtime.runId), previous = current.runtime.budget;
      if (!Number.isSafeInteger(counters.toolCallsUsed) || counters.toolCallsUsed < 0 || !Number.isSafeInteger(counters.costUnitsUsed) || counters.costUnitsUsed < 0) throw new ConversationAgentRuntimeError('event_conflict');
      if (counters.toolCallsUsed > previous.maxToolCalls || counters.costUnitsUsed > previous.budgetUnits) {
        const reason = counters.toolCallsUsed > previous.maxToolCalls ? 'tool_call_limit' : 'budget_exceeded';
        await this.commit(current, `host-budget-overflow-${counters.toolCallsUsed}-${counters.costUnitsUsed}`, 'run_stopped', {
          stopReason: reason, diagnosticCode: 'host_budget_counter_overflow',
          ...(counters.toolCallsUsed <= 1_000_000_000 ? { toolCallsUsed: counters.toolCallsUsed } : {}),
          ...(counters.costUnitsUsed <= 1_000_000_000 ? { costUnitsUsed: counters.costUnitsUsed } : {})
        }, { status: 'needs_reconciliation', stopReason: current.runtime.stopReason ?? reason,
          checkpoint: { ...current.runtime.checkpoint, stage: 'reconciliation' },
          modelCalls: current.runtime.modelCalls.map(call => call.status === 'submitting' ? { ...call, status: 'unknown' } : call.status === 'prepared' ? { ...call, status: 'failed' } : call),
          toolCalls: current.runtime.toolCalls.map(call => call.status === 'started' ? { ...call, status: 'unknown' } : call.status === 'prepared' ? { ...call, status: 'failed' } : call)
        });
        throw new ExecutionBudgetError(reason);
      }
      const toolCallsUsed = Math.max(previous.toolCallsUsed, counters.toolCallsUsed), costUnitsUsed = Math.max(previous.costUnitsUsed, counters.costUnitsUsed);
      if (toolCallsUsed === previous.toolCallsUsed && costUnitsUsed === previous.costUnitsUsed) return current;
      return this.commit(current, `budget-${toolCallsUsed}-${costUnitsUsed}`, 'checkpoint_committed', { toolCallsUsed, costUnitsUsed }, { budget: { ...previous, toolCallsUsed, costUnitsUsed } });
    });
  }
  async settle(responseId: ConversationResponseExecutionId): Promise<ConversationAgentRuntimeSnapshotV1 | undefined> {
    await this.flushProjectedEvents().catch(() => undefined);
    const snapshot = await this.findByResponse(responseId);
    if (!snapshot) return undefined;
    return this.exclusive(snapshot.runtime.runId, async () => {
      let current = await this.require(snapshot.runtime.runId);
      if (current.runtime.status === 'running') current = await this.finishRun(current);
      if (current.runtime.status !== 'stopped') return current;
      return this.commit(current, 'run-settled', 'run_settled', undefined, { status: 'settled', checkpoint: { ...current.runtime.checkpoint, stage: 'settled' } });
    });
  }
  async recoverInterrupted(canRecover?: (runId: ConversationAgentRunId) => Promise<boolean>): Promise<readonly ConversationAgentRuntimeSnapshotV1[]> {
    await this.flushProjectedEvents().catch(() => undefined);
    const recovered: ConversationAgentRuntimeSnapshotV1[] = [];
    for (const snapshot of await this.options.repository.list()) if (snapshot.runtime.status === 'running' && (!canRecover || await canRecover(snapshot.runtime.runId))) recovered.push(await this.exclusive(snapshot.runtime.runId, async () => this.finishRun(await this.require(snapshot.runtime.runId))));
    return recovered;
  }
  /** Acknowledges only receipts supplied after durable Trace projection; no execution action is queued. */
  flushProjectedEvents(): Promise<void> {
    if (this.projectionTimer) { clearTimeout(this.projectionTimer); this.projectionTimer = undefined; }
    const operation = this.projectionFlush.then(async () => {
      for (const [runId, receipts] of this.projectedReceipts) {
        const ids = [...receipts];
        // Receipt-only CAS shares the Run queue so it cannot contend with a checkpoint write.
        // Trace is already durable; a crash before this receipt only repeats safe projection.
        await this.exclusive(runId, async () => {
          if (this.options.repository.acknowledgeOutboxMany) await this.options.repository.acknowledgeOutboxMany(runId, ids);
          else for (const id of ids) await this.options.repository.acknowledgeOutbox(runId, id);
        });
        for (const id of ids) receipts.delete(id);
        if (!receipts.size) this.projectedReceipts.delete(runId);
      }
    });
    this.projectionFlush = operation.catch(() => undefined);
    return operation;
  }

  private async finishRun(snapshot: ConversationAgentRuntimeSnapshotV1, reason?: ExecutionStopReason): Promise<ConversationAgentRuntimeSnapshotV1> {
    const runtime = snapshot.runtime;
    if (runtime.status !== 'running') return snapshot;
    const uncertain = reason === 'unknown_result' || runtime.modelCalls.some(call => call.status === 'submitting') || runtime.toolCalls.some(call =>
      call.status === 'started' && call.admissionPhase !== 'pending' || ['prepared', 'started'].includes(call.status) && call.resultHash !== undefined);
    const stopReason = runtime.stopReason ?? reason ?? (uncertain ? 'unknown_result' : undefined);
    return this.commit(snapshot, 'run-stopped', 'run_stopped', stopReason ? { stopReason } : undefined, {
      status: uncertain ? 'needs_reconciliation' : 'stopped', ...(stopReason ? { stopReason } : {}), checkpoint: { ...runtime.checkpoint, stage: uncertain ? 'reconciliation' : 'stopped' },
      modelCalls: runtime.modelCalls.map(call => call.status === 'submitting' ? { ...call, status: 'unknown' } : call.status === 'prepared' ? { ...call, status: 'failed' } : call),
      toolCalls: runtime.toolCalls.map(call => call.status === 'started' ? { ...call, status: call.admissionPhase === 'pending' && !call.resultHash ? 'failed' : 'unknown' }
        : call.status === 'prepared' ? { ...call, status: call.resultHash ? 'unknown' : 'failed' } : call)
    });
  }
  private async assertAdmission(snapshot: ConversationAgentRuntimeSnapshotV1, boundary: 'model_prepared' | 'model_started' | 'tool_prepared' | 'tool_admitted'): Promise<void> {
    if (snapshot.runtime.status !== 'running') throw new ConversationAgentRuntimeError('run_frozen');
    if (Date.parse(this.options.now?.() ?? new Date().toISOString()) >= snapshot.runtime.budget.deadlineAt) await this.deny(snapshot, 'timeout');
    await this.options.executionOwnershipGuard?.(snapshot.runtime.runId, boundary);
  }
  private async deny(snapshot: ConversationAgentRuntimeSnapshotV1, reason: ExecutionStopReason): Promise<never> {
    await this.finishRun(snapshot, reason); throw new ExecutionBudgetError(reason);
  }
  private async require(runId: ConversationAgentRunId): Promise<ConversationAgentRuntimeSnapshotV1> {
    const snapshot = await this.options.repository.get(runId);
    if (!snapshot) throw new ConversationAgentRuntimeError('run_not_found');
    return snapshot;
  }
  private async commit(snapshot: ConversationAgentRuntimeSnapshotV1, eventKey: string, kind: ConversationAgentRuntimeEventV1['kind'], facts: ConversationAgentRuntimeFacts | undefined,
    patch: Parameters<typeof updateConversationAgentRuntime>[1], publicEvent?: ConversationAgentRuntimePublicEventV1, at?: string, eventId?: string): Promise<ConversationAgentRuntimeSnapshotV1> {
    const event = parseConversationAgentRuntimeEvent({ runId: snapshot.runtime.runId, eventId: eventId ?? this.options.nextEventId(), eventKey, sequence: snapshot.runtime.checkpoint.sequence + 1, kind, at: this.timestamp(snapshot.runtime, at), ...(facts !== undefined ? { facts } : {}), ...(publicEvent ? { publicEvent } : {}) });
    const replay = snapshot.events.find(item => item.eventKey === eventKey);
    if (replay) {
      if (JSON.stringify({ kind: replay.kind, facts: replay.facts, publicEvent: replay.publicEvent }) !== JSON.stringify({ kind: event.kind, facts: event.facts, publicEvent: event.publicEvent })) throw new ConversationAgentRuntimeError('event_conflict');
      return snapshot;
    }
    const runtime = updateConversationAgentRuntime(snapshot.runtime, patch, event.at);
    return this.options.repository.commit({ runId: runtime.runId, expectedRevision: snapshot.runtime.revision, runtime, event });
  }
  private timestamp(runtime: ConversationAgentRuntimeV1, provided?: string): ReturnType<typeof toIsoTimestamp> {
    const candidate = toIsoTimestamp(provided ?? this.options.now?.() ?? new Date().toISOString());
    return candidate < runtime.updatedAt ? runtime.updatedAt : candidate;
  }
  private projectedEvent(entry: ConversationAgentRuntimeOutboxEntryV1): ConversationAgentRuntimeCanonicalEvent {
    return { runId: entry.runId, runEventId: entry.eventId, runSequence: entry.sequence, occurredAt: entry.at, publicEvent: entry.payload as ConversationAgentRuntimeCanonicalEvent['publicEvent'] };
  }
  private async factKey(value: string): Promise<string> {
    const injected = await this.options.hash?.(value);
    if (injected !== undefined) {
      if (!/^[a-f0-9]{16,64}$/.test(injected)) throw new ConversationAgentRuntimeError('event_conflict');
      return injected;
    }
    // This fallback is an opaque idempotency key, not a content or security digest.
    let left = 2166136261, right = 3339675911;
    for (let index = 0; index < value.length; index++) { left = Math.imul(left ^ value.charCodeAt(index), 16777619); right = Math.imul(right ^ value.charCodeAt(index), 2246822519); }
    return `${(left >>> 0).toString(16).padStart(8, '0')}${(right >>> 0).toString(16).padStart(8, '0')}`;
  }
  private exclusive<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.operations.get(key) ?? Promise.resolve();
    const operation = previous.then(work, work);
    this.operations.set(key, operation);
    void operation.finally(() => { if (this.operations.get(key) === operation) this.operations.delete(key); }).catch(() => undefined);
    return operation;
  }
}
