import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { expect, it } from 'vitest';
import { createConversationAgentRun, attachConversationAgentRunExecution, toConversationAgentRunId, toConversationId, toMessageId, toProjectId, toConversationResponseExecutionId, toIsoTimestamp } from '../../src/domain';
import { ConversationAgentRuntimeService } from '../../src/application/conversation-agent-runtime-service';
import { JsonConversationAgentRuntimeRepository } from '../../src/platform/repositories/json-conversation-agent-runtime-repository';
import { NodeProjectStorage } from '../../src/platform/storage';
import { ConversationProductionTraceStore, type ProductionTraceScope } from '../../src/platform/conversation-production-trace';

it('benchmarks eighty durable canonical progress and real Trace receipts', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-runtime-performance-'));
  try {
    const now = toIsoTimestamp(new Date().toISOString()), projectId = toProjectId('performance-project');
    const storage = new NodeProjectStorage(root), repository = new JsonConversationAgentRuntimeRepository(storage, projectId);
    let eventId = 0;
    const service = new ConversationAgentRuntimeService({ repository, nextEventId: () => `performance-event-${++eventId}`, hash: value => createHash('sha256').update(value).digest('hex') });
    const run = attachConversationAgentRunExecution(createConversationAgentRun({ id: toConversationAgentRunId('performance-run'), projectId, conversationId: toConversationId('performance-conversation'), sourceMessageId: toMessageId('performance-source'), createdAt: now }), toConversationResponseExecutionId('performance-response'), now);
    await service.open(run, { startedAt: Date.parse(now), deadlineAt: Date.parse(now) + 360000, maxToolCalls: 8, budgetUnits: 24 });
    const bridge = service.canonicalEvents(run.id), store = new ConversationProductionTraceStore(storage, projectId);
    const scope: ProductionTraceScope = { rootDirectory: root, projectId, conversationId: run.conversationId, sourceMessageId: run.sourceMessageId, traceId: 'performance-trace' };
    const start = performance.now();
    for (let page = 0; page < 80; page++) {
      const entry = await bridge.record({ code: 'document_render', status: 'progress', operationId: `page-${page}`, facts: { count: page }, occurredAt: new Date().toISOString() });
      await store.appendCanonical(scope, entry); await bridge.markProjected(entry.runEventId);
    }
    const pending = await bridge.replayPending();
    const elapsed = Math.round(performance.now() - start);
    console.info(JSON.stringify({ benchmark: 'canonical-progress-80', elapsedMs: elapsed }));
    expect(pending).toEqual([]); expect((await store.list({}))).toHaveLength(80);
    expect((await service.find(run.id))?.events).toHaveLength(81);
  } finally {
    if (path.dirname(path.resolve(root)).toLowerCase() !== path.resolve(os.tmpdir()).toLowerCase() || !path.basename(root).startsWith('unicomp-runtime-performance-')) throw new Error('Unsafe performance fixture cleanup');
    await rm(root, { recursive: true, force: true });
  }
});
