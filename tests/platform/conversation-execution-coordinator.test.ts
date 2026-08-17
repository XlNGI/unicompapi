import { describe, expect, it, vi } from 'vitest';
import { toConversationResponseExecutionId } from '../../src/domain';
import {
  ConversationExecutionCoordinator,
  ConversationExecutionCoordinatorError
} from '../../src/platform';

describe('ConversationExecutionCoordinator', () => {
  it('waits for the real provider completion before resolving a cancellation', async () => {
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

    let settled = false;
    const cancellation = coordinator.cancel(executionId).then((value) => {
      settled = true;
      return value;
    });
    await Promise.resolve();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);

    finish();
    await expect(cancellation).resolves.toBe(true);
    await Promise.resolve();
    expect(coordinator.has(executionId)).toBe(false);
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
