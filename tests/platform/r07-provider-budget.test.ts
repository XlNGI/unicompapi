import { afterEach, describe, expect, it, vi } from 'vitest';
import { HostExecutionBudget } from '../../src/application/execution-budget';
import { runControlledProviderToolRounds, type ControlledProviderToolRoundResponse } from '../../src/platform/providers/provider-tool-calling';

const owners: HostExecutionBudget[] = [];
afterEach(() => { owners.splice(0).forEach(owner => owner.dispose()); vi.useRealTimers(); });
const call = (id: string) => ({ id, name: 'generate_pptx', arguments: { title: 'Local fixture', content: 'Local fixture' } });
function owner(timeout = 360_000) {
  const result = new HostExecutionBudget({ startedAt: Date.now(), deadlineAt: Date.now() + timeout,
    maxToolCalls: 8, budgetUnits: 24 }); owners.push(result); return result;
}

describe('R07 shared provider budget', () => {
  it('allows the 92s + 25s + 91s sequence within its fixed parent deadline, including the initial request', async () => {
    vi.useFakeTimers();
    const parent = owner();
    const initial = parent.run('model', () => new Promise<void>(resolve => setTimeout(resolve, 20_000)));
    await vi.advanceTimersByTimeAsync(20_000); await initial;
    let tools = 0;
    let models = 0;
    let secondSignal: AbortSignal | undefined;
    const messages: string[] = [];
    const response = runControlledProviderToolRounds<string, ControlledProviderToolRoundResponse>({
      initialResponse: { finishReason: 'tool_calls', toolCalls: [call('first')] }, messages,
      signal: new AbortController().signal, executionBudget: parent,
      shouldContinue: value => value.finishReason === 'tool_calls',
      appendAssistant: () => undefined, appendTool: (_call, value, target) => target.push(String(value.status)),
      bridge: { execute: ({ call: tool, signal }) => {
        parent.reserveToolCall(`tool:${tool.id}`, 8); tools += 1;
        if (tools === 2) secondSignal = signal;
        return new Promise(resolve => setTimeout(() => resolve({ schemaVersion: 1, status: 'success', observation: { ok: true } }), tools === 1 ? 92_000 : 91_000));
      } },
      requestNext: async (_messages, signal) => {
        expect(signal.aborted).toBe(false); models += 1;
        if (models === 1) return new Promise(resolve => setTimeout(() => resolve({ finishReason: 'tool_calls', toolCalls: [call('second')] }), 25_000));
        return { finishReason: 'stop', content: 'done' };
      }, toLoopError: code => new Error(code)
    });
    await vi.advanceTimersByTimeAsync(92_000);
    await vi.advanceTimersByTimeAsync(25_000);
    expect(tools).toBe(2);
    expect(secondSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(91_000);
    await expect(response).resolves.toMatchObject({ content: 'done' });
    expect(messages).toEqual(['success', 'success']);
    expect(parent.stopReason).toBeUndefined();
    expect(parent.snapshot('cancelled')).toMatchObject({ toolCallsUsed: 2, costUnitsUsed: 16 });
  });

  it('settles a hanging tool at the deadline and never requests another model round', async () => {
    vi.useFakeTimers();
    const parent = owner(10_000);
    let child: AbortSignal | undefined;
    const next = vi.fn(async () => ({ finishReason: 'stop' }));
    const result = runControlledProviderToolRounds<string, ControlledProviderToolRoundResponse>({ initialResponse: { finishReason: 'tool_calls', toolCalls: [call('hang')] },
      messages: [] as string[], signal: new AbortController().signal, executionBudget: parent,
      shouldContinue: value => value.finishReason === 'tool_calls', appendAssistant: () => undefined, appendTool: () => undefined,
      bridge: { execute: ({ signal }) => { child = signal; return new Promise(() => undefined); } }, requestNext: next,
      toLoopError: code => new Error(code) });
    const rejected = expect(result).rejects.toThrow('timeout');
    await vi.advanceTimersByTimeAsync(10_000); await rejected;
    expect(child?.aborted).toBe(true); expect(next).not.toHaveBeenCalled();
  });
});
