import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { NodeProjectStorage } from '../../src/platform/storage/node-project-storage';
import { toProjectRelativePath } from '../../src/platform/storage/project-paths';
import {
  ConversationProductionTraceStore, withProductionTrace, getProductionTraceScope,
  bindProductionTraceAssistant, emitProductionEvent, getProductionTraceStore,
  type ProductionTraceScope
} from '../../src/platform/conversation-production-trace';
import { parseProductionTraceEvent, type ProductionTraceEventDto } from '../../src/shared/conversation-production-ipc';

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
describe('conversation production trace', () => {
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
