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
  toConversationId,
  toMessageId,
  toProjectContextDraftId,
  toProjectContextFragmentId,
  toProjectContextId
} from '../../domain';
import {
  JsonConversationRepository,
  JsonProjectContextRepository
} from '../repositories';
import { NodeProjectStorage } from '../storage';
import { ConversationController } from './conversation-controller';
import { ProjectContextController } from './project-context-controller';
import type { StorageProjectSession } from './storage-ipc-controller';

export interface ChatContextRuntimeDependencies {
  readonly userDataDirectory: string;
  getSession(): StorageProjectSession | undefined;
  now?: () => string;
  conversationIds?: ConversationIdFactory;
  projectContextIds?: ProjectContextIdFactory;
  onError?(error: unknown): void;
}

export interface ChatContextRuntime {
  readonly conversations: ConversationController;
  readonly projectContexts: ProjectContextController;
  waitForMutations(): Promise<void>;
}

export function createChatContextRuntime(
  dependencies: ChatContextRuntimeDependencies
): ChatContextRuntime {
  const now = dependencies.now ?? (() => new Date().toISOString());
  const conversationIds = dependencies.conversationIds ?? createConversationIds();
  const contextIds = dependencies.projectContextIds ?? createProjectContextIds();
  const conversationRepository = new JsonConversationRepository(
    path.join(dependencies.userDataDirectory, 'conversations.json'),
    now
  );
  const conversationService = new ConversationApplicationService(
    conversationRepository,
    conversationIds,
    now
  );
  const streamingService = new ConversationStreamingService(
    conversationRepository,
    conversationIds,
    now
  );
  const conversations = new ConversationController({
    service: conversationService,
    streaming: streamingService,
    getSession: dependencies.getSession,
    onError: dependencies.onError
  });
  let cached:
    | {
        readonly projectId: string;
        readonly rootDirectory: string;
        readonly service: ProjectContextRegistryService;
      }
    | undefined;
  const projectContexts = new ProjectContextController({
    getSession: dependencies.getSession,
    onError: dependencies.onError,
    getService(session) {
      if (
        cached?.projectId === session.projectId &&
        cached.rootDirectory === session.rootDirectory
      ) {
        return cached.service;
      }
      const repository = new JsonProjectContextRepository(
        new NodeProjectStorage(session.rootDirectory),
        session.projectId,
        now
      );
      const service = new ProjectContextRegistryService(
        conversationRepository,
        repository,
        contextIds,
        now
      );
      cached = {
        projectId: session.projectId,
        rootDirectory: session.rootDirectory,
        service
      };
      return service;
    }
  });
  return {
    conversations,
    projectContexts,
    waitForMutations: async () => {
      await Promise.all([
        conversations.waitForOperations(),
        projectContexts.waitForMutations()
      ]);
    }
  };
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
