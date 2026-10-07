import { mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createConversationAgentRuntime, updateConversationAgentRuntime,
  toConversationAgentRunId, toConversationId, toConversationResponseExecutionId, toIsoTimestamp, toMessageId, toProjectId,
  type ConversationAgentRuntimeOutboxEntryV1, type ConversationAgentRuntimeV1
} from '../../src/domain';
import { JsonConversationAgentRuntimeRepository } from '../../src/platform/repositories/json-conversation-agent-runtime-repository';
import { ConversationAgentRuntimeService } from '../../src/application/conversation-agent-runtime-service';
import { NodeProjectStorage, toProjectRelativePath } from '../../src/platform/storage';
import {
  bindProductionTraceAssistant, bindProductionTraceCanonicalEvents, emitProductionEvent, getProductionTraceStore,
  replayCanonicalProductionEvents, withProductionTrace,
  type CanonicalProductionTraceEvent, type CanonicalProductionTraceEvents, type ProductionTraceScope
} from '../../src/platform/conversation-production-trace';
import { parseProductionEventFacts, type ProductionTraceEventDto } from '../../src/shared/conversation-production-ipc';
import { projectProductionMessages } from '../../src/pages/chat/productionTimeline';
import { DocumentProgress } from '../../src/pages/chat/DocumentProgress';
import type { ConversationDto } from '../../src/shared/chat-context-ipc';

const roots: string[] = [];
const projectId = toProjectId('project-outbox-projection');
const t0 = toIsoTimestamp('2026-10-03T09:00:00.000Z');
const t1 = toIsoTimestamp('2026-10-03T09:00:01.000Z');
const requestHash = 'd'.repeat(64);
const traceFile = toProjectRelativePath('entities/conversation-production-trace.json');
afterEach(async () => {
  await Promise.all(roots.splice(0).map(async root => {
    if (path.dirname(path.resolve(root)).toLowerCase() !== path.resolve(os.tmpdir()).toLowerCase() ||
      !path.basename(root).startsWith('unicomp-outbox-projection-')) throw new Error('Unsafe test cleanup target');
    await rm(root, { recursive: true, force: true });
  }));
});

async function fixture(options?: ConstructorParameters<typeof NodeProjectStorage>[1]) {
  const rootDirectory = await mkdtemp(path.join(os.tmpdir(), 'unicomp-outbox-projection-'));
  roots.push(rootDirectory);
  const storage = new NodeProjectStorage(rootDirectory, options);
  const repository = new JsonConversationAgentRuntimeRepository(storage, projectId);
  const runtime = createConversationAgentRuntime({ runId: toConversationAgentRunId('run-outbox-projection'), projectId,
    conversationId: toConversationId('conversation-outbox'), sourceMessageId: toMessageId('source-outbox'),
    responseExecutionId: toConversationResponseExecutionId('response-outbox'), createdAt: t0,
    budget: { startedAt: Date.parse(t0), deadlineAt: Date.parse(t0) + 360000, maxToolCalls: 8, budgetUnits: 24 } });
  await repository.create(runtime, { runId: runtime.runId, eventId: 'outbox-created', eventKey: 'created',
    sequence: 1, kind: 'run_created', at: t0 });
  const prepared = updateConversationAgentRuntime(runtime, { checkpoint: { ...runtime.checkpoint, stage: 'model' },
    modelCalls: [{ callId: 'model-call-outbox', round: 0, status: 'prepared', requestHash }] }, t1);
  await repository.commit({ runId: runtime.runId, expectedRevision: 0, runtime: prepared,
    event: { runId: runtime.runId, eventId: 'outbox-prepared', eventKey: 'model-prepared', sequence: 2,
      kind: 'model_call_prepared', at: t1, facts: { requestHash, round: 0 } } });
  const scope: ProductionTraceScope = { rootDirectory, projectId, conversationId: runtime.conversationId,
    sourceMessageId: runtime.sourceMessageId, traceId: runtime.sourceMessageId, clientCommandId: 'command-outbox' };
  return { rootDirectory, storage, repository, runtime, scope };
}

function projected(entry: ConversationAgentRuntimeOutboxEntryV1): CanonicalProductionTraceEvent {
  return { runId: entry.runId, runEventId: entry.eventId, runSequence: entry.sequence, occurredAt: entry.at,
    publicEvent: { code: entry.payload.code, status: entry.payload.status,
      ...(entry.payload.operationId ? { operationId: entry.payload.operationId } : {}),
      ...(entry.payload.assistantMessageId ? { assistantMessageId: entry.payload.assistantMessageId } : {}),
      ...(entry.payload.traceId ? { traceId: entry.payload.traceId } : {}),
      ...(entry.payload.clientCommandId ? { clientCommandId: entry.payload.clientCommandId } : {}),
      ...(entry.payload.facts ? { facts: parseProductionEventFacts(entry.payload.facts) } : {}) } };
}

function bridge(repository: JsonConversationAgentRuntimeRepository, runtime: ConversationAgentRuntimeV1,
  acknowledge = (eventId: string) => repository.acknowledgeOutbox(runtime.runId, eventId)): CanonicalProductionTraceEvents {
  return {
    record: vi.fn(async input => {
      const previous = (await repository.get(runtime.runId))!;
      const at = toIsoTimestamp(input.occurredAt);
      const next = updateConversationAgentRuntime(previous.runtime, {}, at);
      const publicEvent = { code: input.code, status: input.status,
        ...(input.operationId ? { operationId: input.operationId } : {}),
        ...(input.assistantMessageId ? { assistantMessageId: input.assistantMessageId } : {}),
        ...(input.traceId ? { traceId: input.traceId } : {}),
        ...(input.clientCommandId ? { clientCommandId: input.clientCommandId } : {}),
        ...(input.facts ? { facts: { ...input.facts } } : {}) };
      const committed = await repository.commit({ runId: runtime.runId, expectedRevision: previous.runtime.revision, runtime: next,
        event: { runId: runtime.runId, eventId: `outbox-progress-${next.checkpoint.sequence}`, eventKey: `progress-${next.checkpoint.sequence}`,
          sequence: next.checkpoint.sequence, kind: 'progress_recorded', at,
          publicEvent } });
      return projected(committed.outbox.at(-1)!);
    }),
    markProjected: acknowledge,
    replayPending: async () => (await repository.listPendingOutbox(runtime.runId)).map(projected)
  };
}

function savedConversation(runtime: ConversationAgentRuntimeV1): ConversationDto {
  return { projectId, conversationId: runtime.conversationId, revision: 1, title: 'Outbox', status: 'active', storageScope: 'current_project',
    readOnly: false, createdAt: t0, updatedAt: t1, messages: [
      { messageId: runtime.sourceMessageId, conversationId: runtime.conversationId, revision: 1, role: 'user', state: 'completed',
        content: '生成报告', attachments: [], createdAt: t0, updatedAt: t0 },
      { messageId: 'assistant-outbox', conversationId: runtime.conversationId, revision: 1, role: 'assistant', state: 'completed',
        content: '正文已接收', attachments: [], createdAt: t1, updatedAt: t1 }
    ] };
}

describe('real canonical repository outbox to public production trace', () => {
  it('replays the durable Host envelope after startup loses the original command and trace scope', async () => {
    const f = await fixture();
    let eventId = 0;
    const service = new ConversationAgentRuntimeService({ repository: f.repository,
      nextEventId: () => `envelope-event-${++eventId}`, hash: value => createHash('sha256').update(value).digest('hex') });
    const canonical = service.canonicalEvents(f.runtime.runId);
    const originalScope = { ...f.scope, traceId: 'original-host-trace', canonicalEvents: canonical };
    const seen: ProductionTraceEventDto[] = [];
    const unsubscribe = await getProductionTraceStore(f.scope).subscribe({}, event => seen.push(event));
    await withProductionTrace(originalScope, () => emitProductionEvent({ code: 'plan_validation', status: 'completed' }));
    await withProductionTrace(originalScope, () => emitProductionEvent({ code: 'model_response', status: 'completed', facts: { contentCharacters: 42 } }));
    // The Trace rows reached disk, but their receipt CAS did not. A third event has no Trace row yet.
    const failAck = vi.spyOn(f.repository, 'acknowledgeOutboxMany').mockRejectedValue(new Error('receipt crash'));
    await expect(service.flushProjectedEvents()).rejects.toThrow('receipt crash');
    await canonical.record({ code: 'tool_call', status: 'started', traceId: 'original-host-trace', occurredAt: new Date().toISOString() });
    expect(await f.repository.listPendingOutbox()).toHaveLength(3);
    failAck.mockRestore();
    const reopened = new JsonConversationAgentRuntimeRepository(new NodeProjectStorage(f.rootDirectory), projectId);
    const replayService = new ConversationAgentRuntimeService({ repository: reopened,
      nextEventId: () => 'must-not-create-new-event', hash: value => createHash('sha256').update(value).digest('hex') });
    const startupScope: ProductionTraceScope = { rootDirectory: f.rootDirectory, projectId,
      conversationId: f.runtime.conversationId, sourceMessageId: f.runtime.sourceMessageId, traceId: f.runtime.sourceMessageId };
    const replay = replayService.canonicalEvents(f.runtime.runId);
    expect(await replayCanonicalProductionEvents({ ...startupScope, assistantMessageId: 'later-assistant' }, replay))
      .toEqual({ projected: 3, pending: 0 });
    await replayService.flushProjectedEvents();
    expect(await reopened.listPendingOutbox()).toEqual([]);
    expect(seen).toHaveLength(3);
    expect(seen.map(event => event.sequence)).toEqual([1, 2, 3]);
    expect(seen.map(event => event.traceId)).toEqual(Array(3).fill('original-host-trace'));
    expect(seen.map(event => event.clientCommandId)).toEqual(['command-outbox', 'command-outbox', undefined]);
    expect(seen.every(event => event.assistantMessageId === undefined)).toBe(true);
    expect((await reopened.get(f.runtime.runId))?.events).toHaveLength(5);
    expect(await replayCanonicalProductionEvents({ ...startupScope, clientCommandId: 'later-command' }, replay))
      .toEqual({ projected: 0, pending: 0 });
    unsubscribe();
  });
  it('keeps a committed checkpoint and outbox when Trace fails, and rebuilds after reopening without new execution facts', async () => {
    const f = await fixture();
    await f.storage.writeJsonAtomically(traceFile, { schemaVersion: 1, projectId: 'wrong-project', sequence: 0, events: [] });
    const canonicalBridge = bridge(f.repository, f.runtime);
    await withProductionTrace(f.scope, async () => {
      bindProductionTraceCanonicalEvents(canonicalBridge);
      bindProductionTraceAssistant('assistant-outbox');
      expect(await emitProductionEvent({ code: 'model_response', status: 'completed', facts: { purpose: 'content', contentCharacters: 42 } }))
        .toEqual({ recorded: false });
    });
    const committed = await f.repository.get(f.runtime.runId);
    expect(committed?.runtime.checkpoint.sequence).toBe(3);
    expect(committed?.events.map(event => event.kind)).toEqual(['run_created', 'model_call_prepared', 'progress_recorded']);
    expect(committed?.outbox).toHaveLength(1);
    expect(committed?.outbox[0].projected).toBe(false);

    const reopenedStorage = new NodeProjectStorage(f.rootDirectory);
    const reopened = new JsonConversationAgentRuntimeRepository(reopenedStorage, projectId);
    await reopenedStorage.writeJsonAtomically(traceFile, { schemaVersion: 1, projectId, sequence: 0, events: [] });
    const replayBridge = bridge(reopened, f.runtime);
    expect(await replayCanonicalProductionEvents(f.scope, replayBridge)).toEqual({ projected: 1, pending: 0 });
    expect(await replayCanonicalProductionEvents(f.scope, replayBridge)).toEqual({ projected: 0, pending: 0 });
    expect(replayBridge.record).not.toHaveBeenCalled();
    expect(canonicalBridge.record).toHaveBeenCalledTimes(1);
    expect((await reopened.get(f.runtime.runId))?.events).toHaveLength(3);
    expect((await reopened.get(f.runtime.runId))?.runtime.modelCalls).toEqual(committed?.runtime.modelCalls);
    expect(await reopened.listPendingOutbox()).toEqual([]);

    const trace = await getProductionTraceStore(f.scope).list({});
    expect(trace).toHaveLength(1);
    expect(trace[0]).toMatchObject({ sequence: 1, runSequence: 3, runId: f.runtime.runId,
      sourceMessageId: f.runtime.sourceMessageId, assistantMessageId: 'assistant-outbox' });
    const timeline = projectProductionMessages(savedConversation(f.runtime), trace);
    expect([...timeline.timelineByMessage.keys()]).toEqual(['assistant-outbox']);
    const html = renderToStaticMarkup(createElement(DocumentProgress, { detail: '执行中',
      events: timeline.timelineByMessage.get('assistant-outbox'), requestBySource: timeline.requestBySource }));
    expect(html.match(/<li /g)).toHaveLength(1);
    expect(html).toContain('已接收 42 字符');
    expect(JSON.stringify(trace)).not.toContain(requestHash);
    expect(JSON.stringify(trace)).not.toMatch(/requestHash|requestBody|prompt|token|credential|rootDirectory|C:\\/);
    expect(html).not.toMatch(/run-outbox|outbox-progress|requestHash|prompt|token|credential/);
  });

  it('survives real atomic acknowledgment failure and does not republish or bind an earlier event to a later assistant', async () => {
    let failAcknowledgment = false;
    const f = await fixture({ onAtomicWriteStage(event) {
      if (failAcknowledgment && event.stage === 'before_replace' && event.targetPath.endsWith('project-metadata.json')) {
        throw new Error('injected acknowledgment crash');
      }
    } });
    const canonicalBridge = bridge(f.repository, f.runtime, async eventId => {
      failAcknowledgment = true;
      await f.repository.acknowledgeOutbox(f.runtime.runId, eventId);
    });
    const seen: ProductionTraceEventDto[] = [];
    const unsubscribe = await getProductionTraceStore(f.scope).subscribe({}, event => seen.push(event));
    expect(await withProductionTrace({ ...f.scope, canonicalEvents: canonicalBridge }, () =>
      emitProductionEvent({ code: 'plan_validation', status: 'completed', facts: { planKind: 'document' } }))).toEqual({ recorded: false });
    expect(seen).toHaveLength(1);
    failAcknowledgment = false;
    const reopened = new JsonConversationAgentRuntimeRepository(new NodeProjectStorage(f.rootDirectory), projectId);
    expect(await reopened.listPendingOutbox(f.runtime.runId)).toHaveLength(1);
    const replayBridge = bridge(reopened, f.runtime);
    const laterScope = { ...f.scope, assistantMessageId: 'assistant-outbox' };
    expect(await replayCanonicalProductionEvents(laterScope, replayBridge)).toEqual({ projected: 1, pending: 0 });
    expect(seen).toHaveLength(1);
    expect(replayBridge.record).not.toHaveBeenCalled();
    expect(await reopened.listPendingOutbox(f.runtime.runId)).toEqual([]);
    const trace = await getProductionTraceStore(f.scope).list({});
    expect(trace).toHaveLength(1);
    expect(trace[0].assistantMessageId).toBeUndefined();
    expect(trace[0].sourceMessageId).toBe(f.runtime.sourceMessageId);
    const timeline = projectProductionMessages(savedConversation(f.runtime), trace);
    expect([...timeline.timelineByMessage.keys()]).toEqual(['assistant-outbox']);
    expect((await reopened.get(f.runtime.runId))?.runtime.revision).toBe(2);
    unsubscribe();
  });

  it('refuses externally supplied scope and raw facts before writing any canonical public event', async () => {
    const f = await fixture();
    const canonicalBridge = bridge(f.repository, f.runtime);
    await withProductionTrace({ ...f.scope, canonicalEvents: canonicalBridge }, async () => {
      await expect(emitProductionEvent({ code: 'model_request', status: 'started', projectId: 'other-project' } as never))
        .rejects.toThrow('payload');
      await expect(emitProductionEvent({ code: 'model_request', status: 'started', facts: { prompt: 'PRIVATE_PROMPT',
        token: 'PRIVATE_TOKEN', path: 'C:/PRIVATE_PATH' } as never })).rejects.toThrow('fact');
    });
    expect(canonicalBridge.record).not.toHaveBeenCalled();
    expect((await f.repository.get(f.runtime.runId))?.events).toHaveLength(2);
    expect(await f.repository.listPendingOutbox()).toEqual([]);
    expect(await getProductionTraceStore(f.scope).list({})).toEqual([]);
  });
});
