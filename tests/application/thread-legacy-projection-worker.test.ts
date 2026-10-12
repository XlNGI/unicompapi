import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createItemV1, createTurnV1, parseMessage, toIsoTimestamp, toMessageItemId, toMessageId, toProjectId, toThreadId, toTurnId } from '../../src/domain';
import { ThreadLegacyProjectionWorker } from '../../src/application/thread-legacy-projection-worker';
import { ThreadFileRepository } from '../../src/platform/repositories/thread-file-repository';
import { JsonProjectConversationRepository } from '../../src/platform/repositories/json-project-conversation-repository';
import { NodeProjectStorage } from '../../src/platform/storage';

const roots: string[] = [];
const t0 = toIsoTimestamp('2026-10-11T00:00:00.000Z');
const t1 = toIsoTimestamp('2026-10-11T00:00:01.000Z');

afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe('ThreadLegacyProjectionWorker', () => {
  it('recovers missing snapshot metadata at the same Message revision', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-thread-metadata-'));
    roots.push(root);
    const projectId = toProjectId('project-metadata');
    const threadId = toThreadId('thread-metadata');
    const message = parseMessage({ schemaVersion: 1, id: 'assistant-metadata', conversationId: threadId, role: 'assistant',
      state: 'completed', revision: 4, content: '已完成正文', reasoningContent: '已保存推理', attachments: [], streamSequence: 1,
      createdAt: t0, updatedAt: t1, completedAt: t1 });
    const threads = new ThreadFileRepository(root);
    await threads.createThread({ threadId, projectId, title: 'Metadata', createdAt: t0 });
    const conversations = new JsonProjectConversationRepository(new NodeProjectStorage(root), projectId);
    const item = createItemV1({ itemId: toMessageItemId(message.id), threadId, sequence: 1, type: 'assistant_message', status: 'completed',
      content: message.content, createdAt: t0, updatedAt: t1, messageSource: { messageId: message.id, messageRevision: message.revision },
      legacyMessageSnapshot: message as unknown as Readonly<Record<string, unknown>> });
    await threads.append({ threadId, idempotencyKey: 'metadata', occurredAt: t1, items: [item],
      projectionOutbox: [{ schemaVersion: 1, eventId: 'metadata-event', threadId, eventType: 'item_upsert', sequence: 1,
        idempotencyKey: 'metadata', item, occurredAt: t1 }] });
    const { createProjectConversation } = await import('../../src/domain');
    const empty = createProjectConversation({ id: threadId as never, projectId, title: 'Metadata', createdAt: t0 });
    await conversations.create(empty);
    await conversations.save({ ...empty, revision: 1, updatedAt: t1,
      messages: [parseMessage(Object.fromEntries(Object.entries(message).filter(([key]) => key !== 'reasoningContent')))] }, empty.revision);
    const worker = new ThreadLegacyProjectionWorker(threads, conversations, () => t1);
    await expect(worker.drain(String(threadId))).resolves.toMatchObject({ projected: 1, pending: 0 });
    expect((await conversations.get(threadId as never))?.messages).toEqual([message]);
    await expect(worker.drain(String(threadId))).resolves.toMatchObject({ projected: 0, pending: 0 });
  });
  it.each(['streaming', 'failed', 'cancelled', 'completed'] as const)('restores the first %s Assistant snapshot with its metadata after projection loss', async state => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-thread-snapshot-'));
    roots.push(root);
    const projectId = toProjectId('project-snapshot');
    const threadId = toThreadId('thread-snapshot');
    const message = parseMessage({ schemaVersion: 1, id: 'assistant-snapshot', conversationId: threadId,
      role: 'assistant', state, revision: 4, content: '真实回复片段', reasoningContent: '已保存的推理文本',
      attachments: [], streamSequence: 1, createdAt: t0, updatedAt: t1,
      ...(state === 'streaming' ? { startedAt: t0 } : state === 'failed' ? { failedAt: t1, failureReason: 'interrupted' }
        : state === 'cancelled' ? { cancelledAt: t1 } : { completedAt: t1,
          documentResult: { kind: 'ppt', workId: 'work-snapshot', fileName: 'snapshot.pptx', sizeBytes: 123 } }) });
    const repository = new ThreadFileRepository(root);
    await repository.createThread({ threadId, projectId, title: 'Snapshot', createdAt: t0 });
    const item = createItemV1({ itemId: toMessageItemId(message.id), threadId, sequence: 1, type: 'assistant_message',
      status: state, content: message.content, createdAt: t0, updatedAt: t1,
      messageSource: { messageId: message.id, messageRevision: message.revision },
      legacyMessageSnapshot: message as unknown as Readonly<Record<string, unknown>> });
    await repository.append({ threadId, idempotencyKey: 'snapshot', occurredAt: t1, items: [item],
      projectionOutbox: [{ schemaVersion: 1, eventId: 'snapshot-event', threadId, eventType: 'item_upsert',
        sequence: 1, idempotencyKey: 'snapshot', item, occurredAt: t1 }] });
    const conversations = new JsonProjectConversationRepository(new NodeProjectStorage(root), projectId);
    const worker = new ThreadLegacyProjectionWorker(repository, conversations, () => t1);
    await expect(worker.drain(String(threadId))).resolves.toMatchObject({ projected: 1, pending: 0 });
    expect((await conversations.get(threadId as never))?.messages).toEqual([message]);
    await expect(worker.drain(String(threadId))).resolves.toMatchObject({ projected: 0, pending: 0 });
  });

  it('projects a committed User Item once and resumes from a durable receipt', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-thread-legacy-worker-'));
    roots.push(root);
    const projectId = toProjectId('project-worker');
    const threadId = toThreadId('thread-worker');
    const repository = new ThreadFileRepository(root);
    await repository.createThread({ threadId, projectId, title: 'Worker', createdAt: t0 });
    const item = createItemV1({ itemId: toMessageItemId('message-worker'), threadId, turnId: toTurnId('turn-message-worker'), sequence: 1, type: 'user_message', status: 'completed', createdAt: t0, updatedAt: t0, messageSource: { messageId: toMessageId('message-worker'), messageRevision: 0 }, content: '你好' });
    const turn = createTurnV1({ turnId: toTurnId('turn-message-worker'), threadId, turnSequence: 1, createdAt: t0, userItemId: item.itemId, provenance: 'native' });
    await repository.append({ threadId, idempotencyKey: 'worker-command', occurredAt: t1, turns: [turn], items: [item], projectionOutbox: [{ schemaVersion: 1, eventId: 'worker-event', threadId, eventType: 'item_upsert', sequence: 1, idempotencyKey: 'worker-item', item, occurredAt: t1 }] });
    const conversations = new JsonProjectConversationRepository(new NodeProjectStorage(root), projectId);
    const worker = new ThreadLegacyProjectionWorker(repository, conversations, () => t1);
    await expect(worker.drain(String(threadId))).resolves.toMatchObject({ projected: 1, pending: 0 });
    expect((await conversations.get(threadId as never))?.messages.map(message => message.content)).toEqual(['你好']);
    await expect(worker.drain(String(threadId))).resolves.toMatchObject({ projected: 0, pending: 0 });
  });

  it('acknowledges stale Assistant stream events without blocking later Turns', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-thread-legacy-worker-debt-'));
    roots.push(root);
    const projectId = toProjectId('project-worker-debt');
    const threadId = toThreadId('thread-worker-debt');
    const repository = new ThreadFileRepository(root);
    await repository.createThread({ threadId, projectId, title: 'Worker debt', createdAt: t0 });
    const user = createItemV1({ itemId: toMessageItemId('message-debt-user'), threadId, turnId: toTurnId('turn-debt'), sequence: 1, type: 'user_message', status: 'completed', createdAt: t0, updatedAt: t0, messageSource: { messageId: toMessageId('message-debt-user'), messageRevision: 0 }, content: '第一轮' });
    const assistant = createItemV1({ itemId: toMessageItemId('message-debt-assistant'), threadId, turnId: toTurnId('turn-debt'), sequence: 2, type: 'assistant_message', status: 'completed', createdAt: t0, updatedAt: t1, messageSource: { messageId: toMessageId('message-debt-assistant'), messageRevision: 0 }, content: '最终回复' });
    const turn = createTurnV1({ turnId: toTurnId('turn-debt'), threadId, turnSequence: 1, createdAt: t0, userItemId: user.itemId, provenance: 'native' });
    await repository.append({ threadId, idempotencyKey: 'worker-debt-seed', occurredAt: t1, turns: [turn], items: [user, assistant], projectionOutbox: [
      { schemaVersion: 1, eventId: 'worker-debt-user', threadId, eventType: 'item_upsert', sequence: 1, idempotencyKey: 'worker-debt-user', item: user, occurredAt: t1 },
      { schemaVersion: 1, eventId: 'worker-debt-assistant', threadId, eventType: 'item_upsert', sequence: 2, idempotencyKey: 'worker-debt-assistant', item: assistant, occurredAt: t1 }
    ] });
    const conversations = new JsonProjectConversationRepository(new NodeProjectStorage(root), projectId);
    const worker = new ThreadLegacyProjectionWorker(repository, conversations, () => t1);
    await expect(worker.drain(String(threadId))).resolves.toMatchObject({ projected: 2, pending: 0 });
    expect((await conversations.get(threadId as never))?.messages.map(message => message.content)).toEqual(['第一轮', '最终回复']);
    const staleAssistant = { ...assistant, content: '旧流片段', updatedAt: t1 };
    await repository.append({ threadId, idempotencyKey: 'worker-debt-stale', occurredAt: t1, items: [staleAssistant], projectionOutbox: [{ schemaVersion: 1, eventId: 'worker-debt-stale-event', threadId, eventType: 'item_upsert', sequence: 2, idempotencyKey: 'worker-debt-stale-event', item: staleAssistant, occurredAt: t1 }] });
    await expect(worker.drain(String(threadId))).resolves.toMatchObject({ projected: 1, pending: 0 });
    expect((await conversations.get(threadId as never))?.messages.at(-1)?.content).toBe('最终回复');
  });
});
