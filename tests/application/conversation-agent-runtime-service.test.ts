import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  attachConversationAgentRunExecution, createConversationAgentRun,
  toConversationAgentRunId, toConversationId, toConversationResponseExecutionId, toIsoTimestamp, toMessageId, toProjectId,
  type ConversationAgentRuntimeRepository
} from '../../src/domain';
import { ConversationAgentRuntimeService, type ConversationAgentRuntimeServiceOptions } from '../../src/application/conversation-agent-runtime-service';
import { JsonConversationAgentRuntimeRepository } from '../../src/platform/repositories/json-conversation-agent-runtime-repository';
import { NodeProjectStorage } from '../../src/platform/storage';
import type { ProviderExecutionLifecyclePort } from '../../src/platform/providers/provider-tool-calling';
import type { CanonicalProductionTraceEvents } from '../../src/platform/conversation-production-trace';

const roots: string[] = [], t0 = toIsoTimestamp('2026-10-03T12:00:00.000Z');
const runId = toConversationAgentRunId('service-run'), responseId = toConversationResponseExecutionId('service-response');
const requestHash = 'a'.repeat(64), resultHash = 'b'.repeat(64), argumentsHash = 'c'.repeat(64), observationHash = 'd'.repeat(64);
afterEach(async () => {
  await Promise.all(roots.splice(0).map(async root => {
    if (path.dirname(path.resolve(root)).toLowerCase() !== path.resolve(os.tmpdir()).toLowerCase() || !path.basename(root).startsWith('unicomp-parent-service-')) throw new Error('Unsafe test cleanup');
    await rm(root, { recursive: true, force: true });
  }));
});
async function setup(override?: (repository: ConversationAgentRuntimeRepository) => ConversationAgentRuntimeRepository, policyPatch: Partial<{ deadlineAt: number; maxToolCalls: number; budgetUnits: number }> = {}, executionOwnershipGuard?: ConversationAgentRuntimeServiceOptions['executionOwnershipGuard']) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-parent-service-')); roots.push(root);
  let at = toIsoTimestamp('2026-10-03T12:00:01.000Z'), event = 0;
  const repository = new JsonConversationAgentRuntimeRepository(new NodeProjectStorage(root), toProjectId('service-project'), () => at);
  const service = new ConversationAgentRuntimeService({ repository: override?.(repository) ?? repository, now: () => at, nextEventId: () => `service-event-${++event}`, hash: value => createHash('sha256').update(value).digest('hex'), executionOwnershipGuard });
  const run = attachConversationAgentRunExecution(createConversationAgentRun({ id: runId, projectId: repository.projectId, conversationId: toConversationId('service-conversation'), sourceMessageId: toMessageId('service-source'), createdAt: t0 }), responseId, at);
  const policy = { startedAt: Date.parse(t0), deadlineAt: Date.parse(t0) + 360000, maxToolCalls: 8, budgetUnits: 24, ...policyPatch };
  await service.open(run, policy);
  const lifecycle: ProviderExecutionLifecyclePort = service.providerLifecycle(runId);
  const canonical: CanonicalProductionTraceEvents = service.canonicalEvents(runId);
  return { root, service, lifecycle, canonical, repository, policy, run, setTime(value: string) { at = toIsoTimestamp(value); } };
}
async function firstModel(lifecycle: ProviderExecutionLifecyclePort, toolCallCount = 1) {
  await lifecycle.modelPrepared({ round: 0, requestHash, messageCount: 2, toolCount: 1 });
  await lifecycle.modelStarted({ round: 0 });
  await lifecycle.modelResult({ round: 0, resultHash, contentLength: 15, finishReason: toolCallCount ? 'tool_calls' : 'stop', toolCallCount });
}
const tool = { round: 0, stepRef: 'provider-tool-0-0', toolId: 'generate_pptx', argumentsHash };

describe('ConversationAgentRuntimeService write-ahead boundaries', () => {
  it('checks the current Host lease before every new model and tool admission', async () => {
    const boundaries: string[] = []; let valid = true;
    const { service, lifecycle } = await setup(undefined, {}, async (owner, boundary) => { expect(owner).toBe(runId); boundaries.push(boundary); if (!valid) throw new Error('lease_lost'); });
    await firstModel(lifecycle); await lifecycle.toolStarted(tool);
    valid = false;
    await expect(lifecycle.toolAdmitted!({ round: 0, stepRef: tool.stepRef })).rejects.toThrow('lease_lost');
    expect(boundaries).toEqual(['model_prepared', 'model_started', 'model_started', 'tool_prepared', 'tool_admitted']);
    expect((await service.find(runId))?.runtime.budget).toMatchObject({ toolCallsUsed: 0, costUnitsUsed: 0 });
  });
  it('retains an independently known late model receipt after lease admission is fenced', async () => {
    let valid = true;
    const { service, lifecycle } = await setup(undefined, {}, async () => { if (!valid) throw new Error('lease_lost'); });
    await lifecycle.modelPrepared({ round: 0, requestHash, messageCount: 2, toolCount: 0 }); await lifecycle.modelStarted({ round: 0 });
    valid = false;
    await lifecycle.modelResult({ round: 0, resultHash, contentLength: 3, finishReason: 'stop', toolCallCount: 0 });
    await expect(lifecycle.modelPrepared({ round: 1, requestHash, messageCount: 3, toolCount: 0 })).rejects.toThrow('lease_lost');
    expect((await service.find(runId))?.runtime.modelCalls[0]).toMatchObject({ status: 'completed', resultHash });
  });
  it('uses one parent across initial model, tool result, Observation and continuation', async () => {
    const { service, lifecycle } = await setup();
    await firstModel(lifecycle); await lifecycle.toolStarted(tool); await lifecycle.toolAdmitted!({ round: 0, stepRef: tool.stepRef });
    await lifecycle.toolResult({ round: 0, stepRef: tool.stepRef, resultHash, status: 'success', outcomeUnknown: false, registeredWorkIds: ['work-ppt'] });
    await expect(lifecycle.modelPrepared({ round: 1, requestHash, messageCount: 4, toolCount: 1 })).rejects.toThrow('observation_missing');
    await lifecycle.observationCommitted({ round: 0, stepRef: tool.stepRef, observationHash });
    await lifecycle.modelPrepared({ round: 1, requestHash, messageCount: 4, toolCount: 1 }); await lifecycle.modelStarted({ round: 1 });
    await lifecycle.modelResult({ round: 1, resultHash, contentLength: 20, finishReason: 'stop', toolCallCount: 0 });
    await service.finish(responseId); const settled = await service.settle(responseId);
    expect(settled?.runtime).toMatchObject({ status: 'settled', budget: { toolCallsUsed: 1, costUnitsUsed: 8 }, registeredWorkIds: ['work-ppt'] });
    const kinds = settled!.events.map(event => event.kind);
    expect(kinds.indexOf('model_call_prepared')).toBeLessThan(kinds.indexOf('model_call_submitting'));
    expect(kinds.indexOf('tool_call_prepared')).toBeLessThan(kinds.indexOf('tool_call_admitted'));
    expect(kinds).not.toContain('tool_call_started');
    expect(kinds.indexOf('checkpoint_committed')).toBeLessThan(kinds.indexOf('tool_call_observed'));
    expect(settled?.outbox).toEqual([]);
  });
  it('rejects duplicate model sends and duplicate tools without increasing the charged budget', async () => {
    const { service, lifecycle } = await setup();
    const request = { round: 0, requestHash, messageCount: 2, toolCount: 1 };
    await lifecycle.modelPrepared(request); await lifecycle.modelPrepared(request); await lifecycle.modelStarted({ round: 0 });
    await expect(lifecycle.modelStarted({ round: 0 })).rejects.toThrow('admission_replay_forbidden');
    await lifecycle.modelResult({ round: 0, resultHash, contentLength: 0, finishReason: 'tool_calls', toolCallCount: 1 });
    await lifecycle.toolStarted(tool); await lifecycle.toolAdmitted!({ round: 0, stepRef: tool.stepRef });
    await expect(lifecycle.toolStarted(tool)).rejects.toThrow('admission_replay_forbidden');
    await expect(lifecycle.toolAdmitted!({ round: 0, stepRef: tool.stepRef })).rejects.toThrow('admission_replay_forbidden');
    expect((await service.find(runId))?.runtime.budget).toMatchObject({ toolCallsUsed: 1, costUnitsUsed: 8 });
  });
  it('commits exactly one preparation and one atomic started/admitted execution receipt before acting', async () => {
    const { service, lifecycle } = await setup(); await firstModel(lifecycle);
    const before = (await service.find(runId))!;
    await lifecycle.toolStarted(tool);
    const proposed = (await service.find(runId))!;
    expect(proposed.runtime.revision).toBe(before.runtime.revision + 1);
    expect(proposed.runtime.toolCalls).toMatchObject([{ status: 'prepared', admissionPhase: 'pending' }]);
    expect(proposed.runtime.budget).toMatchObject({ toolAttemptsUsed: 1, toolCallsUsed: 0, costUnitsUsed: 0 });
    await lifecycle.toolAdmitted!({ round: 0, stepRef: tool.stepRef });
    const admitted = (await service.find(runId))!;
    expect(admitted.runtime.revision).toBe(proposed.runtime.revision + 1);
    expect(admitted.runtime.toolCalls).toMatchObject([{ status: 'started', admissionPhase: 'admitted' }]);
    expect(admitted.runtime.budget).toMatchObject({ toolAttemptsUsed: 1, toolCallsUsed: 1, costUnitsUsed: 8 });
    expect(admitted.events.slice(before.events.length).map(event => event.kind)).toEqual(['tool_call_prepared', 'tool_call_admitted']);
  });
  it('rejects changed preparation facts under the same model key', async () => {
    const { lifecycle } = await setup();
    await lifecycle.modelPrepared({ round: 0, requestHash, messageCount: 2, toolCount: 1 });
    await expect(lifecycle.modelPrepared({ round: 0, requestHash: resultHash, messageCount: 2, toolCount: 1 })).rejects.toThrow('event_conflict');
  });
  it('does not refund known failed tools or admit excess trusted contract units', async () => {
    const { service, lifecycle } = await setup(undefined, { budgetUnits: 8 });
    await firstModel(lifecycle); await lifecycle.toolStarted(tool); await lifecycle.toolAdmitted!({ round: 0, stepRef: tool.stepRef });
    await lifecycle.toolResult({ round: 0, stepRef: tool.stepRef, resultHash, status: 'failed', outcomeUnknown: false });
    await lifecycle.observationCommitted({ round: 0, stepRef: tool.stepRef, observationHash });
    await lifecycle.toolStarted({ ...tool, stepRef: 'provider-tool-0-1' });
    await expect(lifecycle.toolAdmitted!({ round: 0, stepRef: 'provider-tool-0-1' })).rejects.toThrow('budget_exceeded');
    expect((await service.find(runId))?.runtime).toMatchObject({ status: 'stopped', stopReason: 'budget_exceeded', budget: { toolCallsUsed: 1, costUnitsUsed: 8 } });
  });
  it('records known preflight refusals without charging execution units while proposals remain bounded', async () => {
    const { service, lifecycle } = await setup(undefined, { maxToolCalls: 2, budgetUnits: 8 });
    await firstModel(lifecycle, 2);
    for (const ordinal of [0, 1]) {
      const stepRef = `provider-tool-0-${ordinal}`;
      await lifecycle.toolStarted({ ...tool, stepRef });
      await lifecycle.toolResult({ round: 0, stepRef, resultHash, status: 'failed', outcomeUnknown: false, failureCode: 'OUTLINE_INVALID', admissionPhase: 'rejected' });
      await lifecycle.observationCommitted({ round: 0, stepRef, observationHash });
    }
    expect((await service.find(runId))?.runtime).toMatchObject({ budget: { toolAttemptsUsed: 2, toolCallsUsed: 0, costUnitsUsed: 0 }, toolCalls: [{ admissionPhase: 'rejected', failureCode: 'OUTLINE_INVALID' }, { admissionPhase: 'rejected' }] });
    await expect(lifecycle.toolStarted({ ...tool, stepRef: 'provider-tool-0-2' })).rejects.toThrow('tool_call_limit');
  });
  it('keeps two admitted failures or successes at 16 units after a third known refusal', async () => {
    const { service, lifecycle } = await setup(); await firstModel(lifecycle, 3);
    for (const ordinal of [0, 1]) {
      const stepRef = `provider-tool-0-${ordinal}`;
      await lifecycle.toolStarted({ ...tool, stepRef }); await lifecycle.toolAdmitted!({ round: 0, stepRef });
      await lifecycle.toolResult({ round: 0, stepRef, resultHash, status: ordinal === 0 ? 'failed' : 'success', outcomeUnknown: false, admissionPhase: 'admitted' });
      await lifecycle.observationCommitted({ round: 0, stepRef, observationHash });
    }
    const stepRef = 'provider-tool-0-2'; await lifecycle.toolStarted({ ...tool, stepRef });
    await lifecycle.toolResult({ round: 0, stepRef, resultHash, status: 'failed', outcomeUnknown: false, failureCode: 'TOOL_PRECONDITION_FAILED', admissionPhase: 'rejected' });
    await lifecycle.observationCommitted({ round: 0, stepRef, observationHash });
    await service.recordBudget(responseId, { toolCallsUsed: 2, costUnitsUsed: 16 });
    expect((await service.find(runId))?.runtime.budget).toMatchObject({ toolAttemptsUsed: 3, toolCallsUsed: 2, costUnitsUsed: 16 });
  });
  it('retains admitted unknown execution units and rejects result metadata that pretends to authorize admission', async () => {
    const { service, lifecycle } = await setup(); await firstModel(lifecycle); await lifecycle.toolStarted(tool);
    await expect(lifecycle.toolResult({ round: 0, stepRef: tool.stepRef, resultHash, status: 'success', outcomeUnknown: false, admissionPhase: 'admitted' })).rejects.toThrow('event_conflict');
    expect((await service.find(runId))?.runtime.budget.costUnitsUsed).toBe(0);
    await lifecycle.toolAdmitted!({ round: 0, stepRef: tool.stepRef });
    await lifecycle.toolResult({ round: 0, stepRef: tool.stepRef, resultHash, status: 'unknown', outcomeUnknown: true, admissionPhase: 'admitted', failureCode: 'tool_timeout' });
    expect((await service.find(runId))?.runtime).toMatchObject({ status: 'needs_reconciliation', budget: { toolCallsUsed: 1, costUnitsUsed: 8 }, toolCalls: [{ admissionPhase: 'admitted', status: 'unknown', failureCode: 'tool_timeout' }] });
  });
  it('recovers an interrupted proposal before Host admission as known unexecuted work', async () => {
    const { service, lifecycle } = await setup(); await firstModel(lifecycle); await lifecycle.toolStarted(tool);
    await service.recoverInterrupted();
    expect((await service.find(runId))?.runtime).toMatchObject({ status: 'stopped', budget: { toolAttemptsUsed: 1, toolCallsUsed: 0, costUnitsUsed: 0 }, toolCalls: [{ admissionPhase: 'pending', status: 'failed' }] });
    await expect(lifecycle.toolAdmitted!({ round: 0, stepRef: tool.stepRef })).rejects.toThrow('run_frozen');
  });
  it('does not charge a durable readback replay for an already observed child', async () => {
    const { service, lifecycle } = await setup(); await firstModel(lifecycle); await lifecycle.toolStarted(tool);
    await lifecycle.toolResult({ round: 0, stepRef: tool.stepRef, resultHash, status: 'success', outcomeUnknown: false, admissionPhase: 'replayed' });
    await lifecycle.observationCommitted({ round: 0, stepRef: tool.stepRef, observationHash });
    expect((await service.find(runId))?.runtime).toMatchObject({ budget: { toolAttemptsUsed: 1, toolCallsUsed: 0, costUnitsUsed: 0 }, toolCalls: [{ admissionPhase: 'replayed', status: 'observed' }] });
  });
  it('requires Observation even for a prepared known refusal and conservatively freezes an unadmitted unknown receipt', async () => {
    const { service, lifecycle } = await setup(); await firstModel(lifecycle);
    await lifecycle.toolStarted(tool);
    await lifecycle.toolResult({ round: 0, stepRef: tool.stepRef, resultHash, status: 'failed', outcomeUnknown: false, admissionPhase: 'rejected', failureCode: 'invalid_outline' });
    expect((await service.find(runId))?.runtime.toolCalls).toMatchObject([{ status: 'prepared', admissionPhase: 'rejected', resultHash }]);
    await expect(lifecycle.modelPrepared({ round: 1, requestHash, messageCount: 4, toolCount: 1 })).rejects.toThrow('observation_missing');
    await lifecycle.observationCommitted({ round: 0, stepRef: tool.stepRef, observationHash });
    const stepRef = 'unadmitted-write-ahead'; await lifecycle.toolStarted({ ...tool, stepRef });
    await lifecycle.toolResult({ round: 0, stepRef, resultHash, status: 'unknown', outcomeUnknown: true, admissionPhase: 'unknown', failureCode: 'runtime_checkpoint_failed' });
    expect((await service.find(runId))?.runtime).toMatchObject({ status: 'needs_reconciliation', budget: { toolAttemptsUsed: 2, toolCallsUsed: 0, costUnitsUsed: 0 },
      toolCalls: [{ status: 'observed', admissionPhase: 'rejected' }, { status: 'unknown', admissionPhase: 'unknown' }] });
    await expect(lifecycle.toolAdmitted!({ round: 0, stepRef })).rejects.toThrow('run_frozen');
  });
  it('uses the fixed deadline before any initial model send and preserves the deadline on repeated open', async () => {
    const { lifecycle, service, policy, run, setTime } = await setup();
    setTime(new Date(policy.deadlineAt).toISOString());
    await expect(lifecycle.modelPrepared({ round: 0, requestHash, messageCount: 2, toolCount: 1 })).rejects.toThrow('timeout');
    await expect(service.open(run, { ...policy, deadlineAt: policy.deadlineAt + 1000 })).rejects.toThrow('conversation_agent_runtime_revision_conflict');
    expect((await service.find(runId))?.runtime).toMatchObject({ status: 'stopped', stopReason: 'timeout', modelCalls: [], budget: { deadlineAt: policy.deadlineAt } });
  });
  it('freezes a submitted model on restart and does not replay Provider requests', async () => {
    const { lifecycle, service, repository } = await setup();
    await lifecycle.modelPrepared({ round: 0, requestHash, messageCount: 2, toolCount: 1 }); await lifecycle.modelStarted({ round: 0 });
    const reopened = new ConversationAgentRuntimeService({ repository, now: () => '2026-10-03T12:00:02.000Z', nextEventId: () => 'recover-model-event' });
    const recovered = await reopened.recoverInterrupted();
    expect(recovered[0].runtime).toMatchObject({ status: 'needs_reconciliation', stopReason: 'unknown_result', modelCalls: [{ status: 'unknown' }] });
    await expect(reopened.providerLifecycle(runId).modelPrepared({ round: 0, requestHash, messageCount: 2, toolCount: 1 })).rejects.toThrow('run_frozen');
    expect((await service.find(runId))?.runtime.budget.toolCallsUsed).toBe(0);
  });
  it('treats an observed missing receipt after a known Work as uncertain and keeps that Work', async () => {
    const { lifecycle, service } = await setup(); await firstModel(lifecycle); await lifecycle.toolStarted(tool); await lifecycle.toolAdmitted!({ round: 0, stepRef: tool.stepRef });
    await lifecycle.toolResult({ round: 0, stepRef: tool.stepRef, resultHash, status: 'success', outcomeUnknown: false, registeredWorkIds: ['work-committed'] });
    await service.recoverInterrupted();
    expect((await service.find(runId))?.runtime).toMatchObject({ status: 'needs_reconciliation', registeredWorkIds: ['work-committed'], toolCalls: [{ status: 'unknown', resultHash }] });
    await lifecycle.observationCommitted({ round: 0, stepRef: tool.stepRef, observationHash });
    expect((await service.settle(responseId))?.runtime.status).toBe('needs_reconciliation');
  });
  it('keeps late known Work while leaving an uncertain first result immutable', async () => {
    const { lifecycle, service } = await setup(); await firstModel(lifecycle); await lifecycle.toolStarted(tool); await lifecycle.toolAdmitted!({ round: 0, stepRef: tool.stepRef });
    await lifecycle.toolResult({ round: 0, stepRef: tool.stepRef, resultHash, status: 'unknown', outcomeUnknown: true });
    await lifecycle.toolResult({ round: 0, stepRef: tool.stepRef, resultHash: argumentsHash, status: 'success', outcomeUnknown: false, registeredWorkIds: ['work-late'] });
    const persisted = await service.find(runId);
    expect(persisted?.runtime).toMatchObject({ status: 'needs_reconciliation', registeredWorkIds: ['work-late'], toolCalls: [{ status: 'unknown', resultHash }] });
    expect(persisted?.events.at(-1)).toMatchObject({ kind: 'work_registered', facts: { resultHash: argumentsHash } });
    await service.recordRegisteredWorks(responseId, ['work-late', 'work-other-committed']);
    expect((await service.find(runId))?.runtime.registeredWorkIds).toEqual(['work-late', 'work-other-committed']);
  });
  it('fails before execution when admission checkpoint persistence fails and freezes the durable uncertain boundary', async () => {
    let failStarted = false;
    const { lifecycle, service } = await setup(repository => ({ ...repository, projectId: repository.projectId,
      get: repository.get.bind(repository), list: repository.list.bind(repository), findByResponseExecutionId: repository.findByResponseExecutionId.bind(repository), create: repository.create.bind(repository), listPendingOutbox: repository.listPendingOutbox.bind(repository), acknowledgeOutbox: repository.acknowledgeOutbox.bind(repository),
      async commit(input) { const result = await repository.commit(input); if (failStarted && input.event.kind === 'tool_call_admitted') throw new Error('crash after checkpoint replace'); return result; }
    }));
    await firstModel(lifecycle); await lifecycle.toolStarted(tool); failStarted = true; let executed = 0;
    await expect((async () => { await lifecycle.toolAdmitted!({ round: 0, stepRef: tool.stepRef }); executed++; })()).rejects.toThrow('crash after checkpoint replace');
    expect(executed).toBe(0); failStarted = false;
    await service.recoverInterrupted();
    expect((await service.find(runId))?.runtime).toMatchObject({ status: 'needs_reconciliation', toolCalls: [{ status: 'unknown' }], budget: { toolCallsUsed: 1, costUnitsUsed: 8 } });
    await expect(lifecycle.toolStarted(tool)).rejects.toThrow('run_frozen');
  });
  it('publishes only committed safe progress with canonical identity and idempotent outbox acknowledgement', async () => {
    const { canonical, service } = await setup();
    const input = { code: 'model_request' as const, status: 'started' as const, facts: { purpose: 'content' as const }, occurredAt: '2026-10-03T12:00:01.000Z' };
    const entry = await canonical.record(input), replay = await canonical.record({ ...input, occurredAt: '2026-10-03T12:00:02.000Z' });
    expect(replay).toEqual(entry); expect(entry).toMatchObject({ runId, runSequence: 2 });
    expect(await canonical.replayPending!()).toEqual([entry]);
    await canonical.markProjected(entry.runEventId); await canonical.markProjected(entry.runEventId);
    expect(await canonical.replayPending!()).toEqual([]);
    const snapshot = await service.find(runId); expect(snapshot?.events).toHaveLength(2); expect(snapshot?.runtime.revision).toBe(1);
    await expect(canonical.record({ ...input, facts: { ...input.facts, apiKey: 'private' } } as Parameters<typeof canonical.record>[0])).rejects.toThrow(/unsupported|internal/);
    expect(JSON.stringify(snapshot)).not.toMatch(/private|rawPrompt|reasoning/);
  });
  it('does not discard confirmed result evidence when a late failure callback arrives', async () => {
    const { lifecycle, service } = await setup(); await firstModel(lifecycle, 0);
    await lifecycle.modelFailed({ round: 0, unknown: true, code: 'transport' });
    expect((await service.find(runId))?.runtime.modelCalls[0]).toMatchObject({ status: 'completed', resultHash });
  });
  it('persists trusted local Host charges without double charging or refunding Provider claims', async () => {
    const { lifecycle, service } = await setup(); await firstModel(lifecycle); await lifecycle.toolStarted(tool);
    await service.recordBudget(responseId, { toolCallsUsed: 3, costUnitsUsed: 12 });
    await service.recordBudget(responseId, { toolCallsUsed: 1, costUnitsUsed: 8 });
    const recorded = await service.find(runId);
    expect(recorded?.runtime.budget).toMatchObject({ toolCallsUsed: 3, costUnitsUsed: 12 });
    const revision = recorded!.runtime.revision;
    await service.recordBudget(responseId, { toolCallsUsed: 3, costUnitsUsed: 12 });
    expect((await service.find(runId))?.runtime.revision).toBe(revision);
    await expect(service.recordBudget(responseId, { toolCallsUsed: -1, costUnitsUsed: 0 })).rejects.toThrow('event_conflict');
  });
  it('freezes an impossible Host counter while retaining the original policy and evidence', async () => {
    const { lifecycle, service, policy } = await setup(); await firstModel(lifecycle, 0); await service.settle(responseId);
    await expect(service.recordBudget(responseId, { toolCallsUsed: policy.maxToolCalls + 1, costUnitsUsed: 12 })).rejects.toThrow('tool_call_limit');
    const frozen = await service.find(runId);
    expect(frozen?.runtime).toMatchObject({ status: 'needs_reconciliation', stopReason: 'tool_call_limit', budget: { maxToolCalls: policy.maxToolCalls, toolCallsUsed: 0, budgetUnits: policy.budgetUnits } });
    expect(frozen?.events.at(-1)).toMatchObject({ kind: 'run_stopped', facts: { diagnosticCode: 'host_budget_counter_overflow', toolCallsUsed: policy.maxToolCalls + 1 } });
    await expect(lifecycle.modelPrepared({ round: 1, requestHash, messageCount: 4, toolCount: 1 })).rejects.toThrow('run_frozen');
  });
  it('retains projected receipts if batch acknowledgement fails and still permits known canonical settlement', async () => {
    let rejectAck = true;
    const { service, canonical, lifecycle, repository } = await setup(repository => ({ projectId: repository.projectId,
      get: repository.get.bind(repository), list: repository.list.bind(repository), findByResponseExecutionId: repository.findByResponseExecutionId.bind(repository), create: repository.create.bind(repository), commit: repository.commit.bind(repository), listPendingOutbox: repository.listPendingOutbox.bind(repository), acknowledgeOutbox: repository.acknowledgeOutbox.bind(repository),
      async acknowledgeOutboxMany(run, ids) { if (rejectAck) throw new Error('ack temporarily unavailable'); for (const id of ids) await repository.acknowledgeOutbox(run, id); }
    }));
    await firstModel(lifecycle, 0);
    const entry = await canonical.record({ code: 'task_complete', status: 'completed', occurredAt: t0 });
    await canonical.markProjected(entry.runEventId);
    expect(await repository.listPendingOutbox(runId)).toHaveLength(1);
    await expect(service.flushProjectedEvents()).rejects.toThrow('ack temporarily unavailable');
    expect((await service.settle(responseId))?.runtime.status).toBe('settled');
    expect(await repository.listPendingOutbox(runId)).toHaveLength(1);
    rejectAck = false; await service.flushProjectedEvents();
    expect(await repository.listPendingOutbox(runId)).toEqual([]);
  });

  it('serializes receipt acknowledgment behind an in-flight checkpoint', async () => {
    let releaseCheckpoint!: () => void, checkpointEntered!: () => void;
    const checkpointGate = new Promise<void>(resolve => { releaseCheckpoint = resolve; });
    const entered = new Promise<void>(resolve => { checkpointEntered = resolve; });
    let checkpointWriting = false, acknowledgementStarted = false;
    const { service, canonical, lifecycle, repository } = await setup(repository => ({ projectId: repository.projectId,
      get: repository.get.bind(repository), list: repository.list.bind(repository),
      findByResponseExecutionId: repository.findByResponseExecutionId.bind(repository), create: repository.create.bind(repository),
      listPendingOutbox: repository.listPendingOutbox.bind(repository), acknowledgeOutbox: repository.acknowledgeOutbox.bind(repository),
      async commit(input) {
        if (input.event.kind !== 'model_call_prepared') return repository.commit(input);
        checkpointWriting = true;
        checkpointEntered();
        await checkpointGate;
        try { return await repository.commit(input); }
        finally { checkpointWriting = false; }
      },
      async acknowledgeOutboxMany(run, ids) {
        acknowledgementStarted = true;
        if (checkpointWriting) throw new Error('receipt raced an execution checkpoint');
        if (!repository.acknowledgeOutboxMany) throw new Error('Expected real batch receipt repository');
        await repository.acknowledgeOutboxMany(run, ids);
      }
    }));
    const event = await canonical.record({ code: 'plan_validation', status: 'completed', occurredAt: t0 });
    await canonical.markProjected(event.runEventId);
    const checkpoint = lifecycle.modelPrepared({ round: 0, requestHash, messageCount: 2, toolCount: 1 });
    await entered;
    const acknowledgment = service.flushProjectedEvents();
    try {
      await Promise.resolve();
      expect(acknowledgementStarted).toBe(false);
    } finally { releaseCheckpoint(); }
    await checkpoint;
    await acknowledgment;
    expect(acknowledgementStarted).toBe(true);
    expect(await repository.listPendingOutbox(runId)).toEqual([]);
    expect((await service.find(runId))?.runtime).toMatchObject({ revision: 2, modelCalls: [{ status: 'prepared', requestHash }] });
  });
});
