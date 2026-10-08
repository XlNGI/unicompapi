import { describe, expect, it } from 'vitest';
import type { ThreadSummaryDto } from '../../src/shared/chat-context-ipc';
import {
  createThreadSummaryStore,
  mergeThreadSummaryStore,
  threadSummaryStoreItems
} from '../../src/pages/chat/threadSummaryStore';

function summary(threadId: string, revision: number, updatedAt: string): ThreadSummaryDto {
  return {
    threadId,
    conversationId: threadId,
    revision,
    projectId: 'project-1',
    title: threadId,
    status: 'active',
    storageScope: 'current_project',
    readOnly: false,
    createdAt: updatedAt,
    updatedAt,
    messageCount: revision,
    turnCount: revision,
    hasActiveDocumentGeneration: false
  };
}

describe('Thread summary renderer store', () => {
  it('keeps summary identity separate from Item state', () => {
    const first = summary('thread-1', 1, '2026-01-01T00:00:01.000Z');
    const store = createThreadSummaryStore([first]);
    const merged = mergeThreadSummaryStore(store, [summary('thread-2', 1, '2026-01-01T00:00:02.000Z')]);
    expect(threadSummaryStoreItems(merged).map((item) => item.threadId)).toEqual(['thread-2', 'thread-1']);
    expect(merged.summaryById.get('thread-1')).toBe(first);
  });

  it('ignores stale summary revisions', () => {
    const first = summary('thread-1', 2, '2026-01-01T00:00:02.000Z');
    const store = createThreadSummaryStore([first]);
    const merged = mergeThreadSummaryStore(store, [summary('thread-1', 1, '2026-01-01T00:00:03.000Z')]);
    expect(merged.summaryById.get('thread-1')).toBe(first);
  });
});
