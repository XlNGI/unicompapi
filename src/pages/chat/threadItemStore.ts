import type { ThreadItemDto } from '../../shared/chat-context-ipc';

/**
 * Renderer read model for one Thread. The Map is the identity authority for
 * rendered Items; orderedItemIds is only the stable viewport order.
 */
export interface ThreadItemStore {
  readonly itemById: ReadonlyMap<string, ThreadItemDto>;
  readonly orderedItemIds: readonly string[];
  readonly readAtSequence: number;
  readonly olderCursor?: string;
  readonly hasOlder: boolean;
  readonly complete: boolean;
}

export function threadItemKey(item: Pick<ThreadItemDto, 'itemId'>): string {
  return `${item.itemId.namespace}:${item.itemId.value}`;
}

function sameItem(left: ThreadItemDto, right: ThreadItemDto): boolean {
  if (left === right) return true;
  return left.sequence === right.sequence &&
    left.updatedAt === right.updatedAt &&
    left.status === right.status &&
    left.messageId === right.messageId &&
    left.message?.revision === right.message?.revision &&
    left.message?.content === right.message?.content &&
    left.message?.reasoningContent === right.message?.reasoningContent;
}

function orderedIds(items: ReadonlyMap<string, ThreadItemDto>): readonly string[] {
  return [...items.values()]
    .sort((left, right) => left.sequence - right.sequence || threadItemKey(left).localeCompare(threadItemKey(right)))
    .map(threadItemKey);
}

export function createThreadItemStore(
  items: readonly ThreadItemDto[],
  options: Pick<ThreadItemStore, 'readAtSequence' | 'hasOlder' | 'complete'> &
    Partial<Pick<ThreadItemStore, 'olderCursor'>>
): ThreadItemStore {
  const itemById = new Map<string, ThreadItemDto>();
  for (const item of items) itemById.set(threadItemKey(item), item);
  return {
    itemById,
    orderedItemIds: orderedIds(itemById),
    readAtSequence: options.readAtSequence,
    ...(options.olderCursor ? { olderCursor: options.olderCursor } : {}),
    hasOlder: options.hasOlder,
    complete: options.complete
  };
}

export function threadItemStoreItems(store: ThreadItemStore | undefined): readonly ThreadItemDto[] {
  if (!store) return [];
  return store.orderedItemIds.flatMap((id) => {
    const item = store.itemById.get(id);
    return item ? [item] : [];
  });
}

export function mergeThreadItemStore(
  current: ThreadItemStore | undefined,
  incoming: readonly ThreadItemDto[],
  options: Partial<Pick<ThreadItemStore, 'readAtSequence' | 'olderCursor' | 'hasOlder' | 'complete'>> = {}
): ThreadItemStore {
  const itemById = new Map(current?.itemById ?? []);
  let orderMayChange = !current;
  for (const item of incoming) {
    const key = threadItemKey(item);
    const previous = itemById.get(key);
    if (!previous) {
      orderMayChange = true;
      itemById.set(key, item);
    } else {
      if (previous.sequence !== item.sequence) orderMayChange = true;
      if (!sameItem(previous, item)) itemById.set(key, item);
    }
  }
  const order = current?.orderedItemIds;
  const candidateOrder = orderMayChange ? orderedIds(itemById) : order ?? [];
  const nextOrder = orderMayChange ? candidateOrder : order ?? candidateOrder;
  const hasOlder = options.hasOlder ?? current?.hasOlder ?? false;
  const nextCursor = options.olderCursor;
  return {
    itemById,
    orderedItemIds: nextOrder,
    readAtSequence: options.readAtSequence ?? current?.readAtSequence ?? 0,
    ...(nextCursor ? { olderCursor: nextCursor } : {}),
    hasOlder,
    complete: options.complete ?? current?.complete ?? false
  };
}

export function upsertThreadItem(
  current: ThreadItemStore | undefined,
  item: ThreadItemDto,
  options: Partial<Pick<ThreadItemStore, 'readAtSequence' | 'hasOlder' | 'complete'>> = {}
): ThreadItemStore {
  return mergeThreadItemStore(current, [item], options);
}
