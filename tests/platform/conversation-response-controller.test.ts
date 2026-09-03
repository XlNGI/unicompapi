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

function fixture() {
  const base = createConversation({
    id: toConversationId('conversation-controller'),
    title: 'Controller test',
    projectId,
    createdAt
  });
  const withUser = addUserMessage(base, {
    id: toMessageId('message-user-controller'),
    content: 'hello',
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
      productFeature: 'text_chat',
      createdAt
    });

    expect(JSON.stringify(toResponseDraftDto(draft))).not.toContain(promptContent);
    expect(toResponseDraftDto(draft)).not.toHaveProperty('promptContent');
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
        promptContent
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
