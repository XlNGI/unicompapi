import { randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  ConversationApplicationService,
  ConversationStreamingService,
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
  startAssistantMessageStreaming,
  toConversationId,
  toConversationResponseStreamEventId,
  toIsoTimestamp,
  toMessageId,
  toProjectContextDraftId,
  toProjectContextFragmentId,
  toProjectContextId,
  type Conversation,
  type ProjectId
} from '../../domain';
import {
  JsonConversationRepository,
  JsonConversationResponseDraftRepository,
  JsonConversationResponseExecutionRepository,
  JsonProjectConversationRepository,
  JsonProjectContextRepository
} from '../repositories';
import { NodeProjectStorage } from '../storage';
import { ConversationController } from './conversation-controller';
import { toConversationDto } from './conversation-controller';
import {
  ConversationResponseController,
  type ConversationResponseControllerRuntime
} from './conversation-response-controller';
import { ProjectContextController } from './project-context-controller';
import type { StorageProjectSession } from './storage-ipc-controller';
import {
  ConversationResponseExecutionLifecycle,
  DEEPSEEK_CONSTRAINT_SET_ID,
  DEEPSEEK_RESULT_SCHEMA_ID,
  deepSeekChatParameterSchema,
  deepSeekReasoningParameterSchema,
  deepSeekUsageSchema,
  deepSeekProviderPackageDescriptor,
  klingProviderPackageDescriptor,
  newApiProviderPackageDescriptor,
  ProjectConversationResponseSubjectResolver,
  ProviderFeatureCandidateService,
  ProviderFeatureContractRegistry,
  ProviderPackageRegistry,
  RegistryFeatureCandidateSource,
  RouteSelectionTokenVault,
  viduProviderPackageDescriptor,
  volcengineProviderPackageDescriptor,
  type ConnectionOutboundAuthorizationPort,
  type JsonProviderRegistryStore
} from '../providers';
import { JsonProviderRegistryStore as ProviderRegistryStore } from '../providers';
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
  readonly connectionAuthorizations?: ConnectionOutboundAuthorizationPort;
  now?: () => string;
  conversationIds?: ConversationIdFactory;
  projectContextIds?: ProjectContextIdFactory;
  onError?(error: unknown): void;
}

export interface ChatContextRuntime {
  readonly conversations: ConversationControllerPort;
  readonly responses: ConversationResponseController;
  readonly projectContexts: ProjectContextController;
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
  copyLegacyConversation(request: unknown): Promise<ChatContextIpcResult<ConversationDto>>;
  requestAssistantResponse(request: unknown): Promise<ChatContextIpcResult<ConversationDto>>;
  cancelAssistantResponse(request: unknown): Promise<ChatContextIpcResult<ConversationDto>>;
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
    newApiProviderPackageDescriptor,
    viduProviderPackageDescriptor
  ]);
  const contracts = new ProviderFeatureContractRegistry([
    {
      parameterSchema: deepSeekChatParameterSchema,
      resultSchemaId: DEEPSEEK_RESULT_SCHEMA_ID,
      resultSchemaRevision: 1,
      usageSchema: deepSeekUsageSchema,
      constraintSetId: DEEPSEEK_CONSTRAINT_SET_ID,
      constraintSetRevision: 1,
      featureMappingVersion: 1
    },
    {
      parameterSchema: deepSeekReasoningParameterSchema,
      resultSchemaId: DEEPSEEK_RESULT_SCHEMA_ID,
      resultSchemaRevision: 1,
      usageSchema: deepSeekUsageSchema,
      constraintSetId: DEEPSEEK_CONSTRAINT_SET_ID,
      constraintSetRevision: 1,
      featureMappingVersion: 1
    }
  ]);
  type ProjectRuntime = {
    readonly projectId: string;
    readonly rootDirectory: string;
    readonly conversations: ConversationController;
    readonly conversationRepository: JsonProjectConversationRepository;
    readonly contextService: ProjectContextRegistryService;
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
    const streaming = new ConversationStreamingService(
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
        {
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
      now,
      undefined,
      dependencies.connectionAuthorizations
    );
    const responseLifecycle = new ConversationResponseExecutionLifecycle(
      responseExecutions,
      {
        nextConversationResponseStreamEventId: () =>
          toConversationResponseStreamEventId(`response-stream-${randomUUID()}`)
      },
      undefined,
      () => toIsoTimestamp(now())
    );
    cached = {
      projectId: session.projectId,
      rootDirectory: session.rootDirectory,
      conversations: new ConversationController({
        service,
        streaming,
        getSession: dependencies.getSession,
        projectRequired: true,
        storageScope: 'current_project',
        onError: dependencies.onError
      }),
      conversationRepository: projectConversations,
      contextService,
      responses: {
        conversations: projectConversations,
        drafts: responseDrafts,
        contexts: contextRepository,
        candidates: candidateService,
        executions: responseLifecycle
      }
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
    cancelAssistantResponse: (request) =>
      requireProjectController()?.cancelAssistantResponse(request) ??
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
    waitForMutations: async () => {
      await Promise.all([
        conversations.waitForOperations(),
        responses.waitForOperations(),
        projectContexts.waitForMutations()
      ]);
    }
  };
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
