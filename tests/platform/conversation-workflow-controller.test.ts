import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ConversationIdFactory } from '../../src/application';
import {
  toConversationId,
  toMessageId,
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

describe('ConversationWorkflowController', () => {
  it('persists, resumes, and safely answers one clarification workflow', async () => {
    const userDataDirectory = await mkdtemp(path.join(os.tmpdir(), 'unicomp-workflow-user-'));
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'unicomp-workflow-project-'));
    roots.push(userDataDirectory, projectRoot);
    let session: StorageProjectSession | undefined;
    let messageNumber = 0;
    const ids: ConversationIdFactory = {
      nextConversationId: () => toConversationId('conversation-workflow-controller'),
      nextMessageId: () => toMessageId(`message-workflow-controller-${++messageNumber}`)
    };
    let tick = 0;
    const now = () => new Date(Date.UTC(2026, 8, 3, 0, 0, tick++)).toISOString();
    const runtime = createChatContextRuntime({
      userDataDirectory,
      getSession: () => session,
      conversationIds: ids,
      now
    });

    await expect(runtime.workflows.start({
      clientCommandId: 'workflow-without-project',
      conversation: null,
      title: '总结',
      content: '帮我做个总结'
    })).resolves.toMatchObject({ ok: false, error: { code: 'project_not_open' } });

    session = {
      projectId: toProjectId('project-workflow-controller'),
      projectName: 'Workflow controller',
      rootDirectory: projectRoot
    };
    const started = await runtime.workflows.start({
      clientCommandId: 'workflow-start-controller',
      conversation: null,
      title: '总结',
      content: '帮我做个总结'
    });
    expect(started).toMatchObject({
      ok: true,
      value: {
        conversation: { revision: 1, messages: [{ content: '帮我做个总结' }] },
        workflow: { status: 'needs_clarification', revision: 0 }
      }
    });
    if (!started.ok) throw new Error('Workflow fixture did not start');

    const stale = await runtime.workflows.answer({
      workflowId: started.value.workflow.workflowId,
      expectedWorkflowRevision: 1,
      expectedConversationRevision: started.value.conversation.revision,
      content: 'PPT，8页，面向管理层，简洁一点'
    });
    expect(stale).toMatchObject({
      ok: false,
      error: { code: 'workflow_revision_conflict', currentRevision: 0 }
    });
    const unchanged = await runtime.conversations.get({
      conversationId: started.value.conversation.conversationId
    });
    expect(unchanged).toMatchObject({ ok: true, value: { messages: [{ content: '帮我做个总结' }] } });

    const answered = await runtime.workflows.answer({
      workflowId: started.value.workflow.workflowId,
      expectedWorkflowRevision: started.value.workflow.revision,
      expectedConversationRevision: started.value.conversation.revision,
      content: 'PPT，8页，面向管理层，简洁一点'
    });
    expect(answered).toMatchObject({
      ok: true,
      value: {
        conversation: { revision: 2, messages: [{}, { content: 'PPT，8页，面向管理层，简洁一点' }] },
        workflow: {
          workflowId: started.value.workflow.workflowId,
          revision: 1,
          status: 'ready',
          plan: {
            documentKind: 'ppt',
            parameters: { pageCount: 8, audience: '管理层', style: '简洁' }
          }
        }
      }
    });

    const pending = await runtime.workflows.getPending({
      conversationId: started.value.conversation.conversationId
    });
    expect(pending).toMatchObject({
      ok: true,
      value: { workflowId: started.value.workflow.workflowId, status: 'ready' }
    });

    const resumedRuntime = createChatContextRuntime({
      userDataDirectory,
      getSession: () => session,
      conversationIds: ids,
      now
    });
    const resumed = await resumedRuntime.workflows.getPending({
      conversationId: started.value.conversation.conversationId
    });
    expect(resumed).toEqual(pending);
  });
});
