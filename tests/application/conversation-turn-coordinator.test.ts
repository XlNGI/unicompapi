import { describe, expect, it, vi } from 'vitest';
import { ConversationTurnCoordinator } from '../../src/application/conversation-turn-coordinator';
import { toIsoTimestamp } from '../../src/domain';
import type { AcceptedThreadTurn } from '../../src/application/thread-command-service';
import type { ThreadCommandService } from '../../src/application/thread-command-service';
import type { ThreadProjectionCoordinator } from '../../src/application/thread-projection-coordinator';

describe('ConversationTurnCoordinator', () => {
  it('delegates transcript acceptance and execution projection to the existing authorities', async () => {
    const accepted = { thread: { threadId: 'thread-1' }, turn: { turnId: 'turn-1' }, item: { itemId: 'item-1' }, alreadyCommitted: false } as unknown as AcceptedThreadTurn;
    const commands = { acceptUserTurn: vi.fn(async () => accepted) } as unknown as ThreadCommandService;
    const projections = {
      linkExecution: vi.fn(async input => ({ thread: { threadId: input.threadId }, link: { turnId: input.turnId }, alreadyCommitted: false })),
      projectAssistantMessage: vi.fn(async input => ({ thread: { threadId: input.threadId }, item: { itemId: input.assistantMessageId }, alreadyCommitted: false }))
    } as unknown as ThreadProjectionCoordinator;
    const coordinator = new ConversationTurnCoordinator(commands, projections);

    await expect(coordinator.acceptUserTurn({
      threadId: 'thread-1', projectId: 'project-1', title: '测试', messageId: 'message-1', content: '你好',
      createdAt: toIsoTimestamp('2026-10-11T00:00:00.000Z'), clientCommandId: 'command-1'
    })).resolves.toBe(accepted);
    await coordinator.linkExecution({
      threadId: 'thread-1', turnId: 'turn-1', agentRunId: 'run-1', responseExecutionId: 'execution-1',
      createdAt: toIsoTimestamp('2026-10-11T00:00:01.000Z')
    });
    await coordinator.projectAssistantMessage({
      threadId: 'thread-1', sourceMessageId: 'message-1', assistantMessageId: 'assistant-1', messageRevision: 1,
      status: 'completed', content: '完成', createdAt: toIsoTimestamp('2026-10-11T00:00:02.000Z'), updatedAt: toIsoTimestamp('2026-10-11T00:00:02.000Z')
    });

    expect(commands.acceptUserTurn).toHaveBeenCalledOnce();
    expect(projections.linkExecution).toHaveBeenCalledOnce();
    expect(projections.projectAssistantMessage).toHaveBeenCalledOnce();
  });

  it('does not own provider or document side effects', () => {
    const commands = { acceptUserTurn: vi.fn() } as unknown as ThreadCommandService;
    const projections = { linkExecution: vi.fn(), projectAssistantMessage: vi.fn() } as unknown as ThreadProjectionCoordinator;
    const coordinator = new ConversationTurnCoordinator(commands, projections);
    expect(coordinator).not.toHaveProperty('startProvider');
    expect(coordinator).not.toHaveProperty('generateDocument');
  });
});
