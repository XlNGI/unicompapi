import { describe, expect, it } from 'vitest';
import { DocumentGenerationRuntimeBridge, DocumentTaskRuntimeService } from '../../src/application';
import {
  assertDocumentTaskRuntimeUpdate, createDocumentTaskRuntime, parseDocumentTaskRuntime,
  toConversationId, toDocumentTaskRuntimeId, toIsoTimestamp, toMessageId, toProjectId,
  type DocumentTaskRuntime, type DocumentTaskRuntimeRepository
} from '../../src/domain';

const now = () => '2026-09-22T00:00:00.000Z';
const projectId = toProjectId('project-service');
const input = {
  id: toDocumentTaskRuntimeId('runtime-1'), projectId,
  conversationId: toConversationId('conversation-1'), sourceMessageId: toMessageId('message-1'),
  executionId: 'execution-1', documentKind: 'ppt' as const,
  attachmentRefs: ['attachment-1'], workRef: { kind: 'candidate' as const, ref: 'candidate-1', revision: 2 },
  pageRefs: [{ pageId: 'page-1', pageRevision: 2 }],
  budget: { maxSteps: 8, budgetUnits: 16, timeoutMs: 1000 }
};
const call = { callId: 'call-1', toolId: 'read_document_structure' as const, inputHash: 'a'.repeat(64) };
const observation = { step: 1, toolId: call.toolId, ok: true, data: { sections: 2 } };

async function fixture(overrides: Partial<typeof input> = {}) {
  const values = new Map<string, DocumentTaskRuntime>();
  const repository: DocumentTaskRuntimeRepository = {
    projectId,
    async get(id) { return structuredClone(values.get(id)); },
    async list() { return structuredClone([...values.values()]); },
    async create(runtime) { values.set(runtime.id, parseDocumentTaskRuntime(runtime)); },
    async save(runtime, expectedRevision) {
      const previous = values.get(runtime.id);
      if (!previous || previous.revision !== expectedRevision) throw new Error('revision_conflict');
      assertDocumentTaskRuntimeUpdate(previous, runtime);
      values.set(runtime.id, parseDocumentTaskRuntime(runtime));
    }
  };
  let pageRevision = 2;
  let timestamp = now();
  const options = { now: () => timestamp, validateBindings: async (runtime: DocumentTaskRuntime) =>
    runtime.pageRefs.every(page => page.pageRevision === pageRevision) };
  const service = new DocumentTaskRuntimeService(repository, options);
  const runtime = await service.create({ ...input, ...overrides });
  return { repository, service, runtime, options, setPage: (revision: number) => { pageRevision = revision; },
    setTime: (value: string) => { timestamp = value; } };
}

describe('document task runtime lifecycle', () => {
  it('writes ahead, settles and reopens an idempotent observation without charging again', async () => {
    const f = await fixture();
    expect((await f.service.beginToolCall(f.runtime, call)).execute).toBe(true);
    const saved = await f.service.recordObservation(f.runtime, call.callId, observation);
    expect(saved).toMatchObject({ revision: 2, checkpoint: { step: 1, costUnits: 1 }, observations: [observation] });
    const reopened = new DocumentTaskRuntimeService(f.repository, f.options);
    expect((await reopened.beginToolCall(f.runtime, call)).execute).toBe(false);
    expect((await reopened.recordObservation(f.runtime, call.callId, observation)).revision).toBe(2);
    await expect(reopened.beginToolCall(f.runtime, { ...call, inputHash: 'b'.repeat(64) })).rejects.toThrow('call_id_conflict');
    await expect(reopened.recordObservation(f.runtime, call.callId, { ...observation, data: { sections: 3 } })).rejects.toThrow('observation_conflict');
  });

  it('blocks unmatched, out-of-order and duplicate pending calls', async () => {
    const f = await fixture();
    await expect(f.service.recordObservation(f.runtime, call.callId, observation)).rejects.toThrow('observation_call_mismatch');
    await f.service.beginToolCall(f.runtime, call);
    await expect(f.service.beginToolCall(f.runtime, call)).rejects.toThrow('reconciliation_required');
    await expect(f.service.beginToolCall(f.runtime, { ...call, callId: 'call-2' })).rejects.toThrow('reconciliation_required');
    await expect(f.service.recordObservation(f.runtime, call.callId, { ...observation, step: 2 })).rejects.toThrow('observation_call_mismatch');
  });

  it.each(['projectId', 'conversationId', 'executionId'] as const)('rejects mismatched %s', async field => {
    const f = await fixture();
    await expect(f.service.beginToolCall({ ...f.runtime, [field]: 'other' }, call)).rejects.toThrow('runtime_scope_mismatch');
  });

  it('checks live page revisions before execution and before accepting results', async () => {
    const f = await fixture();
    f.setPage(3);
    await expect(f.service.beginToolCall(f.runtime, call)).rejects.toThrow('runtime_binding_or_revision_invalid');
    f.setPage(2);
    await f.service.beginToolCall(f.runtime, call);
    f.setPage(3);
    await expect(f.service.recordObservation(f.runtime, call.callId, observation)).rejects.toThrow('runtime_binding_or_revision_invalid');
    expect((await f.service.recover(f.runtime)).status).toBe('needs_reconciliation');
  });

  it.each(['apply_document_patch', 'read_document_structure'] as const)('does not replay an interrupted %s', async toolId => {
    const f = await fixture();
    await f.service.beginToolCall(f.runtime, { ...call, toolId });
    const resumed = new DocumentTaskRuntimeService(f.repository, f.options);
    const recovered = await resumed.recover(f.runtime);
    expect(recovered).toMatchObject({ status: 'needs_reconciliation', toolCalls: [{ status: 'unknown' }] });
    expect(resumed.canResume(recovered)).toBe(false);
    await expect(resumed.beginToolCall(f.runtime, { ...call, callId: 'call-2' })).rejects.toThrow('reconciliation_required');
  });

  it('marks a failed write unknown but preserves a failed read as an observation', async () => {
    const f = await fixture();
    await f.service.beginToolCall(f.runtime, call);
    await f.service.recordObservation(f.runtime, call.callId, { ...observation, ok: false, diagnostic: 'read_failed' });
    expect((await f.service.recover(f.runtime)).status).toBe('paused');
    await f.service.beginToolCall(f.runtime, { ...call, callId: 'call-2', toolId: 'apply_document_patch' });
    const result = await f.service.recordObservation(f.runtime, 'call-2',
      { step: 2, toolId: 'apply_document_patch', ok: false, data: {}, diagnostic: 'write_failed' });
    expect(result.status).toBe('needs_reconciliation');
    expect(result.observations).toHaveLength(1);
  });

  it('allows a write validation failure to settle when no side effect started', async () => {
    const f = await fixture();
    const writeCall = { ...call, toolId: 'apply_document_patch' as const };
    await f.service.beginToolCall(f.runtime, writeCall);
    const result = await f.service.recordObservation(f.runtime, writeCall.callId, {
      step: 1,
      toolId: writeCall.toolId,
      ok: false,
      data: {},
      diagnostic: 'authorization_or_revision_invalid'
    }, { outcomeUnknown: false });
    expect(result.status).toBe('running');
    expect(result.observations).toHaveLength(1);
    expect(result.toolCalls[0]?.status).toBe('failed');
  });

  it.each(['cancelled', 'failed'] as const)('does not revive %s tasks', async status => {
    const f = await fixture();
    await f.service.setStatus(f.runtime, status);
    await expect(f.service.beginToolCall(f.runtime, call)).rejects.toThrow('runtime_not_resumable');
    expect((await f.service.recover(f.runtime)).status).toBe(status);
    await expect(f.service.setStatus(f.runtime, 'paused')).rejects.toThrow('Invalid document task runtime transition');
  });

  it('preserves spent budget and the original deadline after reopen', async () => {
    const f = await fixture({ budget: { maxSteps: 1, budgetUnits: 1, timeoutMs: 1000 } });
    await f.service.beginToolCall(f.runtime, call);
    await f.service.recordObservation(f.runtime, call.callId, observation);
    const reopened = new DocumentTaskRuntimeService(f.repository, f.options);
    await expect(reopened.beginToolCall(f.runtime, { ...call, callId: 'call-2' })).rejects.toThrow('runtime_budget_exceeded');
    f.setTime('2026-09-22T00:00:01.001Z');
    expect((await reopened.recover(f.runtime)).status).toBe('failed');
  });

  it('promotes a candidate to a registered Work only after all calls settle', async () => {
    const f = await fixture();
    await f.service.start(f.runtime);
    await f.service.beginToolCall(f.runtime, call);
    await f.service.recordObservation(f.runtime, call.callId, observation);
    const completed = await f.service.complete(f.runtime, 'work-document-1');
    expect(completed).toMatchObject({
      status: 'completed',
      checkpoint: { stage: 'complete', step: 1 },
      workRef: { kind: 'registered', ref: 'work-document-1' }
    });
    expect(await f.service.complete(f.runtime, 'work-document-1')).toEqual(completed);
    await expect(f.service.complete(f.runtime, 'work-document-2')).rejects.toThrow('runtime_completion_conflict');
  });

  it('reconciles a completion attempt while a platform side effect is unsettled', async () => {
    const f = await fixture();
    await f.service.start(f.runtime);
    await f.service.beginToolCall(f.runtime, { ...call, toolId: 'apply_document_patch' });
    const result = await f.service.complete(f.runtime, 'work-document-1');
    expect(result.status).toBe('needs_reconciliation');
    expect(result.toolCalls.at(-1)?.status).toBe('unknown');
  });

  it('projects deterministic runner progress into safe observations and completes after Work registration', async () => {
    const f = await fixture();
    const bridge = new DocumentGenerationRuntimeBridge(f.service, f.runtime, f.runtime.executionId);
    await bridge.start();
    const events = [
      { code: 'document_compile' as const, status: 'started' as const, operationId: 'compile', facts: { documentKind: 'ppt' as const, tool: 'write_document' as const } },
      { code: 'document_compile' as const, status: 'completed' as const, operationId: 'compile', facts: { documentKind: 'ppt' as const, bytes: 1234 } },
      { code: 'document_render' as const, status: 'started' as const, operationId: 'render', facts: { documentKind: 'ppt' as const, tool: 'render' as const } },
      { code: 'document_render' as const, status: 'completed' as const, operationId: 'render', facts: { documentKind: 'ppt' as const, totalPages: 3 } },
      { code: 'document_register' as const, status: 'started' as const, operationId: 'register', facts: { documentKind: 'ppt' as const, tool: 'publish' as const } },
      { code: 'document_register' as const, status: 'completed' as const, operationId: 'register', facts: { documentKind: 'ppt' as const } }
    ];
    for (const event of events) await bridge.progress(event);
    await bridge.complete('work-document-2');
    const runtime = await bridge.runtime();
    expect(runtime.status).toBe('completed');
    expect(runtime.observations).toHaveLength(3);
    expect(runtime.observations[0].data).toEqual(expect.objectContaining({ code: 'document_compile', bytes: 1234 }));
    expect(runtime.observations[0].data).not.toHaveProperty('path');
  });

  it('does not complete when a write progress result is cancelled', async () => {
    const f = await fixture();
    const bridge = new DocumentGenerationRuntimeBridge(f.service, f.runtime, f.runtime.executionId);
    await bridge.start();
    await bridge.progress({ code: 'document_publish', status: 'started', operationId: 'publish', facts: { documentKind: 'ppt' } });
    await bridge.progress({ code: 'document_publish', status: 'cancelled', operationId: 'publish', facts: { documentKind: 'ppt' } });
    await bridge.fail('cancelled');
    expect((await bridge.runtime()).status).toBe('needs_reconciliation');
  });
});

describe('runtime persistence data boundary', () => {
  function withData(data: unknown) {
    const base = createDocumentTaskRuntime({ ...input, createdAt: toIsoTimestamp(now()) });
    return { ...base, status: 'running', checkpoint: { stage: 'tool', step: 1, costUnits: 1, lastToolCallId: call.callId },
      toolCalls: [{ id: call.callId, toolId: call.toolId, inputHash: call.inputHash, step: 1, status: 'completed' }],
      observations: [{ ...observation, data }] };
  }

  it.each([
    { value: 'from C:\\private\\data.txt' }, { value: 'see https://example.invalid' },
    { value: 'token=private-value' }, { filePath: 'private' }, { rawContent: 'attachment text' },
    { value: 'x'.repeat(2001) }, { value: Infinity }, JSON.parse('{"__proto__":{"admin":true}}'),
    { values: Array.from({ length: 33 }, () => 1) },
    Object.fromEntries(Array.from({ length: 12 }, (_, index) => ['field' + index, '汉'.repeat(1000)]))
  ])('rejects unsafe or oversized observation %#', data => {
    const value = withData(data);
    expect(() => parseDocumentTaskRuntime(value)).toThrow();
  });

  it('accepts safe metrics and rejects altered identity, extra fields and forged completion', () => {
    const value = withData({ sections: 2 });
    expect(parseDocumentTaskRuntime(value).observations).toHaveLength(1);
    const base = createDocumentTaskRuntime({ ...input, createdAt: toIsoTimestamp(now()) });
    expect(() => parseDocumentTaskRuntime({ ...base, id: 'C:\\private' })).toThrow();
    expect(() => parseDocumentTaskRuntime({ ...base, unexpected: true })).toThrow();
    expect(() => assertDocumentTaskRuntimeUpdate(base, { ...base, revision: 1, status: 'completed' })).toThrow();
  });
});
