import { ConversationNativeSearch } from '../providers/conversation-native-search';
import { randomUUID, createHash } from 'node:crypto';
import { ExecutionBudgetError, type ExecutionStopReason } from '../../application/execution-budget';
import { ConversationCompletionCoordinator } from '../../application/conversation-completion-coordinator';
import { ConversationAgentRuntimeService } from '../../application/conversation-agent-runtime-service';
import { ConversationAgentSessionService, ConversationAgentSessionError } from '../../application/conversation-agent-session-service';
import { JsonConversationAgentSessionRepository } from '../repositories/json-conversation-agent-session-repository';
import { ConversationAgentContinuationRuntime } from './conversation-agent-continuations';
import { ConversationAgentRecoveryRuntime } from './conversation-agent-recovery-runtime';
import { JsonConversationAgentRuntimeRepository } from '../repositories/json-conversation-agent-runtime-repository';
import { bindProductionTraceCanonicalEvents, replayCanonicalProductionEvents } from '../conversation-production-trace';
import { JsonConversationCompletionJournal } from '../repositories/json-conversation-completion-journal';
import { JsonDocumentTaskRuntimeRepository } from '../repositories/json-document-task-runtime-repository';
import { projectConversationParentRun } from './conversation-parent-run-projection';
import path from 'node:path';
import {
  ConversationApplicationService,
  ConversationIntentOrchestrator,
  ConversationWorkflowService,
  ConversationWebResearchService,
  DocumentTaskRuntimeService,
  ProjectContextRegistryService,
  type ConversationIdFactory,
  type ProjectContextIdFactory
} from '../../application';
import {
  addUserMessage,
  appendAssistantMessageChunk,
  beginAssistantMessage,
  cancelAssistantMessage,
  attachDocumentResultToMessage,
  attachRetainedDocumentResultToMessage,
  presentationDocumentPageLimits,
  completeAssistantMessage,
  createConversation,
  createProviderInvocationEvent,
  failAssistantMessage,
  setDocumentGenerationStatusOnMessage,
  startAssistantMessageStreaming,
  toConversationId,
  toDocumentTaskRuntimeId,
  toConversationResponseExecutionId,
  toConversationResponseStreamEventId,
  toIsoTimestamp,
  toMessageId,
  toProjectContextDraftId,
  toProjectContextFragmentId,
  toProjectContextId,
  toSubmissionIntentId,
  transitionSubmissionIntent,
  type Conversation,
  type ConversationAgentRunId,
  type ConversationResponseExecutionId,
  type ConversationResponseExecutionV1,
  type ProjectId,
  type WorkId,
} from '../../domain';
import {
  JsonConversationRepository,
  JsonConversationResponseDraftRepository,
  JsonConversationResponseExecutionRepository,
  JsonConversationAgentRunRepository,
  JsonConversationWorkflowRepository,
  JsonProviderExecutionRouteSnapshotRepository,
  JsonProviderInvocationRepository,
  JsonProviderUsageObservationRepository,
  JsonProjectConversationRepository,
  JsonProjectContextRepository,
  ConversationRevisionConflictError
} from '../repositories';
import { NodeProjectStorage } from '../storage';
import { ConversationAttachmentContextService } from '../documents/conversation-attachment-context';
import { ConversationDocumentPageContextService } from '../documents/conversation-document-page-context';
import { ConversationDocumentToolSessionService } from '../documents/conversation-document-tool-session';
import { PlatformDocumentDraftCompiler, PlatformDocumentGenerationExecutor } from '../documents/document-generation-application-adapters';
import { DocumentGenerationRunner } from '../documents/document-generation-runner';
import { createConfiguredOfficeRenderAdapter } from '../documents/office-render-adapter';
import { createPresentationWorkflowScope, RegisteredPresentationReader } from '../documents/registered-presentation-reader';
import { documentDeliveryFailureReason } from '../documents/conversation-document-workflow';
import { ConversationSemanticClassifier, conversationSemanticLimits } from '../providers/conversation-semantic-classifier';
import { featureCandidateId } from '../providers/provider-registry-feature-candidates';
import { ConversationController } from './conversation-controller';
import { toConversationDto } from './conversation-controller';
import { verifyRetainedDocumentArtifacts } from './retained-document-artifact-projection';
import {
  ConversationWorkflowController,
  type ConversationWorkflowControllerRuntime
} from './conversation-workflow-controller';
import {
  ConversationWebResearchController,
  type ConversationWebResearchControllerRuntime
} from './conversation-web-research-controller';
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
  minimaxH3ProviderPackageDescriptor,
  unicompapiStudioH3ProviderPackageDescriptor,
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
import {
  ControlledWebResearchService,
  RagRetrievalService,
  UnconfiguredWebSearchTransport,
  type WebSearchTransport
} from '../search';

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
  readonly webResearch?: {
    readonly transport?: WebSearchTransport;
    readonly configuration?: ConstructorParameters<typeof ConversationWebResearchService>[1];
  };
  now?: () => string;
  executionNow?: () => number;
  executionLeaseTtlMs?: number;
  conversationIds?: ConversationIdFactory;
  projectContextIds?: ProjectContextIdFactory;
  onError?(error: unknown): void;
}

export interface ChatContextRuntime {
  readonly conversations: ConversationControllerPort;
  readonly responses: ConversationResponseController;
  readonly projectContexts: ProjectContextController;
  readonly workflows: ConversationWorkflowController;
  readonly webResearch: ConversationWebResearchController;
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
  const executionNow = dependencies.executionNow ?? Date.now;
  const executionTimestamp = () => new Date(executionNow()).toISOString();
  const sessionOwnerId = `chat-host-${randomUUID()}`;
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
    minimaxH3ProviderPackageDescriptor,
    unicompapiStudioH3ProviderPackageDescriptor,
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
    readonly agentRuns: JsonConversationAgentRunRepository;
    readonly agentRuntime: ConversationAgentRuntimeService;
    readonly sessionService: ConversationAgentSessionService;
    readonly canInterruptResponse: (id: ConversationResponseExecutionId) => Promise<boolean>;
    readonly attachments: ConversationAttachmentContextService;
    readonly documentTools: ConversationDocumentToolSessionService;
    readonly webResearch: ConversationWebResearchControllerRuntime;
    readonly responses: ConversationResponseControllerRuntime;
  };
  let cached: ProjectRuntime | undefined;
  const runtimes = new Set<ProjectRuntime>();
  const responseFinalizers = new Set<Promise<void>>();
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
    const agentRuns = new JsonConversationAgentRunRepository(storage, session.projectId, executionTimestamp);
    const ownedRunsByResponse = new Map<string, ConversationAgentRunId>();
    const sessions = new JsonConversationAgentSessionRepository(storage, session.projectId, executionTimestamp);
    let continuationRuntime: ConversationAgentContinuationRuntime;
    const sessionService = new ConversationAgentSessionService({ repository: sessions, ownerId: sessionOwnerId,
      leaseTtlMs: dependencies.executionLeaseTtlMs,
      now: executionNow, hash: value => createHash('sha256').update(value).digest('hex'),
      nextResumeToken: () => randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, ''),
      recheckContinuation: ({ session: task, inputReference }) => continuationRuntime.validateReferences(task, inputReference),
      onLeaseLost: (_id, error) => dependencies.onError?.(error) });
    const invocationRoutes = new JsonProviderExecutionRouteSnapshotRepository(
      storage,
      session.projectId
    );
    const invocations = new JsonProviderInvocationRepository(
      storage,
      session.projectId
    );
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
    const usage = new JsonProviderUsageObservationRepository(storage);
    const classifier = canSubmit && textSubmission && authorization
      ? new ConversationSemanticClassifier({
          projectId: session.projectId,
          runtimes: { ...textSubmission, providerRegistry, providerPackages, usage },
          authorization: authorization as ProviderCandidateRuntimeAuthorizationPort & RuntimeAuthorizationOrchestrationPort,
          audit: { routes: invocationRoutes, invocations, usage },
          now
        })
      : undefined;
    const attachments = new ConversationAttachmentContextService({
      rootDirectory: session.rootDirectory,
      projectId: session.projectId,
      summarizer: classifier
    });
    const documentPages = new ConversationDocumentPageContextService({
      rootDirectory: session.rootDirectory, projectId: session.projectId
    });
    const mutationRenderer = createConfiguredOfficeRenderAdapter();
    const documentTools = new ConversationDocumentToolSessionService({
      rootDirectory: session.rootDirectory, projectId: session.projectId, conversations: projectConversations,
      getInheritedExecutionContext: id => continuationRuntime.executionContext(id),
      ...(classifier ? { artDirectionPlanner: async (request) => {
        const active = dependencies.getSession();
        if (request.signal.aborted || active?.projectId !== session.projectId || active.rootDirectory !== session.rootDirectory) {
          throw new Error('art_direction_session_unavailable');
        }
        const execution = await responseExecutions.get(toConversationResponseExecutionId(request.responseExecutionId));
        const route = execution ? await invocationRoutes.get(execution.snapshot.routeSnapshotId) : undefined;
        if (!route || (route.productFeature !== 'text_chat' && route.productFeature !== 'text_reasoning')) {
          throw new Error('art_direction_route_unavailable');
        }
        return classifier.planArtDirection({
          candidateId: featureCandidateId(route.modelId, route.profileId, route.productFeature),
          productFeature: route.productFeature, input: request.input, signal: request.signal, timeoutMs: request.timeoutMs
        });
      } } : {}),
      ...(mutationRenderer ? { mutation: { renderPreview: mutationRenderer, canWrite: async () => {
        const active = dependencies.getSession();
        return active?.projectId === session.projectId && active.rootDirectory === session.rootDirectory;
      } } } : {}),
      generatePptx: {
        compiler: new PlatformDocumentDraftCompiler(),
        executor: new PlatformDocumentGenerationExecutor(new DocumentGenerationRunner({
          rootDirectory: session.rootDirectory, projectId: session.projectId,
          renderPreview: createConfiguredOfficeRenderAdapter(), requireRenderForPpt: true
        })),
        revalidateAuthorization: async context => {
          const active = dependencies.getSession();
          const responseId = context.projectContext.responseExecutionId;
          const indexedRunId = typeof responseId === 'string' ? ownedRunsByResponse.get(responseId) : undefined;
          if (indexedRunId) await sessionService.assertExecutionOwnershipIfPresent(indexedRunId);
          else {
            const child = await new JsonDocumentTaskRuntimeRepository(storage, session.projectId).get(toDocumentTaskRuntimeId(context.taskContext.taskId));
            if (typeof responseId === 'string' && child?.executionId !== responseId) return false;
            const run = child ? await agentRuns.findByResponseExecutionId(toConversationResponseExecutionId(child.executionId)) : undefined;
            if (run) await sessionService.assertExecutionOwnershipIfPresent(run.id);
          }
          return !context.abortSignal.aborted && context.authorization.generationAuthorization === 'approved' &&
            active?.projectId === session.projectId && active.rootDirectory === session.rootDirectory;
        }
      },
      getCurrentProjectId: () => {
        const active = dependencies.getSession();
        return active?.projectId === session.projectId && active.rootDirectory === session.rootDirectory ? active.projectId : undefined;
      }
    });
    const workflowService = new ConversationWorkflowService(
      new JsonConversationWorkflowRepository(storage, session.projectId, executionTimestamp),
      new ConversationIntentOrchestrator({
        classifier,
        classifierTimeoutMs: conversationSemanticLimits.timeoutMs,
        classifierTimeoutGraceMs: conversationSemanticLimits.timeoutGraceMs,
        // Provider availability must never switch new production tasks back to
        // legacy business routing. Saved workflows remain readable offline.
        routingMode: 'agent_first'
      }),
      executionTimestamp, undefined, undefined, createPresentationWorkflowScope({ rootDirectory: session.rootDirectory, projectId: session.projectId })
    );
    const retrieval = new RagRetrievalService({
      rootDirectory: session.rootDirectory,
      projectId: session.projectId
    });
    const webTransport = dependencies.webResearch?.transport ?? new UnconfiguredWebSearchTransport();
    const webResearchService = new ConversationWebResearchService(
      new ControlledWebResearchService({ transport: webTransport }),
      dependencies.webResearch?.configuration ?? {
        enabled: false,
        allowedDomains: [],
        outboundSummary: '联网服务尚未配置，不会外发内容',
        allowMixedQueries: false
      },
      now
    );
    const nativeSearch = new ConversationNativeSearch(storage, providerRegistry, service, now, retrieval);
    const candidateService = new ProviderFeatureCandidateService(
      new ProjectConversationResponseSubjectResolver(
        projectConversations,
        responseDrafts,
        contextRepository,
        documentPages,
        attachments,
        documentTools
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
    const ownedResponseIds = new Set<string>();
    continuationRuntime = new ConversationAgentContinuationRuntime({ storage, projectId: session.projectId, sessions, sessionService,
      agentRuns, conversations: service, now: executionTimestamp, classifier, supportsGeneration: true, supportsMutation: Boolean(mutationRenderer),
      isCurrent: () => { const active = dependencies.getSession(); return active?.projectId === session.projectId && active.rootDirectory === session.rootDirectory; },
      replayExecution: async id => {
        const execution = await responseLifecycle.readModel(toConversationResponseExecutionId(id));
        return { execution, conversation: { ...toConversationDto(await service.get(toConversationId(execution.conversationId))),
          agentSessions: await continuationRuntime.list(execution.conversationId) } };
      },
      cancelExecution: async id => { await executionCoordinator.cancel(toConversationResponseExecutionId(id)); } });
    const agentRuntimeRepository = new JsonConversationAgentRuntimeRepository(storage, session.projectId, now);
    const agentRuntime = new ConversationAgentRuntimeService({ repository: agentRuntimeRepository, now,
      executionOwnershipGuard: runId => sessionService.assertExecutionOwnershipIfPresent(runId),
      nextEventId: () => `run-event-${randomUUID()}`, hash: serialized => createHash('sha256').update(serialized).digest('hex') });
    const projectVerifiedDocumentArtifact = async (responseExecution: ConversationResponseExecutionV1,
      workIds: readonly WorkId[], completionRequired = false) => {
      const tasks = (await documentTools.collectResponseFacts(responseExecution.id)).documentTasks;
      const verified = tasks.filter(task => task.readBackConfirmed && task.registeredWork &&
        task.runtime.projectId === session.projectId && task.runtime.conversationId === responseExecution.snapshot.conversationId &&
        task.runtime.sourceMessageId === responseExecution.snapshot.userMessageId && task.runtime.executionId === responseExecution.id &&
        task.registeredWork.sourceTaskRuntimeId === task.runtime.id && task.registeredWork.projectId === session.projectId);
      if (completionRequired && workIds.some(id => !verified.some(task => task.registeredWork!.id === id))) {
        throw new Error('completion_artifact_changed');
      }
      const deliveredWorkId = workIds.filter(id => verified.some(task => task.registeredWork!.id === id)).at(-1);
      if (!deliveredWorkId || !['completed', 'failed', 'cancelled', 'interrupted'].includes(responseExecution.state)) return;
      let document: Awaited<ReturnType<RegisteredPresentationReader['read']>>;
      try {
        // Re-read the current local file and its Hash. A saved Work alone is not
        // authority to expose a usable retained artifact after a failed reply.
        document = await new RegisteredPresentationReader({ rootDirectory: session.rootDirectory, projectId: session.projectId })
          .read(deliveredWorkId);
      } catch (error) {
        if (completionRequired) throw error;
        return;
      }
      const task = verified.find(item => item.registeredWork!.id === deliveredWorkId)!;
      const receipt = [...task.runtime.observations].reverse().find(item => item.ok &&
        item.data?.registeredWorkId === deliveredWorkId);
      // Only a successful Host publication receipt can supply the page goal.
      const goal = receipt?.data?.planningTargetTotalPages;
      const target = Number.isSafeInteger(goal) && Number(goal) > 0 && Number(goal) <= presentationDocumentPageLimits.maximumPages ? Number(goal) : undefined;
      const result = { workId: document.work.id, fileName: document.fileName, sizeBytes: document.file.sizeBytes!, kind: 'ppt' as const };
      const retained = { ...result, actualPageCount: document.pages.length,
        ...(target === undefined ? {} : { planningTargetTotalPages: target }) };
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const conversation = await projectConversations.get(responseExecution.snapshot.conversationId);
        const assistant = conversation?.messages.find(message => message.id === responseExecution.snapshot.assistantMessageId);
        if (!conversation || !assistant) throw new Error('completion_assistant_unavailable');
        if (conversation.status !== 'active') return;
        const active = dependencies.getSession();
        if (active?.projectId !== session.projectId || active.rootDirectory !== session.rootDirectory) {
          if (completionRequired) throw new Error('completion_artifact_changed');
          return;
        }
        const completed = responseExecution.state === 'completed' && assistant.state === 'completed';
        if (!completed && !['failed', 'cancelled'].includes(assistant.state)) return;
        if (completed ? assistant.documentResult?.workId === result.workId
          : assistant.retainedDocumentResult?.workId === result.workId) return;
        try {
          const updatedAt = toIsoTimestamp([now(), conversation.updatedAt, assistant.updatedAt].sort().at(-1)!);
          await projectConversations.save(completed
            ? attachDocumentResultToMessage(conversation, assistant.id, result, updatedAt)
            : attachRetainedDocumentResultToMessage(conversation, assistant.id, retained, updatedAt), conversation.revision);
          return;
        } catch (error) {
          if (!(error instanceof ConversationRevisionConflictError) || attempt === 3) throw error;
        }
      }
    };
    let completionAcceptances: ProjectSubmissionAcceptanceStore | undefined;
    const completionJournal = new JsonConversationCompletionJournal(storage, session.projectId, executionTimestamp);
    const completion = new ConversationCompletionCoordinator({ agentRuns, responseExecutions,
      documentTasks: new JsonDocumentTaskRuntimeRepository(storage, session.projectId),
      journal: completionJournal, now: executionTimestamp,
      reconciliationOwnershipGuard: async id => {
        const run = await agentRuns.findByResponseExecutionId(id);
        const response = run ? undefined : await responseExecutions.get(id);
        const roots = (await sessions.list()).filter(task => run && task.childSegments.some(segment => segment.runId === run.id) ||
          task.childSegments.some(segment => segment.responseExecutionId === id) || !run && response && task.projectId === response.projectId &&
          task.conversationId === response.snapshot.conversationId && task.childSegments.some(segment => segment.sourceMessageId === response.snapshot.userMessageId));
        if (roots.length > 1) throw new ConversationAgentSessionError('scope_mismatch');
        const root = roots[0];
        if (!root?.lease || root.lease.expiresAt <= executionNow()) return;
        if (root.lease.ownerId !== sessionOwnerId) throw new ConversationAgentSessionError('lease_lost');
        await sessionService.assertSessionOwnership(root.id);
      },
      collectFacts: async (execution) => {
        const facts = await documentTools.collectResponseFacts(execution.id);
        const canonical = await agentRuntime.findByResponse(execution.id);
        const run = await agentRuns.findByResponseExecutionId(execution.id);
        const root = run ? await sessions.findByRunId(run.id) : undefined;
        const pinnedSources = new Set(root?.inputReferences.filter(reference => reference.kind === 'message').map(reference => reference.id));
        const plannedDocument = root && (await workflowService.list(root.conversationId)).some(workflow =>
          pinnedSources.has(workflow.sourceMessageId) && workflow.plan.kind === 'document' && workflow.plan.documentKind === 'ppt' &&
          ['ready', 'executing', 'completed'].includes(workflow.status));
        const acceptance = await completionAcceptances?.getByInvocationAttemptId(execution.providerInvocationAttemptId);
        const events = await responseExecutions.listEvents(execution.id);
        return { ...facts,
          unknownResult: facts.unknownResult || canonical?.runtime.status === 'needs_reconciliation' || acceptance?.intent.status === 'unknown_outcome' || execution.state === 'interrupted' ||
            events.some(event => /tool_loop_unknown_result|submission_outcome_unknown/u.test(event.safeCode ?? '')),
          documentTasks: facts.documentTasks.map(task => ({ ...task,
            required: task.required || Boolean(plannedDocument && task.runtime.operation === 'create'),
            // This host receipt already persisted the verified public artifact reference.
            // The completion WAL owns the dependent assistant/link projection below.
            deliveryConfirmed: task.deliveryConfirmed || Boolean(task.readBackConfirmed && task.registeredWork &&
              task.runtime.observations.some(item => item.ok && item.data?.registeredWorkId === task.registeredWork!.id)) })) };
      },
      projectTerminal: async ({ run, responseExecution, decision, intent }) => {
        await agentRuntime.recordRegisteredWorks(responseExecution.id, decision.registeredWorkIds);
        await projectVerifiedDocumentArtifact(responseExecution, decision.registeredWorkIds, decision.status === 'completed');
        if (['completed', 'failed', 'cancelled'].includes(decision.status)) {
          await workflowService.finishExecution(responseExecution.id, decision.status as 'completed' | 'failed' | 'cancelled');
        }
        if (intent.freezeOrigin === 'local_projection' && run.reconciliationAcknowledgement?.kind === 'closed_without_replay' && ['completed', 'failed', 'cancelled'].includes(run.status)) {
          await sessionService.settleVerifiedLocalProjectionAfterChild(run);
        } else if (run.reconciliationAcknowledgement?.kind === 'closed_without_replay' && run.status === 'cancelled') {
          await sessionService.acknowledgeReconciliationAfterChild(run);
        }
      } });
    const settleOwnedExecution = async (id: ConversationResponseExecutionId, unknownResult = false,
      counters?: { readonly toolCallsUsed: number; readonly costUnitsUsed: number }, reason?: ExecutionStopReason) => {
      if (counters) await agentRuntime.recordBudget(id, counters);
      await agentRuntime.finish(id, unknownResult ? 'unknown_result' : reason);
      const settled = await completion.settle(id, unknownResult ? { unknownResult: true } : {});
      if (settled && ['completed', 'failed', 'cancelled'].includes(settled.run.status)) await agentRuntime.settle(id);
      const canonical = await agentRuntime.findByResponse(id);
      const run = settled?.run ?? await agentRuns.findByResponseExecutionId(id);
      const root = run ? await sessions.findByRunId(run.id) : undefined;
      if (root && run) {
        const works = settled?.intent?.decision.registeredWorkIds ?? canonical?.runtime.registeredWorkIds ?? [];
        if (works.length) await sessionService.recordVerifiedWorks(run.id, works);
        if (['closed', 'expired'].includes(root.status) && !root.reconciliationAcknowledgement && (unknownResult || settled?.run.status === 'needs_reconciliation' || canonical?.runtime.status === 'needs_reconciliation')) {
          await sessionService.freezeObserved({ sessionId: root.id, registeredWorkIds: works });
        }
        if (root.status === 'active') {
          try {
            await sessionService.assertExecutionOwnership(run.id);
            const budget = canonical?.runtime.budget;
            await sessionService.recordSegment({ runId: run.id, toolCallsUsed: budget?.toolCallsUsed ?? counters?.toolCallsUsed ?? 0,
              costUnitsUsed: budget?.costUnitsUsed ?? counters?.costUnitsUsed ?? 0,
              toolAttemptsUsed: budget?.toolAttemptsUsed ?? canonical?.runtime.toolCalls.length ?? counters?.toolCallsUsed ?? 0,
              registeredWorkIds: works });
            if (unknownResult || settled?.run.status === 'needs_reconciliation' || canonical?.runtime.status === 'needs_reconciliation') {
              await sessionService.freeze(root.id, works);
            } else if (settled && ['completed', 'failed', 'cancelled'].includes(settled.run.status)) {
              await sessionService.settle(root.id, settled.run.status as 'completed' | 'failed' | 'cancelled');
            }
          } catch (error) {
            // Loss of ownership cannot grant a new execution or overwrite a live successor.
            // Durable child facts remain available to the fenced recovery coordinator.
            if (unknownResult || settled?.run.status === 'needs_reconciliation' || canonical?.runtime.status === 'needs_reconciliation') {
              const observed = await sessions.get(root.id);
              if (observed && (!observed.lease || observed.lease.expiresAt <= executionNow())) {
                await sessionService.freezeObserved({ sessionId: observed.id, expectedRevision: observed.revision,
                  registeredWorkIds: works }).catch(freezeError => dependencies.onError?.(freezeError));
              }
            }
            dependencies.onError?.(error);
          }
        }
        continuationRuntime.discardPreparation(root.id);
      }
    };
    // Artifact creation may fail after acquiring a document session but before
    // dispatch owns a Provider handle. Those paths must revoke the same session
    // and enter the same bounded, durable settlement as normal handle completion.
    const closeAndSettleOwnedExecution = async (id: ConversationResponseExecutionId, unknownResult = false,
      reason?: ExecutionStopReason) => {
      const toolSession = await documentTools.forExecution({ responseExecutionId: id });
      const stopReason = toolSession?.executionBudget?.stopReason ?? reason;
      const counters = toolSession?.executionBudget?.snapshot(stopReason ?? 'cancelled');
      let known = true;
      if (toolSession) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        let closed: Promise<boolean>;
        try { closed = toolSession.close().then(() => true, () => false); }
        catch { closed = Promise.resolve(false); }
        try {
          known = await Promise.race([closed, new Promise<boolean>(resolve => {
            timer = setTimeout(() => resolve(false), 5_000);
          })]);
        } finally { clearTimeout(timer); }
      } else if (executionCoordinator.has(id)) {
        // A plain response has no document budget whose disposal can abort the
        // Provider. Revoke its actual handle explicitly and bound the receipt.
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          known = await Promise.race([executionCoordinator.cancel(id).catch(() => false),
            new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 5_000); })]);
        } finally { clearTimeout(timer); }
      }
      await settleOwnedExecution(id, unknownResult || !known, counters, stopReason);
    };
    // These projections only inspect and repair persisted local records. Each
    // write is gated by the root recovery owner before the older scans run.
    const recoverLocal = async (
      canResponse: (id: string) => Promise<boolean>,
      canRun: (id: ConversationAgentRunId) => Promise<boolean>,
      repairKnownLocalProjection = false
    ) => {
        await interruptOrphanedConversationResponses(responseLifecycle, projectConversations, now, canResponse);
        await settleRecoverableConversationDocuments(workflowService, responseExecutions, projectConversations, now, canResponse);
        await workflowService.recoverInterruptedExecutions(async workflow => {
          if (workflow.executionId) return canResponse(workflow.executionId);
          const owners = (await sessions.list()).filter(task => task.conversationId === workflow.conversationId && task.sourceMessageId === workflow.sourceMessageId);
          if (owners.length > 1) return false;
          return owners[0] ? canRun(owners[0].id) : true;
        });
        await agentRuntime.recoverInterrupted(canRun);
        // No old in-memory tool owner survives restart. Settle only persisted
        // local facts; ambiguous calls are frozen by Runtime recovery, never replayed.
        for (const run of await agentRuns.list()) {
          if (!run.responseExecutionId || ['completed', 'failed', 'cancelled'].includes(run.status)) continue;
          if (!await canRun(run.id) || !await canResponse(run.responseExecutionId)) continue;
          const childFacts = await documentTools.collectResponseFacts(run.responseExecutionId);
          for (const child of childFacts.documentTasks) {
            if (!['planning', 'running', 'paused'].includes(child.runtime.status)) continue;
            const taskRecovery = new DocumentTaskRuntimeService(new JsonDocumentTaskRuntimeRepository(storage, session.projectId),
              { now: () => [now(), child.runtime.updatedAt].sort().at(-1)!, validateBindings: async () => true });
            const scope = { id: child.runtime.id, projectId: child.runtime.projectId,
              conversationId: child.runtime.conversationId, executionId: child.runtime.executionId };
            const recovered = await taskRecovery.recover(scope);
            if (recovered.status === 'needs_reconciliation') continue;
            if (child.readBackConfirmed && child.runtime.operation === 'analyze' && child.active) await taskRecovery.completeRead(scope);
            else if (child.readBackConfirmed && child.registeredWork) await taskRecovery.complete(scope, child.registeredWork.id);
          }
        }
        for (const snapshot of await agentRuntimeRepository.list()) {
          const runtime = snapshot.runtime;
          if (!await canRun(runtime.runId)) continue;
          await replayCanonicalProductionEvents({ rootDirectory: session.rootDirectory, projectId: session.projectId,
            conversationId: runtime.conversationId, sourceMessageId: runtime.sourceMessageId, traceId: runtime.sourceMessageId },
          agentRuntime.canonicalEvents(runtime.runId));
        }
        await completion.reconcilePending(canResponse);
        for (const run of await agentRuns.list()) {
          if (!run.responseExecutionId) continue;
          if (!await canRun(run.id) || !await canResponse(run.responseExecutionId)) continue;
          const pending = await completion.inspect(run.responseExecutionId);
          if (repairKnownLocalProjection && pending?.intent?.freezeOrigin === 'local_projection') {
            await completion.reconcile(run.responseExecutionId);
          } else if (!['completed', 'failed', 'cancelled'].includes(run.status)) await completion.settle(run.responseExecutionId);
          const recovered = await completion.inspect(run.responseExecutionId);
          // Older failed responses may predate retained artifact cards. Backfill
          // only a verified local projection; keep the saved Run/WAL untouched.
          if (recovered?.intent && ['failed', 'cancelled', 'needs_reconciliation'].includes(recovered.run.status)) {
            const execution = await responseExecutions.get(run.responseExecutionId);
            if (execution) await projectVerifiedDocumentArtifact(execution, recovered.intent.decision.registeredWorkIds);
          }
          if (recovered && ['completed', 'failed', 'cancelled'].includes(recovered.run.status) &&
            recovered.intent?.stage !== 'needs_reconciliation') await agentRuntime.settle(run.responseExecutionId);
        }
    };
    const recovery = new ConversationAgentRecoveryRuntime({ rootDirectory: session.rootDirectory,
      projectId: session.projectId, storage, sessions, sessionService, runtimeRepository: agentRuntimeRepository,
      agentRuns, responses: responseExecutions, completionJournal, documentTools, now: executionNow,
      recoverLocal: async input => {
        const responseIds = new Set<string>(input.responseExecutionIds);
        const runIds = new Set(input.session.childSegments.map(segment => segment.runId));
        await recoverLocal(async id => { await input.claim.assertCurrent(); return responseIds.has(id); },
          async id => { await input.claim.assertCurrent(); return runIds.has(id); }, true);
      },
      onWaitingChallenge: input => continuationRuntime.cacheChallenge(input),
      onSafeContinuation: async input => {
        // Missing output is insufficient evidence. Recheck all primary model,
        // tool, mutation and Work facts while this owner still holds its lease.
        await input.claim.assertCurrent();
        const facts = await recovery.inspectSession(input.session.id);
        if (!facts.noEffectProven || facts.modelBoundary !== 'not_started' || facts.mutationJournal !== 'none' || facts.registeredWorks.length) {
          throw new Error('recovery_no_effect_proof_lost');
        }
        for (const id of input.responseExecutionIds) {
          await input.claim.assertCurrent();
          const execution = await responseExecutions.get(id);
          if (!execution) throw new Error('recovery_response_missing');
          const acceptance = await completionAcceptances?.getByInvocationAttemptId(execution.providerInvocationAttemptId);
          if (acceptance?.intent.status === 'authorization_claimed') {
            // Only the primary acceptance supplies this claim identity. A
            // started or unidentifiable ledger claim cannot be refunded or
            // turned into a continuation by missing HTTP/WAL output.
            if (acceptance.subjectArtifacts.kind !== 'conversation' || acceptance.subjectArtifacts.responseExecution.id !== id ||
              acceptance.intent.projectId !== input.session.projectId) throw new Error('recovery_authorization_scope_invalid');
            try {
              await input.claim.assertCurrent();
              const claim = await authorization?.getClaim?.(acceptance.intent.authorizationClaimId);
              if (!claim || !['claimed', 'released_before_request'].includes(claim.state) || !authorization?.releaseBeforeRequest) {
                throw new Error('recovery_authorization_outcome_unknown');
              }
              await input.claim.assertCurrent();
              await authorization.releaseBeforeRequest(acceptance.intent.authorizationClaimId, executionTimestamp());
              await input.claim.assertCurrent();
              const occurredAt = toIsoTimestamp([executionTimestamp(), acceptance.intent.updatedAt].sort().at(-1)!);
              await completionAcceptances!.advance({ intent: transitionSubmissionIntent(acceptance.intent, 'failed_before_submission', occurredAt,
                { safeCode: 'authorization.released_during_recovery' }),
                invocationEvent: createProviderInvocationEvent({ id: `conversation-recovery-release-${randomUUID()}` as never,
                  invocationAttemptId: acceptance.invocationAttempt.id, sequence: acceptance.invocationEvents.length + 1,
                  type: 'submission_failed_before_request', safeCode: 'authorization.released_during_recovery', occurredAt }) });
              await input.claim.assertCurrent();
            } catch (error) {
              await input.claim.assertCurrent();
              await completion.settle(id, { unknownResult: true });
              throw error;
            }
          }
          if (['pending', 'streaming'].includes(execution.state)) {
            const event = await responseLifecycle.failDeferredPublish(id, 'conversation.recovery_prepared_not_submitted');
            await input.claim.assertCurrent();
            await projectInterruptedAssistant(projectConversations, execution.snapshot.conversationId, execution.snapshot.assistantMessageId, now);
            await responseLifecycle.publish(event);
          }
          await input.claim.assertCurrent();
          const result = await completion.settle(id);
          if (result && result.run.status !== 'failed' && result.run.status !== 'cancelled') throw new Error('recovery_prepared_retirement_failed');
          await input.claim.assertCurrent();
        }
      },
      onError: error => dependencies.onError?.(error) });
    // Root ownership/classification precedes legacy recovery, so a live foreign
    // owner or an explicit no-effect continuation can never be swept up by it.
    const responseRecovery = recovery.recover()
      .then(() => recoverLocal(id => recovery.canRecoverResponse(id), id => recovery.canRecoverRun(id)))
      .then(() => undefined);
    // Recovery may finish before any operation waits for ready. Observe a
    // failure immediately, while preserving the rejected barrier for writes.
    void responseRecovery.catch((error: unknown) => dependencies.onError?.(error));
    let lazyRecoveryTail: Promise<void> = Promise.resolve();
    const refreshRecovery = (scope: { readonly conversationId?: string; readonly responseExecutionId?: string }): Promise<void> => {
      const operation = lazyRecoveryTail.then(async () => {
        await responseRecovery;
        const active = dependencies.getSession();
        if (active?.projectId !== session.projectId || active.rootDirectory !== session.rootDirectory) throw new ConversationAgentSessionError('scope_mismatch');
        // This Host already owns the actual handle, which the lazy path would
        // leave alone. All model/tool effect guards still read the primary lease.
        if (scope.responseExecutionId && ownedResponseIds.has(scope.responseExecutionId) &&
          executionCoordinator.has(toConversationResponseExecutionId(scope.responseExecutionId))) return;
        const execution = scope.responseExecutionId ? await responseExecutions.get(toConversationResponseExecutionId(scope.responseExecutionId)) : undefined;
        if (scope.responseExecutionId && (!execution || execution.projectId !== session.projectId)) return;
        const scopedRun = execution ? await agentRuns.findByResponseExecutionId(execution.id) : undefined;
        const conversationId = scope.conversationId ?? execution?.snapshot.conversationId;
        if (!conversationId || scope.conversationId && execution && execution.snapshot.conversationId !== scope.conversationId) return;
        const now = executionNow();
        const eligible = (await sessions.list()).filter(root => root.projectId === session.projectId && root.conversationId === conversationId &&
          root.status === 'active' && root.lease && root.lease.expiresAt <= now &&
          (root.lease.ownerId !== sessionOwnerId || !root.childSegments.some(segment => segment.responseExecutionId &&
            executionCoordinator.has(segment.responseExecutionId))) &&
          (!execution || root.childSegments.some(segment => segment.responseExecutionId === execution.id || scopedRun && segment.runId === scopedRun.id ||
            !scopedRun && segment.sourceMessageId === execution.snapshot.userMessageId)));
        if (!eligible.length) return;
        // Only the selected scope is investigated. The recovery claim reads the
        // lease again, so a live owner renewed after this read remains untouched.
        const rootIds = eligible.map(root => root.id);
        await recovery.recoverSpecificRootIds(rootIds);
        const refreshed = await Promise.all(rootIds.map(id => sessions.get(id)));
        const runIds = new Set(refreshed.flatMap(root => root?.childSegments.map(segment => segment.runId) ?? []));
        const responseIds = new Set<string>(refreshed.flatMap(root => root?.childSegments.flatMap(segment => segment.responseExecutionId ? [segment.responseExecutionId] : []) ?? []));
        for (const run of await agentRuns.list(toConversationId(conversationId))) {
          if (runIds.has(run.id) && run.responseExecutionId) responseIds.add(run.responseExecutionId);
        }
        await recoverLocal(async id => responseIds.has(id) && await recovery.canRecoverResponse(id),
          async id => runIds.has(id) && await recovery.canRecoverRun(id));
      });
      lazyRecoveryTail = operation.catch(() => undefined); return operation;
    };
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
      agentRuns,
      completion,
      refreshRecovery,
      continuations: { ...continuationRuntime.controller, validate: async input => {
        await refreshRecovery({ conversationId: input.conversation.id });
        // Published text can precede local completion and root receipts. Await the
        // existing bounded owner barrier before judging a new command's eligibility.
        await executionCoordinator.waitForCompletedOperations(async id => {
          const current = await responseLifecycle.readModel(id);
          return current.conversationId === input.conversation.id && ['completed', 'failed', 'cancelled', 'interrupted'].includes(current.state);
        });
        return continuationRuntime.controller.validate?.(input);
      } },
      attachments,
      documentPages,
      documentTools,
      nativeSearch,
      ready: responseRecovery
    };
    if (canSubmit && textSubmission && authorization) {
      const acceptances = new ProjectSubmissionAcceptanceStore(
        new ProjectMetadataUnitOfWork(storage, now)
      );
      completionAcceptances = acceptances;
      const journal = new SubmissionIntentJournal(storage, now);
      const startupSignals = new Map<string, AbortSignal>();
      const artifacts = new ConversationResponseArtifactFactory({
        nativeSearch,
        conversations: projectConversations,
        drafts: responseDrafts,
        contexts: contextRepository,
        executions: responseExecutions,
        attachments,
        documentPages,
        documentTools,
        executionCoordinator,
        bindExecutionOwnership: async id => {
          const run = await completion.bindExecution(toConversationResponseExecutionId(id));
          if (run && await sessions.findByRunId(run.id)) await sessionService.bindExecution(run.id, toConversationResponseExecutionId(id));
          if (run) ownedRunsByResponse.set(id, run.id);
          ownedResponseIds.add(id);
        },
        bindDocumentOwnership: async id => {
          const responseId = toConversationResponseExecutionId(id);
          const run = await completion.bindTasks(responseId);
          if (!run) return;
          const toolSession = await documentTools.forExecution({ responseExecutionId: id });
          const inherited = await continuationRuntime.executionContext(id);
          const startedAt = Date.now();
          await agentRuntime.open(run, toolSession?.executionBudget?.policy ?? inherited?.policy ?? { startedAt, deadlineAt: startedAt + 900_000,
            maxToolCalls: 64, budgetUnits: 1_000_000 });
          bindProductionTraceCanonicalEvents(agentRuntime.canonicalEvents(run.id));
        },
        getStartupSignal: draftId => startupSignals.get(draftId),
        onPreparationFailed: async (id, error) => {
          const executionId = toConversationResponseExecutionId(id);
          const current = await responseLifecycle.readModel(executionId);
          const cancelled = error instanceof Error && error.name === 'AbortError' ||
            error instanceof ExecutionBudgetError && error.code === 'cancelled';
          const event = cancelled
            ? await responseLifecycle.confirmCancelledDeferredPublish(executionId)
            : await responseLifecycle.failDeferredPublish(executionId,
              error instanceof ExecutionBudgetError ? `conversation.${error.scope}_${error.code}` : 'conversation.prepare_failed');
          for (let attempt = 0; attempt < 4; attempt += 1) {
            const conversation = await projectConversations.get(toConversationId(current.conversationId));
            if (!conversation) break;
            try {
              await projectConversations.save(cancelled
                ? cancelAssistantMessage(conversation, toMessageId(current.assistantMessageId), toIsoTimestamp(now()))
                : failAssistantMessage(conversation, toMessageId(current.assistantMessageId), 'unavailable', toIsoTimestamp(now())), conversation.revision);
              break;
            } catch (saveError) {
              if (!(saveError instanceof ConversationRevisionConflictError) || attempt === 3) throw saveError;
            }
          }
          await workflowService.finishExecution(executionId, cancelled ? 'cancelled' : 'failed');
          await responseLifecycle.publish(event);
          await closeAndSettleOwnedExecution(executionId, false,
            error instanceof ExecutionBudgetError ? error.code : cancelled ? 'cancelled' : undefined);
        },
        nextMessageId: () => conversationIds.nextMessageId(),
        now
      });
      const dispatch = createConversationTextDispatchBridge({
        nativeSearch,
        ...textSubmission,
        documentToolCalling: documentTools,
        providerRegistry,
        providerPackages,
        lifecycle: responseLifecycle,
        conversations: projectConversations,
        coordinator: executionCoordinator,
        settleExecution: settleOwnedExecution,
        executionLifecycle: async id => {
          const snapshot = await agentRuntime.findByResponse(id);
          return snapshot ? agentRuntime.providerLifecycle(snapshot.runtime.runId) : undefined;
        },
        executionSignal: async id => {
          const run = await agentRuns.findByResponseExecutionId(id);
          return run ? sessionService.signalForRun(run.id) : undefined;
        },
        usage: new JsonProviderUsageObservationRepository(storage),
        terminalObserver: createConversationTerminalObserver(
          acceptances,
          authorization as RuntimeAuthorizationOrchestrationPort,
          workflowService,
          completion,
          invocationRoutes,
          invocations,
          now,
          responseFinalizers,
          dependencies.onError
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
        if (input.subject.kind !== 'conversation_response_draft') throw new TypeError('Response start requires a conversation draft');
        const draftId = input.subject.responseDraftId;
        if (input.signal) startupSignals.set(draftId, input.signal);
        let started: Awaited<ReturnType<typeof orchestrator.beginConversationResponse>>;
        try { started = await orchestrator.beginConversationResponse(input); }
        finally { if (startupSignals.get(draftId) === input.signal) startupSignals.delete(draftId); }
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
        let responseFinalizer: Promise<void>;
        responseFinalizer = started.completion.then(async () => {
          try {
            const completed = await acceptances.get(submissionIntentId);
            if (completed) {
              await persistConversationCallRecordFacts({
                acceptance: completed,
                routes: invocationRoutes,
                invocations
              });
              if (completed.subjectArtifacts.kind === 'conversation' && !executionCoordinator.has(completed.subjectArtifacts.responseExecution.id)) {
                await completion.settle(completed.subjectArtifacts.responseExecution.id,
                  completed.intent.status === 'unknown_outcome' ? { unknownResult: true } : {});
              }
            }
          } catch (error) {
            dependencies.onError?.(error);
          }
        }, async (error: unknown) => {
          dependencies.onError?.(error);
          try {
            const current = await responseLifecycle.readModel(executionId);
            if (current.state !== 'pending' && current.state !== 'streaming') {
              await closeAndSettleOwnedExecution(executionId,
                error instanceof SubmissionOrchestrationError && error.code === 'submission_outcome_unknown',
                error instanceof ExecutionBudgetError ? error.code : current.state === 'cancelled' ? 'cancelled' : undefined);
              return;
            }
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
            await workflowService.finishExecution(executionId, 'failed');
            await responseLifecycle.publish(event);
            const failed = await acceptances.get(submissionIntentId);
            if (failed) {
              await persistConversationCallRecordFacts({
                acceptance: failed,
                routes: invocationRoutes,
                invocations
              });
            }
            await closeAndSettleOwnedExecution(executionId,
              error instanceof SubmissionOrchestrationError && error.code === 'submission_outcome_unknown',
              error instanceof ExecutionBudgetError ? error.code : undefined);
          } catch (terminalError) {
            dependencies.onError?.(terminalError);
          }
        }).finally(() => responseFinalizers.delete(responseFinalizer));
        responseFinalizers.add(responseFinalizer);
        return responseLifecycle.readModel(executionId);
      };
    }
    cached = {
      projectId: session.projectId,
      rootDirectory: session.rootDirectory,
      conversations: new ConversationController({
        service,
        getSession: dependencies.getSession,
        refreshRecovery: conversationId => refreshRecovery({ conversationId }),
        readAgentSessions: async conversationId => {
          await refreshRecovery({ conversationId }); return continuationRuntime.list(conversationId);
        },
        readParentRuns: async conversationId => {
          await refreshRecovery({ conversationId });
          const summaries = [];
          for (const run of await agentRuns.list(toConversationId(conversationId))) {
            if (!run.responseExecutionId) continue;
            const snapshot = await completion.inspect(run.responseExecutionId);
            if (snapshot) summaries.push(projectConversationParentRun(snapshot));
          }
          return summaries;
        },
        canStartNewResponse: conversationId => completion.canStartNewResponse(toConversationId(conversationId)),
        canEditUserMessage: async (conversationId, messageId) =>
          !(await agentRuns.list(toConversationId(conversationId))).some(run => run.sourceMessageId === messageId &&
            (run.status === 'needs_reconciliation' || run.reconciliationReason !== undefined)),
        projectRequired: true,
        storageScope: 'current_project',
        onError: dependencies.onError
      }),
      conversationRepository: projectConversations,
      agentRuntime,
      sessionService,
      canInterruptResponse: async id => {
        const run = await agentRuns.findByResponseExecutionId(id);
        const task = run ? await sessions.findByRunId(run.id) : undefined;
        return !task || ownedResponseIds.has(id) && (!task.lease || task.lease.ownerId === sessionOwnerId);
      },
      contextService,
      workflowService,
      agentRuns,
      attachments,
      documentTools,
      webResearch: {
        conversationService: new ConversationApplicationService(
          projectConversations,
          conversationIds,
          now
        ),
        workflowService,
        research: webResearchService,
        nativeSearch,
        local: retrieval
      },
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
      const runtime = session ? getProjectRuntime(session) : undefined;
      await runtime?.responses.ready;
      const requested = chatContextRequestParsers.conversationId(request);
      // The UI refresh triggered by a terminal stream event must observe the
      // owned document close and retained artifact projection from that handle.
      await runtime?.responses.executionCoordinator.waitForCompletedOperations(async id => {
        const execution = await runtime.responses.executions.readModel(id);
        return execution.conversationId === requested.conversationId && ['completed', 'failed', 'cancelled', 'interrupted'].includes(execution.state);
      });
      const project = runtime?.conversations;
      if (project) {
        const result = await project.get(request);
        if (result.ok) return { ok: true, value: await verifyRetainedDocumentArtifacts(result.value, {
          rootDirectory: session!.rootDirectory, projectId: session!.projectId,
          isCurrent: () => { const current = dependencies.getSession(); return current?.projectId === session!.projectId && current.rootDirectory === session!.rootDirectory; }
        }) };
        if (result.error.code !== 'conversation_not_found') return result;
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
      if (session) await getProjectRuntime(session).responses.ready;
      const projectItems = session
        ? await getProjectRuntime(session).conversations.list(request)
        : { ok: true as const, value: [] };
      if (!projectItems.ok) return projectItems;
      const verifiedItems = session ? await Promise.all(projectItems.value.map(item => verifyRetainedDocumentArtifacts(item, {
        rootDirectory: session.rootDirectory, projectId: session.projectId,
        isCurrent: () => { const current = dependencies.getSession(); return current?.projectId === session.projectId && current.rootDirectory === session.rootDirectory; }
      }))) : projectItems.value;
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
        value: [...verifiedItems, ...legacyItems].sort((left, right) =>
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
        workflowService: runtime.workflowService,
        attachments: runtime.attachments,
        ready: runtime.responses.ready
      };
    }
  });
  const webResearch = new ConversationWebResearchController({
    getSession: dependencies.getSession,
    onError: dependencies.onError,
    getRuntime(session): ConversationWebResearchControllerRuntime {
      return getProjectRuntime(session).webResearch;
    }
  });
  const responses = new ConversationResponseController({
    getSession: dependencies.getSession,
    getRuntime: (session) => getProjectRuntime(session).responses,
    nextResponseDraftId: () => `response-draft-${randomUUID()}`,
    nextAgentRunId: () => `agent-run-${randomUUID()}`,
    now,
    onError: dependencies.onError
  });
  return {
    conversations,
    responses,
    projectContexts,
    workflows,
    webResearch,
    interruptActiveResponses: async () => {
      const cancelledStarts = responses.cancelActiveStarts();
      const cancelledPlanning = workflows.cancelActivePlanning();
      const interrupted = await Promise.all([...runtimes].map(async (runtime) => {
        // Adapter completion owns the terminal transition. Only persisted handles
        // left without a live adapter are marked interrupted directly.
        const cancelled = await runtime.responses.executionCoordinator.cancelAll();
        await runtime.documentTools.dispose();
        const orphaned = await runtime.responses.executions.listActive();
        let orphanedCount = 0;
        for (const execution of orphaned) {
          if (!await runtime.canInterruptResponse(toConversationResponseExecutionId(execution.responseExecutionId))) continue;
          await runtime.responses.executions.interrupt(
            execution.responseExecutionId,
            'application_shutdown'
          );
          await projectInterruptedAssistant(runtime.conversationRepository, execution.conversationId, execution.assistantMessageId, now);
          orphanedCount += 1;
        }
        runtime.sessionService.dispose();
        return cancelled + orphanedCount;
      }));
      return interrupted.reduce((total, count) => total + count, cancelledPlanning + cancelledStarts);
    },
    waitForMutations: async () => {
      await Promise.all([
        conversations.waitForOperations(),
        responses.waitForOperations(),
        projectContexts.waitForMutations(),
        workflows.waitForOperations(),
        webResearch.waitForOperations()
      ]);
      await Promise.all([...runtimes].map(runtime => runtime.responses.executionCoordinator.waitForCompletedOperations(async id =>
        ['completed', 'failed', 'cancelled', 'interrupted'].includes((await runtime.responses.executions.readModel(id)).state))));
      // Provider completion may have registered a terminal projection after the
      // initial mutation snapshot. Drain it only after the real handle settles.
      await Promise.all([...responseFinalizers]);
      await Promise.all([...runtimes].map(runtime => runtime.responses.completion?.waitForOperations()));
      await Promise.all([...runtimes].map(runtime => runtime.agentRuntime.flushProjectedEvents().catch(error => dependencies.onError?.(error))));
    }
  };
}

async function projectInterruptedAssistant(
  conversations: JsonProjectConversationRepository,
  conversationId: string,
  messageId: string,
  now: () => string
): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const conversation = await conversations.get(toConversationId(conversationId));
    const message = conversation?.messages.find((item) => item.id === messageId);
    if (!conversation || !message || !['pending', 'streaming'].includes(message.state)) return;
    try {
      await conversations.save(failAssistantMessage(conversation, toMessageId(messageId), 'interrupted', toIsoTimestamp(now())), conversation.revision);
      return;
    } catch (error) {
      if (!(error instanceof ConversationRevisionConflictError) || attempt === 3) throw error;
    }
  }
}

async function settleRecoverableConversationDocuments(
  workflows: ConversationWorkflowService,
  executions: JsonConversationResponseExecutionRepository,
  conversations: JsonProjectConversationRepository,
  now: () => string,
  canRecover?: (responseExecutionId: string) => Promise<boolean>
): Promise<void> {
  for (const workflow of await workflows.list()) {
    const executionId = workflow.executionId;
    if (workflow.status !== 'executing' || workflow.plan.kind !== 'document' || !executionId) continue;
    if (canRecover && !await canRecover(executionId)) continue;
    const execution = (await executions.list(workflow.conversationId)).find((item) => item.id === executionId);
    const messageId = execution?.snapshot.assistantMessageId ?? workflow.deliveries?.find((item) =>
      item.status === 'executing' && item.executionId === executionId)?.resultMessageId;
    if (!messageId) continue;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const conversation = await conversations.get(workflow.conversationId);
      const message = conversation?.messages.find((item) => item.id === messageId && item.role === 'assistant');
      const result = message?.documentResult;
      if (result && result.kind === workflow.plan.documentKind && result.validatedContent) {
        await workflows.finishDocumentExecution(executionId, 'completed', { messageId, workId: result.workId });
        break;
      }
      const status = message?.documentGenerationStatus;
      if (message?.state === 'completed' && status?.state === 'failed' && status.kind === workflow.plan.documentKind &&
        (execution ? execution.state === 'completed' && execution.snapshot.userMessageId === workflow.sourceMessageId
          : executionId.startsWith('local-document-revision-'))) {
        await workflows.finishDocumentExecution(executionId, 'failed', { messageId }, documentDeliveryFailureReason(status, true));
        break;
      }
      if (!conversation || message?.state !== 'completed' ||
        (execution ? execution.state !== 'completed' || execution.snapshot.userMessageId !== workflow.sourceMessageId
          : !executionId.startsWith('local-document-revision-')) ||
        (workflow.deliveries && !workflow.deliveries.some((item) => item.kind === workflow.plan.documentKind &&
          item.status === 'executing' && item.executionId === executionId &&
          (!item.resultMessageId || item.resultMessageId === messageId))) ||
        status?.kind !== workflow.plan.documentKind ||
        !status || !['validating_outline', 'generating_file', 'interrupted'].includes(status.state)) break;
      // These local phases follow persistence of the original render inputs.
      // Persist interrupted first so retry must reload those inputs, including
      // after a second crash between message recovery and workflow settlement.
      if (status.state !== 'interrupted') {
        try {
          await conversations.save(setDocumentGenerationStatusOnMessage(conversation, toMessageId(messageId),
            { state: 'interrupted', kind: status.kind }, toIsoTimestamp(now())), conversation.revision);
        } catch (error) {
          if (!(error instanceof ConversationRevisionConflictError) || attempt === 3) throw error;
          continue;
        }
      }
      await workflows.finishDocumentExecution(executionId, 'failed', { messageId }, 'execution_failed');
      break;
    }
  }
}

async function interruptOrphanedConversationResponses(
  executions: ConversationResponseExecutionLifecycle,
  conversations: JsonProjectConversationRepository,
  now: () => string,
  canRecover?: (responseExecutionId: string) => Promise<boolean>
): Promise<void> {
  const active = await executions.listActive();
  for (const execution of active) {
    if (canRecover && !await canRecover(execution.responseExecutionId)) continue;
    await executions.interrupt(execution.responseExecutionId, 'application_shutdown');
    await projectInterruptedAssistant(conversations, execution.conversationId, execution.assistantMessageId, now);
  }
}

function createConversationTerminalObserver(
  acceptances: ProjectSubmissionAcceptanceStore,
  authorization: RuntimeAuthorizationOrchestrationPort,
  workflows: ConversationWorkflowService,
  completion: ConversationCompletionCoordinator,
  routes: JsonProviderExecutionRouteSnapshotRepository,
  invocations: JsonProviderInvocationRepository,
  now: () => string,
  finalizers: Set<Promise<void>>,
  onError?: (error: unknown) => void
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
    const occurredAt = toIsoTimestamp(now());
    let updated: ProjectSubmissionAcceptanceV1 | undefined;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const acceptance = await acceptances.getByInvocationAttemptId(input.invocationAttemptId as never);
      if (!acceptance) return;
      if (['completed', 'failed', 'cancelled', 'unknown_outcome'].includes(acceptance.intent.status)) { updated = acceptance; break; }
      try {
        updated = await acceptances.advance({
          intent: transitionSubmissionIntent(acceptance.intent, status, occurredAt, {
            providerOperationId: input.providerOperationId, ...(input.safeCode ? { safeCode: input.safeCode } : {}) }),
          invocationEvent: createProviderInvocationEvent({ id: `conversation-terminal-${randomUUID()}` as never,
            invocationAttemptId: acceptance.invocationAttempt.id, sequence: acceptance.invocationEvents.length + 1,
            type: eventType, ...(input.safeCode ? { safeCode: input.safeCode } : {}), occurredAt }) });
        break;
      } catch (error) { if (attempt === 3) throw error; }
    }
    if (!updated) throw new Error('completion_acceptance_unavailable');
    await persistConversationCallRecordFacts({ acceptance: updated, routes, invocations });
    await authorization.recordOutcome(updated.intent.authorizationClaimId, occurredAt);
    if (updated.subjectArtifacts.kind === 'conversation') {
      const settled = await completion.settle(updated.subjectArtifacts.responseExecution.id,
        updated.intent.status === 'unknown_outcome' ? { unknownResult: true } : {});
      if (!settled) await workflows.finishExecution(updated.subjectArtifacts.responseExecution.id,
        updated.intent.status === 'completed' ? 'completed' : updated.intent.status === 'cancelled' ? 'cancelled' : 'failed');
    }
  };
  const stopSafely = async (error: unknown, invocationAttemptId: string) => {
    onError?.(error);
    try {
      const acceptance = await acceptances.getByInvocationAttemptId(invocationAttemptId as never);
      if (acceptance?.subjectArtifacts.kind === 'conversation') {
        await completion.settle(acceptance.subjectArtifacts.responseExecution.id, { unknownResult: true });
      }
    } catch (settlementError) { onError?.(settlementError); }
  };
  const track = (operation: Promise<void>): Promise<void> => {
    let tracked: Promise<void>;
    tracked = operation.finally(() => finalizers.delete(tracked));
    finalizers.add(tracked);
    return tracked;
  };
  return {
    completed: (input: { providerOperationId: string; invocationAttemptId: string }) =>
      track(advance(input, 'completed', 'completed').catch(error => stopSafely(error, input.invocationAttemptId))),
    failed: (input: { providerOperationId: string; invocationAttemptId: string; safeCode: string }) =>
      track(advance(input, 'failed', 'failed').catch(error => stopSafely(error, input.invocationAttemptId))),
    cancelled: (input: { providerOperationId: string; invocationAttemptId: string }) =>
      track(advance(input, 'cancelled', 'cancelled').catch(error => stopSafely(error, input.invocationAttemptId))),
    interrupted: (input: { providerOperationId: string; invocationAttemptId: string }) =>
      track(advance(input, 'unknown_outcome', 'outcome_unknown').catch(error => stopSafely(error, input.invocationAttemptId)))
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
