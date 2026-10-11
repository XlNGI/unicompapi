import { describe, expect, it, vi } from 'vitest';
import { ConversationContextReader } from '../../src/application/conversation-context-reader';

describe('ConversationContextReader', () => {
  it('composes Thread, execution, Agent and document facts without using Legacy messages', async () => {
    const reader = new ConversationContextReader(
      { getThread: vi.fn(async () => ({ threadId: 'thread-context', projectId: 'project-context' })), readItems: vi.fn(async () => [{ itemId: { namespace: 'message', value: 'message-1' }, sequence: 1 }]) } as never,
      { list: vi.fn(async () => [{ id: 'run-1' }]) } as never,
      { list: vi.fn(async () => [{ id: 'execution-1' }]) } as never,
      { list: vi.fn(async () => [{ id: 'task-1' }]) } as never,
      { list: vi.fn(async () => [{ id: 'work-1', sourceTaskId: 'task-1', sourceExecutionId: 'execution-1' }]) } as never
    );
    const context = await reader.read('thread-context');
    expect(context.items).toHaveLength(1);
    expect(context.agentRuns).toHaveLength(1);
    expect(context.executions).toHaveLength(1);
    expect(context.documentTasks).toHaveLength(1);
    expect(context.works).toHaveLength(1);
  });
});
