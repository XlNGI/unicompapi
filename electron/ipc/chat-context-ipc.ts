import { app, ipcMain } from 'electron';
import {
  createChatContextRuntime,
  type DeepSeekSharedRuntime,
  type JsonProviderRegistryStore,
  type NewApiSharedRuntime,
  type ProviderCandidateRuntimeAuthorizationPort,
  type ProviderPackageRegistry,
  type RuntimeAuthorizationOrchestrationPort,
  type SecureCredentialVault,
  type StorageProjectSession
} from '../../src/platform';
import { chatContextIpcChannels } from '../../src/shared/chat-context-ipc';
import { webResearchIpcChannels } from '../../src/shared/web-research-ipc';

export interface ChatContextIpcLifecycle {
  interruptActiveResponses(): Promise<number>;
  waitForMutations(): Promise<void>;
}

export function registerChatContextIpcHandlers(options: {
  getSession(): StorageProjectSession | undefined;
  readonly providerRegistry: JsonProviderRegistryStore;
  readonly providerPackages: ProviderPackageRegistry;
  readonly runtimeAuthorization?: ProviderCandidateRuntimeAuthorizationPort &
    Partial<RuntimeAuthorizationOrchestrationPort>;
  readonly textSubmission?: {
    readonly credentialVault: SecureCredentialVault;
    readonly deepSeekRuntime: DeepSeekSharedRuntime;
    readonly newApiRuntime: NewApiSharedRuntime;
  };
}): ChatContextIpcLifecycle {
  const runtime = createChatContextRuntime({
    userDataDirectory: app.getPath('userData'),
    getSession: options.getSession,
    providerRegistry: options.providerRegistry,
    providerPackages: options.providerPackages,
    runtimeAuthorization: options.runtimeAuthorization,
    textSubmission: options.textSubmission
  });
  const conversations = runtime.conversations;
  const contexts = runtime.projectContexts;
  const workflows = runtime.workflows;
  const webResearch = runtime.webResearch;
  const responseSubscriptionOwners = new Map<string, number>();

  ipcMain.handle(chatContextIpcChannels.createConversation, (_event, request: unknown) =>
    conversations.create(request)
  );
  ipcMain.handle(chatContextIpcChannels.getConversation, (_event, request: unknown) =>
    conversations.get(request)
  );
  ipcMain.handle(chatContextIpcChannels.listConversations, (_event, request: unknown) =>
    conversations.list(request)
  );
  ipcMain.handle(chatContextIpcChannels.listConversationCandidates, () =>
    conversations.listCandidates()
  );
  ipcMain.handle(chatContextIpcChannels.renameConversation, (_event, request: unknown) =>
    conversations.rename(request)
  );
  ipcMain.handle(chatContextIpcChannels.archiveConversation, (_event, request: unknown) =>
    conversations.archive(request)
  );
  ipcMain.handle(chatContextIpcChannels.restoreConversation, (_event, request: unknown) =>
    conversations.restore(request)
  );
  ipcMain.handle(chatContextIpcChannels.deleteConversation, (_event, request: unknown) =>
    conversations.delete(request)
  );
  ipcMain.handle(chatContextIpcChannels.addUserMessage, (_event, request: unknown) =>
    conversations.addUserMessage(request)
  );
  ipcMain.handle(chatContextIpcChannels.editCancelledUserMessage, (_event, request: unknown) =>
    conversations.editCancelledUserMessage(request)
  );
  ipcMain.handle(chatContextIpcChannels.copyLegacyConversation, (_event, request: unknown) =>
    conversations.copyLegacyConversation(request)
  );
  ipcMain.handle(chatContextIpcChannels.createResponseDraft, (_event, request: unknown) =>
    runtime.responses.createDraft(request)
  );
  ipcMain.handle(chatContextIpcChannels.replaceResponseContexts, (_event, request: unknown) =>
    runtime.responses.replaceContexts(request)
  );
  ipcMain.handle(chatContextIpcChannels.replaceResponseParameters, (_event, request: unknown) =>
    runtime.responses.replaceParameters(request)
  );
  ipcMain.handle(chatContextIpcChannels.listResponseCandidates, (_event, request: unknown) =>
    runtime.responses.listCandidates(request)
  );
  ipcMain.handle(chatContextIpcChannels.listTextCandidates, (_event, request: unknown) =>
    runtime.responses.listTextCandidates(request)
  );
  ipcMain.handle(chatContextIpcChannels.prepareResponseSubmission, (_event, request: unknown) =>
    runtime.responses.prepareSubmission(request)
  );
  ipcMain.handle(chatContextIpcChannels.submitResponse, (_event, request: unknown) =>
    runtime.responses.submit(request)
  );
  ipcMain.handle(chatContextIpcChannels.startResponse, (_event, request: unknown) =>
    runtime.responses.start(request)
  );
  ipcMain.handle(chatContextIpcChannels.startWorkflow, (_event, request: unknown) =>
    workflows.start(request)
  );
  ipcMain.handle(chatContextIpcChannels.answerWorkflow, (_event, request: unknown) =>
    workflows.answer(request)
  );
  ipcMain.handle(chatContextIpcChannels.confirmWorkflow, (_event, request: unknown) =>
    workflows.confirm(request)
  );
  ipcMain.handle(chatContextIpcChannels.cancelWorkflow, (_event, request: unknown) =>
    workflows.cancel(request)
  );
  ipcMain.handle(chatContextIpcChannels.getWorkflow, (_event, request: unknown) =>
    workflows.get(request)
  );
  ipcMain.handle(chatContextIpcChannels.getPendingWorkflow, (_event, request: unknown) =>
    workflows.getPending(request)
  );
  ipcMain.handle(webResearchIpcChannels.preview, (_event, request: unknown) =>
    webResearch.preview(request)
  );
  ipcMain.handle(webResearchIpcChannels.authorize, (_event, request: unknown) =>
    webResearch.authorize(request)
  );
  ipcMain.handle(webResearchIpcChannels.cancel, (_event, request: unknown) =>
    webResearch.cancel(request)
  );
  ipcMain.handle(webResearchIpcChannels.getStatus, (_event, request: unknown) =>
    webResearch.getStatus(request)
  );
  ipcMain.handle(chatContextIpcChannels.getResponseExecution, (_event, request: unknown) =>
    runtime.responses.getExecution(request)
  );
  ipcMain.handle(chatContextIpcChannels.replayResponseEvents, (_event, request: unknown) =>
    runtime.responses.replayEvents(request)
  );
  ipcMain.handle(chatContextIpcChannels.cancelResponseExecution, (_event, request: unknown) =>
    runtime.responses.cancelExecution(request)
  );
  ipcMain.handle(
    chatContextIpcChannels.subscribeResponseEvents,
    (event, request: unknown) => {
      const subscriberId = typeof request === 'object' && request !== null
        ? (request as { subscriberId?: unknown }).subscriberId
        : undefined;
      if (typeof subscriberId !== 'string') {
        return Promise.resolve({ ok: false, error: { code: 'invalid_request', message: 'Response event subscription is invalid' } });
      }
      const ownerId = event.sender.id;
      return runtime.responses.subscribeEvents(
        { responseExecutionId: (request as { responseExecutionId?: unknown }).responseExecutionId },
        subscriberId,
        (responseEvent) => {
          if (!event.sender.isDestroyed()) {
            event.sender.send(chatContextIpcChannels.responseEvent, { subscriberId, event: responseEvent });
          }
        },
        () => { responseSubscriptionOwners.delete(subscriberId); }
      ).then((result) => {
        if (result.ok) responseSubscriptionOwners.set(subscriberId, ownerId);
        return result;
      });
    }
  );
  ipcMain.on(chatContextIpcChannels.acknowledgeResponseEvents, (event, request: unknown) => {
    const value = request as { subscriberId?: unknown; sequence?: unknown };
    if (typeof value?.subscriberId === 'string' && responseSubscriptionOwners.get(value.subscriberId) === event.sender.id && typeof value.sequence === 'number' && Number.isSafeInteger(value.sequence)) {
      runtime.responses.acknowledgeEvents(value.subscriberId, value.sequence);
    }
  });
  ipcMain.on(chatContextIpcChannels.unsubscribeResponseEvents, (event, request: unknown) => {
    const subscriberId = request && typeof request === 'object'
      ? (request as { subscriberId?: unknown }).subscriberId
      : undefined;
    if (typeof subscriberId === 'string' && responseSubscriptionOwners.get(subscriberId) === event.sender.id) {
      responseSubscriptionOwners.delete(subscriberId);
      runtime.responses.unsubscribeEvents(subscriberId);
    }
  });
  ipcMain.handle(chatContextIpcChannels.createContextDraft, (_event, request: unknown) =>
    contexts.createDraft(request)
  );
  ipcMain.handle(
    chatContextIpcChannels.getContextDraftPreview,
    (_event, request: unknown) => contexts.getDraftPreview(request)
  );
  ipcMain.handle(
    chatContextIpcChannels.addContextMessageFragment,
    (_event, request: unknown) => contexts.addMessageFragment(request)
  );
  ipcMain.handle(
    chatContextIpcChannels.removeContextMessageFragment,
    (_event, request: unknown) => contexts.removeMessageFragment(request)
  );
  ipcMain.handle(
    chatContextIpcChannels.updateContextDraftLabels,
    (_event, request: unknown) => contexts.updateDraftLabels(request)
  );
  ipcMain.handle(chatContextIpcChannels.registerContextDraft, (_event, request: unknown) =>
    contexts.registerDraft(request)
  );
  ipcMain.handle(chatContextIpcChannels.updateProjectContext, (_event, request: unknown) =>
    contexts.updateContext(request)
  );
  ipcMain.handle(chatContextIpcChannels.deleteProjectContext, (_event, request: unknown) =>
    contexts.deleteContext(request)
  );
  ipcMain.handle(
    chatContextIpcChannels.refreshContextSourceStatus,
    (_event, request: unknown) => contexts.refreshSourceStatus(request)
  );
  ipcMain.handle(chatContextIpcChannels.listProjectContextCandidates, () =>
    contexts.listCandidates()
  );
  ipcMain.handle(chatContextIpcChannels.getProjectContext, (_event, request: unknown) =>
    contexts.getContext(request)
  );
  ipcMain.handle(
    chatContextIpcChannels.getProjectContextRevision,
    (_event, request: unknown) => contexts.getContextRevision(request)
  );
  ipcMain.handle(chatContextIpcChannels.getContextSourceStatus, (_event, request: unknown) =>
    contexts.getSourceStatus(request)
  );

  return {
    interruptActiveResponses: runtime.interruptActiveResponses,
    waitForMutations: runtime.waitForMutations
  };
}
