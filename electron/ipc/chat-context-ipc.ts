import { app, ipcMain } from 'electron';
import {
  createChatContextRuntime,
  type StorageProjectSession
} from '../../src/platform';
import { chatContextIpcChannels } from '../../src/shared/chat-context-ipc';

export interface ChatContextIpcLifecycle {
  waitForMutations(): Promise<void>;
}

export function registerChatContextIpcHandlers(options: {
  getSession(): StorageProjectSession | undefined;
}): ChatContextIpcLifecycle {
  const runtime = createChatContextRuntime({
    userDataDirectory: app.getPath('userData'),
    getSession: options.getSession
  });
  const conversations = runtime.conversations;
  const contexts = runtime.projectContexts;

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
  ipcMain.handle(
    chatContextIpcChannels.requestAssistantResponse,
    (_event, request: unknown) => conversations.requestAssistantResponse(request)
  );
  ipcMain.handle(
    chatContextIpcChannels.cancelAssistantResponse,
    (_event, request: unknown) => conversations.cancelAssistantResponse(request)
  );
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

  return { waitForMutations: runtime.waitForMutations };
}
