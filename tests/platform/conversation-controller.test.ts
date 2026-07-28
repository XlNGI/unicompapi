import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ConversationStreamingService,
  type ConversationIdFactory
} from '../../src/application';
import {
  toConversationId,
  toMessageId,
  toProjectId
} from '../../src/domain';
import {
  createChatContextRuntime,
  JsonConversationRepository,
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
    controller: runtime.conversations,
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
  it('creates global conversations and requires an active project for explicit binding', async () => {
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
    const bound = await value.controller.create({
      title: 'Bound chat',
      bindToCurrentProject: true
    });

    expect(unbound).toMatchObject({ ok: true, value: { projectId: null } });
    expect(withoutProject).toMatchObject({
      ok: false,
      error: { code: 'project_not_open' }
    });
    expect(bound).toMatchObject({
      ok: true,
      value: { projectId: 'project-chat' }
    });
  });

  it('strictly validates requests and reports optimistic revision conflicts', async () => {
    const value = await fixture();
    const invalid = await value.controller.create({
      title: 'Invalid',
      bindToCurrentProject: false,
      path: 'C:\\private\\chat.json'
    });
    const created = await value.controller.create({
      title: 'Revision chat',
      bindToCurrentProject: false
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

  it('returns adapter_unavailable without creating or completing an assistant message', async () => {
    const value = await fixture();
    const created = await value.controller.create({
      title: 'Offline chat',
      bindToCurrentProject: false
    });
    if (!created.ok) throw new Error('fixture creation failed');
    const response = await value.controller.requestAssistantResponse({
      conversationId: created.value.conversationId,
      expectedRevision: created.value.revision
    });
    const stored = await value.controller.get({
      conversationId: created.value.conversationId
    });

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'adapter_unavailable' }
    });
    expect(stored).toEqual(created);
    if (!stored.ok) throw new Error('stored conversation unavailable');
    expect(stored.value.messages).toHaveLength(0);
  });

  it('keeps stream facts behind the application service lifecycle', async () => {
    const value = await fixture();
    const created = await value.controller.create({
      title: 'Stream chat',
      bindToCurrentProject: false
    });
    if (!created.ok) throw new Error('fixture creation failed');
    const repository = new JsonConversationRepository(
      path.join(value.root, 'conversations.json')
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
});
