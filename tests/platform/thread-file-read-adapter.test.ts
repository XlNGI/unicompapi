import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createItemV1, createTurnV1, toMessageItemId, toProjectId, toThreadId, toTurnId, toIsoTimestamp } from '../../src/domain';
import { ThreadFileRepository } from '../../src/platform/repositories/thread-file-repository';
import { ThreadFileReadAdapter } from '../../src/platform/ipc/thread-file-read-adapter';
import { projectArtifactItem } from '../../src/application/conversation-thread-adapter';
import { createChatContextRuntime } from '../../src/platform/ipc/chat-context-runtime';
import type { StorageProjectSession } from '../../src/platform/ipc/storage-ipc-controller';
import { ProjectSessionController, StorageProjectSessionRegistry } from '../../src/platform/ipc/project-session-controller';

const t0 = toIsoTimestamp('2026-10-08T00:00:00.000Z');
const t1 = toIsoTimestamp('2026-10-08T00:00:01.000Z');
const threadId = toThreadId('thread-file-adapter');

describe('ThreadFileReadAdapter', () => {
  it('returns an empty list before a project is open, including the directory-dialog focus refresh', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-new-project-read-'));
    const userData = await mkdtemp(path.join(os.tmpdir(), 'unicomp-new-project-user-'));
    const registry = new StorageProjectSessionRegistry();
    const runtime = createChatContextRuntime({ userDataDirectory: userData, getSession: () => registry.get(),
      threadFileReadEnabled: true, threadFileWriteEnabled: true });
    const request = { includeArchived: true, includeDeleted: false, limit: 100 };
    const expectedEmpty = { ok: true, value: { items: [], readAtSequence: 0, hasMore: false } };
    try {
      expect(await runtime.threadReads.listThreadSummaries(request)).toEqual(expectedEmpty);
      expect(await readdir(root)).toEqual([]);
      const controller = new ProjectSessionController({ registry, chooseProjectDirectory: async () => {
        expect(await runtime.threadReads.listThreadSummaries(request)).toEqual(expectedEmpty);
        return root;
      } });
      const created = await controller.createProject({ name: '新建项目本地保存' });
      expect(created.ok).toBe(true);
      const manifest = JSON.parse(await readFile(path.join(root, 'project.json'), 'utf8'));
      expect(manifest.id).toBe(registry.get()?.projectId);
      expect(manifest.name).toBe('新建项目本地保存');
      expect(await runtime.threadReads.listThreadSummaries(request)).toEqual(expectedEmpty);
      const conversation = await runtime.conversations.create({ title: '本地对话', bindToCurrentProject: true });
      expect(conversation.ok).toBe(true);
      if (!conversation.ok) throw new Error('Conversation creation failed');
      const saved = await runtime.conversations.addUserMessage({ conversationId: conversation.value.conversationId,
        expectedRevision: conversation.value.revision, content: '第一条本地消息' });
      expect(saved.ok).toBe(true);
      await runtime.conversations.waitForOperations();
      const restarted = createChatContextRuntime({ userDataDirectory: userData, getSession: () => registry.get(),
        threadFileReadEnabled: true, threadFileWriteEnabled: true });
      try {
        const summaries = await restarted.threadReads.listThreadSummaries(request);
        expect(summaries.ok && summaries.value.items.map(item => item.conversationId)).toEqual([conversation.value.conversationId]);
        const restored = await restarted.conversations.get({ conversationId: conversation.value.conversationId });
        expect(restored.ok && restored.value.messages.map(message => message.content)).toEqual(['第一条本地消息']);
      } finally { await restarted.waitForMutations(); }
      registry.clear();
      expect(await runtime.threadReads.listThreadSummaries(request)).toEqual(expectedEmpty);
    } finally {
      await runtime.waitForMutations();
      await rm(root, { recursive: true, force: true });
      await rm(userData, { recursive: true, force: true });
    }
  });

  it('keeps real project read failures visible instead of treating them as an empty project', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-project-read-failure-'));
    try {
      await mkdir(path.join(root, 'entities', 'threads'), { recursive: true });
      await writeFile(path.join(root, 'entities', 'threads', 'index.v1.json'), '{invalid json');
      const adapter = new ThreadFileReadAdapter({ getRepository: () => new ThreadFileRepository(root),
        projectId: () => 'project-unreadable' });
      await expect(adapter.listThreadSummaries({ includeArchived: true, includeDeleted: false, limit: 100 }))
        .resolves.toMatchObject({ ok: false, error: { code: 'storage_error' } });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('hydrates Runtime controls only for the selected in-scope Thread and rejects a project switch during the read', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-thread-controls-'));
    try {
      const repository = new ThreadFileRepository(root);
      await repository.createThread({ threadId, projectId: toProjectId('project-controls'), title: 'Controls', createdAt: t0 });
      let currentProject = 'project-controls';
      const parentRuns = [{ responseExecutionId: 'response-controls', sourceMessageId: 'source-controls',
        state: 'needs_reconciliation' as const, runRevision: 3, registeredWorkCount: 0, acknowledged: false }];
      const readExecutionState = vi.fn(async () => ({ parentRuns, agentSessions: [] }));
      const adapter = new ThreadFileReadAdapter({ getRepository: () => repository,
        projectId: () => currentProject, readExecutionState });
      await adapter.listThreadSummaries({ includeArchived: true, includeDeleted: false, limit: 20 });
      expect(readExecutionState).not.toHaveBeenCalled();
      const detail = await adapter.getThread({ threadId });
      expect(detail.ok && detail.value.parentRuns).toEqual(parentRuns);
      expect(readExecutionState).toHaveBeenCalledWith(threadId);
      readExecutionState.mockImplementationOnce(async () => {
        currentProject = 'another-project';
        return { parentRuns, agentSessions: [] };
      });
      await expect(adapter.getThread({ threadId })).resolves.toMatchObject({ ok: false, error: { code: 'project_scope_mismatch' } });
      readExecutionState.mockClear();
      await expect(adapter.getThread({ threadId })).resolves.toMatchObject({ ok: false, error: { code: 'project_scope_mismatch' } });
      expect(readExecutionState).not.toHaveBeenCalled();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
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

  it('exposes Thread-native document Artifact metadata for history rendering', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-thread-artifact-read-'));
    try {
      const repository = new ThreadFileRepository(root);
      await repository.createThread({ threadId, projectId: toProjectId('project-adapter'), title: 'Artifact', createdAt: t0 });
      const user = createItemV1({ itemId: toMessageItemId('artifact-user'), threadId, turnId: toTurnId('turn-artifact'), sequence: 1, type: 'user_message', status: 'completed', createdAt: t0, updatedAt: t0, messageSource: { messageId: 'artifact-user' as never, messageRevision: 0 }, content: '生成 PPT' });
      const turn = createTurnV1({ turnId: toTurnId('turn-artifact'), threadId, turnSequence: 1, createdAt: t0, userItemId: user.itemId, provenance: 'native' });
      const artifact = projectArtifactItem({ threadId, turnId: turn.turnId, sequence: 2, status: 'completed', content: 'artifact.pptx (ppt)', createdAt: t0, updatedAt: t1, sourceIdentity: 'work:artifact-work', workId: 'artifact-work', legacyMessageSnapshot: { documentResult: { workId: 'artifact-work', fileName: 'artifact.pptx', kind: 'ppt', sizeBytes: 42 } } });
      await repository.append({ threadId, idempotencyKey: 'artifact-read', occurredAt: t1, turns: [turn], items: [user, artifact] });
      const adapter = new ThreadFileReadAdapter({ getRepository: () => repository, projectId: () => 'project-adapter' });
      const result = await adapter.getThreadItemsPage({ threadId, limit: 10, direction: 'older' });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.items.find(item => item.itemType === 'document_artifact_projection')?.artifact).toEqual({ workId: 'artifact-work', fileName: 'artifact.pptx', kind: 'ppt', sizeBytes: 42 });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
