import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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
  type StorageProjectSession
} from '../../src/platform';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe('chat-context composition runtime', () => {
  it('keeps new conversations, response drafts and contexts project-scoped', async () => {
    const userData = await mkdtemp(path.join(os.tmpdir(), 'unicomp-runtime-user-'));
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'unicomp-runtime-project-'));
    roots.push(userData, projectRoot);
    const session: StorageProjectSession = {
      projectId: toProjectId('project-runtime'),
      projectName: 'Runtime project',
      rootDirectory: projectRoot
    };
    const runtime = createChatContextRuntime({
      userDataDirectory: userData,
      getSession: () => session,
      conversationIds: {
        nextConversationId: () => toConversationId('conversation-runtime'),
        nextMessageId: () => toMessageId('message-runtime')
      },
      projectContextIds: {
        nextDraftId: () => toProjectContextDraftId('draft-runtime'),
        nextFragmentId: () => toProjectContextFragmentId('fragment-runtime'),
        nextContextId: () => toProjectContextId('context-runtime')
      }
    });
    const created = await runtime.conversations.create({
      title: 'Runtime chat',
      bindToCurrentProject: true
    });
    if (!created.ok) throw new Error('conversation creation failed');
    const messaged = await runtime.conversations.addUserMessage({
      conversationId: created.value.conversationId,
      expectedRevision: created.value.revision,
      content: 'runtime selected content'
    });
    if (!messaged.ok) throw new Error('message creation failed');
    const draft = await runtime.projectContexts.createDraft({
      conversationId: created.value.conversationId
    });
    if (!draft.ok) throw new Error('draft creation failed');
    const fragment = await runtime.projectContexts.addMessageFragment({
      draftId: draft.value.draftId,
      expectedRevision: draft.value.revision,
      messageId: messaged.value.messages[0].messageId,
      startUtf16: 0,
      endUtf16: messaged.value.messages[0].content.length
    });
    if (!fragment.ok) throw new Error('fragment creation failed');
    await runtime.waitForMutations();

    const conversationDocument = JSON.parse(
      await readFile(path.join(projectRoot, 'entities', 'conversations.json'), 'utf8')
    );
    const contextDocument = JSON.parse(
      await readFile(
        path.join(projectRoot, 'entities', 'project-contexts.json'),
        'utf8'
      )
    );
    expect(conversationDocument.conversations).toHaveLength(1);
    expect(contextDocument.drafts).toHaveLength(1);
    expect(JSON.stringify(fragment)).not.toContain(userData);
    expect(JSON.stringify(fragment)).not.toContain(projectRoot);
  });
});
