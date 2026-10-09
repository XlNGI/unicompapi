import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createItemV1, createTurnV1, toMessageItemId, toProjectId, toThreadId, toTurnId, toIsoTimestamp } from '../../src/domain';
import { ThreadFileRepository } from '../../src/platform/repositories/thread-file-repository';
import { ThreadFileReadAdapter } from '../../src/platform/ipc/thread-file-read-adapter';
import { createChatContextRuntime } from '../../src/platform/ipc/chat-context-runtime';
import type { StorageProjectSession } from '../../src/platform/ipc/storage-ipc-controller';

const t0 = toIsoTimestamp('2026-10-08T00:00:00.000Z');
const threadId = toThreadId('thread-file-adapter');

describe('ThreadFileReadAdapter', () => {
  it('reads summaries, pages and turns without a legacy Conversation source', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-thread-read-adapter-'));
    try {
      const repository = new ThreadFileRepository(root);
      await repository.createThread({ threadId, projectId: toProjectId('project-adapter'), title: 'Adapter', createdAt: t0 });
      const items = [], turns = [];
      for (let sequence = 1; sequence <= 3; sequence += 1) {
        const turnId = toTurnId(`turn-adapter-${sequence}`);
        const item = createItemV1({ itemId: toMessageItemId(`adapter-message-${sequence}`), threadId, turnId, sequence, type: 'user_message', status: 'completed', createdAt: t0, updatedAt: t0, messageSource: { messageId: `adapter-message-${sequence}` as never, messageRevision: 0 }, content: `message ${sequence}` });
        items.push(item);
        turns.push(createTurnV1({ turnId, threadId, turnSequence: sequence, createdAt: t0, userItemId: item.itemId, provenance: 'native' }));
      }
      await repository.append({ threadId, idempotencyKey: 'adapter-seed', occurredAt: t0, turns, items });
      const adapter = new ThreadFileReadAdapter({ getRepository: () => repository, projectId: () => 'project-adapter' });
      const summaries = await adapter.listThreadSummaries({ includeArchived: true, includeDeleted: false, limit: 20 });
      expect(summaries.ok && summaries.value.items).toHaveLength(1);
      const first = await adapter.getThreadItemsPage({ threadId, limit: 2, direction: 'older' });
      expect(first.ok && first.value.items.map(item => item.messageId)).toEqual(['adapter-message-2', 'adapter-message-3']);
      expect(first.ok && first.value.nextCursor).toBeTruthy();
      const older = await adapter.getThreadItemsPage({ threadId, limit: 2, direction: 'older', cursor: first.ok ? first.value.nextCursor : undefined });
      expect(older.ok && older.value.items.map(item => item.messageId)).toEqual(['adapter-message-1']);
      const turn = await adapter.getTurn({ turnId: 'turn-adapter-2' });
      expect(turn.ok && turn.value.userItemId.value).toBe('adapter-message-2');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('is selected by the runtime only when the explicit isolated flag is enabled', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-thread-runtime-read-'));
    const userData = await mkdtemp(path.join(os.tmpdir(), 'unicomp-thread-runtime-user-'));
    try {
      const repository = new ThreadFileRepository(root);
      await repository.createThread({ threadId, projectId: toProjectId('project-runtime-read'), title: 'Runtime read', createdAt: t0 });
      const session: StorageProjectSession = { rootDirectory: root, projectId: toProjectId('project-runtime-read'), projectName: 'Runtime read' };
      const runtime = createChatContextRuntime({ userDataDirectory: userData, getSession: () => session, threadFileReadEnabled: true });
      const result = await runtime.threadReads.listThreadSummaries({ includeArchived: true, includeDeleted: false, limit: 10 });
      expect(result.ok && result.value.items[0]?.threadId).toBe(threadId);
    } finally { await rm(root, { recursive: true, force: true }); await rm(userData, { recursive: true, force: true }); }
  });

  it('round-trips the legacy Message snapshot fields used by history rendering', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-thread-message-snapshot-'));
    try {
      const repository = new ThreadFileRepository(root);
      await repository.createThread({ threadId, projectId: toProjectId('project-adapter'), title: 'Snapshot', createdAt: t0 });
      const item = createItemV1({ itemId: toMessageItemId('snapshot-message'), threadId, sequence: 1, type: 'assistant_message', status: 'completed', createdAt: t0, updatedAt: t0, messageSource: { messageId: 'snapshot-message' as never, messageRevision: 4 }, content: 'final', legacyMessageSnapshot: { reasoningContent: 'reasoning', attachments: [{ kind: 'file_reference', projectId: 'project-adapter', fileReferenceId: 'file-1', fileName: 'report.docx' }], documentGenerationStatus: { state: 'completed', kind: 'word' }, documentResult: { workId: 'work-1', fileName: 'report.docx', kind: 'word', sizeBytes: 10 } } });
      await repository.append({ threadId, idempotencyKey: 'snapshot-message', occurredAt: t0, items: [item] });
      const adapter = new ThreadFileReadAdapter({ getRepository: () => repository, projectId: () => 'project-adapter' });
      const result = await adapter.getThreadItemsPage({ threadId, limit: 10, direction: 'older' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.items[0]?.message?.reasoningContent).toBe('reasoning');
        expect(result.value.items[0]?.message?.attachments).toHaveLength(1);
        expect(result.value.items[0]?.message?.documentResult?.workId).toBe('work-1');
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
