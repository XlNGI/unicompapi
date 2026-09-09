import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ProjectContextApplicationError,
  ProjectContextRegistryService,
  type ProjectContextIdFactory
} from '../../src/application';
import {
  addUserMessage,
  beginAssistantMessage,
  createConversation,
  deleteConversation,
  toConversationId,
  toIsoTimestamp,
  toMessageId,
  toProjectContextDraftId,
  toProjectContextFragmentId,
  toProjectContextId,
  toProjectId
} from '../../src/domain';
import {
  JsonConversationRepository,
  JsonProjectContextRepository,
  NodeProjectStorage
} from '../../src/platform';

const roots: string[] = [];
const projectId = toProjectId('project-context-service');
const t0 = toIsoTimestamp('2026-07-28T15:00:00.000Z');
const t1 = toIsoTimestamp('2026-07-28T15:01:00.000Z');
const t2 = toIsoTimestamp('2026-07-28T15:02:00.000Z');

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-context-service-'));
  roots.push(root);
  let time = 0;
  const now = () => `2026-07-28T16:${String(time++).padStart(2, '0')}:00.000Z`;
  let draft = 0;
  let fragment = 0;
  let context = 0;
  const ids: ProjectContextIdFactory = {
    nextDraftId: () => toProjectContextDraftId(`service-draft-${draft++}`),
    nextFragmentId: () => toProjectContextFragmentId(`service-fragment-${fragment++}`),
    nextContextId: () => toProjectContextId(`service-context-${context++}`)
  };
  const conversationPath = path.join(root, 'application', 'conversations.json');
  const conversations = new JsonConversationRepository(
    conversationPath,
    now
  );
  const contexts = new JsonProjectContextRepository(
    new NodeProjectStorage(path.join(root, 'project')),
    projectId,
    now
  );
  return {
    conversationPath,
    conversations,
    contexts,
    service: new ProjectContextRegistryService(conversations, contexts, ids, now)
  };
}

async function saveCompletedConversation(
  conversations: JsonConversationRepository,
  id = 'saved-conversation'
) {
  const created = createConversation({
    id: toConversationId(id),
    title: '已保存对话',
    createdAt: t0
  });
  await conversations.create(created);
  const first = addUserMessage(created, {
    id: toMessageId(`${id}-message-1`),
    content: '第一条已完成消息',
    createdAt: t1
  });
  await conversations.save(first, 0);
  const second = addUserMessage(first, {
    id: toMessageId(`${id}-message-2`),
    content: '第二条已完成消息',
    createdAt: t2
  });
  await conversations.save(second, 1);
  return second;
}

describe('ProjectContextRegistryService', () => {
  it('builds a multi-message preview and registers only after explicit confirmation', async () => {
    const { conversations, service, contexts } = await fixture();
    const conversation = await saveCompletedConversation(conversations);
    let draft = await service.createDraft({
      projectId,
      conversationId: conversation.id
    });
    draft = await service.addMessageFragment({
      projectId,
      draftId: draft.draftId,
      expectedRevision: draft.revision,
      messageId: conversation.messages[0].id,
      startUtf16: 0,
      endUtf16: conversation.messages[0].content.length
    });
    draft = await service.addMessageFragment({
      projectId,
      draftId: draft.draftId,
      expectedRevision: draft.revision,
      messageId: conversation.messages[1].id,
      startUtf16: 0,
      endUtf16: conversation.messages[1].content.length
    });
    draft = await service.updateDraftLabels({
      projectId,
      draftId: draft.draftId,
      expectedRevision: draft.revision,
      labels: ['需求', '确认']
    });

    expect(draft).toMatchObject({
      revision: 3,
      canRegister: true,
      contentPreview: '第一条已完成消息\n\n第二条已完成消息'
    });
    await expect(service.registerDraft({
      projectId,
      draftId: draft.draftId,
      expectedRevision: draft.revision,
      confirmed: false as true
    })).rejects.toMatchObject({ code: 'explicit_confirmation_required' });
    await expect(contexts.list()).resolves.toEqual([]);

    const registered = await service.registerDraft({
      projectId,
      draftId: draft.draftId,
      expectedRevision: draft.revision,
      confirmed: true
    });
    expect(registered).toMatchObject({
      revision: 1,
      status: 'active',
      sourceStatus: 'available',
      labels: ['需求', '确认'],
      contentSnapshot: '第一条已完成消息\n\n第二条已完成消息'
    });
    expect(await service.listCandidates({ projectId })).toHaveLength(1);
  });

  it('rejects unsaved conversations, unfinished messages and cross-conversation messages', async () => {
    const { conversations, service } = await fixture();
    await expect(service.createDraft({
      projectId,
      conversationId: toConversationId('not-saved')
    })).rejects.toMatchObject({ code: 'conversation_not_saved' });

    const pendingBase = createConversation({
      id: toConversationId('pending-conversation'),
      title: '未完成消息',
      createdAt: t0
    });
    await conversations.create(pendingBase);
    const pending = beginAssistantMessage(pendingBase, {
      id: toMessageId('pending-message'),
      createdAt: t1
    });
    await conversations.save(pending, 0);
    const pendingDraft = await service.createDraft({
      projectId,
      conversationId: pending.id
    });
    await expect(service.addMessageFragment({
      projectId,
      draftId: pendingDraft.draftId,
      expectedRevision: 0,
      messageId: pending.messages[0].id,
      startUtf16: 0,
      endUtf16: 1
    })).rejects.toMatchObject({ code: 'message_not_completed' });

    const first = await saveCompletedConversation(conversations, 'conversation-one');
    const second = await saveCompletedConversation(conversations, 'conversation-two');
    const firstDraft = await service.createDraft({
      projectId,
      conversationId: first.id
    });
    await expect(service.addMessageFragment({
      projectId,
      draftId: firstDraft.draftId,
      expectedRevision: 0,
      messageId: second.messages[0].id,
      startUtf16: 0,
      endUtf16: second.messages[0].content.length
    })).rejects.toMatchObject({ code: 'message_not_found' });
  });

  it('keeps registered snapshots valid after source deletion and preserves old revisions', async () => {
    const { conversations, service } = await fixture();
    const conversation = await saveCompletedConversation(conversations, 'source-delete');
    let draft = await service.createDraft({ projectId, conversationId: conversation.id });
    draft = await service.addMessageFragment({
      projectId,
      draftId: draft.draftId,
      expectedRevision: 0,
      messageId: conversation.messages[0].id,
      startUtf16: 0,
      endUtf16: conversation.messages[0].content.length
    });
    const registered = await service.registerDraft({
      projectId,
      draftId: draft.draftId,
      expectedRevision: 1,
      confirmed: true
    });

    const deletedConversation = deleteConversation(conversation, toIsoTimestamp(
      '2026-07-28T15:03:00.000Z'
    ));
    await conversations.save(deletedConversation, conversation.revision);
    const refreshed = await service.refreshSourceStatus({
      projectId,
      contextId: registered.contextId,
      expectedRevision: 1
    });
    expect(refreshed).toMatchObject({
      revision: 2,
      sourceStatus: 'source_deleted',
      contentSnapshot: '第一条已完成消息'
    });
    const original = await service.getContextRevision({
      projectId,
      contextId: registered.contextId,
      revision: 1
    });
    expect(original).toMatchObject({
      isCurrent: false,
      sourceStatus: 'available',
      contentSnapshot: '第一条已完成消息'
    });

    const tombstone = await service.deleteContext({
      projectId,
      contextId: registered.contextId,
      expectedRevision: 2
    });
    expect(tombstone).toMatchObject({ revision: 3, status: 'deleted' });
    expect(await service.listCandidates({ projectId })).toEqual([]);
    await expect(conversations.get(conversation.id)).resolves.toEqual(
      deletedConversation
    );
  });

  it('creates new content revisions and returns path-free application DTOs', async () => {
    const { conversations, service } = await fixture();
    const conversation = await saveCompletedConversation(conversations, 'safe-dto');
    let draft = await service.createDraft({ projectId, conversationId: conversation.id });
    draft = await service.addMessageFragment({
      projectId,
      draftId: draft.draftId,
      expectedRevision: 0,
      messageId: conversation.messages[0].id,
      startUtf16: 0,
      endUtf16: conversation.messages[0].content.length
    });
    const registered = await service.registerDraft({
      projectId,
      draftId: draft.draftId,
      expectedRevision: 1,
      confirmed: true
    });
    const updated = await service.updateContext({
      projectId,
      contextId: registered.contextId,
      expectedRevision: 1,
      contentSnapshot: '用户修订后的独立快照',
      labels: ['修订']
    });
    const old = await service.getContextRevision({
      projectId,
      contextId: registered.contextId,
      revision: 1
    });
    expect(updated).toMatchObject({ revision: 2, labels: ['修订'] });
    expect(old.contentSnapshot).toBe('第一条已完成消息');

    const serialized = JSON.stringify({
      draft,
      updated,
      candidates: await service.listCandidates({ projectId }),
      source: await service.getSourceStatus({
        projectId,
        contextId: registered.contextId
      })
    });
    expect(serialized).not.toMatch(
      /absolutePath|sha256|apiKey|credential|endpoint|storagePath|file:\/\//i
    );
  });

  it('records source_unavailable without invalidating the registered snapshot', async () => {
    const { conversationPath, conversations, service } = await fixture();
    const conversation = await saveCompletedConversation(
      conversations,
      'source-unavailable'
    );
    let draft = await service.createDraft({ projectId, conversationId: conversation.id });
    draft = await service.addMessageFragment({
      projectId,
      draftId: draft.draftId,
      expectedRevision: 0,
      messageId: conversation.messages[0].id,
      startUtf16: 0,
      endUtf16: conversation.messages[0].content.length
    });
    const registered = await service.registerDraft({
      projectId,
      draftId: draft.draftId,
      expectedRevision: 1,
      confirmed: true
    });

    await rm(conversationPath, { force: true });
    await rm(`${conversationPath}.bak`, { force: true });
    const refreshed = await service.refreshSourceStatus({
      projectId,
      contextId: registered.contextId,
      expectedRevision: 1
    });
    expect(refreshed).toMatchObject({
      revision: 2,
      sourceStatus: 'source_unavailable',
      contentSnapshot: '第一条已完成消息'
    });
  });

  it('uses stable application error codes without exposing storage details', async () => {
    const { service } = await fixture();
    await expect(service.getContext({
      projectId,
      contextId: toProjectContextId('missing-context')
    })).rejects.toBeInstanceOf(ProjectContextApplicationError);
  });
});
