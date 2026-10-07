import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { NodeProjectStorage } from '../../src/platform/storage/node-project-storage';
import { toProjectRelativePath } from '../../src/platform/storage/project-paths';
import {
  ConversationProductionTraceStore, withProductionTrace, getProductionTraceScope,
  bindProductionTraceAssistant, emitProductionDiagnostic, emitProductionEvent, getProductionTraceStore,
  bindProductionTraceCanonicalEvents, projectCanonicalProductionEvent, replayCanonicalProductionEvents,
  type CanonicalProductionTraceEvent, type CanonicalProductionTraceEvents, type ProductionTraceScope
} from '../../src/platform/conversation-production-trace';
import { executionStopReasons, executionTimeoutScopes, parseProductionEventFacts, parseProductionTraceEvent,
  type ProductionTraceEventDto } from '../../src/shared/conversation-production-ipc';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const rootDirectory = await mkdtemp(path.join(os.tmpdir(), 'unicomp-production-trace-'));
  roots.push(rootDirectory);
  const storage = new NodeProjectStorage(rootDirectory);
  const scope: ProductionTraceScope = { rootDirectory, projectId: 'project-trace', conversationId: 'conversation-trace',
    sourceMessageId: 'message-trace', traceId: 'message-trace', clientCommandId: 'command-trace' };
  return { storage, scope, store: new ConversationProductionTraceStore(storage, scope.projectId) };
}
const progress = { code: 'model_response', status: 'progress', facts: { contentCharacters: 8 } } as const;
function canonical(sequence = 3): CanonicalProductionTraceEvent {
  return { runId: 'run-trace', runEventId: `run-event-${sequence}`, runSequence: sequence,
    occurredAt: '2026-10-03T10:00:00.000Z', publicEvent: { ...progress, assistantMessageId: 'assistant-trace' } };
}

describe('canonical production outbox projection', () => {
  it('retains separate project and canonical sequence and deduplicates a crash before acknowledgment', async () => {
    const { scope, storage, store } = await fixture();
    await store.append(scope, { code: 'request_received', status: 'completed' });
    const entry = canonical();
    const first = await store.appendCanonical(scope, entry);
    const reopened = new ConversationProductionTraceStore(storage, scope.projectId);
    expect(await reopened.appendCanonical(scope, entry)).toEqual(first);
    const events = await reopened.list({});
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ sequence: 2, runId: 'run-trace', runEventId: 'run-event-3', runSequence: 3,
      assistantMessageId: 'assistant-trace', occurredAt: entry.occurredAt });
    expect(JSON.stringify(events)).not.toMatch(/rootDirectory|prompt|token|credential/);
  });

  it('does not republish duplicate canonical events to live subscribers', async () => {
    const { scope, store } = await fixture();
    const seen: ProductionTraceEventDto[] = [];
    const unsubscribe = await store.subscribe({}, event => seen.push(event));
    await Promise.all([store.appendCanonical(scope, canonical()), store.appendCanonical(scope, canonical())]);
    expect(seen).toHaveLength(1);
    unsubscribe();
  });

  it('retains deduplication after display history no longer contains the canonical row', async () => {
    const { scope, store, storage } = await fixture();
    await store.appendCanonical(scope, canonical());
    const file = toProjectRelativePath('entities/conversation-production-trace.json');
    const record = await storage.readJson(file) as Record<string, unknown>;
    const events = Array.from({ length: 2048 }, (_, index) => ({ schemaVersion: 1, projectId: scope.projectId,
      conversationId: scope.conversationId, sourceMessageId: scope.sourceMessageId, traceId: scope.traceId,
      sequence: index + 2, ...progress, occurredAt: canonical().occurredAt }));
    await storage.writeJsonAtomically(file, { ...record, events, sequence: 2049 });
    const reopened = new ConversationProductionTraceStore(storage, scope.projectId);
    expect(await reopened.appendCanonical(scope, canonical())).toBeUndefined();
    expect(await reopened.list({})).toHaveLength(2048);
    expect((await reopened.list({})).at(-1)?.sequence).toBe(2049);
    const acknowledgment = vi.fn(async () => undefined);
    await projectCanonicalProductionEvent(scope, canonical(), { markProjected: acknowledgment });
    expect(acknowledgment).toHaveBeenCalledWith('run-event-3');
    expect(await reopened.list({})).toHaveLength(2048);
  });

  it('supports identifiers containing colons without colliding projection keys', async () => {
    const { scope, store, storage } = await fixture();
    await store.appendCanonical(scope, { ...canonical(), runId: 'run:a', runEventId: 'b' });
    await store.appendCanonical(scope, { ...canonical(), runId: 'run', runEventId: 'a:b' });
    expect(await new ConversationProductionTraceStore(storage, scope.projectId).list({})).toHaveLength(2);
  });

  it('rejects changed payload, identity collisions, scopes and unsafe fields', async () => {
    const { scope, store } = await fixture();
    await store.appendCanonical(scope, canonical());
    await expect(store.appendCanonical(scope, { ...canonical(), publicEvent: { ...progress, facts: { contentCharacters: 9 } } }))
      .rejects.toThrow('identity conflict');
    await expect(store.appendCanonical(scope, { ...canonical(), runEventId: 'other-event' })).rejects.toThrow('sequence conflict');
    await expect(store.appendCanonical({ ...scope, conversationId: 'other-conversation' }, canonical())).rejects.toThrow();
    await expect(store.appendCanonical(scope, { ...canonical(4), publicEvent: { ...progress, rootDirectory: 'C:/private' } as never }))
      .rejects.toThrow('payload');
    await expect(store.appendCanonical(scope, { ...canonical(4), publicEvent: { ...progress, facts: { prompt: 'PRIVATE' } as never } }))
      .rejects.toThrow('fact');
    for (const metadata of [{ runId: 'run-trace' }, { runId: 'run-trace', runEventId: 'event', runSequence: 0 },
      { runId: 'C:/private', runEventId: 'event', runSequence: 1 }]) {
      expect(() => parseProductionTraceEvent({ schemaVersion: 1, projectId: scope.projectId, conversationId: scope.conversationId,
        sourceMessageId: scope.sourceMessageId, traceId: scope.traceId,
        sequence: 1, ...progress, occurredAt: canonical().occurredAt, ...metadata })).toThrow();
    }
    expect(await store.list({})).toHaveLength(1);
  });

  it('replays the original unbound assistant association after the Host later binds an assistant', async () => {
    const { scope, store } = await fixture();
    const entry = { ...canonical(), publicEvent: progress };
    await store.appendCanonical(scope, entry);
    scope.assistantMessageId = 'assistant-later';
    expect(await store.appendCanonical(scope, entry)).not.toHaveProperty('assistantMessageId');
    expect(await store.list({})).toHaveLength(1);
  });

  it('commits canonical intent first, leaves failed acknowledgments pending and replays only projection', async () => {
    const { scope } = await fixture();
    const pending: CanonicalProductionTraceEvent[] = [];
    let failAcknowledgment = true;
    const bridge: CanonicalProductionTraceEvents = {
      record: vi.fn(async input => {
        expect(await getProductionTraceStore(scope).list({})).toEqual([]);
        const { occurredAt, ...publicEvent } = input;
        const entry = { ...canonical(), occurredAt, publicEvent };
        pending.push(entry);
        return entry;
      }),
      markProjected: vi.fn(async () => { if (failAcknowledgment) throw new Error('crash before acknowledgment'); pending.splice(0); }),
      replayPending: async () => pending
    };
    await withProductionTrace(scope, async () => {
      bindProductionTraceCanonicalEvents(bridge);
      bindProductionTraceAssistant('assistant-trace');
      expect(await emitProductionEvent(progress)).toEqual({ recorded: false });
    });
    expect(pending).toHaveLength(1);
    expect(await getProductionTraceStore(scope).list({})).toHaveLength(1);
    failAcknowledgment = false;
    expect(await replayCanonicalProductionEvents(scope, bridge)).toEqual({ projected: 1, pending: 0 });
    expect(await getProductionTraceStore(scope).list({})).toHaveLength(1);
    expect(bridge.record).toHaveBeenCalledTimes(1);
    expect(bridge.markProjected).toHaveBeenCalledTimes(2);
  });

  it('preserves pending intent when projection fails and rebuilds it without dispatching new business work', async () => {
    const { scope } = await fixture();
    const entry = canonical();
    const acknowledged: string[] = [];
    const bridge: CanonicalProductionTraceEvents = {
      record: vi.fn(async () => entry), markProjected: async id => { acknowledged.push(id); },
      replayPending: async () => acknowledged.length ? [] : [entry]
    };
    const append = vi.spyOn(getProductionTraceStore(scope), 'appendCanonical').mockRejectedValueOnce(new Error('projection unavailable'));
    expect(await withProductionTrace({ ...scope, canonicalEvents: bridge }, () => emitProductionEvent(progress))).toEqual({ recorded: false });
    expect(acknowledged).toEqual([]);
    expect(await replayCanonicalProductionEvents(scope, bridge)).toEqual({ projected: 1, pending: 0 });
    expect(bridge.record).toHaveBeenCalledTimes(1);
    expect(await getProductionTraceStore(scope).list({})).toHaveLength(1);
    append.mockRestore();
  });

  it('propagates canonical persistence failures so the caller cannot dispatch after a lost intent', async () => {
    const { scope } = await fixture();
    const bridge: CanonicalProductionTraceEvents = {
      record: async () => { throw new Error('intent unavailable'); }, markProjected: vi.fn(async () => undefined)
    };
    const dispatch = vi.fn();
    await expect(withProductionTrace({ ...scope, canonicalEvents: bridge }, async () => {
      await emitProductionEvent({ code: 'model_request', status: 'started' });
      dispatch();
    })).rejects.toThrow('intent unavailable');
    expect(dispatch).not.toHaveBeenCalled();
    expect(bridge.markProjected).not.toHaveBeenCalled();
    expect(await getProductionTraceStore(scope).list({})).toEqual([]);
  });

  it('consumes supplemental probe failures while the same failed canonical store still blocks required dispatch', async () => {
    const { scope } = await fixture();
    const bridge: CanonicalProductionTraceEvents = {
      record: vi.fn(async () => { throw new Error('canonical disk unavailable'); }),
      markProjected: vi.fn(async () => undefined)
    };
    const issues: string[] = [], store = getProductionTraceStore(scope);
    const unsubscribe = await store.subscribe({}, () => undefined, issue => issues.push(issue.code));
    const dispatch = vi.fn();
    await withProductionTrace({ ...scope, canonicalEvents: bridge }, async () => {
      const supplemental = emitProductionDiagnostic({ code: 'model_request', status: 'started', operationId: 'continuation_credential_lookup' });
      void supplemental;
      expect(await supplemental).toEqual({ recorded: false });
      await expect((async () => {
        await emitProductionEvent({ code: 'model_request', status: 'started' });
        dispatch();
      })()).rejects.toThrow('canonical disk unavailable');
    });
    expect(issues).toEqual(['recording_unavailable']);
    expect(bridge.record).toHaveBeenCalledTimes(2);
    expect(bridge.markProjected).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(await store.list({})).toEqual([]);
    unsubscribe();
  });

  it('keeps a failed supplemental probe non-rejecting even when its issue reporter also fails', async () => {
    const { scope } = await fixture();
    const bridge: CanonicalProductionTraceEvents = {
      record: async () => { throw new Error('canonical disk unavailable'); },
      markProjected: vi.fn(async () => undefined)
    };
    const issue = vi.spyOn(getProductionTraceStore(scope), 'reportIssue').mockImplementation(() => { throw new Error('issue reporter unavailable'); });
    try {
      expect(await withProductionTrace({ ...scope, canonicalEvents: bridge }, () =>
        emitProductionDiagnostic({ code: 'tool_authorization', status: 'completed', operationId: 'runtime_context_refreshed' })))
        .toEqual({ recorded: false });
      expect(issue).toHaveBeenCalledWith(expect.objectContaining({ traceId: scope.traceId }), 'recording_unavailable');
    } finally { issue.mockRestore(); }
  });

  it('keeps canonical binding isolated and forbids rebinding the same execution scope', async () => {
    const { scope } = await fixture();
    const bridge: CanonicalProductionTraceEvents = { record: async () => canonical(), markProjected: async () => undefined };
    expect(() => bindProductionTraceCanonicalEvents(bridge)).toThrow('bridge');
    await withProductionTrace(scope, async () => {
      bindProductionTraceCanonicalEvents(bridge);
      bindProductionTraceCanonicalEvents(bridge);
      expect(() => bindProductionTraceCanonicalEvents({ ...bridge })).toThrow('already bound');
      expect(getProductionTraceScope()?.canonicalEvents).toBe(bridge);
      await projectCanonicalProductionEvent(getProductionTraceScope()!, canonical());
    });
    expect(getProductionTraceScope()).toBeUndefined();
    expect(scope.canonicalEvents).toBeUndefined();
  });
});
describe('conversation production trace', () => {
  it('persists and reopens bounded execution diagnostics as scheduling facts', async () => {
    const { storage, scope, store } = await fixture();
    const facts = { stopReason: 'timeout' as const, timeoutScope: 'execution' as const,
      parentElapsedMs: 360_000, parentRemainingMs: 0, childElapsedMs: 91_000, childRemainingMs: 0,
      toolCallsUsed: 2, costUnitsUsed: 16 };
    await store.append(scope, { code: 'task_complete', status: 'failed', operationId: 'execution_budget', facts });
    const reopened = new ConversationProductionTraceStore(storage, scope.projectId);
    expect((await reopened.list({ conversationId: scope.conversationId }))[0].facts).toEqual(facts);
    for (const stopReason of executionStopReasons) expect(parseProductionEventFacts({ stopReason })).toEqual({ stopReason });
    for (const timeoutScope of executionTimeoutScopes) expect(parseProductionEventFacts({ timeoutScope })).toEqual({ timeoutScope });
    expect(JSON.stringify(await reopened.list({}))).not.toMatch(/rootDirectory|prompt|credential|currency|price/);
  });

  it('rejects raw stop causes, external scope text and non-finite or unbounded counters', () => {
    for (const invalid of [
      { stopReason: 'private_prompt' }, { stopReason: 'timeout https://private.test' },
      { timeoutScope: 'C:/private/file' }, { timeoutScope: 'Authorization Bearer fixture-secret' },
      { prompt: 'private model body' }, { credential: 'fixture-secret' }
    ]) expect(() => parseProductionEventFacts(invalid)).toThrow();
    for (const key of ['parentElapsedMs', 'parentRemainingMs', 'childElapsedMs', 'childRemainingMs', 'toolCallsUsed', 'costUnitsUsed']) {
      for (const value of [-1, 0.5, NaN, Infinity, 1_000_000_001, '0']) {
        expect(() => parseProductionEventFacts({ [key]: value })).toThrow();
      }
      expect(parseProductionEventFacts({ [key]: 0 })).toEqual({ [key]: 0 });
    }
  });

  it('serializes concurrent writes and replays persisted records after reopening', async () => {
    const { storage, scope, store } = await fixture();
    await Promise.all(Array.from({ length: 12 }, () => store.append(scope, progress)));
    const reopened = new ConversationProductionTraceStore(storage, scope.projectId);
    const events = await reopened.list({ conversationId: scope.conversationId });
    expect(events.map((item) => item.sequence)).toEqual(Array.from({ length: 12 }, (_, index) => index + 1));
    expect(events[0]).toMatchObject({ ...progress, clientCommandId: scope.clientCommandId });
    expect(JSON.stringify(events)).not.toContain(scope.rootDirectory);
  });

  it('joins history and concurrent live events exactly once, and isolates command and conversation filters', async () => {
    const { scope, store } = await fixture();
    await store.append(scope, progress);
    const seen: number[] = [];
    const subscription = store.subscribe({ clientCommandId: scope.clientCommandId }, (item) => seen.push(item.sequence));
    const writing = store.append(scope, progress);
    const unsubscribe = await subscription;
    await writing;
    await store.append({ ...scope, conversationId: 'conversation-other', traceId: 'message-other', sourceMessageId: 'message-other', clientCommandId: 'command-other' }, progress);
    expect(seen).toEqual([1, 2]);
    expect(await store.list({ conversationId: scope.conversationId, afterSequence: 1 })).toHaveLength(1);
    unsubscribe();
    await store.append(scope, progress);
    expect(seen).toEqual([1, 2]);
  });

  it('rejects cross-project access and rebinding a trace to another conversation', async () => {
    const { scope, storage, store } = await fixture();
    await store.append(scope, progress);
    await expect(new ConversationProductionTraceStore(storage, 'project-other').list({})).rejects.toThrow('Invalid production trace store');
    await expect(store.append({ ...scope, conversationId: 'conversation-other' }, progress)).rejects.toThrow('identity mismatch');
    expect(await store.list({})).toHaveLength(1);
  });

  it('does not publish a record when atomic persistence fails', async () => {
    const { scope } = await fixture();
    const storage = new NodeProjectStorage(scope.rootDirectory, { onAtomicWriteStage(event) {
      if (event.stage === 'before_replace') throw new Error('simulated failure');
    } });
    const store = new ConversationProductionTraceStore(storage, scope.projectId);
    const seen: ProductionTraceEventDto[] = [];
    await store.subscribe({}, (event) => seen.push(event));
    await expect(store.append(scope, progress)).rejects.toThrow('simulated failure');
    expect(seen).toEqual([]);
    expect(await store.list({})).toEqual([]);
  });

  it('keeps ALS scope isolated across requests and binds an assistant for downstream async work', async () => {
    const { scope } = await fixture();
    const other = { ...scope, traceId: 'message-other', sourceMessageId: 'message-other' };
    await Promise.all([scope, other].map((item) => withProductionTrace(item, async () => {
      await Promise.resolve();
      expect(getProductionTraceScope()?.traceId).toBe(item.traceId);
      bindProductionTraceAssistant(`assistant-${item.traceId}`);
      expect(await emitProductionEvent(progress)).toEqual({ recorded: true });
    })));
    expect(getProductionTraceScope()).toBeUndefined();
    const events = await getProductionTraceStore(scope).list({});
    expect(events.map((event) => event.assistantMessageId).sort()).toEqual(['assistant-message-other', 'assistant-message-trace']);
  });

  it('rejects unapproved content and reports recording failure without failing business work', async () => {
    const { scope } = await fixture();
    const issues: string[] = [];
    await getProductionTraceStore(scope).subscribe({}, () => undefined, (issue) => issues.push(issue.code));
    const result = await withProductionTrace(scope, async () => {
      expect(await emitProductionEvent({ ...progress, facts: { prompt: 'forbidden text' } as never })).toEqual({ recorded: false });
      return 'business completed';
    });
    expect(result).toBe('business completed');
    expect(issues).toEqual(['recording_unavailable']);
    expect(await getProductionTraceStore(scope).list({})).toEqual([]);
    expect(() => parseProductionTraceEvent({ ...scope, ...progress, schemaVersion: 1, sequence: 1, occurredAt: new Date().toISOString() })).toThrow();
  });

  it('limits each trace to 2048 entries and replays the history gap warning after reopening', async () => {
    const { scope, storage, store } = await fixture();
    const events = Array.from({ length: 2048 }, (_, index) => ({ schemaVersion: 1, projectId: scope.projectId,
      conversationId: scope.conversationId, sourceMessageId: scope.sourceMessageId, traceId: scope.traceId,
      sequence: index + 1, ...progress, occurredAt: new Date().toISOString() }));
    await storage.writeJsonAtomically(toProjectRelativePath('entities/conversation-production-trace.json'),
      { schemaVersion: 1, projectId: scope.projectId, sequence: 2048, events });
    await store.append(scope, progress);
    const reopened = new ConversationProductionTraceStore(storage, scope.projectId);
    const seen: number[] = [];
    const issues: string[] = [];
    await reopened.subscribe({ conversationId: scope.conversationId }, (item) => seen.push(item.sequence), (issue) => issues.push(issue.code));
    expect(seen).toHaveLength(2048);
    expect(seen[0]).toBe(2);
    expect(seen.at(-1)).toBe(2049);
    expect(issues).toEqual(['history_truncated']);
  });
});
