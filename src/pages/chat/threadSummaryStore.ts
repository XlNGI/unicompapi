import type { ThreadSummaryDto } from '../../shared/chat-context-ipc';

export interface ThreadSummaryStore {
  readonly summaryById: ReadonlyMap<string, ThreadSummaryDto>;
  readonly orderedThreadIds: readonly string[];
}

export function createThreadSummaryStore(items: readonly ThreadSummaryDto[] = []): ThreadSummaryStore {
  const summaryById = new Map<string, ThreadSummaryDto>();
  for (const item of items) summaryById.set(item.threadId, item);
  return {
    summaryById,
    orderedThreadIds: orderSummaryIds(summaryById)
  };
}

function orderSummaryIds(summaryById: ReadonlyMap<string, ThreadSummaryDto>): readonly string[] {
  return [...summaryById.values()]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.threadId.localeCompare(right.threadId))
    .map((item) => item.threadId);
}

export function threadSummaryStoreItems(store: ThreadSummaryStore): readonly ThreadSummaryDto[] {
  return store.orderedThreadIds.flatMap((id) => {
    const item = store.summaryById.get(id);
    return item ? [item] : [];
  });
}

export function replaceThreadSummaryStore(
  items: readonly ThreadSummaryDto[],
  previous?: ThreadSummaryStore
): ThreadSummaryStore {
  const summaryById = new Map<string, ThreadSummaryDto>();
  for (const item of items) {
    const prior = previous?.summaryById.get(item.threadId);
    summaryById.set(item.threadId, prior && prior.revision > item.revision ? prior : item);
  }
  return {
    summaryById,
    orderedThreadIds: orderSummaryIds(summaryById)
  };
}

export function mergeThreadSummaryStore(
  current: ThreadSummaryStore,
  incoming: readonly ThreadSummaryDto[]
): ThreadSummaryStore {
  const summaryById = new Map(current.summaryById);
  for (const item of incoming) {
    const previous = summaryById.get(item.threadId);
    if (!previous || previous.revision <= item.revision) summaryById.set(item.threadId, item);
  }
  const candidateOrder = orderSummaryIds(summaryById);
  const orderUnchanged = candidateOrder.length === current.orderedThreadIds.length &&
    candidateOrder.every((id, index) => id === current.orderedThreadIds[index]);
  return {
    summaryById,
    orderedThreadIds: orderUnchanged ? current.orderedThreadIds : candidateOrder
  };
}
