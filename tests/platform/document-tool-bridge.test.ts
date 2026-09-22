import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDocumentToolCallingBridge,
  parseControlledProviderTools
} from '../../src/platform';
import type { DocumentAtomicToolBinding } from '../../src/application/document-atomic-tools';

function binding(
  id: DocumentAtomicToolBinding['id'],
  execute: DocumentAtomicToolBinding['execute'] = async () => ({ revision: 3, sourceId: 'source-1' })
): DocumentAtomicToolBinding {
  return {
    id,
    fields: {
      section: { type: 'string', maxLength: 64 },
      input: { type: 'string', maxLength: 256 }
    },
    authorize: async () => true,
    execute
  };
}

function bridgeWith(...bindings: DocumentAtomicToolBinding[]) {
  return createDocumentToolCallingBridge({
    bindings,
    budgetUnits: 16,
    maxCalls: 8,
    timeoutMs: 1_000
  });
}

describe('document tool calling bridge', () => {
  afterEach(() => vi.useRealTimers());
  it('publishes the bounded registry and forwards validated scalar input', async () => {
    const calls: unknown[] = [];
    const bridge = bridgeWith(binding('read_document_structure', async (request, context) => {
      calls.push({ request, tool: context.definition.id });
      return { revision: 3, sourceId: 'source-1' };
    }));

    expect(parseControlledProviderTools(bridge.tools)).toHaveLength(1);
    const result = await bridge.bridge.execute({
      call: {
        id: 'call-read',
        name: 'read_document_structure',
        arguments: { section: 'summary', reason: 'inspect the document' }
      },
      signal: new AbortController().signal
    });

    expect(result).toMatchObject({
      ok: true,
      callId: 'call-read',
      toolId: 'read_document_structure',
      toolVersion: '1.0',
      result: { revision: 3 }
    });
    expect(calls).toHaveLength(1);
  });

  it('rejects unsafe or non-scalar provider arguments before the host', async () => {
    let calls = 0;
    const bridge = bridgeWith(binding('read_document_structure', async () => { calls += 1; return {}; }));
    const unsafe = await bridge.bridge.execute({
      call: {
        id: 'call-unsafe',
        name: 'read_document_structure',
        arguments: { path: 'C:\\private\\draft.pptx' }
      },
      signal: new AbortController().signal
    });
    const nested = await bridge.bridge.execute({
      call: {
        id: 'call-nested',
        name: 'read_document_structure',
        arguments: { input: { path: 'C:\\private\\draft.pptx' } }
      },
      signal: new AbortController().signal
    });

    expect(unsafe).toMatchObject({ ok: false, errorCode: 'invalid_tool_arguments' });
    expect(nested).toMatchObject({ ok: false, errorCode: 'invalid_tool_arguments' });
    expect(JSON.stringify(unsafe)).not.toContain('C:');
    expect(calls).toBe(0);
  });

  it('enforces the task budget and cancellation at the bridge boundary', async () => {
    let calls = 0;
    const bridge = createDocumentToolCallingBridge({
      bindings: [binding('read_document_structure', async () => { calls += 1; return { ok: true }; }), binding('aggregate_data')],
      budgetUnits: 1,
      maxCalls: 8,
      timeoutMs: 1_000
    });
    const signal = new AbortController();
    signal.abort();
    const cancelled = await bridge.bridge.execute({
      call: { id: 'call-cancelled', name: 'read_document_structure', arguments: {} },
      signal: signal.signal
    });
    const first = await bridge.bridge.execute({
      call: { id: 'call-first', name: 'read_document_structure', arguments: {} },
      signal: new AbortController().signal
    });
    const overBudget = await bridge.bridge.execute({
      call: { id: 'call-over', name: 'aggregate_data', arguments: {} },
      signal: new AbortController().signal
    });

    expect(cancelled).toMatchObject({ ok: false, errorCode: 'cancelled' });
    expect(first).toMatchObject({ ok: true });
    expect(overBudget).toMatchObject({ ok: false, errorCode: 'budget_exceeded' });
    expect(calls).toBe(1);
    expect(bridge.spentCostUnits()).toBe(1);
  });

  it('advertises only bound tools and rejects tools absent from this task', async () => {
    const bridge = bridgeWith(binding('read_document_structure'));
    expect(await invoke(bridge, 'unbound', {}, 'apply_document_patch')).toMatchObject({
      ok: false, errorCode: 'tool_not_allowed'
    });
    expect(bridge.spentCostUnits()).toBe(0);
  });

  it('rechecks live authorization for each distinct call without charging refused calls', async () => {
    let allowed = true;
    const execute = vi.fn(async () => ({ revision: 3 }));
    const authorize = vi.fn(async () => allowed);
    const bridge = bridgeWith({ ...binding('read_document_structure', execute), authorize });
    expect(await invoke(bridge, 'allowed')).toMatchObject({ ok: true });
    allowed = false;
    expect(await invoke(bridge, 'revoked')).toMatchObject({ ok: false, errorCode: 'authorization_or_revision_invalid' });
    expect(authorize).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(bridge.spentCostUnits()).toBe(1);
  });

  it('deduplicates concurrent calls and rejects reuse with a different payload', async () => {
    const execute = vi.fn(async () => ({ revision: 4 }));
    const bridge = bridgeWith(binding('apply_document_patch', execute));
    const first = invoke(bridge, 'same', { section: 'summary', input: 'new text' }, 'apply_document_patch');
    const duplicate = invoke(bridge, 'same', { input: 'new text', section: 'summary' }, 'apply_document_patch');
    const conflict = invoke(bridge, 'same', { section: 'other' }, 'apply_document_patch');
    expect(await first).toEqual(await duplicate);
    expect(await conflict).toMatchObject({ ok: false, errorCode: 'call_id_conflict' });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(bridge.spentCostUnits()).toBe(4);
  });

  it('bounds calls including authorization failures', async () => {
    const authorize = vi.fn(async () => false);
    const bridge = createDocumentToolCallingBridge({
      bindings: [{ ...binding('read_document_structure'), authorize }], budgetUnits: 16, maxCalls: 1, timeoutMs: 100
    });
    await invoke(bridge, 'first');
    expect(await invoke(bridge, 'second')).toMatchObject({ ok: false, errorCode: 'tool_call_limit' });
    expect(authorize).toHaveBeenCalledTimes(1);
  });

  it.each(['timeout', 'cancel'] as const)('blocks queued work after a write %s, even if the host finishes late', async (stop) => {
    vi.useFakeTimers();
    let finish!: (data: Readonly<Record<string, unknown>>) => void;
    let started!: () => void;
    const starting = new Promise<void>(resolve => { started = resolve; });
    let executionSignal: AbortSignal | undefined;
    const execute = vi.fn(async (_request, context) => {
      executionSignal = context.signal;
      started();
      return new Promise<Readonly<Record<string, unknown>>>(resolve => { finish = resolve; });
    });
    const read = vi.fn(async () => ({}));
    const bridge = bridgeWith(binding('apply_document_patch', execute), binding('read_document_structure', read));
    const controller = new AbortController();
    const pending = bridge.bridge.execute({ call: { id: 'write', name: 'apply_document_patch', arguments: {} }, signal: controller.signal });
    const queued = invoke(bridge, 'queued');
    await starting;
    if (stop === 'cancel') controller.abort();
    else await vi.advanceTimersByTimeAsync(1_000);
    expect(await pending).toMatchObject({ ok: false, errorCode: stop === 'cancel' ? 'cancelled' : 'tool_timeout', outcomeUnknown: true });
    expect(executionSignal?.aborted).toBe(true);
    expect(await queued).toMatchObject({ errorCode: 'reconciliation_required' });
    finish({ revision: 4 });
    expect(await invoke(bridge, 'late')).toMatchObject({ errorCode: 'reconciliation_required' });
    expect(read).not.toHaveBeenCalled();
  });

  it('times out authorization without executing or charging the tool', async () => {
    vi.useFakeTimers();
    const execute = vi.fn(async () => ({}));
    const bridge = bridgeWith({ ...binding('apply_document_patch', execute), authorize: () => new Promise(() => undefined) });
    const pending = invoke(bridge, 'slow-auth', {}, 'apply_document_patch');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await pending).toMatchObject({ ok: false, errorCode: 'tool_timeout', outcomeUnknown: false });
    expect(execute).not.toHaveBeenCalled();
    expect(bridge.spentCostUnits()).toBe(0);
  });

  it('redacts nested observations and never returns raw exception details', async () => {
    const bridge = bridgeWith(binding('read_document_structure', async () => ({
      revision: 3, path: 'C:\\private\\draft.pptx',
      items: [{ summary: 'File C:\\private\\draft.pptx and https://example.test/private', apiKey: 'private-value' }]
    })));
    const result = await invoke(bridge, 'safe');
    expect(result).toMatchObject({ ok: true, result: { revision: 3, items: [{ summary: 'File [redacted] and [redacted]' }] } });
    expect(JSON.stringify(result)).not.toContain('private');
    const failed = bridgeWith(binding('apply_document_patch', async () => { throw new Error('C:\\private\\draft.pptx'); }));
    expect(await invoke(failed, 'failed', {}, 'apply_document_patch')).toMatchObject({ ok: false, errorCode: 'tool_failed', outcomeUnknown: true });
    expect(await invoke(failed, 'next', {}, 'apply_document_patch')).toMatchObject({ errorCode: 'reconciliation_required' });
  });

  it('rejects oversized observations', async () => {
    const bridge = bridgeWith(binding('read_document_structure', async () => ({ text: 'x'.repeat(8_001) })));
    expect(await invoke(bridge, 'large')).toMatchObject({ ok: false, errorCode: 'tool_failed' });
  });

  it.each([
    {}, { revision: 1.5, mode: 'summary' }, { revision: 0, mode: 'summary' },
    { revision: 1, mode: 'unknown' }, { revision: 1, mode: 'summary', flag: 'true' },
    { revision: 1, mode: 'summary', extra: 'field' }, Object.create({ revision: 1, mode: 'summary' })
  ])('rejects malformed fields before authorization: %j', async (args) => {
    const authorize = vi.fn(async () => true);
    const bridge = bridgeWith({ ...binding('read_document_structure'), authorize, fields: {
      revision: { type: 'integer', minimum: 1, maximum: 3, required: true },
      mode: { type: 'string', maxLength: 8, enum: ['summary'], required: true },
      flag: { type: 'boolean' }
    } });
    expect(await invoke(bridge, 'invalid', args)).toMatchObject({ errorCode: 'invalid_tool_arguments' });
    expect(authorize).not.toHaveBeenCalled();
  });
});

function invoke(bridge: ReturnType<typeof bridgeWith>, id: string, args = {}, name = 'read_document_structure') {
  return bridge.bridge.execute({ call: { id, name, arguments: args }, signal: new AbortController().signal });
}
