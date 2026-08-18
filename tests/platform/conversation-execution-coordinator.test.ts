import { describe, expect, it, vi } from 'vitest';
import { toConversationResponseExecutionId } from '../../src/domain';
import {
  ConversationExecutionCoordinator,
  ConversationExecutionCoordinatorError
} from '../../src/platform';

describe('ConversationExecutionCoordinator', () => {
  it('acknowledges cancellation without waiting for provider completion', async () => {
    const coordinator = new ConversationExecutionCoordinator();
    const executionId = toConversationResponseExecutionId('response-execution-cancel');
    let finish!: () => void;
    const completion = new Promise<void>((resolve) => { finish = resolve; });
    const cancel = vi.fn(async () => true);
    coordinator.register({
      responseExecutionId: executionId,
      providerOperationId: 'provider-operation-cancel',
      cancel,
      completion
    });

    let completed = false;
    void completion.then(() => { completed = true; });
    const cancellation = coordinator.cancel(executionId);
    expect(cancel).toHaveBeenCalledTimes(1);
    await expect(cancellation).resolves.toBe(true);
    expect(completed).toBe(false);

    finish();
    await Promise.resolve();
    expect(coordinator.has(executionId)).toBe(false);
  });

  it('runs the bounded timeout fallback when provider completion stalls', async () => {
    vi.useFakeTimers();
    try {
      const coordinator = new ConversationExecutionCoordinator(25);
      const executionId = toConversationResponseExecutionId('response-execution-timeout');
      let finish!: () => void;
      const completion = new Promise<void>((resolve) => { finish = resolve; });
      const onCancellationTimeout = vi.fn(async () => undefined);
      coordinator.register({
        responseExecutionId: executionId,
        providerOperationId: 'provider-operation-timeout',
        cancel: async () => true,
        completion,
        onCancellationTimeout
      });

      await expect(coordinator.cancel(executionId)).resolves.toBe(true);
      await vi.advanceTimersByTimeAsync(24);
      expect(onCancellationTimeout).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(onCancellationTimeout).toHaveBeenCalledTimes(1);
      finish();
      await Promise.resolve();
    } finally {
      vi.useRealTimers();
    }
  });

  it('deduplicates concurrent cancellation and rejects duplicate active registration', async () => {
    const coordinator = new ConversationExecutionCoordinator();
    const executionId = toConversationResponseExecutionId('response-execution-dedupe');
    const cancel = vi.fn(async () => true);
    const completion = Promise.resolve();
    const operation = {
      responseExecutionId: executionId,
      providerOperationId: 'provider-operation-dedupe',
      cancel,
      completion
    };
    coordinator.register(operation);
    expect(() => coordinator.register(operation)).toThrow(ConversationExecutionCoordinatorError);

    await expect(Promise.all([
      coordinator.cancel(executionId),
      coordinator.cancel(executionId)
    ])).resolves.toEqual([true, true]);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('queues cancellation until a provider handle is registered', async () => {
    const coordinator = new ConversationExecutionCoordinator();
    const executionId = toConversationResponseExecutionId('response-execution-pending-cancel');
    const cancel = vi.fn(async () => true);
    const completion = new Promise<void>(() => undefined);

    await expect(coordinator.cancel(executionId)).resolves.toBe(true);
    coordinator.register({
      responseExecutionId: executionId,
      providerOperationId: 'provider-operation-pending-cancel',
      cancel,
      completion
    });

    await Promise.resolve();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('keeps a timed-out pending cancellation effective for a late provider handle', async () => {
    vi.useFakeTimers();
    try {
      const coordinator = new ConversationExecutionCoordinator(25);
      const executionId = toConversationResponseExecutionId('response-execution-late-cancel');
      const cancel = vi.fn(async () => true);
      const onCancellationTimeout = vi.fn(async () => undefined);
      const completion = new Promise<void>(() => undefined);

      await expect(coordinator.cancel(executionId, onCancellationTimeout)).resolves.toBe(true);
      await vi.advanceTimersByTimeAsync(25);
      expect(onCancellationTimeout).toHaveBeenCalledTimes(1);

      coordinator.register({
        responseExecutionId: executionId,
        providerOperationId: 'provider-operation-late-cancel',
        cancel,
        completion
      });
      await Promise.resolve();
      expect(cancel).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('waits for every registered provider completion during application shutdown', async () => {
    const coordinator = new ConversationExecutionCoordinator();
    let finishFirst!: () => void;
    let finishSecond!: () => void;
    const firstCompletion = new Promise<void>((resolve) => { finishFirst = resolve; });
    const secondCompletion = new Promise<void>((resolve) => { finishSecond = resolve; });
    const firstCancel = vi.fn(async () => true);
    const secondCancel = vi.fn(async () => true);
    coordinator.register({
      responseExecutionId: toConversationResponseExecutionId('response-execution-all-first'),
      providerOperationId: 'provider-operation-all-first',
      cancel: firstCancel,
      completion: firstCompletion
    });
    coordinator.register({
      responseExecutionId: toConversationResponseExecutionId('response-execution-all-second'),
      providerOperationId: 'provider-operation-all-second',
      cancel: secondCancel,
      completion: secondCompletion
    });

    let settled = false;
    const cancellation = coordinator.cancelAll().then((count) => {
      settled = true;
      return count;
    });
    await Promise.resolve();
    expect(firstCancel).toHaveBeenCalledTimes(1);
    expect(secondCancel).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);

    finishFirst();
    await Promise.resolve();
    expect(settled).toBe(false);
    finishSecond();
    await expect(cancellation).resolves.toBe(2);
  });
});
