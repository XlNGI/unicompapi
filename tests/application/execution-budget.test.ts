import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExecutionBudgetError, HostExecutionBudget } from '../../src/application/execution-budget';

const budgets: HostExecutionBudget[] = [];
afterEach(() => { budgets.splice(0).forEach(budget => budget.dispose()); vi.useRealTimers(); });
function budget(timeoutMs = 360_000, signal?: AbortSignal) {
  const value = new HostExecutionBudget({ startedAt: Date.now(), deadlineAt: Date.now() + timeoutMs,
    maxToolCalls: 8, budgetUnits: 24 }, { signal });
  budgets.push(value);
  return value;
}
describe('host execution budget', () => {
  it('observes synchronous cancellation before a plugin throws and preserves the first stop reason', async () => {
    const owner = budget();
    await expect(owner.run('prepare', () => { owner.cancel('cancelled'); throw new Error('synchronous plugin failure'); }))
      .rejects.toMatchObject({ code: 'cancelled' });
    await new Promise(resolve => setImmediate(resolve));
  });

  it('records remaining time on user cancellation without permitting another operation', () => {
    vi.useFakeTimers();
    const owner = budget(360_000);
    vi.advanceTimersByTime(40_000);
    owner.cancel('cancelled');
    expect(owner.snapshot('cancelled').parentRemainingMs).toBe(320_000);
    expect(owner.remainingMs()).toBe(0);
    expect(() => owner.assertCanProceed('tool')).toThrow('cancelled');
  });
  it('aborts an uncooperative running operation at the parent deadline without another event', async () => {
    vi.useFakeTimers();
    const owner = budget(360_000);
    let child: AbortSignal | undefined;
    const operation = owner.run('tool', signal => { child = signal; return new Promise(() => undefined); });
    const rejected = expect(operation).rejects.toMatchObject({ code: 'timeout', scope: 'execution' });
    await vi.advanceTimersByTimeAsync(360_000);
    await rejected;
    expect(child?.aborted).toBe(true);
    expect(owner.stopReason).toBe('timeout');
    expect(owner.remainingMs()).toBe(0);
    expect(() => owner.reserveToolCall('late', 1)).toThrow(ExecutionBudgetError);
  });

  it('preserves first-model time and never resets on progress or subsequent stages', async () => {
    vi.useFakeTimers();
    const owner = budget(360_000);
    const wait = (milliseconds: number) => owner.run('model', () => new Promise<void>(resolve => setTimeout(resolve, milliseconds)));
    const first = wait(40_000);
    await vi.advanceTimersByTimeAsync(40_000); await first;
    const second = wait(250_000);
    await vi.advanceTimersByTimeAsync(250_000); await second;
    expect(owner.remainingMs()).toBeLessThanOrEqual(70_000);
    const hanging = owner.run('tool', () => new Promise(() => undefined));
    const rejected = expect(hanging).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(70_000);
    await rejected;
  });

  it('keeps a local preparation cap distinct from a parent timeout and cancels its child', async () => {
    vi.useFakeTimers();
    const owner = budget();
    let child: AbortSignal | undefined;
    const preparation = owner.run('prepare', signal => { child = signal; return new Promise(() => undefined); }, 15_000);
    const rejected = expect(preparation).rejects.toMatchObject({ code: 'timeout', scope: 'prepare' });
    await vi.advanceTimersByTimeAsync(15_000); await rejected;
    expect(child?.aborted).toBe(true);
    expect(owner.stopReason).toBeUndefined();
    expect(owner.remainingMs()).toBeGreaterThan(300_000);
  });

  it('charges trusted scheduling units once for idempotent claims and shares them across branches', () => {
    const owner = budget();
    expect(owner.reserveToolCall('tool:generate', 8)).toBe(true);
    expect(owner.reserveToolCall('tool:generate', 8)).toBe(false);
    expect(owner.reserveToolCall('tool:mutation', 8)).toBe(true);
    expect(owner.snapshot('cancelled')).toMatchObject({ toolCallsUsed: 2, costUnitsUsed: 16 });
    owner.reserveToolCall('tool:second', 8);
    expect(() => owner.reserveToolCall('tool:over-budget', 1)).toThrow('budget_exceeded');
    expect(owner.stopReason).toBe('budget_exceeded');
    expect(owner.signal.aborted).toBe(true);
  });

  it('never starts a planner after cancellation and observes late promise rejection', async () => {
    const controller = new AbortController();
    const owner = budget(360_000, controller.signal);
    let rejectLate!: (reason: unknown) => void;
    const pending = owner.run('repair', () => new Promise((_resolve, reject) => { rejectLate = reject; }));
    const rejected = expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    controller.abort(); await rejected;
    rejectLate(new Error('late planner result'));
    const next = vi.fn(async () => 'unexpected');
    await expect(owner.run('design', next)).rejects.toMatchObject({ code: 'cancelled' });
    expect(next).not.toHaveBeenCalled();
  });

  it('cleans timers and parent listeners without emitting a fake cancellation on completion', async () => {
    vi.useFakeTimers();
    const signal = new AbortController();
    const report = vi.fn();
    const owner = new HostExecutionBudget({ startedAt: Date.now(), deadlineAt: Date.now() + 10_000,
      maxToolCalls: 8, budgetUnits: 24 }, { signal: signal.signal, onDiagnostic: report });
    expect(await owner.run('model', async () => 'done')).toBe('done');
    owner.dispose();
    signal.abort();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(report).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
