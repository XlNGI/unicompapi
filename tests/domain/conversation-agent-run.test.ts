import { describe, expect, it } from 'vitest';
import {
  attachConversationAgentRunExecution,
  createConversationAgentRun,
  InvalidStateTransitionError,
  toConversationAgentRunId,
  toConversationId,
  toConversationResponseExecutionId,
  toIsoTimestamp,
  toMessageId,
  toProjectId,
  transitionConversationAgentRun
} from '../../src/domain';

const projectId = toProjectId('project-agent-run-domain');
const conversationId = toConversationId('conversation-agent-run-domain');
const sourceMessageId = toMessageId('message-agent-run-domain');
const runId = toConversationAgentRunId('agent-run-domain');
const executionId = toConversationResponseExecutionId('response-execution-agent-run-domain');
const t0 = toIsoTimestamp('2026-09-30T10:00:00.000Z');
const t1 = toIsoTimestamp('2026-09-30T10:01:00.000Z');
const t2 = toIsoTimestamp('2026-09-30T10:02:00.000Z');

describe('conversation agent run domain contract', () => {
  it('models one response lifecycle independently from the conversation workflow', () => {
    const created = createConversationAgentRun({
      id: runId,
      projectId,
      conversationId,
      sourceMessageId,
      createdAt: t0
    });
    expect(created).toMatchObject({ revision: 0, status: 'running' });

    const executing = attachConversationAgentRunExecution(created, executionId, t1);
    expect(executing).toMatchObject({
      revision: 1,
      status: 'executing_tool',
      responseExecutionId: executionId
    });

    const completed = transitionConversationAgentRun(executing, 'completed', t2);
    expect(completed).toMatchObject({ revision: 2, status: 'completed' });
    expect(() => transitionConversationAgentRun(completed, 'running', t2))
      .toThrow(InvalidStateTransitionError);
  });
});
