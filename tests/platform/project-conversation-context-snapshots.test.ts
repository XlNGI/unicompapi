import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  addProjectContextDraftFragment,
  createConversation,
  createConversationResponseDraft,
  createProjectContextDraft,
  createProjectConversation,
  deleteProjectContext,
  registerProjectContextDraft,
  toConversationId,
  toConversationResponseDraftId,
  toIsoTimestamp,
  toMessageId,
  toProjectContextDraftId,
  toProjectContextFragmentId,
  toProjectContextId,
  toProjectId,
  updateConversationResponseProductFeature,
  updateProjectContextContent
} from '../../src/domain';
import {
  ConversationResponseDraftRevisionConflictError,
  JsonConversationResponseDraftRepository,
  JsonProjectConversationRepository,
  NodeProjectStorage,
  ProjectContextSnapshotError,
  createProjectContextContentHash,
  freezeProjectContextOutboundSnapshots,
  pinProjectContextSelection
} from '../../src/platform';

const roots: string[] = [];
const projectId = toProjectId('project-context-snapshots');
const otherProjectId = toProjectId('project-context-other');
const t0 = toIsoTimestamp('2026-08-03T05:00:00.000Z');
const t1 = toIsoTimestamp('2026-08-03T05:01:00.000Z');
const t2 = toIsoTimestamp('2026-08-03T05:02:00.000Z');
const t3 = toIsoTimestamp('2026-08-03T05:03:00.000Z');

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-project-conversation-'));
  roots.push(root);
  const storage = new NodeProjectStorage(root);
  return {
    storage,
    conversations: new JsonProjectConversationRepository(storage, projectId, () => t3),
    responses: new JsonConversationResponseDraftRepository(storage, projectId, () => t3)
  };
}

function projectConversation(id: string) {
  return createProjectConversation({
    id: toConversationId(id),
    projectId,
    title: id,
    createdAt: t0
  });
}

function registeredContext() {
  const content = '固定上下文内容';
  let draft = createProjectContextDraft({
    id: toProjectContextDraftId('context-draft-snapshot'),
    projectId,
    conversationId: toConversationId('conversation-context-source'),
    createdAt: t0
  });
  draft = addProjectContextDraftFragment(draft, {
    id: toProjectContextFragmentId('context-fragment-snapshot'),
    conversationId: draft.conversationId,
    messageId: toMessageId('message-context-source'),
    messageRevision: 1,
    messageRole: 'assistant',
    selection: { schemaVersion: 1, startUtf16: 0, endUtf16: content.length },
    contentSnapshot: content
  }, t1);
  return registerProjectContextDraft(
    draft,
    toProjectContextId('context-snapshot'),
    t2
  );
}

describe('project-owned conversation persistence', () => {
  it('serializes independent project repositories without accepting legacy or cross-project conversations', async () => {
    const { storage } = await fixture();
    const first = new JsonProjectConversationRepository(storage, projectId, () => t3);
    const second = new JsonProjectConversationRepository(storage, projectId, () => t3);
    await Promise.all([
      first.create(projectConversation('conversation-a')),
      second.create(projectConversation('conversation-b'))
    ]);
    await expect(first.list()).resolves.toHaveLength(2);
    await expect(first.create(createConversation({
      id: toConversationId('conversation-legacy'),
      title: 'Legacy application conversation',
      createdAt: t0
    }))).rejects.toThrow('active project');
    await expect(first.create(createProjectConversation({
      id: toConversationId('conversation-cross-project'),
      projectId: otherProjectId,
      title: 'Cross project',
      createdAt: t0
    }))).rejects.toThrow('active project');
  });

  it('stores response drafts separately with exact revision conflicts', async () => {
    const { responses } = await fixture();
    const draft = createConversationResponseDraft({
      id: toConversationResponseDraftId('response-project-1'),
      projectId,
      conversationId: toConversationId('conversation-a'),
      conversationRevision: 0,
      userMessageId: toMessageId('message-user-1'),
      userMessageRevision: 0,
      productFeature: 'text_chat',
      createdAt: t0
    });
    await responses.create(draft);
    const reasoning = updateConversationResponseProductFeature(draft, 'text_reasoning', t1);
    await responses.save(reasoning, 0);
    await expect(responses.save(reasoning, 0)).rejects.toBeInstanceOf(
      ConversationResponseDraftRevisionConflictError
    );
    await expect(responses.list(draft.conversationId)).resolves.toMatchObject([
      { revision: 1, productFeature: 'text_reasoning', userMessageRevision: 0 }
    ]);
  });
});

describe('pinned project context outbound snapshots', () => {
  it('freezes the selected revision and does not export viewed-but-unchecked context', () => {
    const context = registeredContext();
    const viewed = pinProjectContextSelection(context, 1, false);
    expect(freezeProjectContextOutboundSnapshots({
      projectId,
      surface: 'professional',
      contexts: [context],
      selections: [viewed]
    })).toEqual([]);

    const selected = pinProjectContextSelection(context, 1, true);
    const updated = updateProjectContextContent(context, '更新后的上下文', [], t3);
    expect(freezeProjectContextOutboundSnapshots({
      projectId,
      surface: 'professional',
      contexts: [updated],
      selections: [selected]
    })).toEqual([{
      schemaVersion: 1,
      contextId: context.id,
      contextRevision: 1,
      contentHash: createProjectContextContentHash('固定上下文内容'),
      contentSnapshot: '固定上下文内容'
    }]);
  });

  it('rejects quick consumption, hash tampering, cross-project use and deleted contexts', () => {
    const context = registeredContext();
    const selected = pinProjectContextSelection(context, 1, true);
    expect(() => freezeProjectContextOutboundSnapshots({
      projectId,
      surface: 'quick',
      contexts: [context],
      selections: [selected]
    })).toThrow(ProjectContextSnapshotError);
    expect(() => freezeProjectContextOutboundSnapshots({
      projectId,
      surface: 'professional',
      contexts: [context],
      selections: [{ ...selected, contentHash: '0'.repeat(64) }]
    })).toThrow('content has changed');
    expect(() => freezeProjectContextOutboundSnapshots({
      projectId: otherProjectId,
      surface: 'professional',
      contexts: [context],
      selections: [selected]
    })).toThrow('another project');
    const deleted = deleteProjectContext(context, t3);
    expect(() => freezeProjectContextOutboundSnapshots({
      projectId,
      surface: 'professional',
      contexts: [deleted],
      selections: [selected]
    })).toThrow('selected again');
  });
});
