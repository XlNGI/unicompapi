import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConversationApplicationService, ConversationIntentOrchestrator, ConversationWorkflowService, type ConversationIdFactory } from '../../src/application';
import { ConversationSemanticResponseError } from '../../src/application/conversation-intent-orchestrator';
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
import { ConversationSemanticClassifier } from '../../src/platform/providers/conversation-semantic-classifier';

const roots: string[] = [];
const semanticCandidate = { candidateId: 'synthetic-selected', productFeature: 'text_chat' as const };

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe('ConversationWorkflowController', () => {
  it('rejects missing model selection before starting planning or accessing project entities', async () => {
    const getRuntime = vi.fn();
    const controller = new ConversationWorkflowController({
      getSession: () => ({ projectId: toProjectId('project-no-model'), projectName: 'Fixture', rootDirectory: 'unused' }), getRuntime
    });
    expect(await controller.start({ clientCommandId: 'no-model', conversation: null, title: 'PPT', content: '我想制作一个ppt' }))
      .toMatchObject({ ok: false, error: { code: 'model_selection_required' } });
    expect(await controller.answer({ workflowId: 'workflow-no-model', expectedWorkflowRevision: 0,
      expectedConversationRevision: 0, content: '产品介绍' }))
      .toMatchObject({ ok: false, error: { code: 'model_selection_required' } });
    expect(getRuntime).not.toHaveBeenCalled();
  });

  it('never falls back to local business routing when production has no classifier', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-no-classifier-'));
    roots.push(root);
    const runtime = createChatContextRuntime({ userDataDirectory: path.join(root, 'user-data'),
      getSession: () => ({ projectId: toProjectId('project-no-classifier'), projectName: 'Fixture', rootDirectory: root }) });
    expect(await runtime.workflows.start({ clientCommandId: 'no-model', conversation: null,
      title: 'PPT', content: '制作关于销售的 PPT' })).toMatchObject({ ok: false, error: { code: 'model_selection_required' } });
    expect(await runtime.conversations.list({ includeArchived: false, includeDeleted: false })).toEqual({ ok: true, value: [] });
    expect(await runtime.workflows.start({ clientCommandId: 'no-classifier', conversation: null,
      title: 'PPT', content: '制作关于销售的 PPT', semanticCandidate })).toMatchObject({ ok: true, value: {
      workflow: { status: 'failed', planningFailureCode: 'classification_unavailable', plan: { kind: 'unknown' }, pendingQuestions: [] }
    } });
    await runtime.waitForMutations();
  });
  async function semanticFixture(mode: 'unavailable' | 'invalid' | 'invalid_response' | 'timeout' | 'ready' = 'ready') {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-semantic-failure-'));
    roots.push(root);
    const projectId = toProjectId('project-semantic-failure');
    const now = () => '2026-09-22T00:00:00.000Z';
    const storage = new NodeProjectStorage(root);
    const conversations = new JsonProjectConversationRepository(storage, projectId, now);
    const workflows = new JsonConversationWorkflowRepository(storage, projectId, now);
    let sequence = 0;
    const conversationService = new ConversationApplicationService(conversations, {
      nextConversationId: () => toConversationId('conversation-semantic-failure'),
      nextMessageId: () => toMessageId('message-semantic-' + ++sequence)
    }, now);
    let currentMode = mode;
    const classify = vi.fn(async () => {
      if (currentMode === 'unavailable') throw new Error('synthetic transport failure');
      if (currentMode === 'invalid_response') throw new ConversationSemanticResponseError();
      if (currentMode === 'invalid') return { unsupported: true };
      if (currentMode === 'timeout') return new Promise<never>(() => undefined);
      return { schemaVersion: 1, kind: 'document', action: 'create', documentKind: 'ppt',
        parameters: {}, sourcePolicy: 'none', missing: [], ambiguities: [], confidence: 'high', needsConfirmation: false };
    });
    const workflowService = new ConversationWorkflowService(workflows, new ConversationIntentOrchestrator({
      routingMode: 'agent_first', classifierTimeoutMs: 10, classifier: { classify }
    }), now, () => toConversationWorkflowId('workflow-semantic-' + ++sequence));
    const makeController = () => new ConversationWorkflowController({
      getSession: () => ({ projectId, projectName: '合成测试', rootDirectory: root }),
      getRuntime: () => ({ conversationService, workflowService })
    });
    return { root, projectId, workflows, workflowService, classify, controller: makeController(), makeController,
      setMode: (next: typeof mode) => { currentMode = next; } };
  }

  it.each([
    ['unavailable', 'classification_unavailable', '未能启动模型调用或确认调用状态'],
    ['invalid_response', 'classification_invalid_response', '响应不完整或格式无法使用'],
    ['invalid', 'invalid_intent_plan', '模型已返回内容，但任务计划不符合约定'],
    ['timeout', 'classification_timeout', '理解需求在时间预算内未完成']
  ] as const)('persists %s as a failed planning reply, never as a question', async (mode, code, text) => {
    const f = await semanticFixture(mode);
    const result = await f.controller.start({ clientCommandId: 'semantic-start', conversation: null,
      title: '我想制作一个ppt', content: '我想制作一个ppt',
      semanticCandidate: { candidateId: 'synthetic', productFeature: 'text_chat' } });
    expect(result).toMatchObject({ ok: true, value: { workflow: {
      status: 'failed', planningFailureCode: code, pendingQuestions: []
    } } });
    if (!result.ok) throw new Error('fixture failed');
    const reply = result.value.conversation.messages.at(-1)?.content;
    expect(reply).toContain(text);
    expect(reply).not.toMatch(/agent_semantic_plan_required|请告诉我|classification_|invalid_intent_plan/);
    expect(f.classify).toHaveBeenCalledTimes(1);
    const workflow = result.value.workflow;
    await expect(f.workflowService.beginExecution({
      workflowId: toConversationWorkflowId(workflow.workflowId), expectedRevision: workflow.revision, executionId: 'must-not-execute'
    })).rejects.toMatchObject({ code: 'workflow_not_ready' });
    const reopened = new JsonConversationWorkflowRepository(new NodeProjectStorage(f.root), f.projectId);
    expect(await reopened.get(toConversationWorkflowId(workflow.workflowId))).toMatchObject({
      planningFailureCode: code, status: 'failed', pendingQuestions: []
    });
    await f.makeController().getPending({ conversationId: result.value.conversation.conversationId });
    expect(f.classify).toHaveBeenCalledTimes(1);
    // An explicit new request can recover after the selected service is usable.
    f.setMode('ready');
    const retried = await f.controller.start({ clientCommandId: 'semantic-retry',
      conversation: { conversationId: result.value.conversation.conversationId, expectedRevision: result.value.conversation.revision },
      title: '我想制作一个ppt', content: '我想制作一个ppt', semanticCandidate });
    expect(retried).toMatchObject({ ok: true, value: { workflow: {
      status: 'needs_clarification', pendingQuestions: [{ field: 'document_topic' }]
    } } });
    if (!retried.ok) throw new Error('retry failed');
    expect(retried.value.conversation.messages.at(-1)?.content).toContain('你想做什么主题的 PPT');
    expect(retried.value.workflow.planningFailureCode).toBeUndefined();
  });

  it('asks about the topic only after successful planning and safely fails a subsequent answer', async () => {
    const f = await semanticFixture();
    const started = await f.controller.start({ clientCommandId: 'topic-start', conversation: null,
      title: 'PPT', content: '我想制作一个ppt', semanticCandidate });
    if (!started.ok) throw new Error('start failed');
    expect(started.value.conversation.messages.at(-1)?.content).toContain('你想做什么主题的 PPT');
    f.setMode('unavailable');
    const answered = await f.controller.answer({
      workflowId: started.value.workflow.workflowId, expectedWorkflowRevision: started.value.workflow.revision,
      expectedConversationRevision: started.value.conversation.revision, content: '三大基本的产品介绍', semanticCandidate
    });
    expect(answered).toMatchObject({ ok: true, value: { workflow: {
      status: 'failed', planningFailureCode: 'classification_unavailable', pendingQuestions: []
    } } });
    if (!answered.ok) throw new Error('answer failed');
    expect(answered.value.conversation.messages.at(-1)?.content).toContain('未能启动模型调用或确认调用状态');
    expect(answered.value.conversation.messages.at(-1)?.content).not.toContain('agent_semantic_plan_required');
  });

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
    const request = { workflowId: workflow.id, expectedWorkflowRevision: 0, expectedConversationRevision: 1, content: '确认执行', semanticCandidate };
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
    // Planning responses are synthetic; production still uses the selected
    // semantic provider, never offline regex inference.
    const basePlan = { schemaVersion: 1, kind: 'document', action: 'create', documentKind: 'auto',
      parameters: {}, sourcePolicy: 'none', missing: ['document_kind'], ambiguities: [], confidence: 'low', needsConfirmation: false };
    vi.spyOn(ConversationSemanticClassifier.prototype, 'classify')
      .mockResolvedValueOnce(basePlan)
      .mockResolvedValueOnce({ ...basePlan, documentKind: 'ppt', parameters: { topic: '项目总结', pageCount: 8, audience: '管理层', style: '简洁' }, missing: [], confidence: 'high' })
      .mockResolvedValueOnce({ ...basePlan, parameters: { topic: '关于龙' } })
      .mockResolvedValueOnce({ ...basePlan, parameters: { topic: '关于龙' } })
      .mockResolvedValueOnce({ ...basePlan, documentKind: 'ppt', parameters: { topic: '关于龙' }, missing: [], confidence: 'high' });
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
      textSubmission: {} as never,
      runtimeAuthorization: { claimSubmission: vi.fn(), markRequestStarted: vi.fn(), releaseBeforeRequest: vi.fn(), recordOutcome: vi.fn() } as never,
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
      semanticCandidate,
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
      semanticCandidate,
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
      semanticCandidate,
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
      semanticCandidate,
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
      semanticCandidate,
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
      semanticCandidate,
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
