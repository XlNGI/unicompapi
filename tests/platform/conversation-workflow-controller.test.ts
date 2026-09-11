import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConversationApplicationService, ConversationIntentOrchestrator, ConversationWorkflowService, type ConversationIdFactory } from '../../src/application';
import {
  toConversationId,
  toConversationWorkflowId,
  createConversationWorkflow,
  toIsoTimestamp,
  toMessageId,
  toProjectId
} from '../../src/domain';
import {
  createChatContextRuntime,
  type StorageProjectSession
} from '../../src/platform';
import { ConversationWorkflowController } from '../../src/platform/ipc/conversation-workflow-controller';
import { JsonProjectConversationRepository, JsonConversationWorkflowRepository } from '../../src/platform/repositories';
import { NodeProjectStorage } from '../../src/platform/storage';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe('ConversationWorkflowController', () => {
  it('requires the current displayed confirmation and refuses to expand it with new attachments', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-confirmation-binding-'));
    roots.push(root);
    const projectId = toProjectId('project-confirmation-binding');
    const now = () => '2026-09-10T00:00:00.000Z';
    const storage = new NodeProjectStorage(root);
    const conversations = new JsonProjectConversationRepository(storage, projectId, now);
    const workflows = new JsonConversationWorkflowRepository(storage, projectId, now);
    let message = 0;
    const service = new ConversationApplicationService(conversations, {
      nextConversationId: () => toConversationId('conversation-confirmation-binding'),
      nextMessageId: () => toMessageId(`message-confirmation-${++message}`)
    }, now);
    const conversation = await service.create({ title: '确认范围', projectId });
    const withSource = await service.addUserMessage({ conversationId: conversation.id, expectedRevision: 0, content: '制作销售汇报 PPT' });
    const workflow = createConversationWorkflow({
      id: toConversationWorkflowId('workflow-confirmation-binding'), conversationId: conversation.id, projectId,
      sourceMessageId: withSource.messages[0].id, createdAt: toIsoTimestamp(now()),
      plan: { schemaVersion: 1, kind: 'document', action: 'create', documentKind: 'ppt', parameters: { topic: '销售汇报' }, sourcePolicy: 'none', missing: [], ambiguities: [], confidence: 'high', needsConfirmation: true },
      confirmationId: 'confirmation-binding', planHash: 'a'.repeat(64), confirmationExpiresAt: toIsoTimestamp('2026-09-10T00:10:00.000Z')
    });
    await workflows.create(workflow);
    const workflowService = new ConversationWorkflowService(workflows, new ConversationIntentOrchestrator(), now);
    const answer = vi.spyOn(workflowService, 'answer');
    const pin = vi.fn();
    const controller = new ConversationWorkflowController({
      getSession: () => ({ projectId, projectName: '合成测试', rootDirectory: root }),
      getRuntime: () => ({ conversationService: service, workflowService, attachments: { pin } })
    });
    const request = { workflowId: workflow.id, expectedWorkflowRevision: 0, expectedConversationRevision: 1, content: '确认执行' };
    expect(await controller.answer(request)).toMatchObject({ ok: false, error: { code: 'confirmation_required' } });
    await controller.getPending({ conversationId: conversation.id });
    const restored = await service.get(conversation.id);
    expect(restored.messages.at(-1)?.workflowReply).toEqual({ workflowId: workflow.id, revision: 0 });
    expect(await controller.answer({ ...request, expectedConversationRevision: restored.revision, attachmentFileIds: ['file-new-scope'] }))
      .toMatchObject({ ok: false, error: { code: 'confirmation_required' } });
    expect(answer).not.toHaveBeenCalled();
    expect(pin).not.toHaveBeenCalled();
    expect((await service.get(conversation.id)).revision).toBe(restored.revision);
    await controller.getPending({ conversationId: conversation.id });
    expect((await service.get(conversation.id)).revision).toBe(restored.revision);
  });

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
        conversation: { revision: 2, messages: [{ content: '帮我做个总结' }, { role: 'assistant', content: '你希望做成 Word 文档、Excel 表格，还是 PPT 演示？' }] },
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
    expect(unchanged).toMatchObject({ ok: true, value: { messages: [{ content: '帮我做个总结' }, { role: 'assistant' }] } });

    const answered = await runtime.workflows.answer({
      workflowId: started.value.workflow.workflowId,
      expectedWorkflowRevision: started.value.workflow.revision,
      expectedConversationRevision: started.value.conversation.revision,
      content: 'PPT，8页，面向管理层，简洁一点'
    });
    expect(answered).toMatchObject({
      ok: true,
      value: {
        conversation: { revision: 3, messages: [{}, { role: 'assistant' }, { content: 'PPT，8页，面向管理层，简洁一点' }] },
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
    if (!answered.ok) throw new Error('Workflow clarification fixture failed');

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

    const restarted = await runtime.workflows.start({
      clientCommandId: 'workflow-natural-language-controller',
      conversation: {
        conversationId: started.value.conversation.conversationId,
        expectedRevision: answered.value.conversation.revision
      },
      title: '关于龙的 PPT',
      content: '帮我做一个关于龙的'
    });
    expect(restarted).toMatchObject({
      ok: true,
      value: { workflow: { status: 'needs_clarification', revision: 0 } }
    });
    if (!restarted.ok) throw new Error('Natural-language workflow fixture did not start');

    const partial = await runtime.workflows.answer({
      workflowId: restarted.value.workflow.workflowId,
      expectedWorkflowRevision: restarted.value.workflow.revision,
      expectedConversationRevision: restarted.value.conversation.revision,
      content: '制作'
    });
    expect(partial).toMatchObject({
      ok: true,
      value: { workflow: { status: 'needs_clarification', revision: 1 } }
    });
    if (!partial.ok) throw new Error('Natural-language partial answer failed');

    const recovered = await runtime.workflows.answer({
      workflowId: partial.value.workflow.workflowId,
      expectedWorkflowRevision: partial.value.workflow.revision,
      expectedConversationRevision: partial.value.conversation.revision,
      content: 'ppt'
    });
    expect(recovered).toMatchObject({
      ok: true,
      value: {
        workflow: {
          status: 'ready',
          revision: 2,
          plan: {
            kind: 'document',
            action: 'create',
            documentKind: 'ppt',
            parameters: { topic: expect.stringContaining('关于龙') }
          }
        }
      }
    });
    if (!recovered.ok) throw new Error('Natural-language workflow did not recover');
    expect(recovered.value.workflow.plan.parameters.topic).not.toContain('帮我做个总结');
  });
});
