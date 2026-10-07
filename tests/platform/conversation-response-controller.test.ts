import { NativeSearchAuthorizationError, type ConversationNativeSearch } from '../../src/platform/providers/conversation-native-search';
import { ExecutionBudgetError } from '../../src/application/execution-budget';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const traceRoots: string[] = [];
afterEach(async () => {
  await Promise.all(traceRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
import {
  addUserMessage,
  addCompletedAssistantMessage,
  beginAssistantMessage,
  createConversation,
  createConversationResponseDraft,
  createConversationWorkflow,
  parseConversationIntentPlan,
  toConnectionId,
  toConversationAgentRunId,
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
  type ConversationResponseExecutionState,
  type ConversationAgentRunV1
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
  const traceRoot = mkdtempSync(path.join(os.tmpdir(), 'unicomp-response-controller-'));
  traceRoots.push(traceRoot);
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
    editCancelledUserMessage: vi.fn(async () => withUser),
    ensureLocalReply: vi.fn(async (_id: string, key: string, content: string) => addCompletedAssistantMessage(withAssistant, {
      id: toMessageId('message-source-disclosure'), content,
      workflowReply: { workflowId: key, revision: 0 }, createdAt
    }))
  };
  const draftRepository = {
    projectId,
    create: vi.fn(async () => undefined),
    save: vi.fn(async () => undefined)
  };
  const candidateService = {
    listCatalogForFeature: vi.fn(async () => []),
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
      rootDirectory: traceRoot
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}

describe('ConversationResponseController', () => {
  it.each(['failed', 'cancelled', 'interrupted'] as const)('waits for the %s owner before checking whether a new request may start', async state => {
    const value = fixture();
    let terminalSelected = false;
    Object.assign(value.runtime.executionCoordinator, { waitForCompletedOperations: async (
      predicate: (id: ReturnType<typeof toConversationResponseExecutionId>) => Promise<boolean>
    ) => { terminalSelected = await predicate(toConversationResponseExecutionId('response-execution-controller')); } });
    vi.mocked(value.runtime.executions.readModel).mockResolvedValue(execution(state));
    const mayStart = vi.fn(async () => { expect(terminalSelected).toBe(true); return false; });
    Object.assign(value.runtime, { completion: { canStartNewResponse: mayStart } });
    const request = { ...startRequest(`blocked-${state}-owner`), conversation: {
      conversationId: 'conversation-controller', expectedRevision: 1, editedMessageId: null } };
    expect(await value.controller.start(request)).toMatchObject({ ok: false, error: { code: 'response_reconciliation_required' } });
    expect(value.runtime.start).not.toHaveBeenCalled();
    expect(value.service.addUserMessage).not.toHaveBeenCalled();
  });
  it('blocks a new response before changing the existing conversation when settlement is frozen', async () => {
    const value = fixture();
    Object.assign(value.runtime.executionCoordinator, { waitForCompletedOperations: async () => undefined });
    Object.assign(value.runtime, { completion: { canStartNewResponse: async () => false } });
    const request = { ...startRequest('blocked-frozen-parent'), conversation: {
      conversationId: 'conversation-controller', expectedRevision: 1, editedMessageId: null } };
    expect(await value.controller.start(request)).toMatchObject({ ok: false, error: { code: 'response_reconciliation_required' } });
    expect(value.runtime.start).not.toHaveBeenCalled();
    expect(value.service.addUserMessage).not.toHaveBeenCalled();
  });

  it('requires a scoped inspection and explicit confirmation and consumes the token once', async () => {
    const value = fixture();
    const run: ConversationAgentRunV1 = { schemaVersion: 1, id: toConversationAgentRunId('run-controller'), revision: 2,
      projectId, conversationId: toConversationId('conversation-controller'), sourceMessageId: toMessageId('message-user-controller'),
      responseExecutionId: toConversationResponseExecutionId('response-execution-controller'), status: 'needs_reconciliation',
      reconciliationReason: 'unknown_result', createdAt, updatedAt: createdAt };
    const snapshot = { run, taskRevisions: [{ id: 'task-controller', revision: 1 }] };
    const acknowledge = vi.fn(async () => ({ run: { ...run, status: 'cancelled' as const, revision: 3,
      reconciliationAcknowledgement: { kind: 'closed_without_replay' as const, confirmedAt: createdAt } }, intent: undefined }));
    Object.assign(value.runtime, { completion: { inspect: async () => snapshot, reconcile: async () => snapshot, acknowledge } });
    const request = { projectId, responseExecutionId: run.responseExecutionId! };
    expect(await value.controller.inspectReconciliation({ ...request, projectId: 'different-project' }))
      .toMatchObject({ ok: false, error: { code: 'project_scope_mismatch' } });
    expect(await value.controller.inspectReconciliation({ ...request, outputPath: 'C:/unsafe' }))
      .toMatchObject({ ok: false, error: { code: 'invalid_request' } });
    const inspected = await value.controller.inspectReconciliation(request);
    if (!inspected.ok || !inspected.value.inspectToken) throw new Error('Expected a frozen inspection token');
    const command = { ...request, expectedRunRevision: 2, inspectToken: inspected.value.inspectToken, confirmed: false };
    expect(await value.controller.acknowledgeReconciliation(command)).toMatchObject({ ok: false, error: { code: 'explicit_confirmation_required' } });
    expect(acknowledge).not.toHaveBeenCalled();
    expect(await value.controller.acknowledgeReconciliation({ ...command, confirmed: true }))
      .toMatchObject({ ok: true, value: { state: 'cancelled', acknowledged: true, reconciliationReason: 'unknown_result' } });
    expect(acknowledge).toHaveBeenCalledWith(run.responseExecutionId, 2, null, snapshot.taskRevisions);
    expect(await value.controller.acknowledgeReconciliation({ ...command, confirmed: true }))
      .toMatchObject({ ok: false, error: { code: 'reconciliation_snapshot_changed' } });
    expect(acknowledge).toHaveBeenCalledTimes(1);
    expect(value.runtime.start).not.toHaveBeenCalled();
  });
  it('interrupts startup readiness on application shutdown before an execution handle exists', async () => {
    const value = fixture();
    const ready = deferred<void>();
    Object.assign(value.runtime, { ready: ready.promise });
    const pending = value.controller.start(startRequest('shutdown-before-ready'));
    await Promise.resolve();
    expect(value.controller.cancelActiveStarts()).toBe(1);
    await expect(pending).resolves.toMatchObject({ ok: false, error: { code: 'response_start_cancelled' } });
    await value.controller.waitForOperations();
    ready.resolve();
    await Promise.resolve();
    expect(value.runtime.start).not.toHaveBeenCalled();
  });
  it.each(['timeout', 'cancelled', 'budget_exceeded'] as const)('reports a startup %s without a storage error', async code => {
    const value = fixture();
    vi.mocked(value.runtime.start!).mockRejectedValue(new ExecutionBudgetError(code));
    expect(await value.controller.start(startRequest(`budget-start-${code}`))).toMatchObject({ ok: false, error: {
      code: code === 'timeout' ? 'response_execution_timeout' : code === 'cancelled' ? 'response_start_cancelled' : 'response_execution_stopped'
    } });
  });
  it('cancels a start while recovery is still pending, without waiting for readiness or allowing late dispatch', async () => {
    const value = fixture();
    const ready = deferred<void>();
    Object.assign(value.runtime, { ready: ready.promise });
    const request = startRequest('cancel-before-ready');
    const pending = value.controller.start(request);
    await Promise.resolve();
    await expect(value.controller.cancelResponseStart({ projectId, clientCommandId: request.clientCommandId }))
      .resolves.toEqual({ ok: true, value: { cancelled: true } });
    await expect(pending).resolves.toMatchObject({ ok: false, error: { code: 'response_start_cancelled' } });
    ready.resolve();
    await value.controller.waitForOperations();
    await expect(value.controller.start(request)).resolves.toMatchObject({ ok: false, error: { code: 'response_start_cancelled' } });
    expect(value.service.create).not.toHaveBeenCalled();
    expect(value.runtime.start).not.toHaveBeenCalled();
    expect(value.errors).toEqual([]);
  });

  it('rejects cross-project and open-ended cancellation payloads without stopping a current start', async () => {
    const value = fixture();
    const ready = deferred<void>();
    Object.assign(value.runtime, { ready: ready.promise });
    const request = startRequest('cancel-project-scope');
    const pending = value.controller.start(request);
    await Promise.resolve();
    expect(await value.controller.cancelResponseStart({ projectId: 'project-other', clientCommandId: request.clientCommandId }))
      .toMatchObject({ ok: false, error: { code: 'project_scope_mismatch' } });
    expect(await value.controller.cancelResponseStart({ projectId, clientCommandId: request.clientCommandId, path: 'untrusted' }))
      .toMatchObject({ ok: false, error: { code: 'invalid_request' } });
    expect(await value.controller.cancelResponseStart({ projectId, clientCommandId: 'unknown-command' }))
      .toEqual({ ok: true, value: { cancelled: false } });
    ready.resolve();
    expect(await pending).toMatchObject({ ok: true });
    expect(value.runtime.start).toHaveBeenCalledOnce();
  });

  it('cancels an Agent-native tool preparation and never pins or dispatches its late result', async () => {
    const value = fixture();
    const preparation = deferred<undefined>();
    const prepare = vi.fn(async (_input: { signal?: AbortSignal }) => preparation.promise);
    const pinDraft = vi.fn(async () => undefined);
    Object.assign(value.runtime, { documentTools: { prepare, pinDraft, select: vi.fn() } });
    const request = { ...startRequest('cancel-agent-preparation'), confirmed: undefined };
    delete (request as { confirmed?: unknown }).confirmed;
    const pending = value.controller.startAgent(request);
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce());
    const signal = prepare.mock.calls[0][0].signal!;
    expect(signal.aborted).toBe(false);
    await value.controller.cancelResponseStart({ projectId, clientCommandId: request.clientCommandId });
    expect(await pending).toMatchObject({ ok: false, error: { code: 'response_start_cancelled' } });
    expect(signal.aborted).toBe(true);
    preparation.resolve(undefined);
    await value.controller.waitForOperations();
    expect(pinDraft).not.toHaveBeenCalled();
    expect(value.candidateService.prepareSubmission).not.toHaveBeenCalled();
    expect(value.runtime.start).not.toHaveBeenCalled();
  });

  it('pins the Agent-native startup signal before dispatch while retaining select-only compatibility', async () => {
    const value = fixture();
    const selection = { kind: 'generation' as const, projectId, conversationId: toConversationId('conversation-controller'),
      currentUserMessageId: toMessageId('message-user-controller'), userMessageRevision: 0,
      userMessageHash: 'a'.repeat(64), authorizationStatus: 'approved' as const, bindingHash: 'b'.repeat(64) };
    const prepare = vi.fn(async () => selection);
    const pinDraft = vi.fn(async (_input: { signal?: AbortSignal; selection: typeof selection }) => undefined);
    Object.assign(value.runtime, { documentTools: { prepare, pinDraft, select: vi.fn() } });
    const request = { ...startRequest('agent-signal-pin'), confirmed: undefined };
    delete (request as { confirmed?: unknown }).confirmed;
    expect(await value.controller.startAgent(request)).toMatchObject({ ok: true });
    expect(prepare).toHaveBeenCalledWith(expect.objectContaining({ signal: expect.any(AbortSignal), draft: expect.objectContaining({ agentNative: true }) }));
    expect(pinDraft).toHaveBeenCalledWith(expect.objectContaining({ selection, signal: expect.any(AbortSignal) }));
    const signal = vi.mocked(value.runtime.start!).mock.calls[0][0].signal;
    expect(pinDraft.mock.calls[0][0]).toMatchObject({ signal });
    expect(signal?.aborted).toBe(false);
  });

  it('cancels the AgentRun and a late active execution when cancellation wins the startup race', async () => {
    const value = fixture();
    const started = deferred<ConversationResponseExecutionReadModelV1>();
    vi.mocked(value.runtime.start!).mockImplementation(async () => started.promise);
    let run: ConversationAgentRunV1 | undefined;
    const runs = { list: vi.fn(async () => []), create: vi.fn(async (created: ConversationAgentRunV1) => { run = created; }),
      get: vi.fn(async () => run), save: vi.fn(async (updated: ConversationAgentRunV1) => { run = updated; }) };
    Object.assign(value.runtime, { agentRuns: runs });
    const request = { ...startRequest('cancel-agent-dispatch'), confirmed: undefined };
    delete (request as { confirmed?: unknown }).confirmed;
    const pending = value.controller.startAgent(request);
    await vi.waitFor(() => expect(value.runtime.start).toHaveBeenCalledOnce());
    await value.controller.cancelResponseStart({ projectId, clientCommandId: request.clientCommandId });
    expect(await pending).toMatchObject({ ok: false, error: { code: 'response_start_cancelled' } });
    await vi.waitFor(() => expect(run?.status).toBe('cancelled'));
    started.resolve(execution('pending'));
    await vi.waitFor(() => expect(value.runtime.executionCoordinator.cancel).toHaveBeenCalledWith('response-execution-controller'));
    expect(value.runtime.start).toHaveBeenCalledOnce();
  });

  it('does not cancel a completed execution that arrives after startup cancellation', async () => {
    const value = fixture();
    const started = deferred<ConversationResponseExecutionReadModelV1>();
    vi.mocked(value.runtime.start!).mockImplementation(async () => started.promise);
    const request = startRequest('cancel-late-completed');
    const pending = value.controller.start(request);
    await vi.waitFor(() => expect(value.runtime.start).toHaveBeenCalledOnce());
    await value.controller.cancelResponseStart({ projectId, clientCommandId: request.clientCommandId });
    expect(await pending).toMatchObject({ ok: false, error: { code: 'response_start_cancelled' } });
    started.resolve(execution('completed'));
    await value.controller.waitForOperations();
    await Promise.resolve();
    expect(value.runtime.executionCoordinator.cancel).not.toHaveBeenCalled();
  });

  it('includes replayed task progress in the execution IPC snapshot', async () => {
    const value = fixture();
    const taskProgress = [{
      sequence: 2, stage: 'planning' as const, progressStatus: 'completed' as const,
      taskRevision: 1, occurredAt: createdAt
    }];
    vi.mocked(value.runtime.executions.readModel).mockResolvedValue({
      ...execution(), streamSequence: 2, taskProgress
    });
    expect(await value.controller.getExecution({ responseExecutionId: 'response-execution-controller' }))
      .toMatchObject({ ok: true, value: { taskProgress } });
  });

  it('lists text candidates after startup recovery fails while response writes stay blocked', async () => {
    const value = fixture();
    const error = new Error('legacy recovery record is unsupported');
    const ready = Promise.reject(error);
    void ready.catch(() => undefined);
    Object.assign(value.runtime, { ready });

    await expect(value.controller.listTextCandidates({
      productFeature: 'text_chat'
    })).resolves.toEqual({ ok: true, value: [] });
    expect(value.candidateService.listCatalogForFeature).toHaveBeenCalledWith({
      projectId,
      productFeature: 'text_chat'
    });
    await expect(value.controller.start(startRequest())).resolves.toMatchObject({ ok: false });
    expect(value.errors).toEqual([error]);
    expect(value.service.create).not.toHaveBeenCalled();
    expect(value.draftRepository.create).not.toHaveBeenCalled();
    expect(value.candidateService.prepareSubmission).not.toHaveBeenCalled();
    expect(value.runtime.start).not.toHaveBeenCalled();
  });

  it('does not wait for pending project recovery before listing the model catalog', async () => {
    const value = fixture();
    let finishRecovery: () => void = () => undefined;
    const ready = new Promise<void>((resolve) => { finishRecovery = resolve; });
    Object.assign(value.runtime, { ready });
    try {
      await expect(value.controller.listTextCandidates({
        productFeature: 'text_reasoning'
      })).resolves.toEqual({ ok: true, value: [] });
      expect(value.candidateService.listCatalogForFeature).toHaveBeenCalledWith({
        projectId,
        productFeature: 'text_reasoning'
      });
      expect(value.runtime.conversations.get).not.toHaveBeenCalled();
    } finally {
      finishRecovery();
    }
  });

  it('stops before workflow execution and provider dispatch while native search authorization is pending', async () => {
    const f = fixture();
    const workflow = { ...f.readyWorkflow, plan: { ...f.readyWorkflow.plan, sourcePolicy: 'web' as const } };
    f.workflowService.get.mockResolvedValue(workflow);
    Object.assign(f.candidateService, { resolveBinding: vi.fn(async () => ({ candidate: {} })) });
    Object.assign(f.runtime, { nativeSearch: { prepare: vi.fn(async () => { throw new NativeSearchAuthorizationError(); }), allowsConversation: vi.fn(async () => false) } as unknown as ConversationNativeSearch });
    const result = await f.controller.start({ ...startRequest(), conversation: { conversationId: 'conversation-controller', expectedRevision: 2, editedMessageId: null },
      workflow: { workflowId: workflow.id, expectedRevision: workflow.revision } });
    expect(result).toMatchObject({ ok: false, error: { code: 'native_search_authorization_required' } });
    expect(f.workflowService.beginExecution).not.toHaveBeenCalled();
    expect(f.runtime.start).not.toHaveBeenCalled();
  });

  it('starts the Agent-native path without creating or validating a semantic workflow', async () => {
    const value = fixture();
    const select = vi.fn(async () => undefined);
    Object.assign(value.runtime, { documentTools: { select, pinDraft: vi.fn() } });
    const request = { ...startRequest(), confirmed: undefined };
    delete (request as { confirmed?: unknown }).confirmed;
    const result = await value.controller.startAgent(request);
    expect(result).toMatchObject({ ok: true });
    expect(value.workflowService.get).not.toHaveBeenCalled();
    expect(value.workflowService.beginExecution).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
    expect(value.draftRepository.create).toHaveBeenCalledWith(expect.objectContaining({ agentNative: true }));
    expect(value.runtime.start).toHaveBeenCalledOnce();
  });

  it('persists a waiting task without drafting, authorizing or dispatching a provider request', async () => {
    const value = fixture();
    const agentSession = { sessionId: 'root-session-controller', revision: 2, sourceMessageId: 'message-user-controller',
      state: 'waiting_user' as const, waiting: { reason: 'input_required' as const, allowedActions: ['reply' as const] },
      resumeToken: 'resume-controller', deadlineAt: '2026-08-18T00:10:00.000Z', registeredWorkCount: 0 };
    const continuations = { prepare: vi.fn(async () => ({ agentSession, waiting: true })),
      bindRun: vi.fn(async () => undefined), bindExecution: vi.fn(async () => undefined), cancel: vi.fn(async () => agentSession) };
    const prepare = vi.fn(async () => undefined);
    Object.assign(value.runtime, { continuations, documentTools: { select: vi.fn(), prepare, pinDraft: vi.fn() } });
    const request = { ...startRequest('waiting-agent-controller'), confirmed: undefined };
    delete (request as { confirmed?: unknown }).confirmed;
    const first = await value.controller.startAgent(request);
    const replay = await value.controller.startAgent(request);
    expect(first).toMatchObject({ ok: true, value: { waiting: true, agentSession,
      conversation: { agentSessions: [agentSession] } } });
    expect(first.ok && first.value).not.toHaveProperty('execution');
    expect(replay).toEqual(first);
    expect(continuations.prepare).toHaveBeenCalledOnce();
    expect(prepare).not.toHaveBeenCalled();
    expect(value.draftRepository.create).not.toHaveBeenCalled();
    expect(value.candidateService.prepareSubmission).not.toHaveBeenCalled();
    expect(value.runtime.start).not.toHaveBeenCalled();
  });

  it('binds a ready continuation response to the stable root task while leaving native tool routing intact', async () => {
    const value = fixture();
    const agentSession = { sessionId: 'root-session-controller', revision: 3, sourceMessageId: 'original-source-controller',
      state: 'running' as const, deadlineAt: '2026-08-18T00:10:00.000Z', registeredWorkCount: 0 };
    const continuations = { prepare: vi.fn(async () => ({ agentSession, waiting: false,
      parentRunId: 'stable-root-controller', reservedRunId: 'reserved-child-controller' })),
      bindRun: vi.fn(async () => undefined), bindExecution: vi.fn(async () => undefined), cancel: vi.fn(async () => agentSession) };
    let run: ConversationAgentRunV1 | undefined;
    const agentRuns = { list: vi.fn(async () => []), create: vi.fn(async (created: ConversationAgentRunV1) => { run = created; }),
      get: vi.fn(async () => run), save: vi.fn(async (updated: ConversationAgentRunV1) => { run = updated; }) };
    Object.assign(value.runtime, { continuations, agentRuns });
    const request = { ...startRequest('continue-agent-controller'), confirmed: undefined };
    delete (request as { confirmed?: unknown }).confirmed;
    const result = await value.controller.startAgent({ ...request,
      conversation: { conversationId: 'conversation-controller', expectedRevision: 1, editedMessageId: null },
      continuation: { sessionId: agentSession.sessionId, expectedRevision: 2, resumeToken: 'resume-controller', action: 'reply' } });
    expect(result).toMatchObject({ ok: true, value: { agentSession, execution: { state: 'pending' } } });
    expect(continuations.prepare).toHaveBeenCalledWith(expect.objectContaining({ input: expect.objectContaining({
      continuation: { sessionId: agentSession.sessionId, expectedRevision: 2, resumeToken: 'resume-controller', action: 'reply' }
    }) }));
    expect(run?.parentRunId).toBe('stable-root-controller');
    expect(run?.id).toBe('reserved-child-controller');
    expect(continuations.bindRun).toHaveBeenCalledWith({ sessionId: agentSession.sessionId, runId: run?.id });
    expect(continuations.bindExecution).toHaveBeenCalledWith({ sessionId: agentSession.sessionId,
      runId: run?.id, responseExecutionId: 'response-execution-controller' });
    expect(value.workflowService.beginExecution).not.toHaveBeenCalled();
    expect(value.runtime.start).toHaveBeenCalledOnce();
  });

  it('replays a prior continuation response before active execution checks or another message is written', async () => {
    const value = fixture();
    const conversation = await value.service.get();
    const replay = { conversation: { conversationId: conversation.id, revision: conversation.revision, projectId,
      title: conversation.title, status: conversation.status, storageScope: 'current_project' as const, readOnly: false,
      messages: [], createdAt, updatedAt: createdAt }, execution: { ...execution(), taskProgress: [] } };
    const validate = vi.fn(async () => replay);
    const prepare = vi.fn();
    Object.assign(value.runtime, { continuations: { validate, prepare } });
    vi.mocked(value.runtime.executions.listActive).mockResolvedValue([execution()]);
    const request = { ...startRequest('replayed-continuation'), confirmed: undefined,
      conversation: { conversationId: conversation.id, expectedRevision: 0, editedMessageId: null },
      continuation: { sessionId: 'stable-root-controller', expectedRevision: 2, resumeToken: 'prior-token', action: 'reply' } };
    delete (request as { confirmed?: unknown }).confirmed;
    expect(await value.controller.startAgent(request)).toMatchObject({ ok: true, value: replay });
    expect(value.service.addUserMessage).not.toHaveBeenCalled();
    expect(value.runtime.executions.listActive).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    expect(value.runtime.start).not.toHaveBeenCalled();
  });

  it('requires project scope and the current session revision to cancel a waiting task', async () => {
    const value = fixture();
    const agentSession = { sessionId: 'root-session-controller', revision: 4, sourceMessageId: 'original-source-controller',
      state: 'cancelled' as const, deadlineAt: '2026-08-18T00:10:00.000Z', registeredWorkCount: 0 };
    const cancel = vi.fn(async () => agentSession);
    Object.assign(value.runtime, { continuations: { cancel } });
    expect(await value.controller.cancelAgentSession({ projectId: 'other-project', sessionId: agentSession.sessionId, expectedRevision: 3 }))
      .toMatchObject({ ok: false, error: { code: 'project_scope_mismatch' } });
    expect(cancel).not.toHaveBeenCalled();
    expect(await value.controller.cancelAgentSession({ projectId, sessionId: agentSession.sessionId, expectedRevision: 3 }))
      .toMatchObject({ ok: true, value: agentSession });
    expect(cancel).toHaveBeenCalledWith({ projectId, sessionId: agentSession.sessionId, expectedRevision: 3 });
    expect(await value.controller.cancelAgentSession({ projectId, sessionId: agentSession.sessionId, expectedRevision: 3, closeUnknown: true }))
      .toMatchObject({ ok: true, value: agentSession });
    expect(cancel).toHaveBeenLastCalledWith({ projectId, sessionId: agentSession.sessionId, expectedRevision: 3, closeUnknown: true });
  });

  it('discloses document sources before pinning the response revision', async () => {
    const f = fixture();
    const workflow = { ...f.readyWorkflow, plan: { ...f.readyWorkflow.plan, kind: 'document' as const, action: 'create' as const, documentKind: 'ppt' as const } };
    f.workflowService.get.mockResolvedValue(workflow);
    const result = await f.controller.start({ ...startRequest(), conversation: { conversationId: 'conversation-controller', expectedRevision: 2, editedMessageId: null },
      workflow: { workflowId: workflow.id, expectedRevision: workflow.revision } });
    expect(result.ok).toBe(true);
    expect(f.service.ensureLocalReply).toHaveBeenCalledWith('conversation-controller', expect.stringContaining('sources-'), expect.stringContaining('本次制作不联网搜索'));
    const disclosed = await f.service.ensureLocalReply.mock.results[0].value;
    expect(f.draftRepository.create).toHaveBeenCalledWith(expect.objectContaining({ conversationRevision: disclosed.revision }));
    expect(f.service.ensureLocalReply.mock.invocationCallOrder[0]).toBeLessThan(f.draftRepository.create.mock.invocationCallOrder[0]);
    expect(f.runtime.start).toHaveBeenCalledOnce();
  });

  it('keeps a reusable conversation grant eligible without claiming offline creation', async () => {
    const f = fixture();
    const workflow = { ...f.readyWorkflow, plan: { ...f.readyWorkflow.plan, kind: 'document' as const, action: 'create' as const, documentKind: 'ppt' as const } };
    f.workflowService.get.mockResolvedValue(workflow);
    const native = { prepare: vi.fn(async () => undefined), allowsConversation: vi.fn(async () => true) };
    Object.assign(f.runtime, { nativeSearch: native });
    Object.assign(f.candidateService, { resolveBinding: vi.fn(async () => ({ candidate: {} })) });
    const result = await f.controller.start({ ...startRequest(), conversation: { conversationId: 'conversation-controller', expectedRevision: 2, editedMessageId: null },
      workflow: { workflowId: workflow.id, expectedRevision: workflow.revision } });
    expect(result.ok).toBe(true);
    expect(native.prepare).toHaveBeenCalledOnce();
    expect(f.service.ensureLocalReply).not.toHaveBeenCalled();
  });

  it.each(['不要联网', '不需要联网', '取消网络搜索', '关闭联网', '只使用内部资料'])('honors %s before considering reusable grants', async (content) => {
    const f = fixture(undefined, content);
    const workflow = { ...f.readyWorkflow, plan: { ...f.readyWorkflow.plan, kind: 'document' as const, sourcePolicy: 'web' as const, action: 'create' as const, documentKind: 'ppt' as const } };
    f.workflowService.get.mockResolvedValue(workflow);
    const native = { revoke: vi.fn(async () => undefined), prepare: vi.fn(), allowsConversation: vi.fn(async () => true) };
    Object.assign(f.runtime, { nativeSearch: native });
    const result = await f.controller.start({ ...startRequest(), conversation: { conversationId: 'conversation-controller', expectedRevision: 2, editedMessageId: null },
      workflow: { workflowId: workflow.id, expectedRevision: workflow.revision } });
    expect(result.ok).toBe(true);
    expect(native.revoke).toHaveBeenCalledWith('conversation-controller');
    expect(native.allowsConversation).not.toHaveBeenCalled();
    expect(native.prepare).not.toHaveBeenCalled();
    expect(f.service.ensureLocalReply).toHaveBeenCalledOnce();
  });

  it('discloses local retrieval for mixed requests without opening search preparation', async () => {
    const f = fixture();
    const workflow = { ...f.readyWorkflow, plan: { ...f.readyWorkflow.plan, kind: 'document' as const, sourcePolicy: 'mixed' as const, action: 'create' as const, documentKind: 'ppt' as const } };
    f.workflowService.get.mockResolvedValue(workflow);
    const native = { preferLocal: vi.fn(async () => true), prepare: vi.fn(), allowsConversation: vi.fn(async () => true) };
    Object.assign(f.runtime, { nativeSearch: native });
    const result = await f.controller.start({ ...startRequest(), conversation: { conversationId: 'conversation-controller', expectedRevision: 2, editedMessageId: null },
      workflow: { workflowId: workflow.id, expectedRevision: workflow.revision } });
    expect(result.ok).toBe(true);
    expect(native.prepare).not.toHaveBeenCalled();
    expect(f.service.ensureLocalReply).toHaveBeenCalledWith('conversation-controller', expect.any(String), expect.stringContaining('已检索到本地资料'));
    const disclosed = await f.service.ensureLocalReply.mock.results[0].value;
    expect(f.draftRepository.create).toHaveBeenCalledWith(expect.objectContaining({ conversationRevision: disclosed.revision }));
  });

  it('pins an explicit image question for main-process reading without exposing internal routing in the DTO', async () => {
    const value = fixture(undefined, '分析一下图片');
    const result = await value.controller.start({ ...startRequest(), content: '分析一下图片' });
    expect(result.ok).toBe(true);
    expect(value.draftRepository.create).toHaveBeenCalledWith(expect.objectContaining({ imageQuery: '分析一下图片' }));
    expect(JSON.stringify(result)).not.toContain('imageQuery');
  });

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

  it('submits the validated document plan as a bounded provider contract', async () => {
    const value = fixture();
    const plan = parseConversationIntentPlan({
      schemaVersion: 1,
      kind: 'document',
      action: 'create',
      documentKind: 'ppt',
      parameters: {
        topic: '季度经营汇报',
        pageCount: 5,
        style: '简洁商务',
        requirements: '突出收入、风险和下一步行动'
      },
      sourcePolicy: 'internal',
      missing: [],
      ambiguities: [],
      confidence: 'high',
      needsConfirmation: false
    });
    value.workflowService.get.mockResolvedValue({ ...value.readyWorkflow, plan });

    const result = await value.controller.start({
      ...startRequest('workflow-document-contract'),
      conversation: {
        conversationId: 'conversation-controller',
        expectedRevision: 2,
        editedMessageId: null
      },
      content: '制作季度经营汇报 PPT',
      workflow: {
        workflowId: value.readyWorkflow.id,
        expectedRevision: value.readyWorkflow.revision
      }
    });

    expect(result).toMatchObject({ ok: true });
    const createDraft = value.draftRepository.create as unknown as {
      mock: { calls: readonly (readonly unknown[])[] };
    };
    const draft = createDraft.mock.calls.at(-1)?.[0] as { promptContent?: string } | undefined;
    expect(draft?.promptContent).toContain('【UniComp 受控文档生成合同】');
    expect(draft?.promptContent).toContain('"documentKind":"ppt"');
    expect(draft?.promptContent).toContain('"pageCount":5');
    expect(draft?.promptContent).toContain('制作季度经营汇报 PPT');
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
