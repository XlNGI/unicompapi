import { randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  ConversationApplicationService,
  ConversationIntentOrchestrator,
  ConversationWorkflowService,
  ProjectContextRegistryService,
  type ConversationIdFactory,
  type ProjectContextIdFactory
} from '../../application';
import {
  addUserMessage,
  appendAssistantMessageChunk,
  beginAssistantMessage,
  completeAssistantMessage,
  createConversation,
  createProviderInvocationEvent,
  failAssistantMessage,
  startAssistantMessageStreaming,
  toConversationId,
  toConversationResponseStreamEventId,
  toIsoTimestamp,
  toMessageId,
  toProjectContextDraftId,
  toProjectContextFragmentId,
  toProjectContextId,
  toSubmissionIntentId,
  transitionSubmissionIntent,
  type Conversation,
  type ProjectId
} from '../../domain';
import {
  JsonConversationRepository,
  JsonConversationResponseDraftRepository,
  JsonConversationResponseExecutionRepository,
  JsonConversationWorkflowRepository,
  JsonProviderExecutionRouteSnapshotRepository,
  JsonProviderInvocationRepository,
  JsonProviderUsageObservationRepository,
  JsonProjectConversationRepository,
  JsonProjectContextRepository,
  ConversationRevisionConflictError
} from '../repositories';
import { NodeProjectStorage } from '../storage';
import { ConversationController } from './conversation-controller';
import { toConversationDto } from './conversation-controller';
import {
  ConversationWorkflowController,
  type ConversationWorkflowControllerRuntime
} from './conversation-workflow-controller';
import {
  ConversationResponseController,
  type ConversationResponseControllerRuntime
} from './conversation-response-controller';
import { ProjectContextController } from './project-context-controller';
import type { StorageProjectSession } from './storage-ipc-controller';
import {
  ConversationResponseArtifactFactory,
  ConversationExecutionCoordinator,
  ControlledConversationResponseStreamChannel,
  ConversationResponseExecutionLifecycle,
  createConversationTextDispatchBridge,
  createConversationTextSubmissionIdFactory,
  createTextProviderFeatureContracts,
  deepSeekProviderPackageDescriptor,
  klingProviderPackageDescriptor,
  kimiProviderPackageDescriptor,
  newApiProviderPackageDescriptor,
  ProjectConversationResponseSubjectResolver,
  ProviderFeatureCandidateService,
  ProviderFeatureContractRegistry,
  ProviderPackageRegistry,
  ProviderSubmissionOrchestrator,
  SubmissionOrchestrationError,
  RegistryFeatureCandidateSource,
  RouteSelectionTokenVault,
  type ConversationTextSubmissionRuntimes,
  type ProviderCandidateRuntimeAuthorizationPort,
  type RuntimeAuthorizationOrchestrationPort,
  unicompapiProviderPackageDescriptor,
  viduProviderPackageDescriptor,
  volcengineProviderPackageDescriptor,
  type JsonProviderRegistryStore
} from '../providers';
import { JsonProviderRegistryStore as ProviderRegistryStore } from '../providers';
import {
  ProjectMetadataUnitOfWork,
  ProjectSubmissionAcceptanceStore,
  SubmissionIntentJournal
} from '../storage';
import type { ProjectSubmissionAcceptanceV1 } from '../storage';
import type {
  ChatContextIpcResult,
  ConversationCandidateDto,
  ConversationDto
} from '../../shared/chat-context-ipc';
import { chatContextRequestParsers } from '../../shared/chat-context-ipc';
import { chatContextFailure, failure } from './chat-context-errors';

export interface ChatContextRuntimeDependencies {
  readonly userDataDirectory: string;
  getSession(): StorageProjectSession | undefined;
  readonly providerRegistry?: JsonProviderRegistryStore;
  readonly providerPackages?: ProviderPackageRegistry;
  readonly runtimeAuthorization?: ProviderCandidateRuntimeAuthorizationPort &
    Partial<RuntimeAuthorizationOrchestrationPort>;
  readonly textSubmission?: Omit<
    ConversationTextSubmissionRuntimes,
    'providerRegistry' | 'providerPackages' | 'usage'
  >;
  now?: () => string;
  conversationIds?: ConversationIdFactory;
  projectContextIds?: ProjectContextIdFactory;
  onError?(error: unknown): void;
}

export interface ChatContextRuntime {
  readonly conversations: ConversationControllerPort;
  readonly responses: ConversationResponseController;
  readonly projectContexts: ProjectContextController;
  readonly workflows: ConversationWorkflowController;
  interruptActiveResponses(): Promise<number>;
  waitForMutations(): Promise<void>;
}

export interface ConversationControllerPort {
  create(request: unknown): Promise<ChatContextIpcResult<ConversationDto>>;
  get(request: unknown): Promise<ChatContextIpcResult<ConversationDto>>;
  list(request: unknown): Promise<ChatContextIpcResult<readonly ConversationDto[]>>;
  listCandidates(): Promise<ChatContextIpcResult<readonly ConversationCandidateDto[]>>;
  rename(request: unknown): Promise<ChatContextIpcResult<ConversationDto>>;
  archive(request: unknown): Promise<ChatContextIpcResult<ConversationDto>>;
  restore(request: unknown): Promise<ChatContextIpcResult<ConversationDto>>;
  delete(request: unknown): Promise<ChatContextIpcResult<ConversationDto>>;
  addUserMessage(request: unknown): Promise<ChatContextIpcResult<ConversationDto>>;
  editCancelledUserMessage(request: unknown): Promise<ChatContextIpcResult<ConversationDto>>;
  copyLegacyConversation(request: unknown): Promise<ChatContextIpcResult<ConversationDto>>;
  requestAssistantResponse(request: unknown): Promise<ChatContextIpcResult<ConversationDto>>;
  waitForOperations(): Promise<void>;
}

export function createChatContextRuntime(
  dependencies: ChatContextRuntimeDependencies
): ChatContextRuntime {
  const now = dependencies.now ?? (() => new Date().toISOString());
  const conversationIds = dependencies.conversationIds ?? createConversationIds();
  const contextIds = dependencies.projectContextIds ?? createProjectContextIds();
  const legacyRepository = new JsonConversationRepository(
    path.join(dependencies.userDataDirectory, 'conversations.json'),
    now
  );
  const legacyService = new ConversationApplicationService(
    legacyRepository,
    conversationIds,
    now
  );
  const providerRegistry = dependencies.providerRegistry ?? new ProviderRegistryStore(
    path.join(dependencies.userDataDirectory, 'provider-registry.json')
  );
  const providerPackages = dependencies.providerPackages ?? new ProviderPackageRegistry([
    deepSeekProviderPackageDescriptor,
    volcengineProviderPackageDescriptor,
    klingProviderPackageDescriptor,
    kimiProviderPackageDescriptor,
    newApiProviderPackageDescriptor,
    unicompapiProviderPackageDescriptor,
    viduProviderPackageDescriptor
  ]);
  const contracts = new ProviderFeatureContractRegistry([
    ...createTextProviderFeatureContracts()
  ]);
  type ProjectRuntime = {
    readonly projectId: string;
    readonly rootDirectory: string;
    readonly conversations: ConversationController;
    readonly conversationRepository: JsonProjectConversationRepository;
    readonly contextService: ProjectContextRegistryService;
    readonly workflowService: ConversationWorkflowService;
    readonly responses: ConversationResponseControllerRuntime;
  };
  let cached: ProjectRuntime | undefined;
  const runtimes = new Set<ProjectRuntime>();
  const getProjectRuntime = (session: StorageProjectSession): ProjectRuntime => {
    if (
      cached?.projectId === session.projectId &&
      cached.rootDirectory === session.rootDirectory
    ) {
      return cached;
    }
    const storage = new NodeProjectStorage(session.rootDirectory);
    const projectConversations = new JsonProjectConversationRepository(
      storage,
      session.projectId,
      now
    );
    const service = new ConversationApplicationService(
      projectConversations,
      conversationIds,
      now
    );
    const contextRepository = new JsonProjectContextRepository(
      storage,
      session.projectId,
      now
    );
    const contextService = new ProjectContextRegistryService(
      projectConversations,
      contextRepository,
      contextIds,
      now
    );
    const responseDrafts = new JsonConversationResponseDraftRepository(
      storage,
      session.projectId,
      now
    );
    const responseExecutions = new JsonConversationResponseExecutionRepository(
      storage,
      session.projectId
    );
    const workflowService = new ConversationWorkflowService(
      new JsonConversationWorkflowRepository(storage, session.projectId, now),
      new ConversationIntentOrchestrator(),
      now
    );
    const invocationRoutes = new JsonProviderExecutionRouteSnapshotRepository(
      storage,
      session.projectId
    );
    const invocations = new JsonProviderInvocationRepository(
      storage,
      session.projectId
    );
    const candidateService = new ProviderFeatureCandidateService(
      new ProjectConversationResponseSubjectResolver(
        projectConversations,
        responseDrafts,
        contextRepository
      ),
      new RegistryFeatureCandidateSource(
        providerRegistry,
        providerPackages,
        contracts,
        dependencies.runtimeAuthorization ?? {
          async checkAccess() {
            return {
              allowed: false,
              operation: 'submit' as const,
              reason: 'no_matching_policy' as const
            };
          }
        }
      ),
      new RouteSelectionTokenVault(),
      now
    );
    const streamChannel = new ControlledConversationResponseStreamChannel();
    const responseLifecycle = new ConversationResponseExecutionLifecycle(
      responseExecutions,
      {
        nextConversationResponseStreamEventId: () =>
          toConversationResponseStreamEventId(`response-stream-${randomUUID()}`)
      },
      streamChannel,
      () => toIsoTimestamp(now())
    );
    const executionCoordinator = new ConversationExecutionCoordinator();
    // After a process restart no in-memory adapter exists to resume these streams.
    const responseRecovery = responseLifecycle
      .interruptActiveForApplicationShutdown()
      .then(() => workflowService.recoverInterruptedExecutions())
      .then(() => undefined);
    const authorization = dependencies.runtimeAuthorization;
    const textSubmission = dependencies.textSubmission;
    const canSubmit = Boolean(
      textSubmission &&
      authorization &&
      typeof authorization.claimSubmission === 'function' &&
      typeof authorization.markRequestStarted === 'function' &&
      typeof authorization.releaseBeforeRequest === 'function' &&
      typeof authorization.recordOutcome === 'function'
    );
    const responses: ConversationResponseControllerRuntime = {
      conversationService: service,
      conversations: projectConversations,
      drafts: responseDrafts,
      contexts: contextRepository,
      candidates: candidateService,
      executions: responseLifecycle,
      executionCoordinator,
      streamChannel,
      workflowService,
      ready: responseRecovery
    };
    if (canSubmit && textSubmission && authorization) {
      const acceptances = new ProjectSubmissionAcceptanceStore(
        new ProjectMetadataUnitOfWork(storage, now)
      );
      const journal = new SubmissionIntentJournal(storage, now);
      const artifacts = new ConversationResponseArtifactFactory({
        conversations: projectConversations,
        drafts: responseDrafts,
        contexts: contextRepository,
        executions: responseExecutions,
        nextMessageId: () => conversationIds.nextMessageId(),
        now
      });
      const dispatch = createConversationTextDispatchBridge({
        ...textSubmission,
        providerRegistry,
        providerPackages,
        lifecycle: responseLifecycle,
        conversations: projectConversations,
        coordinator: executionCoordinator,
        usage: new JsonProviderUsageObservationRepository(storage),
        terminalObserver: createConversationTerminalObserver(
          acceptances,
          authorization as RuntimeAuthorizationOrchestrationPort,
          workflowService,
          invocationRoutes,
          invocations,
          now
        ),
        now
      });
      const orchestrator = new ProviderSubmissionOrchestrator(
        candidateService,
        acceptances,
        authorization as RuntimeAuthorizationOrchestrationPort,
        journal,
        artifacts,
        dispatch,
        createConversationTextSubmissionIdFactory(),
        now
      );
      responses.submit = async (input) => {
        const orchestration = await orchestrator.submitConversationResponse(input);
        const acceptance = (await acceptances.list()).find(
          (item) => item.intent.id === orchestration.submissionIntentId
        );
        if (
          !acceptance ||
          acceptance.subjectArtifacts.kind !== 'conversation'
        ) {
          throw new Error('Conversation response acceptance artifacts are missing');
        }
        await persistConversationCallRecordFacts({
          acceptance,
          routes: invocationRoutes,
          invocations
        });
        return responseLifecycle.readModel(
          acceptance.subjectArtifacts.responseExecution.id
        );
      };
      responses.start = async (input) => {
        const started = await orchestrator.beginConversationResponse(input);
        if (started.subjectArtifacts.kind !== 'conversation') {
          throw new Error('Conversation response acceptance artifacts are missing');
        }
        const submissionIntentId = toSubmissionIntentId(started.accepted.submissionIntentId);
        const accepted = await acceptances.get(submissionIntentId);
        if (!accepted || accepted.subjectArtifacts.kind !== 'conversation') {
          throw new Error('Conversation response acceptance artifacts are missing');
        }
        await persistConversationCallRecordFacts({
          acceptance: accepted,
          routes: invocationRoutes,
          invocations
        });
        const executionId = started.subjectArtifacts.responseExecution.id;
        void started.completion.then(async () => {
          try {
            const completed = await acceptances.get(submissionIntentId);
            if (completed) {
              await persistConversationCallRecordFacts({
                acceptance: completed,
                routes: invocationRoutes,
                invocations
              });
            }
          } catch (error) {
            dependencies.onError?.(error);
          }
        }, async (error: unknown) => {
          dependencies.onError?.(error);
          try {
            const current = await responseLifecycle.readModel(executionId);
            if (current.state !== 'pending' && current.state !== 'streaming') return;
            const event = await responseLifecycle.failDeferredPublish(
              executionId,
              backgroundSubmissionSafeCode(error)
            );
            for (let attempt = 0; attempt < 4; attempt += 1) {
              const conversation = await projectConversations.get(
                toConversationId(current.conversationId)
              );
              if (!conversation) break;
              try {
                await projectConversations.save(
                  failAssistantMessage(
                    conversation,
                    toMessageId(current.assistantMessageId),
                    'unavailable',
                    toIsoTimestamp(now())
                  ),
                  conversation.revision
                );
                break;
              } catch (saveError) {
                if (!(saveError instanceof ConversationRevisionConflictError) || attempt === 3) {
                  throw saveError;
                }
              }
            }
            await responseLifecycle.publish(event);
            const failed = await acceptances.get(submissionIntentId);
            if (failed) {
              await persistConversationCallRecordFacts({
                acceptance: failed,
                routes: invocationRoutes,
                invocations
              });
            }
          } catch (terminalError) {
            dependencies.onError?.(terminalError);
          }
        });
        return responseLifecycle.readModel(executionId);
      };
    }
    cached = {
      projectId: session.projectId,
      rootDirectory: session.rootDirectory,
      conversations: new ConversationController({
        service,
        getSession: dependencies.getSession,
        projectRequired: true,
        storageScope: 'current_project',
        onError: dependencies.onError
      }),
      conversationRepository: projectConversations,
      contextService,
      workflowService,
      responses
    };
    runtimes.add(cached);
    return cached;
  };

  const requireProjectController = () => {
    const session = dependencies.getSession();
    return session ? getProjectRuntime(session).conversations : undefined;
  };
  const safeConversationOperation = async <T>(
    operation: () => Promise<ChatContextIpcResult<T>>
  ): Promise<ChatContextIpcResult<T>> => {
    try {
      return await operation();
    } catch (error) {
      return chatContextFailure(error, dependencies.onError);
    }
  };
  const conversations: ConversationControllerPort = {
    create: (request) => requireProjectController()?.create(request) ??
      Promise.resolve(failure('project_not_open', 'A project must be open')),
    get: (request) => safeConversationOperation(async () => {
      const session = dependencies.getSession();
      const project = session ? getProjectRuntime(session).conversations : undefined;
      if (project) {
        const result = await project.get(request);
        if (result.ok || result.error.code !== 'conversation_not_found') return result;
      }
      const input = chatContextRequestParsers.conversationId(request);
      const legacy = await legacyRepository.get(toConversationId(input.conversationId));
      if (!legacy || (legacy.projectId !== null && legacy.projectId !== session?.projectId)) {
        return failure('conversation_not_found', 'The conversation does not exist');
      }
      return {
        ok: true,
        value: toConversationDto(
          legacy,
          legacy.projectId === null ? 'legacy_unbound' : 'legacy_project',
          true
        )
      };
    }),
    list: (request) => safeConversationOperation(async () => {
      const input = chatContextRequestParsers.listConversations(request);
      const statuses = [
        'active' as const,
        ...(input.includeArchived ? ['archived' as const] : []),
        ...(input.includeDeleted ? ['deleted' as const] : [])
      ];
      const session = dependencies.getSession();
      const projectItems = session
        ? await getProjectRuntime(session).conversations.list(request)
        : { ok: true as const, value: [] };
      if (!projectItems.ok) return projectItems;
      const projectIds = new Set(projectItems.value.map((item) => item.conversationId));
      const legacyItems = (await legacyService.list({ statuses }))
        .filter((item) =>
          !projectIds.has(item.id) &&
          (item.projectId === null || item.projectId === session?.projectId)
        )
        .map((item) => toConversationDto(
          item,
          item.projectId === null ? 'legacy_unbound' : 'legacy_project',
          true
        ));
      return {
        ok: true,
        value: [...projectItems.value, ...legacyItems].sort((left, right) =>
          right.updatedAt.localeCompare(left.updatedAt) ||
          left.conversationId.localeCompare(right.conversationId)
        )
      };
    }),
    listCandidates: () => requireProjectController()?.listCandidates() ??
      Promise.resolve(failure('project_not_open', 'A project must be open')),
    rename: (request) => requireProjectController()?.rename(request) ??
      Promise.resolve(failure('project_not_open', 'A project must be open')),
    archive: (request) => requireProjectController()?.archive(request) ??
      Promise.resolve(failure('project_not_open', 'A project must be open')),
    restore: (request) => requireProjectController()?.restore(request) ??
      Promise.resolve(failure('project_not_open', 'A project must be open')),
    delete: (request) => requireProjectController()?.delete(request) ??
      Promise.resolve(failure('project_not_open', 'A project must be open')),
    addUserMessage: (request) => requireProjectController()?.addUserMessage(request) ??
      Promise.resolve(failure('project_not_open', 'A project must be open')),
    editCancelledUserMessage: (request) =>
      requireProjectController()?.editCancelledUserMessage(request) ??
      Promise.resolve(failure('project_not_open', 'A project must be open')),
    copyLegacyConversation: (request) => safeConversationOperation(async () => {
      const session = dependencies.getSession();
      if (!session) return failure('project_not_open', 'A project must be open');
      const input = chatContextRequestParsers.conversationId(request);
      const legacy = await legacyRepository.get(toConversationId(input.conversationId));
      if (!legacy || (legacy.projectId !== null && legacy.projectId !== session.projectId)) {
        return failure('conversation_not_found', 'The legacy conversation does not exist');
      }
      const project = getProjectRuntime(session);
      const copied = createLegacyConversationCopy(
        legacy,
        session.projectId,
        conversationIds,
        now
      );
      await project.conversationRepository.createImportedSnapshot(copied);
      return { ok: true, value: toConversationDto(copied) };
    }),
    requestAssistantResponse: (request) =>
      requireProjectController()?.requestAssistantResponse(request) ??
      Promise.resolve(failure('project_not_open', 'A project must be open')),
    waitForOperations: async () => {
      await Promise.all([...runtimes].map((runtime) =>
        runtime.conversations.waitForOperations()
      ));
    }
  };
  const projectContexts = new ProjectContextController({
    getSession: dependencies.getSession,
    onError: dependencies.onError,
    getService(session) {
      return getProjectRuntime(session).contextService;
    }
  });
  const workflows = new ConversationWorkflowController({
    getSession: dependencies.getSession,
    onError: dependencies.onError,
    getRuntime(session): ConversationWorkflowControllerRuntime {
      const runtime = getProjectRuntime(session);
      return {
        conversationService: new ConversationApplicationService(
          runtime.conversationRepository,
          conversationIds,
          now
        ),
        workflowService: runtime.workflowService
      };
    }
  });
  const responses = new ConversationResponseController({
    getSession: dependencies.getSession,
    getRuntime: (session) => getProjectRuntime(session).responses,
    nextResponseDraftId: () => `response-draft-${randomUUID()}`,
    now,
    onError: dependencies.onError
  });
  return {
    conversations,
    responses,
    projectContexts,
    workflows,
    interruptActiveResponses: async () => {
      const interrupted = await Promise.all([...runtimes].map(async (runtime) => {
        // Adapter completion owns the terminal transition. Only persisted handles
        // left without a live adapter are marked interrupted directly.
        const cancelled = await runtime.responses.executionCoordinator.cancelAll();
        const orphaned = await runtime.responses.executions.listActive();
        for (const execution of orphaned) {
          await runtime.responses.executions.interrupt(
            execution.responseExecutionId,
            'application_shutdown'
          );
        }
        return cancelled + orphaned.length;
      }));
      return interrupted.reduce((total, count) => total + count, 0);
    },
    waitForMutations: async () => {
      await Promise.all([
        conversations.waitForOperations(),
        responses.waitForOperations(),
        projectContexts.waitForMutations(),
        workflows.waitForOperations()
      ]);
    }
  };
}

function createConversationTerminalObserver(
  acceptances: ProjectSubmissionAcceptanceStore,
  authorization: RuntimeAuthorizationOrchestrationPort,
  workflows: ConversationWorkflowService,
  routes: JsonProviderExecutionRouteSnapshotRepository,
  invocations: JsonProviderInvocationRepository,
  now: () => string
) {
  const advance = async (
    input: {
      readonly providerOperationId: string;
      readonly invocationAttemptId: string;
      readonly safeCode?: string;
    },
    status: 'completed' | 'failed' | 'cancelled' | 'unknown_outcome',
    eventType: 'completed' | 'failed' | 'cancelled' | 'outcome_unknown'
  ): Promise<void> => {
    const acceptance = await acceptances.getByInvocationAttemptId(
      input.invocationAttemptId as never
    );
    if (!acceptance || ['completed', 'failed', 'cancelled', 'unknown_outcome'].includes(acceptance.intent.status)) {
      return;
    }
    const occurredAt = toIsoTimestamp(now());
    const intent = transitionSubmissionIntent(acceptance.intent, status, occurredAt, {
      providerOperationId: input.providerOperationId,
      ...(input.safeCode ? { safeCode: input.safeCode } : {})
    });
    const updated = await acceptances.advance({
      intent,
      invocationEvent: createProviderInvocationEvent({
        id: `conversation-terminal-${randomUUID()}` as never,
        invocationAttemptId: acceptance.invocationAttempt.id,
        sequence: acceptance.invocationEvents.length + 1,
        type: eventType,
        ...(input.safeCode ? { safeCode: input.safeCode } : {}),
        occurredAt
      })
    });
    await persistConversationCallRecordFacts({ acceptance: updated, routes, invocations });
    await authorization.recordOutcome(acceptance.intent.authorizationClaimId, occurredAt);
    if (acceptance.subjectArtifacts.kind === 'conversation') {
      await workflows.finishExecution(
        acceptance.subjectArtifacts.responseExecution.id,
        status === 'completed'
          ? 'completed'
          : status === 'cancelled'
            ? 'cancelled'
            : 'failed'
      );
    }
  };
  return {
    completed: (input: { providerOperationId: string; invocationAttemptId: string }) =>
      advance(input, 'completed', 'completed').catch(() => undefined),
    failed: (input: { providerOperationId: string; invocationAttemptId: string; safeCode: string }) =>
      advance(input, 'failed', 'failed').catch(() => undefined),
    cancelled: (input: { providerOperationId: string; invocationAttemptId: string }) =>
      advance(input, 'cancelled', 'cancelled').catch(() => undefined),
    interrupted: (input: { providerOperationId: string; invocationAttemptId: string }) =>
      advance(input, 'unknown_outcome', 'outcome_unknown').catch(() => undefined)
  };
}

function backgroundSubmissionSafeCode(error: unknown): string {
  return error instanceof SubmissionOrchestrationError
    ? `conversation.${error.code}`
    : 'conversation.background_submission_failed';
}

function createLegacyConversationCopy(
  legacy: Conversation,
  projectId: ProjectId,
  ids: ConversationIdFactory,
  now: () => string
): Conversation {
  const suffix = '（项目副本）';
  let copied = createConversation({
    id: ids.nextConversationId(),
    title: `${legacy.title.slice(0, 200 - suffix.length)}${suffix}`,
    projectId,
    createdAt: toIsoTimestamp(now())
  });
  for (const message of legacy.messages.filter((item) => item.state === 'completed')) {
    if (message.role === 'user') {
      copied = addUserMessage(copied, {
        id: ids.nextMessageId(),
        content: message.content,
        createdAt: toIsoTimestamp(now())
      });
      continue;
    }
    const messageId = ids.nextMessageId();
    copied = beginAssistantMessage(copied, {
      id: messageId,
      createdAt: toIsoTimestamp(now())
    });
    copied = startAssistantMessageStreaming(copied, messageId, toIsoTimestamp(now()));
    copied = appendAssistantMessageChunk(
      copied,
      messageId,
      message.content,
      toIsoTimestamp(now())
    );
    copied = completeAssistantMessage(copied, messageId, toIsoTimestamp(now()));
  }
  return copied;
}

function createConversationIds(): ConversationIdFactory {
  return {
    nextConversationId: () => toConversationId(`conversation-${randomUUID()}`),
    nextMessageId: () => toMessageId(`message-${randomUUID()}`)
  };
}

function createProjectContextIds(): ProjectContextIdFactory {
  return {
    nextDraftId: () => toProjectContextDraftId(`context-draft-${randomUUID()}`),
    nextFragmentId: () =>
      toProjectContextFragmentId(`context-fragment-${randomUUID()}`),
    nextContextId: () => toProjectContextId(`context-${randomUUID()}`)
  };
}

async function persistConversationCallRecordFacts(input: {
  readonly acceptance: ProjectSubmissionAcceptanceV1;
  readonly routes: JsonProviderExecutionRouteSnapshotRepository;
  readonly invocations: JsonProviderInvocationRepository;
}): Promise<void> {
  await input.routes.save(input.acceptance.routeSnapshot);
  const initial = input.acceptance.invocationEvents[0];
  if (!initial) return;
  const existing = await input.invocations.get(input.acceptance.invocationAttempt.id);
  if (!existing) {
    await input.invocations.create({
      ...input.acceptance.invocationAttempt,
      state: 'submitting'
    }, initial);
  }
  const existingEvents = new Set(
    await input.invocations.listEvents(input.acceptance.invocationAttempt.id)
  );
  for (const event of input.acceptance.invocationEvents) {
    if (![...existingEvents].some((item) => item.id === event.id)) {
      await input.invocations.appendEvent(event);
    }
  }
}
