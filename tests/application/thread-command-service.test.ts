import { describe, expect, it } from 'vitest';
import { ThreadCommandService, type ThreadCommandRepository } from '../../src/application/thread-command-service';
import { toIsoTimestamp, toProjectId, toThreadId, type ItemV1, type ThreadV1, type TurnV1 } from '../../src/domain';

function repository() {
  let thread: ThreadV1 | undefined;
  const turns: TurnV1[] = [];
  const items: ItemV1[] = [];
  const commands = new Map<string, { thread: ThreadV1 }>();
  const repo: ThreadCommandRepository = {
    async getThread() { return thread; },
    async createThread(input) {
      if (thread) throw new Error('thread_already_exists');
      thread = { schemaVersion: 1, threadId: input.threadId, projectId: input.projectId, title: input.title, status: 'active', createdAt: input.createdAt, updatedAt: input.createdAt, lastItemSequence: 0, itemCount: 0, turnCount: 0, generation: 0 };
      return thread!;
    },
    async readTurns() { return turns; },
    async readItems() { return items; },
    async append(input: Parameters<ThreadCommandRepository['append']>[0]) {
      const existing = commands.get(input.idempotencyKey);
      if (existing) return { ...existing, alreadyCommitted: true };
      if (!thread) throw new Error('thread_not_found');
      if (input.expectedGeneration !== thread.generation) throw new Error('generation_conflict');
      turns.push(...(input.turns ?? []));
      items.push(...(input.items ?? []));
      thread = { ...thread, generation: thread.generation + 1, lastItemSequence: items.at(-1)?.sequence ?? thread.lastItemSequence, itemCount: items.length, turnCount: turns.length, updatedAt: input.occurredAt };
      const result = { thread: thread!, alreadyCommitted: false };
      commands.set(input.idempotencyKey, result);
      return result;
    }
  };
  return repo;
}

describe('ThreadCommandService', () => {
  it('reuses the original Turn for the same committed User Item across Host commands', async () => {
    const repo = repository(), service = new ThreadCommandService(repo);
    const input = { threadId: toThreadId('thread-command'), projectId: toProjectId('project-command'), title: '命令测试',
      messageId: 'message-command', content: '你好', createdAt: toIsoTimestamp('2026-10-10T00:00:00.000Z'), clientCommandId: 'user-command' };
    const first = await service.acceptUserTurn(input);
    const existing = await service.acceptUserTurn({ ...input, clientCommandId: 'workflow-execute' });
    expect(existing.turn.turnId).toBe(first.turn.turnId);
    expect(existing.thread.generation).toBe(first.thread.generation);
    expect((await repo.readTurns(input.threadId))).toHaveLength(1);
    await expect(service.acceptUserTurn({ ...input, clientCommandId: 'bad-replay', content: 'different content' })).rejects.toThrow('thread_user_item_conflict');
  });
  it('accepts one native turn and returns the same facts on an idempotent retry', async () => {
    const repo = repository();
    const service = new ThreadCommandService(repo);
    const input = { threadId: toThreadId('thread-command'), projectId: toProjectId('project-command'), title: '命令测试', messageId: 'message-command', content: '你好', createdAt: toIsoTimestamp('2026-10-10T00:00:00.000Z'), clientCommandId: 'command-1' };
    const first = await service.acceptUserTurn(input);
    const second = await service.acceptUserTurn(input);
    expect(first.alreadyCommitted).toBe(false);
    expect(second.alreadyCommitted).toBe(true);
    expect(second.turn.turnId).toBe(first.turn.turnId);
    expect(second.item.itemId).toEqual(first.item.itemId);
    expect(second.thread.generation).toBe(first.thread.generation);
  });
});
