import { describe, expect, it, vi } from 'vitest';
import type { MessageDto, ThreadItemDto } from '../../src/shared/chat-context-ipc';
import {
  createThreadItemStore,
  mergeThreadItemStore,
  threadItemKey,
  threadItemStoreItems
} from '../../src/pages/chat/threadItemStore';
import {
  appendThreadItemStreamContent,
  clearThreadItemStreamContent,
  getThreadItemStreamContent,
  setThreadItemStreamSnapshot,
  subscribeThreadItemStream
} from '../../src/pages/chat/threadItemStreamStore';
import { VirtualMessageLayoutIndex } from '../../src/pages/chat/VirtualMessageList';

function item(sequence: number, content = `message-${sequence}`): ThreadItemDto {
  const message: MessageDto = {
    messageId: `message-${sequence}`,
    conversationId: 'thread-1',
    revision: 1,
    role: sequence % 2 ? 'user' : 'assistant',
    state: 'completed',
    content,
    attachments: [],
    createdAt: `2026-01-01T00:00:0${sequence}.000Z`,
    updatedAt: `2026-01-01T00:00:0${sequence}.000Z`
  };
  return {
    itemId: { namespace: 'message', value: message.messageId },
    threadId: 'thread-1',
    sequence,
    itemType: message.role === 'user' ? 'user_message' : 'assistant_message',
    status: message.state,
    createdAt: message.createdAt,
    updatedAt: message.updatedAt,
    messageId: message.messageId,
    message
  };
}

describe('Thread Item renderer store', () => {
  it('indexes large history offsets and height updates logarithmically', () => {
    const heights = Array.from({ length: 100_000 }, () => 112);
    const layout = new VirtualMessageLayoutIndex(heights, 24);
    expect(layout.offsetOf(99_999)).toBe(99_999 * 136);
    expect(layout.itemAt(99_999 * 136 + 12)).toBe(99_999);
    expect(layout.update(50_000, 180)).toBe(true);
    expect(layout.offsetOf(99_999)).toBe(99_999 * 136 + 68);
    expect(layout.totalHeight).toBe(100_000 * 112 + 99_999 * 24 + 68);
  });

  it('notifies only subscribers for the changed Item and releases subscriptions', () => {
    const first = vi.fn();
    const second = vi.fn();
    const unsubscribe = subscribeThreadItemStream('message:first', first);
    const unsubscribeSecond = subscribeThreadItemStream('message:second', second);

    setThreadItemStreamSnapshot('message:first', 'snapshot');
    appendThreadItemStreamContent('message:first', ' delta');

    expect(getThreadItemStreamContent('message:first')).toBe('snapshot delta');
    expect(first).toHaveBeenCalledTimes(2);
    expect(second).not.toHaveBeenCalled();
    unsubscribe();
    clearThreadItemStreamContent('message:first');
    expect(first).toHaveBeenCalledTimes(2);
    unsubscribeSecond();
  });

  it('restores a complete snapshot before accepting resumed deltas', () => {
    setThreadItemStreamSnapshot('message:resume', 'latest before remount');
    const changed = vi.fn();
    const unsubscribe = subscribeThreadItemStream('message:resume', changed);
    expect(getThreadItemStreamContent('message:resume')).toBe('latest before remount');

    appendThreadItemStreamContent('message:resume', ' + next');
    expect(getThreadItemStreamContent('message:resume')).toBe('latest before remount + next');
    expect(changed).toHaveBeenCalledOnce();
    unsubscribe();
    clearThreadItemStreamContent('message:resume');
  });

  it('keeps identity keyed state and stable sequence order across page merges', () => {
    const first = item(2);
    const store = createThreadItemStore([first, item(3)], {
      readAtSequence: 3,
      hasOlder: true,
      complete: false,
      olderCursor: 'cursor-3'
    });
    const merged = mergeThreadItemStore(store, [item(1), first], {
      readAtSequence: 3,
      hasOlder: false,
      olderCursor: undefined
    });
    expect(merged.orderedItemIds).toEqual(['message:message-1', 'message:message-2', 'message:message-3']);
    expect(merged.itemById.get(threadItemKey(first))).toBe(first);
    expect(threadItemStoreItems(merged).map((entry) => entry.sequence)).toEqual([1, 2, 3]);
    expect(merged.hasOlder).toBe(false);
  });

  it('replaces only the changed Item object', () => {
    const store = createThreadItemStore([item(1), item(2)], { readAtSequence: 2, hasOlder: false, complete: false });
    const changed = item(2, 'updated');
    const merged = mergeThreadItemStore(store, [changed], { readAtSequence: 2 });
    expect(merged.itemById.get('message:message-1')).toBe(store.itemById.get('message:message-1'));
    expect(merged.itemById.get('message:message-2')).toBe(changed);
    expect(merged.orderedItemIds).toBe(store.orderedItemIds);
  });

  it('does not create a duplicate for replayed projection identity', () => {
    const projection: ThreadItemDto = {
      itemId: { namespace: 'projection', value: 'item-projection-v1:abc' },
      threadId: 'thread-1',
      turnId: 'turn-1',
      sequence: 4,
      itemType: 'tool_call_projection',
      status: 'streaming',
      createdAt: '2026-01-01T00:00:04.000Z',
      updatedAt: '2026-01-01T00:00:04.000Z',
      projectionSource: { eventSystem: 'agent_runtime', sourceIdentity: 'run-1/tool-1', toolCallId: 'tool-1' }
    };
    const store = createThreadItemStore([projection], { readAtSequence: 4, hasOlder: false, complete: false });
    const replayed = mergeThreadItemStore(store, [projection], { readAtSequence: 4 });
    expect(replayed.orderedItemIds).toEqual(['projection:item-projection-v1:abc']);
    expect(replayed.itemById.size).toBe(1);
    expect(replayed.itemById.get('projection:item-projection-v1:abc')).toBe(projection);
  });
});
