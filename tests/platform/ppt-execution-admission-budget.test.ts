import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConversationAgentRuntimeService } from '../../src/application/conversation-agent-runtime-service';
import { DocumentTaskRuntimeService } from '../../src/application/document-task-runtime-service';
import { HostExecutionBudget } from '../../src/application/execution-budget';
import {
  attachConversationAgentRunExecution, createConversationAgentRun, createCanonicalToolRegistry,
  toConversationAgentRunId, toConversationId, toConversationResponseExecutionId, toDocumentTaskRuntimeId,
  toIsoTimestamp, toMessageId, toProjectId, type DocumentToolResult, type ToolExecutionContext
} from '../../src/domain';
import { createDocumentToolCallingBridge } from '../../src/platform/providers/document-tool-bridge';
import { providerExecutionHash, runControlledProviderToolRounds, type ControlledProviderToolRoundResponse } from '../../src/platform/providers/provider-tool-calling';
import { JsonConversationAgentRuntimeRepository } from '../../src/platform/repositories/json-conversation-agent-runtime-repository';
import { JsonDocumentTaskRuntimeRepository } from '../../src/platform/repositories/json-document-task-runtime-repository';
import { NodeProjectStorage } from '../../src/platform/storage';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(async root => {
    if (path.dirname(path.resolve(root)).toLowerCase() !== path.resolve(os.tmpdir()).toLowerCase() || !path.basename(root).startsWith('unicomp-admission-budget-')) throw new Error('Unsafe test cleanup');
    await rm(root, { recursive: true, force: true });
  }));
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-admission-budget-')); roots.push(root);
  const storage = new NodeProjectStorage(root), projectId = toProjectId('budget-project');
  const conversationId = toConversationId('budget-conversation'), sourceMessageId = toMessageId('budget-source');
  const runId = toConversationAgentRunId('budget-run'), responseId = toConversationResponseExecutionId('budget-response');
  const at = toIsoTimestamp(new Date().toISOString()); let event = 0;
  const policy = { startedAt: Date.parse(at), deadlineAt: Date.parse(at) + 360_000, maxToolCalls: 8, budgetUnits: 24 };
  const parent = new ConversationAgentRuntimeService({ repository: new JsonConversationAgentRuntimeRepository(storage, projectId, () => at), now: () => at,
    nextEventId: () => `budget-event-${++event}`, hash: value => createHash('sha256').update(value).digest('hex') });
  const run = attachConversationAgentRunExecution(createConversationAgentRun({ id: runId, projectId, conversationId, sourceMessageId, createdAt: at }), responseId, at);
  await parent.open(run, policy);
  const child = new DocumentTaskRuntimeService(new JsonDocumentTaskRuntimeRepository(storage, projectId, () => at), { now: () => at, validateBindings: async () => true });
  const scope = await child.create({ id: toDocumentTaskRuntimeId('budget-child'), projectId, conversationId, sourceMessageId, executionId: responseId,
    documentKind: 'ppt', operation: 'create', attachmentRefs: [], pageRefs: [], budget: { maxSteps: 8, budgetUnits: 24, timeoutMs: 360_000, deadlineAt: policy.deadlineAt } });
  const budget = new HostExecutionBudget(policy), lifecycle = parent.providerLifecycle(runId);
  const host: ToolExecutionContext = { operation: 'create', capabilities: ['generate_pptx'], projectContext: { projectId },
    authorization: { canRead: true, canWrite: true, allowedToolIds: ['generate_pptx'], generationAuthorization: 'approved' },
    taskContext: { taskId: scope.id, checkpoint: { revision: 0, step: 0 }, deadlineAt: policy.deadlineAt }, abortSignal: budget.signal };
  const model = async (round: number, toolCallCount: number) => {
    await lifecycle.modelPrepared({ round, requestHash: 'a'.repeat(64), messageCount: round * 2 + 1, toolCount: 1 });
    await lifecycle.modelStarted({ round });
    await lifecycle.modelResult({ round, resultHash: 'b'.repeat(64), contentLength: 0, finishReason: toolCallCount ? 'tool_calls' : 'stop', toolCallCount });
  };
  return { root, parent, child, scope, budget, lifecycle, host, runId, responseId, model };
}
const args = { title: 'Synthetic presentation', content: '# Topic\n## First page\nSynthetic local text' };

describe('actual PPT admission and the two durable budget ledgers', () => {
  it('keeps parent, child and Host at 16 units after one actual failure, one success and a withdrawn generation proposal', async () => {
    const f = await fixture(); let attempts = 0, withdrawn = false;
    const execute = vi.fn(async (): Promise<DocumentToolResult> => {
      if (++attempts === 1) return { schemaVersion: 1, status: 'failed', diagnostics: [{ code: 'generation_failed', severity: 'error', message: 'generation_failed' }] };
      withdrawn = true;
      return { schemaVersion: 1, status: 'success', observation: { artifactRegistered: true }, artifactRefs: [{ kind: 'work', ref: 'synthetic-work' }] };
    });
    const bridge = createDocumentToolCallingBridge({ bindings: [{ contract: createCanonicalToolRegistry().get('generate_pptx')!, authorize: async () => true, execute }],
      getExecutionContext: () => withdrawn ? { ...f.host, authorization: { ...f.host.authorization, canWrite: false } } : f.host,
      budgetUnits: 24, maxCalls: 8, timeoutMs: 5_000, executionBudget: f.budget, runtime: { service: f.child, scope: f.scope } });
    const response = (round: number): ControlledProviderToolRoundResponse => round < 3
      ? { finishReason: 'tool_calls', toolCalls: [{ id: `generation-${round}`, name: 'generate_pptx', arguments: args }] } : { finishReason: 'stop' };
    let round = 0; const messages: string[] = [];
    try {
      await f.model(0, 1);
      await runControlledProviderToolRounds({ initialResponse: response(0), messages, bridge: bridge.bridge, signal: f.budget.signal,
        executionBudget: f.budget, executionLifecycle: f.lifecycle, shouldContinue: value => value.finishReason === 'tool_calls',
        appendAssistant: () => undefined, appendTool: (_call, result, target) => target.push(JSON.stringify(result)),
        requestNext: async () => { ++round; await f.model(round, round < 3 ? 1 : 0); return response(round); }, toLoopError: code => new Error(code) });
      await f.parent.recordBudget(f.responseId, f.budget.snapshot('cancelled'));
      const parent = (await f.parent.find(f.runId))!, child = await f.child.require(f.scope);
      expect(execute).toHaveBeenCalledTimes(2);
      expect(f.budget.stopReason).toBeUndefined();
      expect(f.budget.snapshot('cancelled')).toMatchObject({ toolCallsUsed: 2, costUnitsUsed: 16 });
      expect(parent.runtime.budget).toMatchObject({ toolAttemptsUsed: 3, toolCallsUsed: 2, costUnitsUsed: 16 });
      expect(child.checkpoint).toMatchObject({ step: 2, costUnits: 16 });
      expect(parent.runtime.toolCalls).toMatchObject([{ admissionPhase: 'admitted', failureCode: 'generation_failed' }, { admissionPhase: 'admitted' }, { admissionPhase: 'rejected', failureCode: 'TOOL_PRECONDITION_FAILED' }]);
      expect(parent.runtime.registeredWorkIds).toEqual(['synthetic-work']);
      expect(parent.events.filter(event => event.kind === 'tool_call_admitted')).toHaveLength(2);
      expect(messages[2]).toContain('TOOL_PRECONDITION_FAILED');
    } finally { f.budget.dispose(); }
  });

  it('returns a known pure preflight rejection before either durable journal or an execution charge', async () => {
    const f = await fixture(); const execute = vi.fn();
    const bridge = createDocumentToolCallingBridge({ bindings: [{ contract: createCanonicalToolRegistry().get('generate_pptx')!, authorize: async () => true,
      preflight: async () => ({ schemaVersion: 1, status: 'failed', diagnostics: [{ code: 'invalid_outline', severity: 'error', message: 'invalid_outline' }] }), execute }],
      getExecutionContext: () => f.host, budgetUnits: 24, maxCalls: 8, timeoutMs: 5_000, executionBudget: f.budget, runtime: { service: f.child, scope: f.scope } });
    try {
      await f.model(0, 1);
      await f.lifecycle.toolStarted({ round: 0, stepRef: 'preflight', toolId: 'generate_pptx', argumentsHash: providerExecutionHash(args) });
      const admission = vi.fn(async () => { await f.lifecycle.toolAdmitted({ round: 0, stepRef: 'preflight' }); });
      const result = await bridge.bridge.execute({ call: { id: 'preflight', name: 'generate_pptx', arguments: args }, signal: f.budget.signal, onExecutionAdmitted: admission });
      await f.lifecycle.toolResult({ round: 0, stepRef: 'preflight', resultHash: providerExecutionHash(result), status: 'failed', outcomeUnknown: false, admissionPhase: 'rejected', failureCode: 'invalid_outline' });
      expect(result).toMatchObject({ status: 'failed', diagnostics: [{ code: 'invalid_outline' }] });
      expect(execute).not.toHaveBeenCalled(); expect(admission).not.toHaveBeenCalled();
      expect((await f.parent.find(f.runId))?.runtime.budget).toMatchObject({ toolAttemptsUsed: 1, toolCallsUsed: 0, costUnitsUsed: 0 });
      expect((await f.child.require(f.scope)).checkpoint).toMatchObject({ step: 0, costUnits: 0 });
      expect(f.budget.snapshot('cancelled')).toMatchObject({ toolCallsUsed: 0, costUnitsUsed: 0 });
    } finally { f.budget.dispose(); }
  });

  it('retains admitted units in all three ledgers and freezes an uncertain actual generation result', async () => {
    const f = await fixture();
    const execute = vi.fn(async (): Promise<DocumentToolResult> => ({ schemaVersion: 1, status: 'unknown',
      diagnostics: [{ code: 'reconciliation_required', severity: 'error', message: 'reconciliation_required' }] }));
    const bridge = createDocumentToolCallingBridge({ bindings: [{ contract: createCanonicalToolRegistry().get('generate_pptx')!, authorize: async () => true, execute }],
      getExecutionContext: () => f.host, budgetUnits: 24, maxCalls: 8, timeoutMs: 5_000, executionBudget: f.budget, runtime: { service: f.child, scope: f.scope } });
    try {
      await f.model(0, 1);
      await f.lifecycle.toolStarted({ round: 0, stepRef: 'unknown-generation', toolId: 'generate_pptx', argumentsHash: providerExecutionHash(args) });
      const result = await bridge.bridge.execute({ call: { id: 'unknown-generation', name: 'generate_pptx', arguments: args }, signal: f.budget.signal,
        onExecutionAdmitted: () => f.lifecycle.toolAdmitted({ round: 0, stepRef: 'unknown-generation' }) });
      await f.parent.recordBudget(f.responseId, f.budget.snapshot('unknown_result'));
      await f.parent.finish(f.responseId, 'unknown_result');
      expect(result.status).toBe('unknown'); expect(execute).toHaveBeenCalledOnce();
      expect(f.budget.snapshot('unknown_result')).toMatchObject({ toolCallsUsed: 1, costUnitsUsed: 8 });
      expect((await f.parent.find(f.runId))?.runtime).toMatchObject({ status: 'needs_reconciliation', budget: { toolAttemptsUsed: 1, toolCallsUsed: 1, costUnitsUsed: 8 },
        toolCalls: [{ admissionPhase: 'admitted', status: 'unknown' }] });
      expect(await f.child.require(f.scope)).toMatchObject({ status: 'needs_reconciliation', checkpoint: { step: 1, costUnits: 8 }, toolCalls: [{ status: 'unknown' }] });
      await expect(f.lifecycle.toolStarted({ round: 0, stepRef: 'forbidden-retry', toolId: 'generate_pptx', argumentsHash: providerExecutionHash(args) })).rejects.toThrow('run_frozen');
      expect(execute).toHaveBeenCalledOnce();
    } finally { f.budget.dispose(); }
  });
});
