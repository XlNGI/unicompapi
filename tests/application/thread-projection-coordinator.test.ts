import { describe, expect, it } from 'vitest';
import { ThreadProjectionCoordinator } from '../../src/application/thread-projection-coordinator';
import { createThreadV1, createTurnV1, toIsoTimestamp, toMessageItemId, toProjectId, toThreadId, toTurnId, type ItemV1, type ThreadV1, type TurnExecutionLinkV1, type TurnV1 } from '../../src/domain';

function repository() {
  const threadId = toThreadId('thread-projection');
  let thread: ThreadV1 = { ...createThreadV1({ threadId, projectId: toProjectId('project-projection'), title: '投影测试', createdAt: toIsoTimestamp('2026-10-10T00:00:00.000Z') }), generation: 1, turnCount: 1 };
  const turn = createTurnV1({ turnId: toTurnId('turn-projection'), threadId, turnSequence: 1, createdAt: toIsoTimestamp('2026-10-10T00:00:00.000Z'), userItemId: toMessageItemId('message-projection'), provenance: 'native' });
  const turns: TurnV1[] = [turn];
  const items: ItemV1[] = [];
  const links: TurnExecutionLinkV1[] = [];
  const commands = new Set<string>();
  return {
    async getThread() { return thread; },
    async readTurns() { return turns; },
    async readExecutionLinks() { return links; },
    async readItems() { return items; },
    async append(input: { idempotencyKey: string; turns?: readonly TurnV1[]; items?: readonly ItemV1[]; executionLinks?: readonly TurnExecutionLinkV1[] }) {
      if (commands.has(input.idempotencyKey)) return { thread, alreadyCommitted: true };
      commands.add(input.idempotencyKey);
      if (input.turns) turns.splice(0, turns.length, ...input.turns);
      if (input.items) items.push(...input.items);
      if (input.executionLinks) links.push(...input.executionLinks);
      thread = { ...thread, generation: thread.generation + 1 };
      return { thread, alreadyCommitted: false };
    }
  };
}

describe('ThreadProjectionCoordinator', () => {
  it('links one Agent Run to a Turn and treats replay as idempotent', async () => {
    const repo = repository();
    const coordinator = new ThreadProjectionCoordinator(repo);
    const input = { threadId: 'thread-projection', turnId: 'turn-projection', agentRunId: 'agent-run-projection', responseExecutionId: 'response-projection', createdAt: toIsoTimestamp('2026-10-10T00:00:01.000Z') };
    const first = await coordinator.linkExecution(input);
    const second = await coordinator.linkExecution(input);
    expect(first.alreadyCommitted).toBe(false);
    expect(second.alreadyCommitted).toBe(true);
    expect(second.link.linkSequence).toBe(1);
    expect(repo.readExecutionLinks).toBeDefined();
  });

  it('projects one verified Work as an idempotent artifact Item', async () => {
    const repo = repository();
    const coordinator = new ThreadProjectionCoordinator(repo);
    const input = { threadId: 'thread-projection', sourceMessageId: 'message-projection', workId: 'work-projection',
      responseExecutionId: 'response-projection', status: 'completed' as const, content: '报告.pptx',
      createdAt: toIsoTimestamp('2026-10-10T00:00:01.000Z'), updatedAt: toIsoTimestamp('2026-10-10T00:00:02.000Z') };
    const first = await coordinator.projectDocumentArtifact(input);
    const second = await coordinator.projectDocumentArtifact(input);
    expect(first.alreadyCommitted).toBe(false);
    expect(first.item.type).toBe('document_artifact_projection');
    expect(String(first.item.projectionSource?.workId)).toBe('work-projection');
    expect(second.alreadyCommitted).toBe(true);
    expect(second.item.itemId).toEqual(first.item.itemId);
  });

  it('projects Tool Call and Tool Result as separate idempotent Items', async () => {
    const repo = repository();
    const coordinator = new ThreadProjectionCoordinator(repo);
    const common = { threadId: 'thread-projection', sourceMessageId: 'message-projection', toolCallId: 'step-1', toolId: 'generate_pptx',
      responseExecutionId: 'response-projection', agentRunId: 'run-projection', status: 'completed' as const,
      content: 'generate_pptx', createdAt: toIsoTimestamp('2026-10-10T00:00:01.000Z'), updatedAt: toIsoTimestamp('2026-10-10T00:00:02.000Z') };
    const call = await coordinator.projectTool({ ...common, kind: 'tool_call_projection' });
    const result = await coordinator.projectTool({ ...common, kind: 'tool_result_projection', content: 'completed' });
    const replay = await coordinator.projectTool({ ...common, kind: 'tool_result_projection', content: 'changed' });
    expect(call.item.type).toBe('tool_call_projection');
    expect(result.item.type).toBe('tool_result_projection');
    expect(replay.alreadyCommitted).toBe(true);
    expect(replay.item.itemId).toEqual(result.item.itemId);
  });
});
