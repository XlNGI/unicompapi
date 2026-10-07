import { describe, expect, it } from 'vitest';
import {
  createConversationAgentRuntime, parseConversationAgentRuntime, parseConversationAgentRuntimeFacts,
  parseConversationAgentRuntimeSnapshot, updateConversationAgentRuntime,
  toConversationAgentRunId, toConversationId, toConversationResponseExecutionId, toIsoTimestamp, toMessageId, toProjectId, toWorkId
} from '../../src/domain';

const t0 = toIsoTimestamp('2026-10-03T10:00:00.000Z'), t1 = toIsoTimestamp('2026-10-03T10:00:01.000Z');
const digest = 'a'.repeat(64), result = 'b'.repeat(64);
function initial() {
  return createConversationAgentRuntime({ runId: toConversationAgentRunId('run-domain'), projectId: toProjectId('project-domain'),
    conversationId: toConversationId('conversation-domain'), sourceMessageId: toMessageId('source-domain'),
    responseExecutionId: toConversationResponseExecutionId('response-domain'), createdAt: t0,
    budget: { startedAt: Date.parse(t0), deadlineAt: Date.parse(t0) + 360000, maxToolCalls: 8, budgetUnits: 24 } });
}

describe('persistent conversation parent runtime', () => {
  it('preserves fixed ownership and deadline even when a task attempts to reset its budget', () => {
    const runtime = initial();
    for (const patch of [
      { runId: toConversationAgentRunId('different') }, { sourceMessageId: toMessageId('different') },
      { responseExecutionId: toConversationResponseExecutionId('different') },
      { budget: { ...runtime.budget, deadlineAt: runtime.budget.deadlineAt + 1 } },
      { budget: { ...runtime.budget, budgetUnits: 32 } }
    ]) {
      expect(() => updateConversationAgentRuntime(runtime, patch, t1)).toThrow();
    }
  });
  it('does not permit counter refunds or starting prepared work after cancellation', () => {
    const runtime = updateConversationAgentRuntime(initial(), { budget: { ...initial().budget, toolCallsUsed: 1, costUnitsUsed: 8 },
      modelCalls: [{ callId: 'model-0', round: 0, requestHash: digest, status: 'prepared' }] }, t1);
    expect(() => updateConversationAgentRuntime(runtime, { budget: { ...runtime.budget, toolCallsUsed: 0 } }, t1)).toThrow(/regressed/);
    const stopped = updateConversationAgentRuntime(runtime, { status: 'stopped', stopReason: 'cancelled' }, t1);
    expect(() => updateConversationAgentRuntime(stopped, { modelCalls: [{ ...runtime.modelCalls[0], status: 'submitting' }] }, t1)).toThrow(/start/);
  });
  it('requires an actual result and Observation before allowing a tool round to settle', () => {
    const call = { stepRef: 'tool-0-0', round: 0, toolId: 'generate_pptx', argumentsHash: digest, status: 'observed' as const };
    expect(() => parseConversationAgentRuntime({ ...initial(), toolCalls: [call] })).toThrow(/Observation/);
    expect(() => parseConversationAgentRuntime({ ...initial(), status: 'settled', toolCalls: [{ ...call, status: 'started' }] })).toThrow(/settled/);
    expect(() => parseConversationAgentRuntime({ ...initial(), toolCalls: [{ ...call, resultHash: result, observationHash: digest }] })).not.toThrow();
    expect(() => parseConversationAgentRuntime({ ...initial(), toolCalls: [{ ...call, status: 'unknown' }] })).toThrow(/frozen parent/);
  });
  it('reads legacy conservative charges without inventing admission evidence or enabling a new replay', () => {
    const budget = { ...initial().budget }; delete budget.toolAttemptsUsed;
    const legacy = parseConversationAgentRuntime({ ...initial(), budget: { ...budget, toolCallsUsed: 1, costUnitsUsed: 8 },
      toolCalls: [{ stepRef: 'legacy-call', round: 0, toolId: 'generate_pptx', argumentsHash: digest, status: 'started' }] });
    expect(legacy.budget.toolAttemptsUsed).toBeUndefined();
    expect(legacy.toolCalls[0].admissionPhase).toBeUndefined();
    const frozen = updateConversationAgentRuntime(legacy, { status: 'needs_reconciliation', stopReason: 'unknown_result',
      toolCalls: [{ ...legacy.toolCalls[0], status: 'unknown' }] }, t1);
    expect(frozen.budget).toMatchObject({ toolCallsUsed: 1, costUnitsUsed: 8 });
    expect(() => updateConversationAgentRuntime(legacy, { toolCalls: [{ ...legacy.toolCalls[0], admissionPhase: 'pending' }] }, t1)).toThrow(/immutable/);
  });
  it('prevents removing proposal accounting or a persisted new admission marker', () => {
    const runtime = updateConversationAgentRuntime(initial(), { budget: { ...initial().budget, toolAttemptsUsed: 1 },
      toolCalls: [{ stepRef: 'new-proposal', round: 0, toolId: 'generate_pptx', argumentsHash: digest, status: 'started', admissionPhase: 'pending' }] }, t1);
    const budget = { ...runtime.budget }; delete budget.toolAttemptsUsed;
    expect(() => updateConversationAgentRuntime(runtime, { budget }, t1)).toThrow(/accounting/);
    expect(() => updateConversationAgentRuntime(runtime, { toolCalls: [{ ...runtime.toolCalls[0], admissionPhase: undefined }] }, t1)).toThrow(/immutable/);
  });
  it('freezes uncertain effects while preserving late known Work and child evidence', () => {
    const runtime = updateConversationAgentRuntime(initial(), { toolCalls: [{ stepRef: 'tool-0', round: 0, toolId: 'generate_pptx', argumentsHash: digest, status: 'started' }] }, t1);
    const unknown = updateConversationAgentRuntime(runtime, { status: 'needs_reconciliation', stopReason: 'unknown_result', toolCalls: [{ ...runtime.toolCalls[0], status: 'unknown' }] }, t1);
    const known = updateConversationAgentRuntime(unknown, { registeredWorkIds: [toWorkId('work-late')], toolCalls: [{ ...unknown.toolCalls[0], status: 'observed', resultHash: result, observationHash: digest }] }, t1);
    expect(known.status).toBe('needs_reconciliation');
    expect(() => updateConversationAgentRuntime(known, { status: 'settled' }, t1)).toThrow(/reconciliation/);
    expect(() => updateConversationAgentRuntime(known, { registeredWorkIds: [] }, t1)).toThrow(/removed/);
    expect(() => updateConversationAgentRuntime(known, { toolCalls: [...known.toolCalls, { ...runtime.toolCalls[0], stepRef: 'another-tool' }] }, t1)).toThrow(/admit/);
  });
  it('rejects new calls that skip the pre-execution checkpoint', () => {
    expect(() => updateConversationAgentRuntime(initial(), { modelCalls: [{ callId: 'model-0', round: 0, requestHash: digest, resultHash: result, status: 'completed' }] }, t1)).toThrow(/pre-execution/);
  });
  it.each([
    { rawPrompt: 'private enterprise report' }, { reasoning: 'hidden reasoning' }, { apiKey: 'private-key' },
    { workId: 'C:/private/report.pptx' }, { requestHash: 'Bearer private' }, { count: -1 }, { count: NaN }, { count: 1.5 },
    { stopReason: 'C:/private/report' }, { pageIntent: 'complete attachment content' }
  ])('rejects untrusted or unbounded semantic facts %j', facts => {
    expect(() => parseConversationAgentRuntimeFacts(facts)).toThrow();
  });
  it('cannot inject uncommitted public outbox facts into a valid checkpoint', () => {
    const runtime = initial();
    const event = { runId: runtime.runId, eventId: 'event-1', eventKey: 'created', sequence: 1, kind: 'run_created', at: t0 };
    expect(() => parseConversationAgentRuntimeSnapshot({ runtime, events: [event], outbox: [{ eventId: 'fake-event', eventKey: 'created', runId: runtime.runId, sequence: 1, at: t0, payload: { code: 'task_complete', status: 'completed' }, projected: false }] })).toThrow(/outbox/);
  });
});
