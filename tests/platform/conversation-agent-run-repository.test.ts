import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createConversationAgentRun,
  toConversationAgentRunId,
  toConversationId,
  toConversationResponseExecutionId,
  toIsoTimestamp,
  toMessageId,
  toProjectId,
  attachConversationAgentRunExecution,
  transitionConversationAgentRun
} from '../../src/domain';
import { JsonConversationAgentRunRepository, ConversationAgentRunRevisionConflictError } from '../../src/platform';
import { NodeProjectStorage } from '../../src/platform/storage';

const roots: string[] = [];
const projectId = toProjectId('project-agent-run-repository');
const conversationId = toConversationId('conversation-agent-run-repository');
const sourceMessageId = toMessageId('message-agent-run-repository');
const t0 = toIsoTimestamp('2026-09-30T11:00:00.000Z');
const t1 = toIsoTimestamp('2026-09-30T11:01:00.000Z');
const t2 = toIsoTimestamp('2026-09-30T11:02:00.000Z');

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('JsonConversationAgentRunRepository', () => {
  it('persists lifecycle revisions and rejects stale writes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-agent-runs-'));
    roots.push(root);
    let currentTime = t0;
    const repository = new JsonConversationAgentRunRepository(
      new NodeProjectStorage(root),
      projectId,
      () => currentTime
    );
    const created = createConversationAgentRun({
      id: toConversationAgentRunId('agent-run-repository'),
      projectId,
      conversationId,
      sourceMessageId,
      createdAt: t0
    });
    await repository.create(created);
    currentTime = t1;
    const executing = attachConversationAgentRunExecution(
      created,
      toConversationResponseExecutionId('response-execution-agent-run-repository'),
      t1
    );
    await repository.save(executing, created.revision);
    currentTime = t2;
    const completed = transitionConversationAgentRun(executing, 'completed', t2);
    await repository.save(completed, executing.revision);

    await expect(repository.get(created.id)).resolves.toEqual(completed);
    await expect(repository.findByResponseExecutionId(executing.responseExecutionId!))
      .resolves.toEqual(completed);
    await expect(repository.save(completed, executing.revision)).rejects
      .toBeInstanceOf(ConversationAgentRunRevisionConflictError);
    const document = JSON.parse(await readFile(path.join(root, 'entities/conversation-agent-runs.json'), 'utf8')) as {
      runs: readonly { revision: number; status: string }[]
    };
    expect(document.runs).toEqual([{ ...completed }]);
  });
});
