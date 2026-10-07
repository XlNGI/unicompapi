import {
  applyConversationExecutionCompletion,
  acknowledgeConversationAgentRunReconciliation,
  attachConversationAgentRunExecution,
  bindConversationAgentRunTasks,
  confirmConversationAgentRunProjectedCompletion,
  evaluateConversationExecutionCompletion,
  markConversationAgentRunNeedsReconciliation,
  toIsoTimestamp,
  type ConversationAgentRunRepository,
  type ConversationAgentRunV1,
  type ConversationExecutionCompletionDecision,
  type ConversationExecutionCompletionFacts,
  type ConversationResponseExecutionId,
  type ConversationResponseExecutionRepository,
  type ConversationResponseExecutionV1,
  type DocumentTaskRuntimeRepository,
  type IsoTimestamp
} from '../domain';

export type ConversationCompletionFacts = Omit<ConversationExecutionCompletionFacts, 'run' | 'response'>;

export type ConversationCompletionFailureStage = 'facts' | 'wal_prepare' | 'evidence' | 'projection' | 'run_commit' | 'wal_commit';

/** A write-ahead decision. Entity files are projections, not a multi-file transaction. */
export interface ConversationCompletionIntent {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly responseExecutionId: ConversationResponseExecutionId;
  readonly expectedRunRevision: number;
  readonly targetRun: ConversationAgentRunV1;
  readonly decision: ConversationExecutionCompletionDecision;
  readonly responseState: ConversationResponseExecutionV1['state'];
  readonly taskRevisions: readonly { readonly id: string; readonly revision: number }[];
  readonly stage: 'prepared' | 'run_applied' | 'applied' | 'needs_reconciliation' | 'acknowledged';
  /** Missing provenance in older records must remain an unknown result. */
  readonly freezeOrigin?: 'local_projection' | 'unknown_result';
  readonly failureStage?: ConversationCompletionFailureStage;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

export interface ConversationCompletionJournal {
  get(id: ConversationResponseExecutionId): Promise<ConversationCompletionIntent | undefined>;
  listPending(): Promise<readonly ConversationCompletionIntent[]>;
  save(intent: ConversationCompletionIntent, expectedRevision: number | null): Promise<void>;
}

export interface ConversationCompletionSettlement {
  readonly run: ConversationAgentRunV1;
  readonly decision: ConversationExecutionCompletionDecision;
  readonly intent: ConversationCompletionIntent;
}

export interface ConversationCompletionCoordinatorOptions {
  readonly agentRuns: ConversationAgentRunRepository;
  readonly responseExecutions: ConversationResponseExecutionRepository;
  readonly documentTasks: DocumentTaskRuntimeRepository;
  readonly journal: ConversationCompletionJournal;
  readonly collectFacts: (execution: ConversationResponseExecutionV1,
    run: ConversationAgentRunV1) => Promise<ConversationCompletionFacts>;
  /** Local, idempotent projections only. This callback must never submit a model or tool. */
  readonly projectTerminal: (settlement: ConversationCompletionSettlement & {
    readonly responseExecution: ConversationResponseExecutionV1;
  }) => Promise<void>;
  /** Rechecks the primary root owner. Local settlement never acquires execution authority. */
  readonly reconciliationOwnershipGuard?: (responseExecutionId: ConversationResponseExecutionId) => Promise<void>;
  readonly now?: () => string;
}

export class ConversationCompletionError extends Error {
  constructor(readonly code: 'entity_conflict' | 'settlement_unknown', readonly cause?: unknown) {
    super(code);
    this.name = 'ConversationCompletionError';
  }
}

/** Owns cross-entity completion without owning another execution loop. */
export class ConversationCompletionCoordinator {
  private readonly operations = new Map<string, Promise<unknown>>();

  constructor(private readonly options: ConversationCompletionCoordinatorOptions) {}

  bindExecution(responseExecutionId: ConversationResponseExecutionId): Promise<ConversationAgentRunV1 | undefined> {
    return this.exclusive(responseExecutionId, async () => {
      const execution = await this.options.responseExecutions.get(responseExecutionId);
      if (!execution) throw new ConversationCompletionError('entity_conflict');
      const bound = await this.options.agentRuns.findByResponseExecutionId(responseExecutionId);
      if (bound) return this.requireOwnership(bound, execution);
      const runs = await this.options.agentRuns.list(execution.snapshot.conversationId);
      const containers = new Set(runs.flatMap(run => run.parentRunId ? [run.parentRunId] : []));
      const candidates = runs.filter(run => run.sourceMessageId === execution.snapshot.userMessageId &&
        !run.responseExecutionId && !containers.has(run.id));
      if (candidates.length === 0) return undefined;
      if (candidates.length !== 1 || candidates[0].status !== 'running') {
        throw new ConversationCompletionError('entity_conflict');
      }
      const run = this.requireOwnership(candidates[0], execution);
      const next = attachConversationAgentRunExecution(run, responseExecutionId, this.timestamp(run.updatedAt));
      await this.saveRun(next, run.revision);
      return next;
    });
  }

  bindTasks(responseExecutionId: ConversationResponseExecutionId): Promise<ConversationAgentRunV1 | undefined> {
    return this.exclusive(responseExecutionId, async () => {
      const execution = await this.options.responseExecutions.get(responseExecutionId);
      const run = await this.options.agentRuns.findByResponseExecutionId(responseExecutionId);
      if (!execution || !run) return undefined;
      this.requireOwnership(run, execution);
      const tasks = (await this.options.documentTasks.list(run.conversationId))
        .filter(task => task.executionId === responseExecutionId);
      if (tasks.some(task => task.projectId !== run.projectId || task.sourceMessageId !== run.sourceMessageId)) {
        await this.freeze(run);
        throw new ConversationCompletionError('entity_conflict');
      }
      const next = bindConversationAgentRunTasks(run, tasks.map(task => task.id), this.timestamp(run.updatedAt));
      if (next !== run) await this.saveRun(next, run.revision);
      return next;
    });
  }

  settle(responseExecutionId: ConversationResponseExecutionId,
    overrides: Pick<ConversationCompletionFacts, 'unknownResult' | 'toolFailed'> = {}): Promise<ConversationCompletionSettlement | undefined> {
    return this.exclusive(responseExecutionId, async () => {
      await this.options.reconciliationOwnershipGuard?.(responseExecutionId);
      return this.settleOnce(responseExecutionId, overrides);
    });
  }

  async inspect(responseExecutionId: ConversationResponseExecutionId): Promise<{
    readonly run: ConversationAgentRunV1;
    readonly intent?: ConversationCompletionIntent;
    readonly taskRevisions: ConversationCompletionIntent['taskRevisions'];
  } | undefined> {
    const execution = await this.options.responseExecutions.get(responseExecutionId);
    const run = await this.options.agentRuns.findByResponseExecutionId(responseExecutionId);
    if (!execution || !run) return undefined;
    this.requireOwnership(run, execution);
    const intent = await this.options.journal.get(responseExecutionId);
    if (intent) this.requireIntentOwnership(intent, run);
    const tasks = (await this.options.documentTasks.list(run.conversationId)).filter(task => task.executionId === execution.id);
    if (tasks.some(task => task.projectId !== run.projectId || task.sourceMessageId !== run.sourceMessageId)) {
      throw new ConversationCompletionError('entity_conflict');
    }
    return { run, ...(intent ? { intent } : {}),
      taskRevisions: tasks.map(task => ({ id: task.id, revision: task.revision })).sort((left, right) => left.id.localeCompare(right.id)) };
  }

  /** This command rechecks host facts and unfinished local projections, never unknown side effects. */
  reconcile(responseExecutionId: ConversationResponseExecutionId): Promise<ConversationCompletionSettlement | undefined> {
    return this.exclusive(responseExecutionId, async () => {
      await this.options.reconciliationOwnershipGuard?.(responseExecutionId);
      const snapshot = await this.inspect(responseExecutionId);
      if (!snapshot?.intent) return undefined;
      const { run, intent } = snapshot;
      if (intent.targetRun.status === 'cancelled' && intent.targetRun.reconciliationAcknowledgement?.kind === 'closed_without_replay' &&
        ['prepared', 'run_applied', 'needs_reconciliation'].includes(intent.stage)) return this.reconcileAcknowledgedProjection(run, intent);
      if (intent.freezeOrigin === 'local_projection' &&
        (intent.stage === 'needs_reconciliation' || run.status === 'needs_reconciliation')) {
        return this.reconcileLocalProjection(run, intent);
      }
      if (intent.stage === 'needs_reconciliation' || run.status === 'needs_reconciliation') {
        return { run, decision: intent.decision, intent };
      }
      if (intent.stage === 'applied' || intent.stage === 'acknowledged') return { run, decision: intent.decision, intent };
      return this.settleOnce(responseExecutionId, {});
    });
  }

  /** Replays local settlement only; unknown outcomes remain frozen until explicit reconciliation. */
  async reconcilePending(canRecover?: (responseExecutionId: ConversationResponseExecutionId) => Promise<boolean>): Promise<number> {
    const pending = await this.options.journal.listPending();
    let reconciled = 0;
    for (const intent of pending) {
      if (intent.stage === 'needs_reconciliation' && !(intent.targetRun.status === 'cancelled' && intent.targetRun.reconciliationAcknowledgement?.kind === 'closed_without_replay')) continue;
      if (canRecover && !await canRecover(intent.responseExecutionId)) continue;
      await this.reconcile(intent.responseExecutionId);
      reconciled += 1;
    }
    return reconciled;
  }

  async canStartNewResponse(conversationId: ConversationAgentRunV1['conversationId']): Promise<boolean> {
    try {
      const runs = await this.options.agentRuns.list(conversationId);
      if (runs.some(run => run.status === 'needs_reconciliation' || run.responseExecutionId !== undefined &&
        (run.status === 'running' || run.status === 'executing_tool'))) return false;
      const pending = await this.options.journal.listPending();
      return !pending.some(intent => intent.targetRun.conversationId === conversationId);
    } catch {
      return false;
    }
  }

  /** Host authorization is required before this method. It closes the old execution
   * without declaring its effect absent and without restoring its replay authority. */
  acknowledge(responseExecutionId: ConversationResponseExecutionId, expectedRunRevision: number,
    expectedIntentRevision?: number | null,
    expectedTaskRevisions?: ConversationCompletionIntent['taskRevisions']): Promise<ConversationCompletionSettlement | undefined> {
    return this.exclusive(responseExecutionId, async () => {
      await this.options.reconciliationOwnershipGuard?.(responseExecutionId);
      const snapshot = await this.inspect(responseExecutionId);
      if (!snapshot) return undefined;
      const { run } = snapshot;
      const previous = snapshot.intent;
      if (!Number.isSafeInteger(expectedRunRevision) || run.revision !== expectedRunRevision ||
        (expectedIntentRevision !== undefined && (previous?.revision ?? null) !== expectedIntentRevision) ||
        (expectedTaskRevisions !== undefined && JSON.stringify(snapshot.taskRevisions) !== JSON.stringify(expectedTaskRevisions)) ||
        (run.status !== 'needs_reconciliation' && previous?.stage !== 'needs_reconciliation') ||
        !this.options.agentRuns.acknowledgeReconciliation) throw new ConversationCompletionError('entity_conflict');
      const execution = await this.options.responseExecutions.get(responseExecutionId);
      if (!execution) throw new ConversationCompletionError('entity_conflict');
      const facts = await this.options.collectFacts(execution, run);
      this.requireFactVersions(facts, snapshot.taskRevisions);
      await this.assertSnapshotEvidence(run, execution.state, snapshot.taskRevisions, previous?.revision ?? null);
      const reason = run.reconciliationReason ?? previous?.decision.reconciliationReason ?? 'unknown_result';
      const next = acknowledgeConversationAgentRunReconciliation(run, this.timestamp(run.updatedAt), reason);
      const evaluated = evaluateConversationExecutionCompletion({ ...facts, run,
        response: { id: execution.id, projectId: execution.projectId, conversationId: execution.snapshot.conversationId,
          sourceMessageId: execution.snapshot.userMessageId, state: execution.state }, unknownResult: true });
      const decision: ConversationExecutionCompletionDecision = {
        ...evaluated, status: next.status, reason: 'reconciliation_required', reconciliationReason: reason,
        registeredWorkIds: [...new Set([...(previous?.decision.registeredWorkIds ?? []), ...evaluated.registeredWorkIds])],
        executionOwner: 'none', canReplay: false
      };
      let prepared: ConversationCompletionIntent = { schemaVersion: 1, revision: (previous?.revision ?? -1) + 1,
        responseExecutionId, expectedRunRevision: run.revision, targetRun: next, decision, responseState: execution.state,
        taskRevisions: snapshot.taskRevisions,
        stage: 'prepared', ...(previous?.freezeOrigin ? { freezeOrigin: previous.freezeOrigin, failureStage: previous.failureStage } : {}),
        createdAt: previous?.createdAt ?? this.timestamp(run.updatedAt), updatedAt: this.timestamp(run.updatedAt) };
      try {
        await this.saveIntent(prepared, previous?.revision ?? null);
        await this.assertSnapshotEvidence(run, execution.state, snapshot.taskRevisions, prepared.revision);
        await this.options.projectTerminal({ run: next, decision, intent: prepared, responseExecution: execution });
        await this.assertSnapshotEvidence(run, execution.state, snapshot.taskRevisions, prepared.revision);
        try {
          await this.assertSnapshotEvidence(run, execution.state, snapshot.taskRevisions, prepared.revision);
          const acknowledged = await this.options.agentRuns.acknowledgeReconciliation(run.id, run.revision, next.updatedAt, reason);
          if (JSON.stringify(acknowledged) !== JSON.stringify(next)) throw new ConversationCompletionError('entity_conflict');
        } catch (error) {
          const stored = await this.options.agentRuns.get(run.id);
          if (JSON.stringify(stored) !== JSON.stringify(next)) throw error;
        }
        prepared = await this.advance(prepared, 'acknowledged');
        return { run: next, decision, intent: prepared };
      } catch (error) {
        const persisted = await this.options.journal.get(responseExecutionId).catch(() => undefined);
        if (persisted) await this.advance(persisted, 'needs_reconciliation',
          error instanceof ConversationCompletionError && error.code === 'entity_conflict'
            ? { freezeOrigin: 'unknown_result', failureStage: 'evidence' } : {}).catch(() => undefined);
        if (error instanceof ConversationCompletionError && error.code === 'entity_conflict') throw error;
        throw new ConversationCompletionError('settlement_unknown', error);
      }
    });
  }

  async waitForOperations(): Promise<void> {
    await Promise.allSettled([...this.operations.values()]);
  }

  private async reconcileAcknowledgedProjection(run: ConversationAgentRunV1, intent: ConversationCompletionIntent): Promise<ConversationCompletionSettlement> {
    if (!this.options.agentRuns.acknowledgeReconciliation) throw new ConversationCompletionError('entity_conflict');
    const execution = await this.options.responseExecutions.get(intent.responseExecutionId);
    if (!execution || execution.state !== intent.responseState) throw new ConversationCompletionError('entity_conflict');
    const target = intent.targetRun;
    if (JSON.stringify(run) !== JSON.stringify(target)) {
      if (run.revision !== intent.expectedRunRevision || run.status !== 'needs_reconciliation') throw new ConversationCompletionError('entity_conflict');
      await this.assertSnapshotEvidence(run, execution.state, intent.taskRevisions, intent.revision);
      await this.options.projectTerminal({ run: target, decision: intent.decision, intent, responseExecution: execution });
      await this.assertSnapshotEvidence(run, execution.state, intent.taskRevisions, intent.revision);
      const result = await this.options.agentRuns.acknowledgeReconciliation(run.id, run.revision, target.updatedAt, target.reconciliationReason);
      if (JSON.stringify(result) !== JSON.stringify(target)) throw new ConversationCompletionError('entity_conflict');
    }
    const acknowledged = await this.advance(intent, 'acknowledged');
    return { run: target, decision: intent.decision, intent: acknowledged };
  }

  private async settleOnce(responseExecutionId: ConversationResponseExecutionId,
    overrides: Pick<ConversationCompletionFacts, 'unknownResult' | 'toolFailed'>): Promise<ConversationCompletionSettlement | undefined> {
    const execution = await this.options.responseExecutions.get(responseExecutionId);
    const run = await this.options.agentRuns.findByResponseExecutionId(responseExecutionId);
    if (!execution || !run) return undefined;
    this.requireOwnership(run, execution);
    let previous: ConversationCompletionIntent | undefined;
    // Active execution facts are expected to change. Only terminal execution
    // boundaries enter the completion WAL and require a stable evidence snapshot.
    if (execution.state === 'pending' || execution.state === 'streaming') return undefined;
    let prepared: ConversationCompletionIntent | undefined;
    let failureStage: ConversationCompletionFailureStage = 'facts';
    try {
      previous = await this.options.journal.get(responseExecutionId);
      if (previous) this.requireIntentOwnership(previous, run);
      if (previous?.stage === 'acknowledged') return { run, decision: previous.decision, intent: previous };
      // Automatic callbacks cannot clear or relabel a known local failure. Only
      // explicit reconciliation may replay its accepted local projections.
      if (previous?.stage === 'needs_reconciliation' && previous.freezeOrigin === 'local_projection') {
        if (overrides.unknownResult === true) {
          const frozen = await this.advance(previous, 'needs_reconciliation', { freezeOrigin: 'unknown_result', failureStage: 'facts' });
          return { run, decision: frozen.decision, intent: frozen };
        }
        return { run, decision: previous.decision, intent: previous };
      }
      const facts = await this.options.collectFacts(execution, run);
      const decision = evaluateConversationExecutionCompletion({
        ...facts, ...overrides, run,
        response: { id: execution.id, projectId: execution.projectId,
          conversationId: execution.snapshot.conversationId, sourceMessageId: execution.snapshot.userMessageId,
          state: execution.state }
      });
      const next = applyConversationExecutionCompletion(run, decision, this.timestamp(run.updatedAt));
      const taskRevisions = (facts.documentTasks ?? []).map(({ runtime }) => ({ id: runtime.id, revision: runtime.revision }))
        .sort((left, right) => left.id.localeCompare(right.id));
      prepared = {
        schemaVersion: 1, revision: (previous?.revision ?? -1) + 1, responseExecutionId,
        expectedRunRevision: run.revision, targetRun: next, decision, responseState: execution.state,
        taskRevisions, stage: 'prepared', createdAt: previous?.createdAt ?? this.timestamp(run.updatedAt),
        updatedAt: this.timestamp(run.updatedAt),
        ...(previous?.freezeOrigin ? { freezeOrigin: previous.freezeOrigin, failureStage: previous.failureStage } : {})
      };
      failureStage = 'wal_prepare';
      await this.saveIntent(prepared, previous?.revision ?? null);
      failureStage = 'evidence';
      await this.assertEvidence(prepared);
      const settlement = { run: next, decision, intent: prepared };
      // Completion of the model is not completion of this local delivery. The
      // WAL makes accepted projections repeatable before closing their parent.
      failureStage = 'projection';
      await this.options.projectTerminal({ ...settlement, responseExecution: execution });
      failureStage = 'evidence';
      await this.assertEvidence(prepared);
      failureStage = 'run_commit';
      if (next !== run) await this.saveRun(next, run.revision);
      failureStage = 'wal_commit';
      prepared = await this.advance(prepared, 'run_applied');
      const frozen = previous?.stage === 'needs_reconciliation' || decision.status === 'needs_reconciliation' || overrides.unknownResult === true;
      const applied = await this.advance(prepared, frozen ? 'needs_reconciliation' : 'applied');
      return { ...settlement, intent: applied };
    } catch (error) {
      // No tool or HTTP retry is allowed after an ambiguous metadata/projection boundary.
      const latest = await this.options.agentRuns.get(run.id).catch(() => undefined);
      if (latest) await this.freeze(latest).catch(() => undefined);
      if (prepared) {
        const persisted = await this.options.journal.get(responseExecutionId).catch(() => undefined);
        if (persisted) {
          const knownLocalFailure = ['projection', 'run_commit', 'wal_commit'].includes(failureStage) &&
            ['completed', 'failed', 'cancelled'].includes(prepared.decision.status) && overrides.unknownResult !== true &&
            previous?.stage !== 'needs_reconciliation' && prepared.freezeOrigin !== 'unknown_result' && latest &&
            (latest.revision === run.revision || JSON.stringify(latest) === JSON.stringify(prepared.targetRun));
          await this.advance(persisted, 'needs_reconciliation', {
            freezeOrigin: knownLocalFailure ? 'local_projection' : 'unknown_result', failureStage
          }).catch(() => undefined);
        }
      }
      throw new ConversationCompletionError('settlement_unknown', error);
    }
  }

  private requireOwnership(run: ConversationAgentRunV1, execution: ConversationResponseExecutionV1): ConversationAgentRunV1 {
    if (run.projectId !== this.options.agentRuns.projectId || run.projectId !== execution.projectId ||
      run.projectId !== this.options.documentTasks.projectId || run.conversationId !== execution.snapshot.conversationId ||
      run.sourceMessageId !== execution.snapshot.userMessageId ||
      (run.responseExecutionId !== undefined && run.responseExecutionId !== execution.id)) {
      throw new ConversationCompletionError('entity_conflict');
    }
    return run;
  }

  private async reconcileLocalProjection(run: ConversationAgentRunV1,
    previous: ConversationCompletionIntent): Promise<ConversationCompletionSettlement> {
    let prepared = previous;
    let failureStage: ConversationCompletionFailureStage = 'evidence';
    try {
      const execution = await this.options.responseExecutions.get(previous.responseExecutionId);
      if (!execution || !['completed', 'failed', 'cancelled'].includes(previous.decision.status) ||
        execution.state !== previous.responseState || run.status !== 'needs_reconciliation' &&
        ['completed', 'failed', 'cancelled'].includes(run.status) && run.status !== previous.decision.status) {
        throw new ConversationCompletionError('entity_conflict');
      }
      this.requireOwnership(run, execution);
      await this.assertSnapshotEvidence(run, execution.state, previous.taskRevisions, previous.revision);
      const facts = await this.options.collectFacts(execution, run);
      this.requireFactVersions(facts, previous.taskRevisions);
      // Evaluate current facts independently of the immutable frozen parent. The
      // persisted parent is only changed through the dedicated confirmation CAS.
      const decision = evaluateConversationExecutionCompletion({ ...facts,
        run: { ...run, status: 'executing_tool', reconciliationReason: undefined, reconciliationAcknowledgement: undefined },
        response: { id: execution.id, projectId: execution.projectId, conversationId: execution.snapshot.conversationId,
          sourceMessageId: execution.snapshot.userMessageId, state: execution.state } });
      if (decision.status !== previous.decision.status ||
        JSON.stringify([...decision.registeredWorkIds].sort()) !== JSON.stringify([...previous.decision.registeredWorkIds].sort())) {
        throw new ConversationCompletionError('entity_conflict');
      }
      await this.assertSnapshotEvidence(run, execution.state, previous.taskRevisions, previous.revision);
      const targetStatus = decision.status as 'completed' | 'failed' | 'cancelled';
      if (run.status === 'needs_reconciliation' && !this.options.agentRuns.confirmProjectedCompletion) {
        throw new ConversationCompletionError('entity_conflict');
      }
      const next = run.status === 'needs_reconciliation'
        ? confirmConversationAgentRunProjectedCompletion(run, targetStatus, this.timestamp(run.updatedAt))
        : applyConversationExecutionCompletion(run, decision, this.timestamp(run.updatedAt));
      prepared = { ...previous, revision: previous.revision + 1, expectedRunRevision: run.revision,
        targetRun: next, decision, stage: 'prepared', updatedAt: this.timestamp(previous.updatedAt) };
      failureStage = 'wal_prepare';
      await this.saveIntent(prepared, previous.revision);
      failureStage = 'evidence';
      await this.assertSnapshotEvidence(run, execution.state, prepared.taskRevisions, prepared.revision);
      failureStage = 'projection';
      await this.options.projectTerminal({ run: next, decision, intent: prepared, responseExecution: execution });
      failureStage = 'evidence';
      await this.assertSnapshotEvidence(run, execution.state, prepared.taskRevisions, prepared.revision);
      await this.assertSnapshotEvidence(run, execution.state, prepared.taskRevisions, prepared.revision);
      failureStage = 'run_commit';
      if (run.status === 'needs_reconciliation') {
        try {
          const confirmed = await this.options.agentRuns.confirmProjectedCompletion!(run.id, run.revision, targetStatus, next.updatedAt);
          if (JSON.stringify(confirmed) !== JSON.stringify(next)) throw new ConversationCompletionError('entity_conflict');
        } catch (error) {
          const stored = await this.options.agentRuns.get(run.id);
          if (JSON.stringify(stored) !== JSON.stringify(next)) throw error;
        }
      } else if (next !== run) await this.saveRun(next, run.revision);
      failureStage = 'wal_commit';
      prepared = await this.advance(prepared, 'run_applied');
      prepared = await this.advance(prepared, 'applied');
      return { run: next, decision, intent: prepared };
    } catch (error) {
      const persisted = await this.options.journal.get(previous.responseExecutionId).catch(() => undefined);
      if (persisted) await this.advance(persisted, 'needs_reconciliation', {
        // Any changed scope/version/fact invalidates the proof for local recovery.
        freezeOrigin: failureStage === 'evidence' ? 'unknown_result' : 'local_projection',
        failureStage: failureStage === 'wal_prepare' ? 'wal_commit' : failureStage
      }).catch(() => undefined);
      throw new ConversationCompletionError('settlement_unknown', error);
    }
  }

  private requireFactVersions(facts: ConversationCompletionFacts,
    expected: ConversationCompletionIntent['taskRevisions']): void {
    const actual = (facts.documentTasks ?? []).map(({ runtime }) => ({ id: runtime.id, revision: runtime.revision }))
      .sort((left, right) => left.id.localeCompare(right.id));
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new ConversationCompletionError('entity_conflict');
  }

  private async assertSnapshotEvidence(run: ConversationAgentRunV1, responseState: ConversationResponseExecutionV1['state'],
    taskRevisions: ConversationCompletionIntent['taskRevisions'], intentRevision: number | null): Promise<void> {
    if (!run.responseExecutionId) throw new ConversationCompletionError('entity_conflict');
    await this.options.reconciliationOwnershipGuard?.(run.responseExecutionId);
    const stored = await this.options.agentRuns.get(run.id);
    const response = await this.options.responseExecutions.get(run.responseExecutionId);
    const intent = await this.options.journal.get(run.responseExecutionId);
    if (!stored || !response || stored.revision !== run.revision || response.state !== responseState ||
      (intent?.revision ?? null) !== intentRevision) throw new ConversationCompletionError('entity_conflict');
    this.requireOwnership(stored, response);
    if (intent) this.requireIntentOwnership(intent, stored);
    const tasks = (await this.options.documentTasks.list(run.conversationId)).filter(task => task.executionId === response.id);
    if (tasks.some(task => task.projectId !== run.projectId || task.sourceMessageId !== run.sourceMessageId) ||
      run.documentTaskIds !== undefined && (run.documentTaskIds.some(id => !tasks.some(task => task.id === id)) ||
        tasks.some(task => !run.documentTaskIds!.includes(task.id))) ||
      JSON.stringify(tasks.map(task => ({ id: task.id, revision: task.revision })).sort((left, right) => left.id.localeCompare(right.id))) !==
      JSON.stringify(taskRevisions)) throw new ConversationCompletionError('entity_conflict');
  }

  private requireIntentOwnership(intent: ConversationCompletionIntent, run: ConversationAgentRunV1): void {
    if (intent.targetRun.id !== run.id || intent.targetRun.projectId !== run.projectId ||
      intent.targetRun.conversationId !== run.conversationId || intent.targetRun.sourceMessageId !== run.sourceMessageId ||
      intent.targetRun.createdAt !== run.createdAt || intent.targetRun.responseExecutionId !== run.responseExecutionId) {
      throw new ConversationCompletionError('entity_conflict');
    }
  }

  private async freeze(run: ConversationAgentRunV1): Promise<void> {
    const next = markConversationAgentRunNeedsReconciliation(run, 'unknown_result', this.timestamp(run.updatedAt));
    if (next !== run) await this.saveRun(next, run.revision);
  }

  private async assertEvidence(intent: ConversationCompletionIntent): Promise<void> {
    await this.options.reconciliationOwnershipGuard?.(intent.responseExecutionId);
    // A frozen decision grants no completion or replay authority.
    if (intent.decision.status === 'needs_reconciliation') return;
    const run = await this.options.agentRuns.get(intent.targetRun.id);
    const response = await this.options.responseExecutions.get(intent.responseExecutionId);
    if (!run || !response || run.revision !== intent.expectedRunRevision || response.state !== intent.responseState) {
      throw new ConversationCompletionError('entity_conflict');
    }
    this.requireOwnership(run, response);
    const tasks = (await this.options.documentTasks.list(run.conversationId))
      .filter(task => task.executionId === response.id);
    if (run.documentTaskIds !== undefined && (run.documentTaskIds.some(id => !tasks.some(task => task.id === id)) ||
      tasks.some(task => !run.documentTaskIds!.includes(task.id))) ||
      tasks.length !== intent.taskRevisions.length || tasks.some(task => task.projectId !== run.projectId ||
      task.sourceMessageId !== run.sourceMessageId || !intent.taskRevisions.some(receipt => receipt.id === task.id && receipt.revision === task.revision))) {
      throw new ConversationCompletionError('entity_conflict');
    }
  }

  private async saveRun(run: ConversationAgentRunV1, expectedRevision: number): Promise<void> {
    if (run.responseExecutionId) await this.options.reconciliationOwnershipGuard?.(run.responseExecutionId);
    try { await this.options.agentRuns.save(run, expectedRevision); }
    catch (error) {
      // A rename can succeed before its acknowledgement fails. Read the exact primary result.
      const stored = await this.options.agentRuns.get(run.id);
      if (JSON.stringify(stored) !== JSON.stringify(run)) throw error;
    }
  }

  private async saveIntent(intent: ConversationCompletionIntent, expectedRevision: number | null): Promise<void> {
    await this.options.reconciliationOwnershipGuard?.(intent.responseExecutionId);
    try { await this.options.journal.save(intent, expectedRevision); }
    catch (error) {
      const stored = await this.options.journal.get(intent.responseExecutionId);
      if (JSON.stringify(stored) !== JSON.stringify(intent)) throw error;
    }
  }

  private async advance(intent: ConversationCompletionIntent,
    stage: ConversationCompletionIntent['stage'],
    failure: Pick<ConversationCompletionIntent, 'freezeOrigin' | 'failureStage'> = {}): Promise<ConversationCompletionIntent> {
    const next = { ...intent, ...failure, stage, revision: intent.revision + 1, updatedAt: this.timestamp(intent.updatedAt) };
    await this.saveIntent(next, intent.revision);
    return next;
  }

  private timestamp(minimum: IsoTimestamp): IsoTimestamp {
    return toIsoTimestamp([minimum, this.options.now?.() ?? new Date().toISOString()].sort().at(-1)!);
  }

  private exclusive<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const pending = this.operations.get(key) ?? Promise.resolve();
    const next = pending.catch(() => undefined).then(operation);
    this.operations.set(key, next);
    void next.finally(() => { if (this.operations.get(key) === next) this.operations.delete(key); }).catch(() => undefined);
    return next;
  }
}
