import { describe, expect, it } from 'vitest';
import {
  createConversationResponseDraft,
  createProjectConversation,
  parseConversationResponseDraft,
  replaceConversationResponseContextSelections,
  toConversationId,
  toConversationResponseDraftId,
  toIsoTimestamp,
  toMessageId,
  toProjectContextId,
  toProjectId,
  updateConversationResponseProductFeature
} from '../../src/domain';

const projectId = toProjectId('project-conversation-response');
const t0 = toIsoTimestamp('2026-08-03T04:00:00.000Z');
const t1 = toIsoTimestamp('2026-08-03T04:01:00.000Z');

describe('project conversation and response draft contracts', () => {
  it('requires every new optimized conversation to belong to a project', () => {
    expect(createProjectConversation({
      id: toConversationId('conversation-project-owned'),
      projectId,
      title: 'Project conversation',
      createdAt: t0
    })).toMatchObject({ projectId, revision: 0, status: 'active' });
    expect(() => createProjectConversation({
      id: toConversationId('conversation-project-missing'),
      projectId: null as never,
      title: 'Missing project',
      createdAt: t0
    })).toThrow('project ID');
  });

  it('persists an explicit text ProductFeature and user-message revision', () => {
    const draft = createConversationResponseDraft({
      id: toConversationResponseDraftId('response-draft-1'),
      projectId,
      conversationId: toConversationId('conversation-project-owned'),
      conversationRevision: 3,
      userMessageId: toMessageId('user-message-1'),
      userMessageRevision: 2,
      productFeature: 'text_chat',
      createdAt: t0
    });
    const reasoning = updateConversationResponseProductFeature(
      draft,
      'text_reasoning',
      t1
    );
    expect(reasoning).toMatchObject({
      revision: 1,
      conversationRevision: 3,
      userMessageRevision: 2,
      productFeature: 'text_reasoning',
      contextSelections: []
    });
    expect(() => parseConversationResponseDraft({
      ...draft,
      productFeature: 'text_to_image'
    })).toThrow('text ProductFeature');
    expect(() => parseConversationResponseDraft({
      ...draft,
      absolutePath: 'C:\\private\\conversation.json'
    })).toThrow('invalid');

    const selection = {
      schemaVersion: 1 as const,
      contextId: toProjectContextId('context-response-1'),
      contextRevision: 2,
      contentHash: 'a'.repeat(64),
      includeInPrompt: false
    };
    const withContext = replaceConversationResponseContextSelections(
      reasoning,
      [selection],
      toIsoTimestamp('2026-08-03T04:02:00.000Z')
    );
    expect(withContext).toMatchObject({
      revision: 2,
      contextSelections: [selection]
    });
    expect(() => replaceConversationResponseContextSelections(
      withContext,
      [selection, selection],
      toIsoTimestamp('2026-08-03T04:03:00.000Z')
    )).toThrow('must be unique');
  });
});
