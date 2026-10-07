import { describe, expect, it, vi } from 'vitest';
import {
  acknowledgeConversationAgentRunReconciliation, confirmConversationAgentRunProjectedCompletion, attachConversationAgentRunExecution, createConversationAgentRun, createDocumentTaskRuntime,
  evaluateConversationExecutionCompletion, toConversationAgentRunId, toConversationId,
  toConversationResponseExecutionId, toDocumentTaskRuntimeId, toExecutionId, toIsoTimestamp, toMessageId, toProjectId, toWorkId,
  type ConversationAgentRunRepository, type ConversationAgentRunV1, type ConversationResponseExecutionRepository,
  type ConversationResponseExecutionV1, type DocumentTaskRuntime, type DocumentTaskRuntimeRepository
} from '../../src/domain';
import {
  ConversationCompletionCoordinator, type ConversationCompletionFacts, type ConversationCompletionIntent,
  type ConversationCompletionJournal, type ConversationCompletionSettlement
} from '../../src/application/conversation-completion-coordinator';

const t0 = toIsoTimestamp('2026-10-03T12:00:00.000Z');
const t1 = toIsoTimestamp('2026-10-03T12:01:00.000Z');
const projectId = toProjectId('completion-project');
const conversationId = toConversationId('completion-conversation');
const responseExecutionId = toConversationResponseExecutionId('completion-response');
const sourceMessageId = toMessageId('completion-user');

function fixture(input: { bound?: boolean; tasks?: readonly DocumentTaskRuntime[]; facts?: ConversationCompletionFacts } = {}) {
  let run = createConversationAgentRun({ id: toConversationAgentRunId('completion-run'), projectId,
    conversationId, sourceMessageId, createdAt: t0 });
  if (input.bound !== false) run = attachConversationAgentRunExecution(run, responseExecutionId, t0);
  let response = { id: responseExecutionId, projectId, state: 'completed',
    snapshot: { conversationId, userMessageId: sourceMessageId } } as ConversationResponseExecutionV1;
  let journal: ConversationCompletionIntent | undefined;
  let facts = input.facts ?? {};
  let tasks = input.tasks ?? [];
  const agentRuns = {
    projectId,
    get: vi.fn(async () => run), list: vi.fn(async () => [run]),
    findByResponseExecutionId: vi.fn(async () => run.responseExecutionId === responseExecutionId ? run : undefined),
    save: vi.fn(async (next: ConversationAgentRunV1, expectedRevision: number) => {
      if (run.revision !== expectedRevision) throw new Error('revision_conflict');
      run = next;
    }),
    acknowledgeReconciliation: vi.fn(async (_id: string, expectedRevision: number, at: typeof t1,
      reason?: ConversationAgentRunV1['reconciliationReason']) => {
      if (run.revision !== expectedRevision) throw new Error('revision_conflict');
      run = acknowledgeConversationAgentRunReconciliation(run, at, reason);
      return run;
    }),
    confirmProjectedCompletion: vi.fn(async (_id: string, expectedRevision: number, status: 'completed' | 'failed' | 'cancelled', at: typeof t1) => {
      if (run.revision !== expectedRevision) throw new Error('revision_conflict');
      run = confirmConversationAgentRunProjectedCompletion(run, status, at);
      return run;
    })
  } as unknown as ConversationAgentRunRepository;
  const executions = { projectId, get: vi.fn(async () => response) } as unknown as ConversationResponseExecutionRepository;
  const documentTasks = { projectId, list: vi.fn(async () => tasks) } as unknown as DocumentTaskRuntimeRepository;
  const intents: ConversationCompletionJournal = {
    get: vi.fn(async () => journal), listPending: vi.fn(async () => journal && !['applied', 'acknowledged'].includes(journal.stage) ? [journal] : []),
    save: vi.fn(async (next, expectedRevision) => {
      if ((journal?.revision ?? null) !== expectedRevision) throw new Error('revision_conflict');
      journal = next;
    })
  };
  const projectTerminal = vi.fn(async (_settlement: ConversationCompletionSettlement) => undefined);
  const collectFacts = vi.fn(async () => facts);
  const options = { agentRuns, responseExecutions: executions, documentTasks, journal: intents,
    collectFacts, projectTerminal, now: () => t1 };
  const coordinator = new ConversationCompletionCoordinator(options);
  return { coordinator, options, agentRuns, intents, projectTerminal, collectFacts,
    run: () => run, intent: () => journal, setRun: (next: ConversationAgentRunV1) => { run = next; },
    setFacts: (next: ConversationCompletionFacts) => { facts = next; },
    setTasks: (next: readonly DocumentTaskRuntime[]) => { tasks = next; },
    setResponse: (next: Partial<ConversationResponseExecutionV1>) => { response = { ...response, ...next }; },
    setIntent: (next: ConversationCompletionIntent) => { journal = next; }
  };
}

function task() {
  return createDocumentTaskRuntime({ id: toDocumentTaskRuntimeId('completion-task'), projectId,
    conversationId, sourceMessageId, executionId: responseExecutionId, documentKind: 'ppt',
    budget: { maxSteps: 24, budgetUnits: 24, timeoutMs: 360_000 }, createdAt: t0 });
}

describe('ConversationCompletionCoordinator', () => {
  it.each(['reconcile', 'acknowledge', 'settle'] as const)('rejects %s owned by another live root before preparing any child WAL', async command => {
    const f = fixture();
    if (command === 'reconcile') {
      f.projectTerminal.mockRejectedValueOnce(new Error('local_projection_failure'));
      await expect(f.coordinator.settle(responseExecutionId)).rejects.toThrow();
    } else if (command === 'acknowledge') await f.coordinator.settle(responseExecutionId, { unknownResult: true });
    const run = f.run(), intent = f.intent();
    vi.mocked(f.intents.save).mockClear(); vi.mocked(f.agentRuns.save).mockClear(); f.projectTerminal.mockClear();
    const guard = vi.fn(async () => { throw new Error('foreign_live_root'); });
    const other = new ConversationCompletionCoordinator({ ...f.options, reconciliationOwnershipGuard: guard });
    await expect(command === 'reconcile' ? other.reconcile(responseExecutionId) : command === 'acknowledge'
      ? other.acknowledge(responseExecutionId, run.revision) : other.settle(responseExecutionId)).rejects.toThrow('foreign_live_root');
    expect(f.run()).toEqual(run); expect(f.intent()).toEqual(intent);
    expect(f.intents.save).not.toHaveBeenCalled(); expect(f.agentRuns.save).not.toHaveBeenCalled(); expect(f.projectTerminal).not.toHaveBeenCalled();
  });

  it('rechecks the root owner after a local projection and leaves its prepared WAL untouched on ownership loss', async () => {
    const f = fixture(); let owned = true;
    const guarded = new ConversationCompletionCoordinator({ ...f.options,
      reconciliationOwnershipGuard: async () => { if (!owned) throw new Error('root_owner_changed'); } });
    f.projectTerminal.mockImplementation(async () => { owned = false; });
    await expect(guarded.settle(responseExecutionId)).rejects.toMatchObject({ code: 'settlement_unknown' });
    expect(f.intent()?.stage).toBe('prepared'); expect(f.intents.save).toHaveBeenCalledTimes(1);
    expect(f.agentRuns.save).not.toHaveBeenCalled(); expect(f.run().status).toBe('executing_tool');
  });
  it('binds the host source message before a response can finish and preserves ownership on repeated binding', async () => {
    const f = fixture({ bound: false });
    const bound = await f.coordinator.bindExecution(responseExecutionId);
    expect(bound?.responseExecutionId).toBe(responseExecutionId);
    expect(bound?.status).toBe('executing_tool');
    await f.coordinator.bindExecution(responseExecutionId);
    expect(f.agentRuns.save).toHaveBeenCalledTimes(1);
  });

  it('binds child identity before execution and freezes when a bound child disappears', async () => {
    const runtime = task();
    const f = fixture({ tasks: [runtime], facts: { documentTasks: [{ runtime, active: false }] } });
    await f.coordinator.bindTasks(responseExecutionId);
    expect(f.run().documentTaskIds).toEqual([runtime.id]);
    f.setFacts({ documentTasks: [] });
    const settled = await f.coordinator.settle(responseExecutionId);
    expect(settled?.run.status).toBe('needs_reconciliation');
    expect(settled?.decision.reconciliationReason).toBe('entity_conflict');
  });

  it('binds the child response without selecting its same-message planning container', async () => {
    const f = fixture({ bound: false });
    const parent = f.run();
    const child = createConversationAgentRun({ id: toConversationAgentRunId('completion-child'), projectId,
      conversationId, sourceMessageId, parentRunId: parent.id, createdAt: t0 });
    f.setRun(child);
    vi.mocked(f.agentRuns.list).mockImplementation(async () => [parent, f.run()]);
    const bound = await f.coordinator.bindExecution(responseExecutionId);
    expect(bound?.id).toBe(child.id);
    expect(bound?.parentRunId).toBe(parent.id);
    expect(bound?.responseExecutionId).toBe(responseExecutionId);
  });

  it('does not make an unused document capability a completion requirement', async () => {
    const runtime = task();
    const f = fixture({ tasks: [runtime], facts: { documentTasks: [{ runtime, active: false }] } });
    await f.coordinator.bindTasks(responseExecutionId);
    const settled = await f.coordinator.settle(responseExecutionId);
    expect(settled?.run.status).toBe('completed');
    expect(f.intent()?.stage).toBe('applied');
    expect(await f.coordinator.canStartNewResponse(conversationId)).toBe(true);
  });

  it('keeps the parent active until local terminal projections have been durably accepted', async () => {
    const f = fixture();
    f.projectTerminal.mockImplementation(async () => {
      expect(f.run().status).toBe('executing_tool');
      expect(f.intent()?.stage).toBe('prepared');
    });
    await f.coordinator.settle(responseExecutionId);
    expect(f.run().status).toBe('completed');
  });

  it('preserves an unrecovered real tool failure despite a normal model completion', async () => {
    const f = fixture({ facts: { toolFailed: true } });
    const settled = await f.coordinator.settle(responseExecutionId);
    expect(settled?.run.status).toBe('failed');
    expect(settled?.decision.reason).toBe('tool_failed');
  });

  it('freezes an unknown external outcome even without a document task and never replays on late completion', async () => {
    const f = fixture();
    const first = await f.coordinator.settle(responseExecutionId, { unknownResult: true });
    expect(first?.run.status).toBe('needs_reconciliation');
    expect(first?.decision.canReplay).toBe(false);
    f.setFacts({});
    await f.coordinator.settle(responseExecutionId);
    expect(f.run().status).toBe('needs_reconciliation');
    expect(await f.coordinator.canStartNewResponse(conversationId)).toBe(false);
  });

  it('keeps local projection failure frozen on automatic reopening and explicitly settles only its local projections', async () => {
    const f = fixture();
    f.projectTerminal.mockRejectedValueOnce(new Error('local_projection_write_failed'));
    await expect(f.coordinator.settle(responseExecutionId)).rejects.toMatchObject({ code: 'settlement_unknown' });
    expect(f.run().status).toBe('needs_reconciliation');
    expect(f.intent()?.stage).toBe('needs_reconciliation');
    expect(f.intent()?.freezeOrigin).toBe('local_projection');
    expect(await f.coordinator.canStartNewResponse(conversationId)).toBe(false);
    const reopened = new ConversationCompletionCoordinator(f.options);
    expect(await reopened.reconcilePending()).toBe(0);
    await reopened.reconcile(responseExecutionId);
    expect(f.projectTerminal).toHaveBeenCalledTimes(2);
    expect(f.run()).toMatchObject({ status: 'completed', reconciliationReason: 'unknown_result',
      reconciliationAcknowledgement: { kind: 'closed_without_replay' } });
    expect(f.intent()?.stage).toBe('applied');
    expect(await reopened.canStartNewResponse(conversationId)).toBe(true);
  });

  it('never treats a true or legacy unknown freeze as a retryable local projection', async () => {
    const f = fixture();
    await f.coordinator.settle(responseExecutionId, { unknownResult: true });
    const projected = f.projectTerminal.mock.calls.length;
    await f.coordinator.reconcile(responseExecutionId);
    expect(f.projectTerminal).toHaveBeenCalledTimes(projected);
    expect(f.run().status).toBe('needs_reconciliation');
    f.setIntent({ ...f.intent()!, freezeOrigin: undefined, failureStage: undefined });
    await new ConversationCompletionCoordinator(f.options).reconcile(responseExecutionId);
    expect(f.projectTerminal).toHaveBeenCalledTimes(projected);
    expect(f.run().status).toBe('needs_reconciliation');
  });

  it('permanently removes local recovery authority when a later callback reports a true unknown result', async () => {
    const f = fixture();
    f.projectTerminal.mockRejectedValueOnce(new Error('projection unavailable'));
    await expect(f.coordinator.settle(responseExecutionId)).rejects.toMatchObject({ code: 'settlement_unknown' });
    expect(f.intent()?.freezeOrigin).toBe('local_projection');
    await f.coordinator.settle(responseExecutionId, { unknownResult: true });
    expect(f.intent()).toMatchObject({ freezeOrigin: 'unknown_result', failureStage: 'facts' });
    await f.coordinator.reconcile(responseExecutionId);
    expect(f.projectTerminal).toHaveBeenCalledTimes(1);
    expect(f.run().status).toBe('needs_reconciliation');
  });

  it('repairs the persisted explicit acknowledgement locally after its child projection failed', async () => {
    const f = fixture(); f.setResponse({ state: 'interrupted' });
    await f.coordinator.settle(responseExecutionId, { unknownResult: true });
    f.projectTerminal.mockRejectedValueOnce(new Error('ack_projection_unavailable'));
    await expect(f.coordinator.acknowledge(responseExecutionId, f.run().revision)).rejects.toMatchObject({ code: 'settlement_unknown' });
    expect(f.run().status).toBe('needs_reconciliation');
    expect(f.intent()?.targetRun.reconciliationAcknowledgement?.kind).toBe('closed_without_replay');
    expect(await new ConversationCompletionCoordinator(f.options).reconcilePending()).toBe(1);
    expect(f.run().status).toBe('cancelled'); expect(f.intent()?.stage).toBe('acknowledged');
    expect(f.intent()?.decision.canReplay).toBe(false);
    expect(await f.coordinator.canStartNewResponse(conversationId)).toBe(true);
  });

  it('invalidates local reconciliation proof when child facts change while collecting evidence', async () => {
    const runtime = task();
    const f = fixture({ tasks: [runtime], facts: { documentTasks: [{ runtime, active: false }] } });
    await f.coordinator.bindTasks(responseExecutionId);
    f.projectTerminal.mockRejectedValueOnce(new Error('projection unavailable'));
    await expect(f.coordinator.settle(responseExecutionId)).rejects.toMatchObject({ code: 'settlement_unknown' });
    f.collectFacts.mockImplementationOnce(async () => {
      const changed = { ...runtime, revision: runtime.revision + 1 };
      f.setTasks([changed]);
      return { documentTasks: [{ runtime: changed, active: false }] };
    });
    await expect(f.coordinator.reconcile(responseExecutionId)).rejects.toMatchObject({ code: 'settlement_unknown' });
    expect(f.intent()).toMatchObject({ stage: 'needs_reconciliation', freezeOrigin: 'unknown_result', failureStage: 'evidence' });
    expect(f.projectTerminal).toHaveBeenCalledTimes(1);
    expect(f.run().status).toBe('needs_reconciliation');
  });

  it('reconciles a prepare-only crash without resubmitting a provider or tool', async () => {
    const f = fixture();
    const decision = evaluateConversationExecutionCompletion({ run: f.run(), response: {
      id: responseExecutionId, projectId, conversationId, sourceMessageId, state: 'completed' } });
    f.setIntent({ schemaVersion: 1, revision: 0, responseExecutionId, expectedRunRevision: f.run().revision,
      targetRun: { ...f.run(), status: 'completed', revision: f.run().revision + 1, updatedAt: t1 },
      decision, responseState: 'completed', taskRevisions: [], stage: 'prepared', createdAt: t1, updatedAt: t1 });
    const reopened = new ConversationCompletionCoordinator(f.options);
    await reopened.reconcilePending();
    expect(f.run().status).toBe('completed');
    expect(f.projectTerminal).toHaveBeenCalledTimes(1);
    expect(f.intent()?.stage).toBe('applied');
  });

  it('also repairs local projections when response and parent were already terminal', async () => {
    const f = fixture();
    await f.coordinator.settle(responseExecutionId);
    await f.coordinator.settle(responseExecutionId);
    expect(f.agentRuns.save).toHaveBeenCalledTimes(1);
    expect(f.projectTerminal).toHaveBeenCalledTimes(2);
  });

  it('does not replay a pending projection owned by another live root', async () => {
    const f = fixture();
    const decision = evaluateConversationExecutionCompletion({ run: f.run(), response: {
      id: responseExecutionId, projectId, conversationId, sourceMessageId, state: 'completed' } });
    const intent: ConversationCompletionIntent = { schemaVersion: 1, revision: 0, responseExecutionId,
      expectedRunRevision: f.run().revision, targetRun: { ...f.run(), status: 'completed', revision: f.run().revision + 1, updatedAt: t1 },
      decision, responseState: 'completed', taskRevisions: [], stage: 'prepared', createdAt: t1, updatedAt: t1 };
    f.setIntent(intent);
    const canRecover = vi.fn(async () => false);
    expect(await f.coordinator.reconcilePending(canRecover)).toBe(0);
    expect(canRecover).toHaveBeenCalledWith(responseExecutionId);
    expect(f.intent()).toEqual(intent);
    expect(f.run().status).toBe('executing_tool');
    expect(f.projectTerminal).not.toHaveBeenCalled();
  });

  it('proves an acknowledged-late Run save from its exact primary record instead of applying it twice', async () => {
    const f = fixture();
    vi.mocked(f.agentRuns.save).mockImplementationOnce(async next => { f.setRun(next); throw new Error('rename_ack_lost'); });
    await f.coordinator.settle(responseExecutionId);
    expect(f.run().status).toBe('completed');
    expect(f.agentRuns.save).toHaveBeenCalledTimes(1);
    expect(f.intent()?.stage).toBe('applied');
  });

  it('proves an acknowledged-late WAL save from its exact primary record', async () => {
    const f = fixture();
    vi.mocked(f.intents.save).mockImplementationOnce(async next => { f.setIntent(next); throw new Error('rename_ack_lost'); });
    await f.coordinator.settle(responseExecutionId);
    expect(f.run().status).toBe('completed');
    expect(f.projectTerminal).toHaveBeenCalledTimes(1);
  });

  it('keeps a pending WAL as a replay barrier when the final journal write is unknown after parent CAS', async () => {
    const f = fixture();
    vi.mocked(f.intents.save).mockImplementation(async (next, expected) => {
      if (next.stage === 'applied') throw new Error('disk_not_acknowledged');
      if ((f.intent()?.revision ?? null) !== expected) throw new Error('revision_conflict');
      f.setIntent(next);
    });
    await expect(f.coordinator.settle(responseExecutionId)).rejects.toMatchObject({ code: 'settlement_unknown' });
    expect(f.run().status).toBe('completed');
    expect(f.intent()?.stage).toBe('needs_reconciliation');
    expect(await f.coordinator.canStartNewResponse(conversationId)).toBe(false);
    vi.mocked(f.intents.save).mockImplementation(async next => { f.setIntent(next); });
    await f.coordinator.settle(responseExecutionId);
    expect(f.intent()?.stage).toBe('needs_reconciliation');
    expect(await f.coordinator.canStartNewResponse(conversationId)).toBe(false);
  });

  it('never overwrites a concurrent terminal cancellation and keeps the journal blocked', async () => {
    const f = fixture();
    f.projectTerminal.mockImplementationOnce(async () => {
      f.setRun({ ...f.run(), revision: f.run().revision + 1, status: 'cancelled', updatedAt: t1 });
    });
    await expect(f.coordinator.settle(responseExecutionId)).rejects.toMatchObject({ code: 'settlement_unknown' });
    expect(f.run().status).toBe('cancelled');
    expect(f.intent()?.stage).toBe('needs_reconciliation');
    expect(await f.coordinator.canStartNewResponse(conversationId)).toBe(false);
  });

  it('serializes overlapping settlement callbacks and drains their true completion', async () => {
    const f = fixture();
    const first = f.coordinator.settle(responseExecutionId);
    const second = f.coordinator.settle(responseExecutionId);
    await f.coordinator.waitForOperations();
    await Promise.all([first, second]);
    expect(f.run().status).toBe('completed');
    expect(f.agentRuns.save).toHaveBeenCalledTimes(1);
  });

  it('rejects changed child evidence after the local projection rather than completing from a stale read', async () => {
    const runtime = task();
    const f = fixture({ tasks: [runtime], facts: { documentTasks: [{ runtime, active: false }] } });
    await f.coordinator.bindTasks(responseExecutionId);
    f.projectTerminal.mockImplementationOnce(async () => {
      f.setTasks([{ ...runtime, revision: runtime.revision + 1, status: 'needs_reconciliation' }]);
    });
    await expect(f.coordinator.settle(responseExecutionId)).rejects.toMatchObject({ code: 'settlement_unknown' });
    expect(f.run().status).toBe('needs_reconciliation');
    expect(f.intent()?.stage).toBe('needs_reconciliation');
  });

  it('checks the response owner before exposing journal state', async () => {
    const f = fixture();
    f.setResponse({ projectId: toProjectId('other-project') });
    await expect(f.coordinator.inspect(responseExecutionId)).rejects.toMatchObject({ code: 'entity_conflict' });
    expect(f.intents.get).not.toHaveBeenCalled();
  });

  it('refuses fresh sends when journal provenance cannot be established', async () => {
    const f = fixture();
    vi.mocked(f.intents.listPending).mockRejectedValue(new Error('backup_requires_reconciliation'));
    expect(await f.coordinator.canStartNewResponse(conversationId)).toBe(false);
  });

  it('explicitly closes a frozen run without replay and permanently retains its unknown reason', async () => {
    const f = fixture();
    await f.coordinator.settle(responseExecutionId, { unknownResult: true });
    const revision = f.run().revision;
    const journalRevision = f.intent()!.revision;
    const closed = await f.coordinator.acknowledge(responseExecutionId, revision, journalRevision);
    expect(closed?.run.status).toBe('cancelled');
    expect(closed?.run.reconciliationReason).toBe('unknown_result');
    expect(closed?.run.reconciliationAcknowledgement?.kind).toBe('closed_without_replay');
    expect(closed?.decision.canReplay).toBe(false);
    expect(f.intent()?.stage).toBe('acknowledged');
    expect(await f.coordinator.canStartNewResponse(conversationId)).toBe(true);
    const after = f.run();
    await f.coordinator.settle(responseExecutionId);
    expect(f.run()).toEqual(after);
    expect(f.intent()?.stage).toBe('acknowledged');
  });

  it('requires the inspected Run and WAL revisions before acknowledging', async () => {
    const f = fixture();
    await f.coordinator.settle(responseExecutionId, { unknownResult: true });
    await expect(f.coordinator.acknowledge(responseExecutionId, f.run().revision - 1, f.intent()!.revision))
      .rejects.toMatchObject({ code: 'entity_conflict' });
    await expect(f.coordinator.acknowledge(responseExecutionId, f.run().revision, f.intent()!.revision - 1))
      .rejects.toMatchObject({ code: 'entity_conflict' });
    expect(f.run().status).toBe('needs_reconciliation');
    expect(f.intent()?.stage).toBe('needs_reconciliation');
  });

  it.each(['collect', 'projection'] as const)('rejects acknowledgement when child evidence changes during %s', async phase => {
    const runtime = task();
    const f = fixture({ tasks: [runtime], facts: { documentTasks: [{ runtime, active: false }] } });
    await f.coordinator.bindTasks(responseExecutionId);
    await f.coordinator.settle(responseExecutionId, { unknownResult: true });
    const pin = (await f.coordinator.inspect(responseExecutionId))!;
    const changed = { ...runtime, revision: runtime.revision + 1 };
    if (phase === 'collect') f.collectFacts.mockImplementationOnce(async () => {
      f.setTasks([changed]);
      return { documentTasks: [{ runtime: changed, active: false }] };
    });
    else f.projectTerminal.mockImplementationOnce(async () => { f.setTasks([changed]); });
    await expect(f.coordinator.acknowledge(responseExecutionId, pin.run.revision, pin.intent!.revision, pin.taskRevisions))
      .rejects.toMatchObject({ code: 'entity_conflict' });
    expect(f.agentRuns.acknowledgeReconciliation).not.toHaveBeenCalled();
    expect(f.run().status).toBe('needs_reconciliation');
    expect(await f.coordinator.canStartNewResponse(conversationId)).toBe(false);
  });

  it('preserves a registered Work and unknown child task when the user closes reconciliation', async () => {
    const workId = toWorkId('completion-retained-work');
    const runtime = { ...task(), status: 'needs_reconciliation', workRef: { kind: 'registered', ref: workId } } as DocumentTaskRuntime;
    const f = fixture({ tasks: [runtime], facts: { documentTasks: [{ runtime,
      registeredWork: { id: workId, projectId, sourceExecutionId: toExecutionId(runtime.id), sourceTaskRuntimeId: runtime.id },
      readBackConfirmed: true, deliveryConfirmed: true }] } });
    await f.coordinator.bindTasks(responseExecutionId);
    await f.coordinator.settle(responseExecutionId);
    const closed = await f.coordinator.acknowledge(responseExecutionId, f.run().revision, f.intent()!.revision);
    expect(closed?.decision.registeredWorkIds).toEqual([workId]);
    expect(closed?.run.status).toBe('cancelled');
    expect(closed?.run.documentTaskIds).toEqual([runtime.id]);
    expect(runtime.status).toBe('needs_reconciliation');
  });

  it('only adds the no-replay acknowledgement when the historical parent was already completed', async () => {
    const f = fixture();
    await f.coordinator.settle(responseExecutionId);
    f.setIntent({ ...f.intent()!, stage: 'needs_reconciliation' });
    const closed = await f.coordinator.acknowledge(responseExecutionId, f.run().revision, f.intent()!.revision);
    expect(closed?.run.status).toBe('completed');
    expect(closed?.run.reconciliationReason).toBe('unknown_result');
    expect(closed?.run.reconciliationAcknowledgement?.kind).toBe('closed_without_replay');
    expect(f.intent()?.stage).toBe('acknowledged');
  });
});
