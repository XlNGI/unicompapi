import { describe, expect, it, vi } from 'vitest';
import {
  addUserMessage,
  beginAssistantMessage,
  createConversation,
  createConversationResponseDraft,
  createConversationWorkflow,
  parseConversationIntentPlan,
  toConnectionId,
  toConversationId,
  toConversationResponseDraftId,
  toConversationResponseExecutionId,
  toConversationWorkflowId,
  toIsoTimestamp,
  toMessageId,
  toModelId,
  toProjectId,
  toProviderId,
  type ConversationResponseExecutionReadModelV1,
  type ConversationResponseExecutionState
} from '../../src/domain';
import {
  ConversationResponseController,
  toResponseDraftDto,
  type ConversationResponseControllerRuntime
} from '../../src/platform';
import { ConversationDocumentPageError } from '../../src/platform/documents/conversation-document-page-context';

const projectId = toProjectId('project-response-controller');
const createdAt = toIsoTimestamp('2026-08-18T00:00:00.000Z');

function execution(
  state: ConversationResponseExecutionState = 'pending'
): ConversationResponseExecutionReadModelV1 {
  return {
    schemaVersion: 1,
    responseExecutionId: toConversationResponseExecutionId('response-execution-controller'),
    projectId,
    conversationId: toConversationId('conversation-controller'),
    userMessageId: toMessageId('message-user-controller'),
    assistantMessageId: toMessageId('message-assistant-controller'),
    productFeature: 'text_chat',
    providerId: toProviderId('provider-controller'),
    connectionId: toConnectionId('connection-controller'),
    modelId: toModelId('model-controller'),
    runtimeSource: 'official_direct',
    state,
    streamSequence: 1,
    reasoningContent: '',
    content: '',
    createdAt,
    updatedAt: createdAt
  };
}

function fixture(documentPages?: ConversationResponseControllerRuntime['documentPages'], userContent = 'hello', userDisplayContent?: string) {
  const base = createConversation({
    id: toConversationId('conversation-controller'),
    title: 'Controller test',
    projectId,
    createdAt
  });
  const withUser = addUserMessage(base, {
    id: toMessageId('message-user-controller'),
    content: userContent,
    ...(userDisplayContent !== undefined ? { displayContent: userDisplayContent } : {}),
    createdAt
  });
  const withAssistant = beginAssistantMessage(withUser, {
    id: toMessageId('message-assistant-controller'),
    createdAt
  });
  const service = {
    create: vi.fn(async () => base),
    get: vi.fn(async () => withAssistant),
    addUserMessage: vi.fn(async () => withUser),
    editCancelledUserMessage: vi.fn(async () => withUser)
  };
  const draftRepository = {
    projectId,
    create: vi.fn(async () => undefined),
    save: vi.fn(async () => undefined)
  };
  const candidateService = {
    prepareSubmission: vi.fn(async () => ({
      routeSelectionToken: 'route-selection-controller',
      confirmation: {
        schemaVersion: 1 as const,
        confirmationId: 'confirmation-controller',
        confirmed: true as const
      }
    }))
  };
  const startedExecution = execution();
  const readyWorkflow = createConversationWorkflow({
    id: toConversationWorkflowId('workflow-response-controller'),
    projectId,
    conversationId: withUser.id,
    sourceMessageId: withUser.messages[0].id,
    plan: parseConversationIntentPlan({
      schemaVersion: 1,
      kind: 'chat',
      parameters: {},
      sourcePolicy: 'none',
      missing: [],
      ambiguities: [],
      confidence: 'high',
      needsConfirmation: false
    }),
    createdAt
  });
  const executingWorkflow = {
    ...readyWorkflow,
    revision: 1,
    status: 'executing' as const,
    executionId: 'pending:workflow-response-controller'
  };
  const workflowService = {
    get: vi.fn(async () => readyWorkflow),
    beginExecution: vi.fn(async () => executingWorkflow),
    bindExecution: vi.fn(async () => ({
      ...executingWorkflow,
      revision: 2,
      executionId: startedExecution.responseExecutionId
    })),
    finishExecution: vi.fn(async () => undefined)
  };
  const runtime = {
    conversationService: service,
    conversations: {
      projectId,
      get: vi.fn(async () => withUser)
    },
    drafts: draftRepository,
    contexts: { projectId },
    candidates: candidateService,
    executions: {
      listActive: vi.fn(async () => []),
      readModel: vi.fn(async () => startedExecution),
      interrupt: vi.fn(async () => undefined)
    },
    executionCoordinator: {
      has: vi.fn(() => false),
      cancel: vi.fn(async () => true)
    },
    streamChannel: {},
    workflowService,
    documentPages,
    ready: Promise.resolve(),
    start: vi.fn(async () => startedExecution)
  } as unknown as ConversationResponseControllerRuntime;
  const errors: unknown[] = [];
  const controller = new ConversationResponseController({
    getSession: () => ({
      projectId,
      projectName: 'Controller test',
      rootDirectory: 'C:\\unicomp-controller-test'
    }),
    getRuntime: () => runtime,
    nextResponseDraftId: () => 'response-draft-controller',
    now: () => createdAt,
    onError: (error) => errors.push(error)
  });
  return {
    controller,
    runtime,
    service,
    candidateService,
    draftRepository,
    readyWorkflow,
    workflowService,
    errors
  };
}

function startRequest(clientCommandId = 'client-command-controller') {
  return {
    clientCommandId,
    conversation: null,
    title: 'Controller test',
    content: 'hello',
    productFeature: 'text_chat',
    candidateId: 'candidate-controller',
    contextSelections: [],
    parameterValues: {},
    confirmed: true
  };
}

describe('ConversationResponseController', () => {
  it.each(['content', 'matching displayContent'] as const)('preflights and pins the stored %s page query through the legacy createDraft entry', async (source) => {
    const query = '第 5 页讲了什么？';
    const documentPages = { resolve: vi.fn(async () => [{ sourceId: 'delivered-work', sourceType: 'project' as const,
      contentHash: 'a'.repeat(64), excerpt: '实际第 5 页：现金流风险' }]) };
    const value = source === 'content' ? fixture(documentPages, query)
      : fixture(documentPages, query, query);
    const result = await value.controller.createDraft({
      conversationId: 'conversation-controller', expectedRevision: 1,
      userMessageId: 'message-user-controller', productFeature: 'text_chat'
    });
    expect(result).toMatchObject({ ok: true });
    expect(documentPages.resolve).toHaveBeenCalledWith(expect.objectContaining({
      currentUserMessageId: 'message-user-controller', query
    }));
    expect(value.draftRepository.create).toHaveBeenCalledWith(expect.objectContaining({
      attachmentQuery: query, documentPageQuery: query
    }));
    expect(documentPages.resolve.mock.invocationCallOrder[0]).toBeLessThan(value.draftRepository.create.mock.invocationCallOrder[0]);
    expect(result.ok && result.value).not.toHaveProperty('documentPageQuery');
    expect(value.candidateService.prepareSubmission).not.toHaveBeenCalled();
    expect(value.runtime.start).not.toHaveBeenCalled();
  });

  it('keeps legacy generation prompts out of page preflight when createDraft uses a separate display request', async () => {
    const documentPages = { resolve: vi.fn(async () => []) };
    const displayContent = '修改第 5 页的内容';
    const value = fixture(documentPages, '内部生成提示：输出修改第 5 页后的完整 PPT 结构', displayContent);
    expect(await value.controller.createDraft({
      conversationId: 'conversation-controller', expectedRevision: 1,
      userMessageId: 'message-user-controller', productFeature: 'text_chat'
    })).toMatchObject({ ok: true });
    expect(documentPages.resolve).not.toHaveBeenCalled();
    expect(value.draftRepository.create).toHaveBeenCalledWith(expect.objectContaining({ attachmentQuery: displayContent }));
    expect(value.draftRepository.create).toHaveBeenCalledWith(expect.not.objectContaining({ documentPageQuery: expect.anything() }));
  });

  it('keeps an unbound legacy generation start on the document history path', async () => {
    const documentPages = { resolve: vi.fn(async () => []) };
    const content = '内部生成提示：修改第 5 页并返回完整 PPT 大纲';
    const displayContent = '修改第 5 页的内容';
    const value = fixture(documentPages, content, displayContent);
    expect(await value.controller.start({ ...startRequest(), content, displayContent })).toMatchObject({ ok: true });
    expect(documentPages.resolve).not.toHaveBeenCalled();
    expect(value.draftRepository.create).toHaveBeenCalledWith(expect.objectContaining({ attachmentQuery: displayContent }));
    expect(value.draftRepository.create).toHaveBeenCalledWith(expect.not.objectContaining({ documentPageQuery: expect.anything() }));
    expect(value.runtime.start).toHaveBeenCalledOnce();
  });

  it('rejects an unavailable page before legacy createDraft can persist a draft', async () => {
    const documentPages = { resolve: vi.fn(async () => {
      throw new ConversationDocumentPageError('document_page_out_of_range', '该 PPT 没有第 5 页。');
    }) };
    const value = fixture(documentPages, '第 5 页讲了什么？');
    expect(await value.controller.createDraft({
      conversationId: 'conversation-controller', expectedRevision: 1,
      userMessageId: 'message-user-controller', productFeature: 'text_chat'
    })).toMatchObject({ ok: false, error: { code: 'document_page_out_of_range' } });
    expect(documentPages.resolve).toHaveBeenCalledOnce();
    expect(value.draftRepository.create).not.toHaveBeenCalled();
    expect(value.candidateService.prepareSubmission).not.toHaveBeenCalled();
    expect(value.runtime.start).not.toHaveBeenCalled();
  });

  it('stops a missing generated PPT page before draft creation, candidate authorization or dispatch', async () => {
    const documentPages = { resolve: vi.fn(async () => {
      throw new ConversationDocumentPageError('document_page_out_of_range', '该 PPT 没有第 5 页。');
    }) };
    const value = fixture(documentPages);
    const result = await value.controller.start({ ...startRequest(), content: '第 5 页讲了什么？' });
    expect(result).toMatchObject({ ok: false, error: { code: 'document_page_out_of_range', message: '该 PPT 没有第 5 页。' } });
    expect(documentPages.resolve).toHaveBeenCalledOnce();
    expect(value.draftRepository.create).not.toHaveBeenCalled();
    expect(value.candidateService.prepareSubmission).not.toHaveBeenCalled();
    expect(value.runtime.start).not.toHaveBeenCalled();
  });

  it('persists the trusted page query after successful local page preflight', async () => {
    const documentPages = { resolve: vi.fn(async () => [{ sourceId: 'delivered-work', sourceType: 'project' as const,
      contentHash: 'a'.repeat(64), excerpt: '实际第 5 页：现金流风险' }]) };
    const value = fixture(documentPages, '第 5 页讲了什么？');
    expect(await value.controller.start({ ...startRequest(), content: '第 5 页讲了什么？' })).toMatchObject({ ok: true });
    expect(value.draftRepository.create).toHaveBeenCalledWith(expect.objectContaining({ documentPageQuery: '第 5 页讲了什么？' }));
  });
  it('projects a provider completion that raced ahead of workflow execution binding', async () => {
    const value = fixture();
    vi.mocked(value.runtime.executions.readModel).mockResolvedValue(execution('completed'));
    const result = await value.controller.start({
      ...startRequest('fast-workflow-response'),
      conversation: { conversationId: value.readyWorkflow.conversationId, expectedRevision: 2, editedMessageId: null },
      workflow: { workflowId: value.readyWorkflow.id, expectedRevision: value.readyWorkflow.revision }
    });
    expect(result).toMatchObject({ ok: true, value: { execution: { state: 'completed' } } });
    expect(value.workflowService.finishExecution).toHaveBeenCalledWith('response-execution-controller', 'completed');
    expect(value.workflowService.bindExecution.mock.invocationCallOrder[0]).toBeLessThan(value.workflowService.finishExecution.mock.invocationCallOrder[0]);
    expect(value.runtime.start).toHaveBeenCalledTimes(1);
  });

  it('returns the dispatched execution when post-binding reconciliation fails', async () => {
    const value = fixture();
    const error = new Error('temporary read failure after dispatch');
    vi.mocked(value.runtime.executions.readModel).mockRejectedValue(error);
    const request = {
      ...startRequest('post-dispatch-read-failure'),
      conversation: { conversationId: value.readyWorkflow.conversationId, expectedRevision: 2, editedMessageId: null },
      workflow: { workflowId: value.readyWorkflow.id, expectedRevision: value.readyWorkflow.revision }
    };
    expect(await value.controller.start(request)).toMatchObject({ ok: true, value: { execution: { responseExecutionId: 'response-execution-controller' } } });
    await value.controller.start(request);
    expect(value.errors).toContain(error);
    expect(value.runtime.start).toHaveBeenCalledTimes(1);
  });

  it('does not expose an internal workflow prompt through the response draft DTO', () => {
    const promptContent = '受控内部提示：不要进入 Renderer';
    const draft = createConversationResponseDraft({
      id: toConversationResponseDraftId('response-draft-projection'),
      projectId,
      conversationId: toConversationId('conversation-controller'),
      conversationRevision: 1,
      userMessageId: toMessageId('message-user-controller'),
      userMessageRevision: 0,
      promptContent,
      attachmentQuery: '内部持久化的累计资料需求',
      documentPageQuery: '第 5 页讲了什么？',
      productFeature: 'text_chat',
      createdAt
    });

    expect(JSON.stringify(toResponseDraftDto(draft))).not.toContain(promptContent);
    expect(toResponseDraftDto(draft)).not.toHaveProperty('promptContent');
    expect(toResponseDraftDto(draft)).not.toHaveProperty('attachmentQuery');
    expect(toResponseDraftDto(draft)).not.toHaveProperty('documentPageQuery');
  });

  it('rejects an attachment query supplied through renderer IPC', async () => {
    const value = fixture();
    const result = await value.controller.start({ ...startRequest(), attachmentQuery: '绕过全表资料范围校验' });
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
    expect(value.candidateService.prepareSubmission).not.toHaveBeenCalled();
    expect(value.runtime.start).not.toHaveBeenCalled();
  });

  it('rejects a generated document page query supplied through renderer IPC', async () => {
    const value = fixture();
    const result = await value.controller.start({ ...startRequest(), documentPageQuery: '第 7 页' });
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
    expect(value.candidateService.prepareSubmission).not.toHaveBeenCalled();
  });

  it('deduplicates concurrent start commands by client command ID', async () => {
    const value = fixture();
    const [first, second] = await Promise.all([
      value.controller.start(startRequest()),
      value.controller.start(startRequest())
    ]);

    expect(value.errors).toEqual([]);
    expect(first).toMatchObject({
      ok: true,
      value: {
        execution: { responseExecutionId: 'response-execution-controller' }
      }
    });
    expect(second).toEqual(first);
    expect(value.service.create).toHaveBeenCalledTimes(1);
    expect(value.service.addUserMessage).toHaveBeenCalledTimes(1);
    expect(value.candidateService.prepareSubmission).toHaveBeenCalledTimes(1);
    expect(value.runtime.start).toHaveBeenCalledTimes(1);
  });

  it('keeps the provider prompt internal while returning the user request in the conversation DTO', async () => {
    const value = fixture();
    const internalPrompt = '内部模型指令：输出完整且可解析的 PPT 结构';
    const userRequest = '帮我生成 AI Agent PPT';
    const displayedConversation = addUserMessage(
      createConversation({
        id: toConversationId('conversation-controller'),
        title: 'Controller test',
        projectId,
        createdAt
      }),
      {
        id: toMessageId('message-user-controller'),
        content: internalPrompt,
        displayContent: userRequest,
        createdAt
      }
    );
    value.service.addUserMessage.mockResolvedValue(displayedConversation);
    value.service.get.mockResolvedValue(displayedConversation);

    const result = await value.controller.start({
      ...startRequest('client-command-display-content'),
      content: internalPrompt,
      displayContent: userRequest
    });

    expect(value.errors).toEqual([]);
    expect(value.service.addUserMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        content: internalPrompt,
        displayContent: userRequest
      })
    );
    expect(result).toMatchObject({
      ok: true,
      value: {
        conversation: {
          messages: [
            expect.objectContaining({
              role: 'user',
              content: userRequest
            })
          ]
        }
      }
    });
    if (result.ok) {
      expect(JSON.stringify(result.value.conversation)).not.toContain(internalPrompt);
    }
  });

  it('starts a ready workflow from its persisted source message without appending a duplicate user turn', async () => {
    const value = fixture();
    const promptContent = '受控内部提示：输出结构化文档大纲';
    const attachmentQuery = '原始需求\n后续要求：总结附件全文';
    value.workflowService.get.mockResolvedValue({ ...value.readyWorkflow,
      plan: parseConversationIntentPlan({ ...value.readyWorkflow.plan, parameters: { requirements: attachmentQuery } }) });
    const result = await value.controller.start({
      ...startRequest('workflow-response-controller'),
      conversation: {
        conversationId: 'conversation-controller',
        expectedRevision: 2,
        editedMessageId: null
      },
      content: promptContent,
      workflow: {
        workflowId: value.readyWorkflow.id,
        expectedRevision: value.readyWorkflow.revision
      }
    });

    expect(result).toMatchObject({ ok: true });
    expect(value.service.addUserMessage).not.toHaveBeenCalled();
    expect(value.draftRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        userMessageId: 'message-user-controller',
        promptContent,
        attachmentQuery
      })
    );
    expect(value.workflowService.beginExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowId: value.readyWorkflow.id,
        expectedRevision: value.readyWorkflow.revision
      })
    );
    expect(value.workflowService.bindExecution).toHaveBeenCalledWith(
      expect.objectContaining({ executionId: 'response-execution-controller' })
    );
  });

  it('passes a transport interruption callback for a cancellation that outlives the request', async () => {
    const value = fixture();
    const pending = execution('pending');
    const interrupted = execution('interrupted');
    let reads = 0;
    value.runtime.executions.readModel = vi.fn(async () => reads++ === 0 ? pending : interrupted);
    value.runtime.executionCoordinator.cancel = vi.fn(async (
      _executionId: unknown,
      onCancellationTimeout?: () => Promise<void>
    ) => {
      await onCancellationTimeout?.();
      return true;
    });

    const result = await value.controller.cancelExecution({
      responseExecutionId: 'response-execution-controller'
    });

    expect(result).toMatchObject({
      ok: true,
      value: { state: 'interrupted' }
    });
    expect(value.runtime.executions.interrupt).toHaveBeenCalledWith(
      'response-execution-controller',
      'transport_interrupted'
    );
  });

  it('cancels an active provider transport before reading persisted execution state', async () => {
    const value = fixture();
    const order: string[] = [];
    value.runtime.executionCoordinator.has = vi.fn(() => true);
    value.runtime.executionCoordinator.cancel = vi.fn(async () => {
      order.push('cancel');
      return true;
    });
    value.runtime.executions.readModel = vi.fn(async () => {
      order.push('read');
      return execution('streaming');
    });

    const result = await value.controller.cancelExecution({
      responseExecutionId: 'response-execution-controller'
    });

    expect(result).toMatchObject({
      ok: true,
      value: { state: 'streaming' }
    });
    expect(order).toEqual(['cancel', 'read']);
    expect(value.runtime.conversations.get).not.toHaveBeenCalled();
  });
});
