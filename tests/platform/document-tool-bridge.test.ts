import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDocumentToolCallingBridge, parseControlledProviderTools } from '../../src/platform';
import type { DocumentAtomicExecutionContext, DocumentAtomicToolBinding } from '../../src/application/document-atomic-tools';
import type { DocumentTaskRuntimeScope } from '../../src/application/document-task-runtime-service';
import {
  canonicalToolIds, canonicalToolInputSchema, createCanonicalToolRegistry,
  type CanonicalToolContract, type CanonicalToolId, type CanonicalToolRegistry,
  type DocumentToolResult, type ToolExecutionContext
} from '../../src/domain/entities/canonical-tool-contract';

const canonicalRegistry = createCanonicalToolRegistry();
// Test-only exposure exercises write safety without registering a production write adapter.
const testRegistry = createCanonicalToolRegistry([...canonicalRegistry.values()].map(contract =>
  contract.toolId === 'apply_document_patch' ? { ...contract, exposure: 'provider' } : contract));
type BridgeOptions = Parameters<typeof createDocumentToolCallingBridge>[0];

function success(observation: Readonly<Record<string, unknown>> = {}): DocumentToolResult {
  return { schemaVersion: 1, status: 'success', observation };
}

function hostContext(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    currentDocumentId: 'document-1',
    currentDocumentIR: { operation: 'edit', attachmentRefs: [], documentRef: 'document-1' },
    revision: 3, operation: 'edit', capabilities: [...canonicalToolIds],
    projectContext: { projectId: 'project-1', workId: 'work-1' },
    authorization: { canRead: true, canWrite: true, allowedToolIds: [...canonicalToolIds] },
    taskContext: { taskId: 'task-1', checkpoint: { revision: 3, step: 0 } },
    abortSignal: new AbortController().signal, ...overrides
  };
}

function binding(id: CanonicalToolId,
  execute: DocumentAtomicToolBinding['execute'] = async () => success({ revision: 3, sourceId: 'source-1' }),
  registry: CanonicalToolRegistry = testRegistry): DocumentAtomicToolBinding {
  return { contract: registry.get(id)!, authorize: async () => true, execute };
}

function createBridge(bindings: readonly DocumentAtomicToolBinding[], overrides: Partial<Omit<BridgeOptions, 'bindings'>> = {}) {
  const host = hostContext();
  return createDocumentToolCallingBridge({
    bindings, registry: testRegistry, getExecutionContext: () => host,
    budgetUnits: 16, maxCalls: 8, timeoutMs: 1_000, ...overrides
  });
}
function bridgeWith(...bindings: DocumentAtomicToolBinding[]) { return createBridge(bindings); }
function failure(code: string, status = 'failed') { return { schemaVersion: 1, status, diagnostics: [{ code }] }; }

describe('document tool calling bridge', () => {
  afterEach(() => vi.useRealTimers());

  it('publishes canonical Provider parameters and forwards business arguments separately from Host context', async () => {
    const execute = vi.fn(async (_args, _context) => success({ revision: 3, sourceId: 'source-1' }));
    const bridge = bridgeWith(binding('read_document_structure', execute));
    const contract = canonicalRegistry.get('read_document_structure')!;
    expect(parseControlledProviderTools(bridge.tools)).toHaveLength(1);
    expect(bridge.tools[0]?.function).toEqual({
      name: contract.toolId, description: contract.description,
      requiresExistingDocument: contract.preconditions.requiresExistingDocument,
      parameters: canonicalToolInputSchema(contract)
    });
    expect(await invoke(bridge, 'call-read', { scope: 'page', ordinal: 3 })).toMatchObject({
      schemaVersion: 1, status: 'success', observation: { revision: 3, sourceId: 'source-1' },
      metadata: { callId: 'call-read', toolId: contract.toolId, toolVersion: contract.version, costUnits: contract.execution.budgetUnits }
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith({ scope: 'page', ordinal: 3 }, expect.objectContaining({
      currentDocumentId: 'document-1', revision: 3, callId: 'call-read',
      idempotencyKey: expect.stringMatching(/^[a-f0-9]{64}$/), projectContext: { projectId: 'project-1', workId: 'work-1' }
    }));
  });

  it('allows the current Work/document to refresh inside one create task runtime', () => {
    let host = hostContext({ operation: 'create', currentDocumentId: undefined, currentDocumentIR: undefined, revision: 0,
      projectContext: { projectId: 'project-1' }, authorization: { canRead: true, canWrite: true, allowedToolIds: [...canonicalToolIds] } });
    const bridge = createDocumentToolCallingBridge({
      bindings: [binding('read_document_structure')], registry: testRegistry,
      getExecutionContext: () => host, budgetUnits: 16, maxCalls: 8, timeoutMs: 1_000
    });
    expect(bridge.tools).toEqual([]);
    host = hostContext({ operation: 'create', currentDocumentId: 'work-2', currentDocumentIR: { operation: 'analyze', attachmentRefs: [] }, revision: 1,
      projectContext: { projectId: 'project-1', workId: 'work-2' }, authorization: { canRead: true, canWrite: false, allowedToolIds: [...canonicalToolIds] } });
    expect(bridge.tools).toHaveLength(1);
    const rebound = host;
    host = { ...rebound, projectContext: { ...rebound.projectContext, projectId: 'other-project' } };
    expect(() => bridge.tools).toThrow('runtime_scope_mismatch');
    host = { ...rebound, taskContext: { ...rebound.taskContext, taskId: 'other-task' } };
    expect(() => bridge.tools).toThrow('runtime_scope_mismatch');
    host = rebound;
    expect(bridge.tools).toHaveLength(1);
  });

  it.each([
    { currentDocumentId: undefined }, { currentDocumentIR: undefined }, { revision: undefined },
    { capabilities: [] }, { authorization: { canRead: false, canWrite: true, allowedToolIds: canonicalToolIds } },
    { authorization: { canRead: true, canWrite: true, allowedToolIds: [] } }
  ] as Partial<ToolExecutionContext>[])('hides and rejects unavailable tools before the Host: %j', async missing => {
    const execute = vi.fn(async () => success());
    const authorize = vi.fn(async () => true);
    const host = hostContext(missing);
    const bridge = createBridge([{ ...binding('read_document_structure', execute), authorize }], { getExecutionContext: () => host });
    expect(bridge.tools).toEqual([]);
    expect(await invoke(bridge, 'unavailable')).toMatchObject(failure('TOOL_PRECONDITION_FAILED'));
    expect(authorize).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(bridge.spentCostUnits()).toBe(0);
  });

  it('allows a newly initialized bound IR and hides internal-only registry entries', () => {
    const host = hostContext({ operation: 'create', currentDocumentIR: { operation: 'create', attachmentRefs: [] }, revision: 0 });
    const bridge = createBridge([binding('read_document_structure'), binding('render_preview')], { registry: canonicalRegistry, getExecutionContext: () => host });
    expect(bridge.tools.map(tool => tool.function.name)).toEqual(['read_document_structure']);
    expect(bridge.tools[0]?.function.requiresExistingDocument).toBe(true);
  });

  it('derives available tools again when document state or grants change', async () => {
    let host = hostContext();
    const execute = vi.fn(async () => success());
    const bridge = createBridge([binding('read_document_structure', execute)], { getExecutionContext: () => host });
    expect(bridge.tools).toHaveLength(1);
    host = { ...host, authorization: { ...host.authorization, allowedToolIds: [] } };
    expect(bridge.tools).toEqual([]);
    expect(await invoke(bridge, 'revoked')).toMatchObject(failure('TOOL_PRECONDITION_FAILED'));
    host = hostContext({ currentDocumentId: undefined, currentDocumentIR: undefined });
    expect(bridge.tools).toEqual([]);
    host = hostContext();
    expect(bridge.tools).toHaveLength(1);
    expect(await invoke(bridge, 'restored')).toMatchObject({ status: 'success' });
    expect(execute).toHaveBeenCalledOnce();
  });

  it.each(['path', 'filePath', 'rootDirectory', 'relativePath', 'documentRef', 'documentId', 'currentDocumentId', 'revision', 'authorization', 'reason'])('rejects model-supplied %s before authorization', async key => {
    const authorize = vi.fn(async () => true);
    const execute = vi.fn(async () => success());
    const bridge = bridgeWith({ ...binding('read_document_structure', execute), authorize });
    const result = await invoke(bridge, 'unsafe', { [key]: 'C:\\private\\draft.pptx' });
    expect(result).toMatchObject(failure('invalid_tool_arguments'));
    expect(JSON.stringify(result)).not.toContain('C:');
    expect(authorize).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    { scope: 'page' }, { scope: 'section' }, { ordinal: 1 }, { scope: 'document', ordinal: 1 },
    { scope: 'page', ordinal: 1.5 }, { scope: 'page', ordinal: 0 }, { scope: 'page', ordinal: 501 },
    { scope: 'summary' }, { scope: 'page', ordinal: '1' }, { scope: true },
    { scope: { path: 'C:\\private\\draft.pptx' } }, { scope: 'page', ordinal: 1, extra: true },
    Object.create({ scope: 'page', ordinal: 1 })
  ])('rejects malformed canonical fields and conditions before authorization: %j', async args => {
    const authorize = vi.fn(async () => true);
    const bridge = bridgeWith({ ...binding('read_document_structure'), authorize });
    expect(await invoke(bridge, 'invalid', args)).toMatchObject(failure('invalid_tool_arguments'));
    expect(authorize).not.toHaveBeenCalled();
  });

  it('applies the contract scope default before calling the Adapter', async () => {
    const execute = vi.fn(async () => success());
    const bridge = bridgeWith(binding('read_document_structure', execute));
    expect(await invoke(bridge, 'default')).toMatchObject({ status: 'success' });
    expect(execute).toHaveBeenCalledWith({ scope: 'document' }, expect.anything());
  });

  it('isolates and deeply freezes Runtime context supplied to Adapters', async () => {
    const host = hostContext();
    const execute = vi.fn(async (args, context: DocumentAtomicExecutionContext) => {
      expect(args).toEqual({ scope: 'document' });
      expect(Object.isFrozen(args)).toBe(true);
      expect(context.currentDocumentId).toBe(host.currentDocumentId);
      expect(context.currentDocumentIR).not.toBe(host.currentDocumentIR);
      expect(context.currentDocumentIR).toEqual(host.currentDocumentIR);
      expect(context.authorization).not.toBe(host.authorization);
      expect(context.capabilities).not.toBe(host.capabilities);
      expect(context.abortSignal).not.toBe(host.abortSignal);
      expect(Object.isFrozen(context)).toBe(true);
      expect(Object.isFrozen(context.currentDocumentIR)).toBe(true);
      expect(Object.isFrozen(context.authorization.allowedToolIds)).toBe(true);
      expect(Object.isFrozen(context.taskContext.checkpoint)).toBe(true);
      expect(Object.isFrozen(context.capabilities)).toBe(true);
      expect(() => (context.capabilities as string[]).push('generate_chart')).toThrow();
      return success();
    });
    const originalCapabilities = [...host.capabilities];
    const bridge = createBridge([binding('read_document_structure', execute)], { getExecutionContext: () => host });
    expect(await invoke(bridge, 'isolated')).toMatchObject({ status: 'success' });
    expect(execute).toHaveBeenCalledOnce();
    expect(host.capabilities).toEqual(originalCapabilities);
  });

  it('enforces task budget and cancellation without charging refused calls', async () => {
    const execute = vi.fn(async () => success());
    const cost = canonicalRegistry.get('read_document_structure')!.execution.budgetUnits;
    const bridge = createBridge([binding('read_document_structure', execute)], { budgetUnits: cost });
    const controller = new AbortController();
    controller.abort();
    expect(await bridge.bridge.execute({ call: { id: 'cancelled', name: 'read_document_structure', arguments: {} }, signal: controller.signal })).toMatchObject(failure('cancelled', 'cancelled'));
    expect(await invoke(bridge, 'first')).toMatchObject({ status: 'success' });
    expect(await invoke(bridge, 'over-budget')).toMatchObject(failure('budget_exceeded'));
    expect(execute).toHaveBeenCalledOnce();
    expect(bridge.spentCostUnits()).toBe(cost);
  });

  it('uses contract budget metadata instead of a Bridge cost table', async () => {
    const original = canonicalRegistry.get('read_document_structure')!;
    const contract: CanonicalToolContract = { ...original, execution: { ...original.execution, budgetUnits: 3 } };
    const registry = createCanonicalToolRegistry([contract]);
    const execute = vi.fn(async () => success());
    const bridge = createBridge([binding(contract.toolId, execute, registry)], { registry, budgetUnits: 4 });
    expect(await invoke(bridge, 'contract-cost')).toMatchObject({ status: 'success', metadata: { costUnits: contract.execution.budgetUnits } });
    expect(await invoke(bridge, 'exhausted')).toMatchObject(failure('budget_exceeded'));
    expect(bridge.spentCostUnits()).toBe(contract.execution.budgetUnits);
    expect(execute).toHaveBeenCalledOnce();
  });

  it('advertises only bound tools and rejects tools absent from the task', async () => {
    const bridge = bridgeWith(binding('read_document_structure'));
    expect(await invoke(bridge, 'unbound', {}, 'apply_document_patch')).toMatchObject(failure('tool_not_allowed'));
    expect(bridge.spentCostUnits()).toBe(0);
  });

  it('rechecks live Adapter authorization for every distinct call', async () => {
    let allowed = true;
    const execute = vi.fn(async () => success({ revision: 3 }));
    const authorize = vi.fn(async () => allowed);
    const bridge = bridgeWith({ ...binding('read_document_structure', execute), authorize });
    expect(await invoke(bridge, 'allowed')).toMatchObject({ status: 'success' });
    allowed = false;
    expect(await invoke(bridge, 'revoked')).toMatchObject(failure('authorization_or_revision_invalid'));
    expect(authorize).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledOnce();
    expect(bridge.spentCostUnits()).toBe(1);
  });

  it('deduplicates concurrent writes and rejects call ID reuse for another valid tool', async () => {
    const execute = vi.fn(async () => success({ revision: 4 }));
    const bridge = bridgeWith(binding('apply_document_patch', execute), binding('read_document_structure'));
    const first = invoke(bridge, 'same', {}, 'apply_document_patch');
    const duplicate = invoke(bridge, 'same', {}, 'apply_document_patch');
    const conflict = invoke(bridge, 'same');
    expect(await first).toEqual(await duplicate);
    expect(await conflict).toMatchObject(failure('call_id_conflict'));
    expect(execute).toHaveBeenCalledOnce();
    expect(bridge.spentCostUnits()).toBe(testRegistry.get('apply_document_patch')!.execution.budgetUnits);
  });

  it('deduplicates normalized defaults and field order while detecting a changed payload', async () => {
    const execute = vi.fn(async () => success());
    const bridge = bridgeWith(binding('read_document_structure', execute));
    const first = invoke(bridge, 'ordered', { scope: 'page', ordinal: 1 });
    const duplicate = invoke(bridge, 'ordered', { ordinal: 1, scope: 'page' });
    const conflict = invoke(bridge, 'ordered', { scope: 'page', ordinal: 2 });
    expect(await first).toEqual(await duplicate);
    expect(await conflict).toMatchObject(failure('call_id_conflict'));
    expect(await invoke(bridge, 'defaults')).toEqual(await invoke(bridge, 'defaults', { scope: 'document' }));
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('binds idempotency to the Runtime document and revision', async () => {
    let host = hostContext();
    const execute = vi.fn(async () => success());
    const bridge = createBridge([binding('read_document_structure', execute)], { getExecutionContext: () => host });
    expect(await invoke(bridge, 'same-document')).toMatchObject({ status: 'success' });
    host = { ...host, currentDocumentId: 'document-2' };
    expect(await invoke(bridge, 'same-document')).toMatchObject(failure('call_id_conflict'));
    host = { ...host, currentDocumentId: 'document-1', revision: 4 };
    expect(await invoke(bridge, 'same-document')).toMatchObject(failure('call_id_conflict'));
    expect(execute).toHaveBeenCalledOnce();
  });

  it('bounds calls including authorization failures', async () => {
    const authorize = vi.fn(async () => false);
    const bridge = createBridge([{ ...binding('read_document_structure'), authorize }], { maxCalls: 1, timeoutMs: 100 });
    expect(await invoke(bridge, 'first')).toMatchObject(failure('authorization_or_revision_invalid'));
    expect(await invoke(bridge, 'second')).toMatchObject(failure('tool_call_limit'));
    expect(authorize).toHaveBeenCalledOnce();
  });

  it.each(['timeout', 'cancel'] as const)('blocks queued work after a write %s, even if the Host finishes late', async stop => {
    vi.useFakeTimers();
    let finish!: (data: DocumentToolResult) => void;
    let started!: () => void;
    const starting = new Promise<void>(resolve => { started = resolve; });
    let executionSignal: AbortSignal | undefined;
    const execute: DocumentAtomicToolBinding['execute'] = vi.fn(async (_args, context) => {
      executionSignal = context.abortSignal;
      started();
      return new Promise<DocumentToolResult>(resolve => { finish = resolve; });
    });
    const read = vi.fn(async () => success());
    const bridge = bridgeWith(binding('apply_document_patch', execute), binding('read_document_structure', read));
    const controller = new AbortController();
    const pending = bridge.bridge.execute({ call: { id: 'write', name: 'apply_document_patch', arguments: {} }, signal: controller.signal });
    const queued = invoke(bridge, 'queued');
    await starting;
    if (stop === 'cancel') controller.abort();
    else await vi.advanceTimersByTimeAsync(1_000);
    expect(await pending).toMatchObject(failure(stop === 'cancel' ? 'cancelled' : 'tool_timeout', 'unknown'));
    expect(executionSignal?.aborted).toBe(true);
    expect(await queued).toMatchObject(failure('reconciliation_required', 'unknown'));
    finish(success({ revision: 4 }));
    expect(await invoke(bridge, 'late')).toMatchObject(failure('reconciliation_required', 'unknown'));
    expect(read).not.toHaveBeenCalled();
  });

  it('times out authorization without executing or charging the tool', async () => {
    vi.useFakeTimers();
    const execute = vi.fn(async () => success());
    const bridge = bridgeWith({ ...binding('apply_document_patch', execute), authorize: () => new Promise(() => undefined) });
    const pending = invoke(bridge, 'slow-auth', {}, 'apply_document_patch');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await pending).toMatchObject(failure('tool_timeout'));
    expect(execute).not.toHaveBeenCalled();
    expect(bridge.spentCostUnits()).toBe(0);
  });

  it('uses the contract timeout when shorter than the Host ceiling', async () => {
    vi.useFakeTimers();
    const original = canonicalRegistry.get('read_document_structure')!;
    const contract: CanonicalToolContract = { ...original, execution: { ...original.execution, timeoutMs: 25 } };
    const registry = createCanonicalToolRegistry([contract]);
    const execute = vi.fn(async () => new Promise<DocumentToolResult>(() => undefined));
    const bridge = createBridge([binding(contract.toolId, execute, registry)], { registry, timeoutMs: 1_000 });
    let settled = false;
    const pending = invoke(bridge, 'bounded-time').then(result => { settled = true; return result; });
    await vi.advanceTimersByTimeAsync(24);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toMatchObject(failure('tool_timeout'));
    expect(execute).toHaveBeenCalledOnce();
  });

  it('propagates cancellation from the Runtime task signal', async () => {
    const controller = new AbortController();
    const host = hostContext({ abortSignal: controller.signal });
    const execute = vi.fn(async () => success());
    const bridge = createBridge([binding('read_document_structure', execute)], { getExecutionContext: () => host });
    controller.abort();
    expect(bridge.tools).toEqual([]);
    expect(await invoke(bridge, 'runtime-cancel')).toMatchObject(failure('cancelled', 'cancelled'));
    expect(execute).not.toHaveBeenCalled();
  });

  it('rechecks document revision after asynchronous authorization', async () => {
    let host = hostContext();
    const execute = vi.fn(async () => success());
    const authorize = vi.fn(async () => { host = { ...host, revision: 4 }; return true; });
    const bridge = createBridge([{ ...binding('read_document_structure', execute), authorize }], { getExecutionContext: () => host });
    expect(await invoke(bridge, 'stale')).toMatchObject(failure('authorization_or_revision_invalid'));
    expect(execute).not.toHaveBeenCalled();
    expect(bridge.spentCostUnits()).toBe(0);
  });

  it('redacts nested observations and never returns raw exception details', async () => {
    const bridge = bridgeWith(binding('read_document_structure', async () => success({
      revision: 3, path: 'C:\\private\\draft.pptx',
      items: [{ summary: 'File C:\\private\\draft.pptx and https://example.test/private', apiKey: 'private-value' }]
    })));
    const result = await invoke(bridge, 'safe');
    expect(result).toMatchObject({ status: 'success', observation: { revision: 3, items: [{ summary: 'File [redacted] and [redacted]' }] } });
    expect(JSON.stringify(result)).not.toContain('private');
    const failed = bridgeWith(binding('apply_document_patch', async () => { throw new Error('C:\\private\\draft.pptx'); }));
    const failedResult = await invoke(failed, 'failed', {}, 'apply_document_patch');
    expect(failedResult).toMatchObject(failure('tool_failed', 'unknown'));
    expect(JSON.stringify(failedResult)).not.toContain('private');
    expect(await invoke(failed, 'next', {}, 'apply_document_patch')).toMatchObject(failure('reconciliation_required', 'unknown'));
  });

  it('rejects oversized observations at the ToolResult boundary', async () => {
    const bridge = bridgeWith(binding('read_document_structure', async () => success({ text: 'x'.repeat(8_001) })));
    expect(await invoke(bridge, 'large')).toMatchObject(failure('invalid_tool_result'));
  });

  it('rejects a read Adapter attempting to return an IR patch', async () => {
    const bridge = bridgeWith(binding('read_document_structure', async () => ({ ...success(), irPatch: { title: 'model changed title' } })));
    expect(await invoke(bridge, 'unexpected-patch')).toMatchObject(failure('invalid_tool_result'));
  });

  it('writes tool calls before execution and commits a sanitized checkpoint observation', async () => {
    const order: string[] = [];
    const beginToolCall = vi.fn(async () => { order.push('checkpoint'); return { execute: true, runtime: { checkpoint: { step: 1 }, observations: [], toolCalls: [] } }; });
    const recordObservation = vi.fn(async () => { order.push('observation'); });
    const runtime = { service: { beginToolCall, recordObservation }, scope: {} as DocumentTaskRuntimeScope } as unknown as BridgeOptions['runtime'];
    const execute = vi.fn(async () => { order.push('execute'); return success({ revision: 4, content: 'must not persist', sourceId: 'source-1' }); });
    const bridge = createBridge([binding('read_document_structure', execute)], { runtime });
    expect(await invoke(bridge, 'durable')).toMatchObject({ status: 'success', observation: { revision: 4, sourceId: 'source-1' } });
    expect(beginToolCall).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ callId: 'durable', toolId: 'read_document_structure', inputHash: expect.stringMatching(/^[a-f0-9]{64}$/) }), expect.objectContaining({ currentDocumentId: 'document-1', revision: 3 }));
    expect(recordObservation).toHaveBeenCalledWith(expect.anything(), 'durable', {
      step: 1, toolId: 'read_document_structure', ok: true, data: { revision: 4, sourceId: 'source-1' }
    }, { outcomeUnknown: false });
    expect(order).toEqual(['checkpoint', 'execute', 'observation']);
  });

  it('replays a settled checkpoint summary without repeating the Host side effect', async () => {
    const execute = vi.fn(async () => success({ revision: 4 }));
    const beginToolCall = vi.fn(async () => ({
      execute: false,
      runtime: { checkpoint: { step: 1 }, toolCalls: [{ id: 'durable-replay', toolId: 'read_document_structure', step: 1 }],
        observations: [{ step: 1, toolId: 'read_document_structure', ok: true, data: { revision: 4 } }] }
    }));
    const recordObservation = vi.fn();
    const runtime = { service: { beginToolCall, recordObservation }, scope: {} as DocumentTaskRuntimeScope } as unknown as BridgeOptions['runtime'];
    const bridge = createBridge([binding('read_document_structure', execute)], { runtime });
    expect(await invoke(bridge, 'durable-replay')).toMatchObject({ status: 'success', observation: { revision: 4 }, metadata: { replayed: true, projection: 'checkpoint_summary' } });
    expect(execute).not.toHaveBeenCalled();
    expect(recordObservation).not.toHaveBeenCalled();
  });

  it('freezes later execution when persisting an observation fails', async () => {
    const beginToolCall = vi.fn(async () => ({ execute: true, runtime: { checkpoint: { step: 1 }, observations: [], toolCalls: [] } }));
    const runtime = { service: { beginToolCall, recordObservation: vi.fn(async () => { throw new Error('disk failed'); }) }, scope: {} as DocumentTaskRuntimeScope } as unknown as BridgeOptions['runtime'];
    const execute = vi.fn(async () => success());
    const bridge = createBridge([binding('read_document_structure', execute)], { runtime });
    expect(await invoke(bridge, 'persist-fails')).toMatchObject(failure('runtime_checkpoint_failed', 'unknown'));
    expect(await invoke(bridge, 'after-persist-failure')).toMatchObject(failure('reconciliation_required', 'unknown'));
    expect(execute).toHaveBeenCalledOnce();
  });
});

function invoke(bridge: ReturnType<typeof bridgeWith>, id: string, args: Readonly<Record<string, unknown>> = {}, name = 'read_document_structure') {
  return bridge.bridge.execute({ call: { id, name, arguments: args }, signal: new AbortController().signal });
}

describe('canonical checkpoint lifetime', () => {
  afterEach(() => vi.useRealTimers());
  it.each([
    ['begin', 'cancel'], ['begin', 'timeout'], ['commit', 'cancel'], ['commit', 'timeout']
  ] as const)('bounds a pending %s checkpoint during %s and prevents late execution', async (phase, stop) => {
    vi.useFakeTimers();
    let entered!: () => void;
    const entering = new Promise<void>(resolve => { entered = resolve; });
    let release!: () => void;
    const checkpoint = { execute: true, runtime: { checkpoint: { step: 1 }, toolCalls: [], observations: [] } };
    const beginToolCall = vi.fn(async () => {
      if (phase === 'begin') { entered(); await new Promise<void>(resolve => { release = resolve; }); }
      return checkpoint;
    });
    const recordObservation = vi.fn(async () => {
      if (phase === 'commit') { entered(); await new Promise<void>(resolve => { release = resolve; }); }
    });
    const runtime = { service: { beginToolCall, recordObservation }, scope: {} as DocumentTaskRuntimeScope } as unknown as BridgeOptions['runtime'];
    const execute = vi.fn(async () => success({ revision: 3 }));
    const current = createBridge([binding('read_document_structure', execute)], { runtime, timeoutMs: 10 });
    const signal = new AbortController();
    const result = current.bridge.execute({ call: { id: 'pending', name: 'read_document_structure', arguments: {} }, signal: signal.signal });
    await entering;
    const queued = invoke(current, 'queued');
    if (stop === 'cancel') signal.abort();
    else await vi.advanceTimersByTimeAsync(11);
    expect(await result).toMatchObject(failure(stop === 'cancel' ? 'cancelled' : 'tool_timeout', 'unknown'));
    expect(await queued).toMatchObject(failure('reconciliation_required', 'unknown'));
    expect(current.tools).toEqual([]);
    release();
    await vi.advanceTimersByTimeAsync(1);
    expect(execute).toHaveBeenCalledTimes(phase === 'begin' ? 0 : 1);
    if (phase === 'begin') expect(recordObservation).not.toHaveBeenCalled();
    expect(await invoke(current, 'late')).toMatchObject(failure('reconciliation_required', 'unknown'));
  });
});
