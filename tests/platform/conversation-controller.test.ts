import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ConversationStreamingService,
  type ConversationIdFactory
} from '../../src/application';
import {
  addUserMessage,
  createConversation,
  toConversationId,
  toIsoTimestamp,
  toMessageId,
  toProjectId
} from '../../src/domain';
import {
  createChatContextRuntime,
  JsonConversationRepository,
  JsonProjectConversationRepository,
  NodeProjectStorage,
  type StorageProjectSession
} from '../../src/platform';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-chat-controller-'));
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'unicomp-chat-project-'));
  roots.push(root, projectRoot);
  let session: StorageProjectSession | undefined;
  let conversationNumber = 0;
  let messageNumber = 0;
  const ids: ConversationIdFactory = {
    nextConversationId: () =>
      toConversationId(`conversation-${++conversationNumber}`),
    nextMessageId: () => toMessageId(`message-${++messageNumber}`)
  };
  const runtime = createChatContextRuntime({
    userDataDirectory: root,
    getSession: () => session,
    conversationIds: ids,
    now: (() => {
      let tick = 0;
      return () => new Date(Date.UTC(2020, 0, 1, 0, 0, tick++)).toISOString();
    })()
  });
  return {
    root,
    projectRoot,
    controller: runtime.conversations,
    responses: runtime.responses,
    contexts: runtime.projectContexts,
    ids,
    openProject() {
      session = {
        projectId: toProjectId('project-chat'),
        projectName: 'Chat project',
        rootDirectory: projectRoot
      };
    }
  };
}

describe('ConversationController', () => {
  it('requires the active project and rejects new unbound conversations', async () => {
    const value = await fixture();
    const unbound = await value.controller.create({
      title: 'Unbound chat',
      bindToCurrentProject: false
    });
    const withoutProject = await value.controller.create({
      title: 'Bound chat',
      bindToCurrentProject: true
    });
    value.openProject();
    const rejectedUnbound = await value.controller.create({
      title: 'Unbound chat',
      bindToCurrentProject: false
    });
    const bound = await value.controller.create({
      title: 'Bound chat',
      bindToCurrentProject: true
    });

    expect(unbound).toMatchObject({ ok: false, error: { code: 'project_not_open' } });
    expect(withoutProject).toMatchObject({
      ok: false,
      error: { code: 'project_not_open' }
    });
    expect(bound).toMatchObject({
      ok: true,
      value: { projectId: 'project-chat', storageScope: 'current_project', readOnly: false }
    });
    expect(rejectedUnbound).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
  });

  it('strictly validates requests and reports optimistic revision conflicts', async () => {
    const value = await fixture();
    value.openProject();
    const invalid = await value.controller.create({
      title: 'Invalid',
      bindToCurrentProject: false,
      path: 'C:\\private\\chat.json'
    });
    const created = await value.controller.create({
      title: 'Revision chat',
      bindToCurrentProject: true
    });
    if (!created.ok) throw new Error('fixture creation failed');
    const conflict = await value.controller.rename({
      conversationId: created.value.conversationId,
      expectedRevision: 9,
      title: 'Stale title'
    });

    expect(invalid).toMatchObject({
      ok: false,
      error: { code: 'invalid_request' }
    });
    expect(conflict).toMatchObject({
      ok: false,
      error: { code: 'revision_conflict', currentRevision: 0 }
    });
    expect(JSON.stringify(invalid)).not.toContain('C:\\private');
  });

  it('lists only current-project safe conversation candidates without message content', async () => {
    const value = await fixture();
    expect(await value.controller.listCandidates()).toMatchObject({
      ok: false,
      error: { code: 'project_not_open' }
    });

    value.openProject();
    const bound = await value.controller.create({
      title: 'Bound chat',
      bindToCurrentProject: true
    });
    if (!bound.ok) throw new Error('fixture creation failed');
    const withMessage = await value.controller.addUserMessage({
      conversationId: bound.value.conversationId,
      expectedRevision: bound.value.revision,
      content: 'private message body'
    });
    if (!withMessage.ok) throw new Error('fixture message failed');

    const candidates = await value.controller.listCandidates();
    expect(candidates).toEqual({
      ok: true,
      value: [{
        conversationId: bound.value.conversationId,
        projectId: 'project-chat',
        title: 'Bound chat',
        status: 'active',
        messageCount: 1,
        completedMessageCount: 1,
        updatedAt: withMessage.value.updatedAt
      }]
    });
    expect(JSON.stringify(candidates)).not.toContain('private message body');
    expect(JSON.stringify(candidates)).not.toContain('messages');
  });

  it('creates a persisted response draft and reports no fabricated candidates', async () => {
    const value = await fixture();
    await expect(value.responses.createDraft({
      conversationId: 'conversation-missing',
      expectedRevision: 0,
      userMessageId: 'message-missing',
      productFeature: 'text_chat'
    })).resolves.toMatchObject({
      ok: false,
      error: { code: 'project_not_open' }
    });
    value.openProject();
    const created = await value.controller.create({
      title: 'Offline chat',
      bindToCurrentProject: true
    });
    if (!created.ok) throw new Error('fixture creation failed');
    const withMessage = await value.controller.addUserMessage({
      conversationId: created.value.conversationId,
      expectedRevision: created.value.revision,
      content: 'local message'
    });
    if (!withMessage.ok) throw new Error('fixture message failed');
    const userMessage = withMessage.value.messages[0];
    const contextDraft = await value.contexts.createDraft({
      conversationId: withMessage.value.conversationId
    });
    if (!contextDraft.ok) throw new Error('context draft unavailable');
    const withFragment = await value.contexts.addMessageFragment({
      draftId: contextDraft.value.draftId,
      expectedRevision: contextDraft.value.revision,
      messageId: userMessage.messageId,
      startUtf16: 0,
      endUtf16: userMessage.content.length
    });
    if (!withFragment.ok) throw new Error('context fragment unavailable');
    const registered = await value.contexts.registerDraft({
      draftId: withFragment.value.draftId,
      expectedRevision: withFragment.value.revision,
      confirmed: true
    });
    if (!registered.ok) throw new Error('registered context unavailable');
    const draft = await value.responses.createDraft({
      conversationId: withMessage.value.conversationId,
      expectedRevision: withMessage.value.revision,
      userMessageId: userMessage.messageId,
      productFeature: 'text_chat'
    });
    expect(draft).toMatchObject({
      ok: true,
      value: { conversationId: created.value.conversationId, productFeature: 'text_chat' }
    });
    expect(JSON.stringify(draft)).not.toMatch(
      /local message|contentHash|contentSnapshot|prompt|routeSnapshot|credential|endpoint|[A-Z]:\\\\/
    );
    if (!draft.ok) throw new Error('response draft unavailable');
    const pinned = await value.responses.replaceContexts({
      responseDraftId: draft.value.responseDraftId,
      expectedRevision: draft.value.revision,
      selections: [{
        contextId: registered.value.contextId,
        contextRevision: registered.value.revision,
        includeInPrompt: true
      }]
    });
    expect(pinned).toMatchObject({
      ok: true,
      value: {
        contextSelections: [{
          contextId: registered.value.contextId,
          contextRevision: registered.value.revision,
          includeInPrompt: true
        }]
      }
    });
    expect(JSON.stringify(pinned)).not.toMatch(
      /local message|contentHash|contentSnapshot|prompt|routeSnapshot|credential|endpoint|[A-Z]:\\\\/
    );
    if (!pinned.ok) throw new Error('pinned response context unavailable');
    await expect(value.responses.listCandidates({
      responseDraftId: pinned.value.responseDraftId,
      expectedRevision: pinned.value.revision
    })).resolves.toEqual({ ok: true, value: [] });
  });

  it('keeps stream facts behind the application service lifecycle', async () => {
    const value = await fixture();
    value.openProject();
    const created = await value.controller.create({
      title: 'Stream chat',
      bindToCurrentProject: true
    });
    if (!created.ok) throw new Error('fixture creation failed');
    const repository = new JsonProjectConversationRepository(
      new NodeProjectStorage(value.projectRoot),
      toProjectId('project-chat')
    );
    const streaming = new ConversationStreamingService(repository, value.ids);
    const started = await streaming.start({
      conversationId: toConversationId(created.value.conversationId),
      expectedRevision: 0
    });
    const appended = await streaming.append({
      conversationId: started.conversation.id,
      messageId: started.messageId,
      expectedRevision: started.conversation.revision,
      chunk: 'real chunk'
    });
    const completed = await streaming.complete({
      conversationId: appended.id,
      messageId: started.messageId,
      expectedRevision: appended.revision
    });

    expect(started.conversation.messages[0]).toMatchObject({ state: 'pending' });
    expect(appended.messages[0]).toMatchObject({
      state: 'streaming',
      content: 'real chunk'
    });
    expect(completed.messages[0]).toMatchObject({
      state: 'completed',
      content: 'real chunk'
    });
  });

  it('keeps legacy application conversations read-only until explicit project copy', async () => {
    const value = await fixture();
    const legacyRepository = new JsonConversationRepository(
      path.join(value.root, 'conversations.json')
    );
    const legacy = addUserMessage(createConversation({
      id: toConversationId('conversation-legacy'),
      title: 'Legacy chat',
      createdAt: toIsoTimestamp('2020-01-01T00:00:00.000Z')
    }), {
      id: toMessageId('message-legacy'),
      content: 'legacy completed text',
      createdAt: toIsoTimestamp('2020-01-01T00:00:01.000Z')
    });
    await legacyRepository.create({ ...legacy, revision: 0, messages: [] });
    await legacyRepository.save(legacy, 0);
    value.openProject();

    const listed = await value.controller.list({
      includeArchived: true,
      includeDeleted: false
    });
    expect(listed).toMatchObject({
      ok: true,
      value: [{
        conversationId: 'conversation-legacy',
        storageScope: 'legacy_unbound',
        readOnly: true
      }]
    });
    const copied = await value.controller.copyLegacyConversation({
      conversationId: 'conversation-legacy'
    });
    expect(copied).toMatchObject({
      ok: true,
      value: {
        projectId: 'project-chat',
        storageScope: 'current_project',
        readOnly: false,
        messages: [{ content: 'legacy completed text', state: 'completed' }]
      }
    });

    const concurrent = await Promise.all([
      value.controller.copyLegacyConversation({ conversationId: 'conversation-legacy' }),
      value.controller.copyLegacyConversation({ conversationId: 'conversation-legacy' })
    ]);
    expect(concurrent).toHaveLength(2);
    expect(concurrent.every((result) =>
      result.ok &&
      result.value.messages.length === 1 &&
      result.value.messages[0].content === 'legacy completed text'
    )).toBe(true);
    expect(new Set(concurrent.flatMap((result) =>
      result.ok ? [result.value.conversationId] : []
    )).size).toBe(2);

    const projectRepository = new JsonProjectConversationRepository(
      new NodeProjectStorage(value.projectRoot),
      toProjectId('project-chat')
    );
    await expect(projectRepository.list()).resolves.toHaveLength(3);
    await expect(legacyRepository.get(toConversationId('conversation-legacy'))).resolves
      .toEqual(legacy);
  });
});
