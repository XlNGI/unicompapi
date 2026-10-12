import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConversationApplicationService, ConversationStreamingService, ConversationTurnCoordinator, ThreadCommandService, ThreadProjectionCoordinator, ThreadLegacyProjectionWorker } from '../../src/application';
import { toConversationId, toMessageId, toProjectId, toThreadId, toWorkId } from '../../src/domain';
import { ThreadConversationRepository } from '../../src/platform/repositories/thread-conversation-repository';
import { ThreadFileRepository } from '../../src/platform/repositories/thread-file-repository';
import { JsonProjectConversationRepository } from '../../src/platform/repositories/json-project-conversation-repository';
import { NodeProjectStorage } from '../../src/platform/storage';
import { createChatContextRuntime } from '../../src/platform/ipc/chat-context-runtime';

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-thread-conversation-')); roots.push(root);
  const projectId = toProjectId('thread-conversation-project'), threadId = toThreadId('thread-conversation');
  let denyMetadata = false, sequence = 0;
  const now = () => '2026-10-12T16:00:00.000Z';
  const threads = new ThreadFileRepository(root, { fault: point => { if (denyMetadata && point === 'before_projection_update') throw new Error('metadata projection denied'); } });
  const legacy = new JsonProjectConversationRepository(new NodeProjectStorage(root), projectId, now);
  const projection = new ThreadLegacyProjectionWorker(threads, legacy, now);
  const coordinator = new ConversationTurnCoordinator(new ThreadCommandService(threads), new ThreadProjectionCoordinator(threads));
  const repository = new ThreadConversationRepository(threads, projectId, coordinator, { projection });
  const ids = { nextConversationId: () => toConversationId(threadId), nextMessageId: () => toMessageId(`message-${++sequence}`) };
  const service = new ConversationApplicationService(repository, ids, now), streaming = new ConversationStreamingService(repository, ids, now);
  const conversation = await service.create({ title: 'Thread', projectId });
  return { root, projectId, threadId, conversation, repository, legacy, projection, coordinator, threads, service, streaming, setMetadataFailure(value: boolean) { denyMetadata = value; } };
}

describe('Thread Conversation repository compatibility contracts', () => {
  it('keeps direct IPC turns, metadata, Context reads and restart authoritative with Legacy saves denied', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-thread-conversation-runtime-')); roots.push(root);
    const projectId = toProjectId('thread-conversation-runtime');
    const session = { projectId, rootDirectory: root, projectName: 'Synthetic' };
    const createRuntime = () => createChatContextRuntime({ userDataDirectory: path.join(root, 'profile'), getSession: () => session,
      threadFileReadEnabled: true, threadFileWriteEnabled: true });
    const runtime = createRuntime();
    const denied = vi.spyOn(JsonProjectConversationRepository.prototype, 'save').mockRejectedValue(new Error('Legacy denied'));
    const created = await runtime.conversations.create({ title: '原始标题', bindToCurrentProject: true });
    if (!created.ok) throw new Error(created.error.message);
    const user = await runtime.conversations.addUserMessage({ conversationId: created.value.conversationId,
      expectedRevision: created.value.revision, content: '已提交的需求' });
    if (!user.ok) throw new Error(user.error.message);
    const renamed = await runtime.conversations.rename({ conversationId: user.value.conversationId, expectedRevision: user.value.revision, title: 'Thread 最新标题' });
    expect(renamed).toMatchObject({ ok: true, value: { title: 'Thread 最新标题' } });
    const threads = new ThreadFileRepository(root);
    expect((await threads.readTurns(toThreadId(user.value.conversationId)))).toHaveLength(1);
    const reopened = createRuntime();
    const restored = await reopened.conversations.get({ conversationId: user.value.conversationId });
    expect(restored).toMatchObject({ ok: true, value: { title: 'Thread 最新标题', messages: [{ content: '已提交的需求' }] } });
    expect(await reopened.projectContexts.createDraft({ conversationId: user.value.conversationId })).toMatchObject({ ok: true });
    await runtime.waitForMutations(); await reopened.waitForMutations();
    denied.mockRestore();
  });
  it('keeps ordinary User, Assistant, Office status and receipts in Thread while Legacy saves fail', async () => {
    const f = await fixture();
    const denied = vi.spyOn(f.legacy, 'save').mockRejectedValue(new Error('Legacy denied'));
    const user = await f.service.addUserMessage({ conversationId: f.conversation.id, expectedRevision: 0, content: '制作文档' });
    const started = await f.streaming.start({ conversationId: user.id, expectedRevision: user.revision });
    const text = await f.streaming.append({ conversationId: user.id, messageId: started.messageId, expectedRevision: started.conversation.revision, chunk: '文档正文' });
    let completed = await f.streaming.complete({ conversationId: text.id, messageId: started.messageId, expectedRevision: text.revision });
    completed = await f.streaming.updateDocumentGenerationStatus({ conversationId: text.id, messageId: started.messageId, expectedRevision: completed.revision, status: { state: 'generating_file', kind: 'word' } });
    const result = { kind: 'word' as const, workId: toWorkId('existing-work'), fileName: '文档.docx', sizeBytes: 100, validatedContent: '文档正文' };
    const delivered = await f.streaming.attachDocumentResult({ conversationId: text.id, messageId: started.messageId, expectedRevision: completed.revision, documentResult: result });
    expect((await f.repository.get(text.id))?.messages.at(-1)).toMatchObject({ content: '文档正文', documentResult: result });
    expect((await f.legacy.get(text.id))?.messages).toHaveLength(0);
    denied.mockRestore();
    expect((await f.projection.drain(text.id)).pending).toBe(0);
    expect((await f.legacy.get(text.id))?.messages).toEqual(delivered.messages);
  });

  it('commits metadata changes without messages and restores their latest state after a projection failure', async () => {
    const f = await fixture(); f.setMetadataFailure(true);
    const renamed = await f.service.rename({ conversationId: f.conversation.id, expectedRevision: 0, title: '已改名' });
    const archived = await f.service.archive({ conversationId: renamed.id, expectedRevision: renamed.revision });
    expect(await f.repository.get(renamed.id)).toMatchObject({ title: '已改名', status: 'archived', revision: archived.revision });
    expect(await f.repository.list({ statuses: ['archived'] })).toHaveLength(1);
    f.setMetadataFailure(false);
    expect((await new ThreadFileRepository(f.root).recover(f.threadId)).status).toBe('ready');
    expect(await f.repository.list({ statuses: ['archived'] })).toHaveLength(1);
    const restored = await f.service.restore({ conversationId: renamed.id, expectedRevision: archived.revision });
    await f.service.delete({ conversationId: renamed.id, expectedRevision: restored.revision });
    await expect(f.service.restore({ conversationId: renamed.id, expectedRevision: restored.revision + 1 })).rejects.toThrow();
    expect(await f.legacy.get(renamed.id)).toMatchObject({ title: '已改名', status: 'deleted' });
  });

  it('rejects stale concurrent saves and foreign projects without dropping transcript messages', async () => {
    const f = await fixture();
    const results = await Promise.allSettled([
      f.service.addUserMessage({ conversationId: f.conversation.id, expectedRevision: 0, content: 'A' }),
      f.service.addUserMessage({ conversationId: f.conversation.id, expectedRevision: 0, content: 'B' })
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect((await f.repository.get(f.conversation.id))?.messages).toHaveLength(1);
    await expect(f.repository.list({ projectId: toProjectId('foreign') })).rejects.toThrow();
    const current = (await f.repository.get(f.conversation.id))!;
    await expect(f.repository.save({ ...current, revision: current.revision + 1, messages: [] }, current.revision)).rejects.toThrow('update_invalid');
  });

  it('retains both Assistant identities on the same Turn when local replies precede the final answer', async () => {
    const f = await fixture();
    const user = await f.service.addUserMessage({ conversationId: f.conversation.id, expectedRevision: 0, content: '讨论' });
    const first = await f.streaming.createCompletedLocalAssistantMessage({ conversationId: user.id, expectedRevision: user.revision, content: '已记录' });
    await f.streaming.createCompletedLocalAssistantMessage({ conversationId: user.id, expectedRevision: first.conversation.revision, content: '最终回复' });
    const [turn] = await f.threads.readTurns(f.threadId);
    expect(turn.assistantItemIds).toHaveLength(2);
    expect(new Set(turn.assistantItemIds.map(item => item.value)).size).toBe(2);
  });
});
