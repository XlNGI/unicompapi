import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ConversationStreamingService,
  type ConversationIdFactory,
  type ProjectContextIdFactory
} from '../../src/application';
import {
  toConversationId,
  toMessageId,
  toProjectContextDraftId,
  toProjectContextFragmentId,
  toProjectContextId,
  toProjectId
} from '../../src/domain';
import {
  createChatContextRuntime,
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
  const userData = await mkdtemp(path.join(os.tmpdir(), 'unicomp-context-ipc-'));
  const projectA = await mkdtemp(path.join(os.tmpdir(), 'unicomp-context-a-'));
  const projectB = await mkdtemp(path.join(os.tmpdir(), 'unicomp-context-b-'));
  roots.push(userData, projectA, projectB);
  let session: StorageProjectSession | undefined = {
    projectId: toProjectId('project-a'),
    projectName: 'Project A',
    rootDirectory: projectA
  };
  let conversationNumber = 0;
  let messageNumber = 0;
  let draftNumber = 0;
  let fragmentNumber = 0;
  let contextNumber = 0;
  const conversationIds: ConversationIdFactory = {
    nextConversationId: () =>
      toConversationId(`conversation-${++conversationNumber}`),
    nextMessageId: () => toMessageId(`message-${++messageNumber}`)
  };
  const projectContextIds: ProjectContextIdFactory = {
    nextDraftId: () => toProjectContextDraftId(`draft-${++draftNumber}`),
    nextFragmentId: () =>
      toProjectContextFragmentId(`fragment-${++fragmentNumber}`),
    nextContextId: () => toProjectContextId(`context-${++contextNumber}`)
  };
  const runtime = createChatContextRuntime({
    userDataDirectory: userData,
    getSession: () => session,
    conversationIds,
    projectContextIds,
    now: (() => {
      let tick = 0;
      return () => new Date(Date.UTC(2020, 0, 1, 0, 0, tick++)).toISOString();
    })()
  });
  return {
    projectA,
    conversations: runtime.conversations,
    contexts: runtime.projectContexts,
    conversationIds,
    closeProject: () => {
      session = undefined;
    },
    openProjectB: () => {
      session = {
        projectId: toProjectId('project-b'),
        projectName: 'Project B',
        rootDirectory: projectB
      };
    }
  };
}

async function createConversationWithMessage(
  value: Awaited<ReturnType<typeof fixture>>,
  content: string
) {
  const created = await value.conversations.create({
    title: content,
    bindToCurrentProject: true
  });
  if (!created.ok) throw new Error('conversation fixture failed');
  const updated = await value.conversations.addUserMessage({
    conversationId: created.value.conversationId,
    expectedRevision: created.value.revision,
    content
  });
  if (!updated.ok) throw new Error('message fixture failed');
  return {
    conversation: updated.value,
    message: updated.value.messages[0]
  };
}

describe('ProjectContextController', () => {
  it('requires a current project and rejects unsaved conversation IDs', async () => {
    const value = await fixture();
    const unsaved = await value.contexts.createDraft({
      conversationId: 'conversation-missing'
    });
    value.closeProject();
    const noProject = await value.contexts.createDraft({
      conversationId: 'conversation-missing'
    });

    expect(unsaved).toMatchObject({
      ok: false,
      error: { code: 'conversation_not_saved' }
    });
    expect(noProject).toMatchObject({
      ok: false,
      error: { code: 'project_not_open' }
    });
  });

  it('rejects non-completed and cross-conversation message fragments', async () => {
    const value = await fixture();
    const first = await createConversationWithMessage(value, 'first message');
    const second = await createConversationWithMessage(value, 'second message');
    const repository = new JsonProjectConversationRepository(
      new NodeProjectStorage(value.projectA),
      toProjectId('project-a')
    );
    const streaming = new ConversationStreamingService(
      repository,
      value.conversationIds
    );
    const pending = await streaming.start({
      conversationId: toConversationId(first.conversation.conversationId),
      expectedRevision: first.conversation.revision
    });
    const draft = await value.contexts.createDraft({
      conversationId: first.conversation.conversationId
    });
    if (!draft.ok) throw new Error('draft fixture failed');
    const nonCompleted = await value.contexts.addMessageFragment({
      draftId: draft.value.draftId,
      expectedRevision: draft.value.revision,
      messageId: pending.messageId,
      startUtf16: 0,
      endUtf16: 1
    });
    const crossConversation = await value.contexts.addMessageFragment({
      draftId: draft.value.draftId,
      expectedRevision: draft.value.revision,
      messageId: second.message.messageId,
      startUtf16: 0,
      endUtf16: second.message.content.length
    });

    expect(nonCompleted).toMatchObject({
      ok: false,
      error: { code: 'message_not_completed' }
    });
    expect(crossConversation).toMatchObject({
      ok: false,
      error: { code: 'message_not_found' }
    });
  });

  it('registers multiple fragments, preserves snapshots after source deletion, and updates source status', async () => {
    const value = await fixture();
    const source = await createConversationWithMessage(value, 'first selected text');
    const secondMessage = await value.conversations.addUserMessage({
      conversationId: source.conversation.conversationId,
      expectedRevision: source.conversation.revision,
      content: 'second selected text'
    });
    if (!secondMessage.ok) throw new Error('second message fixture failed');
    const draft = await value.contexts.createDraft({
      conversationId: source.conversation.conversationId
    });
    if (!draft.ok) throw new Error('draft fixture failed');
    const firstFragment = await value.contexts.addMessageFragment({
      draftId: draft.value.draftId,
      expectedRevision: draft.value.revision,
      messageId: source.message.messageId,
      startUtf16: 0,
      endUtf16: source.message.content.length
    });
    if (!firstFragment.ok) throw new Error('first fragment fixture failed');
    const second = secondMessage.value.messages[1];
    const secondFragment = await value.contexts.addMessageFragment({
      draftId: draft.value.draftId,
      expectedRevision: firstFragment.value.revision,
      messageId: second.messageId,
      startUtf16: 0,
      endUtf16: second.content.length
    });
    if (!secondFragment.ok) throw new Error('second fragment fixture failed');
    const registered = await value.contexts.registerDraft({
      draftId: draft.value.draftId,
      expectedRevision: secondFragment.value.revision,
      confirmed: true
    });
    if (!registered.ok) throw new Error('registration fixture failed');
    const deleted = await value.conversations.delete({
      conversationId: secondMessage.value.conversationId,
      expectedRevision: secondMessage.value.revision
    });
    if (!deleted.ok) throw new Error('deletion fixture failed');
    const preserved = await value.contexts.getContext({
      contextId: registered.value.contextId
    });
    const refreshed = await value.contexts.refreshSourceStatus({
      contextId: registered.value.contextId,
      expectedRevision: registered.value.revision
    });

    expect(registered.value.sourceFragments).toHaveLength(2);
    expect(preserved).toMatchObject({
      ok: true,
      value: {
        contentSnapshot: registered.value.contentSnapshot,
        status: 'active'
      }
    });
    expect(refreshed).toMatchObject({
      ok: true,
      value: { sourceStatus: 'source_deleted', revision: 2 }
    });
  });

  it('rejects stale revisions, unknown fields, and access through another project session', async () => {
    const value = await fixture();
    const source = await createConversationWithMessage(value, 'scoped content');
    const draft = await value.contexts.createDraft({
      conversationId: source.conversation.conversationId
    });
    if (!draft.ok) throw new Error('draft fixture failed');
    const invalid = await value.contexts.getDraftPreview({
      draftId: draft.value.draftId,
      projectId: 'project-a'
    });
    const stale = await value.contexts.updateDraftLabels({
      draftId: draft.value.draftId,
      expectedRevision: 7,
      labels: ['stale']
    });
    value.openProjectB();
    const crossProject = await value.contexts.getDraftPreview({
      draftId: draft.value.draftId
    });

    expect(invalid).toMatchObject({
      ok: false,
      error: { code: 'invalid_request' }
    });
    expect(stale).toMatchObject({
      ok: false,
      error: { code: 'revision_conflict' }
    });
    expect(crossProject).toMatchObject({
      ok: false,
      error: { code: 'draft_not_found' }
    });
    const serialized = JSON.stringify([invalid, stale, crossProject]);
    expect(serialized).not.toContain(projectAPathMarker());
  });
});

function projectAPathMarker(): string {
  return 'unicomp-context-a-';
}
