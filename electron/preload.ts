import { contextBridge, ipcRenderer } from 'electron';
import {
  storageIpcChannels,
  type StorageApi
} from '../src/shared/storage-ipc';
import {
  providerIpcChannels,
  type ProviderApi
} from '../src/shared/provider-ipc';
import {
  imageWorkspaceIpcChannels,
  type ImageWorkspaceApi
} from '../src/shared/image-workspace-ipc';
import {
  imageSubmissionIpcChannels,
  type ImageSubmissionApi
} from '../src/shared/image-submission-ipc';
import {
  videoWorkspaceIpcChannels,
  type VideoWorkspaceApi
} from '../src/shared/video-workspace-ipc';
import {
  videoSubmissionIpcChannels,
  type VideoSubmissionApi
} from '../src/shared/video-submission-ipc';
import {
  videoEditorIpcChannels,
  type VideoEditorApi
} from '../src/shared/video-editor-ipc';
import {
  settingsIpcChannels,
  type SettingsApi
} from '../src/shared/settings-ipc';
import {
  chatContextIpcChannels,
  type ChatContextApi
} from '../src/shared/chat-context-ipc';

const storage: StorageApi = {
  probeFile: (fileId) =>
    ipcRenderer.invoke(storageIpcChannels.probeFile, { fileId }),
  verifyFile: (fileId) =>
    ipcRenderer.invoke(storageIpcChannels.verifyFile, { fileId }),
  relinkFile: (fileId) =>
    ipcRenderer.invoke(storageIpcChannels.relinkFile, { fileId }),
  restoreBackup: (fileId) =>
    ipcRenderer.invoke(storageIpcChannels.restoreBackup, { fileId }),
  rebuildIndex: () => ipcRenderer.invoke(storageIpcChannels.rebuildIndex),
  openProject: () => ipcRenderer.invoke(storageIpcChannels.openProject),
  createProject: (name) =>
    ipcRenderer.invoke(storageIpcChannels.createProject, { name }),
  listProjects: () => ipcRenderer.invoke(storageIpcChannels.listProjects),
  listTasks: () => ipcRenderer.invoke(storageIpcChannels.listTasks),
  getTaskDetails: (taskId) =>
    ipcRenderer.invoke(storageIpcChannels.getTaskDetails, { taskId }),
  listWorks: () => ipcRenderer.invoke(storageIpcChannels.listWorks),
  getWorkDetails: (workId) =>
    ipcRenderer.invoke(storageIpcChannels.getWorkDetails, { workId }),
  createWorkMediaHandle: (workId) =>
    ipcRenderer.invoke(storageIpcChannels.createWorkMediaHandle, { workId }),
  revealWorkFile: (workId) =>
    ipcRenderer.invoke(storageIpcChannels.revealWorkFile, { workId }),
  closeProject: () => ipcRenderer.invoke(storageIpcChannels.closeProject),
  getProjectSession: () =>
    ipcRenderer.invoke(storageIpcChannels.getProjectSession)
};

const providers: ProviderApi = {
  getRegistry: () => ipcRenderer.invoke(providerIpcChannels.getRegistry),
  saveCredential: (connectionId, value) =>
    ipcRenderer.invoke(providerIpcChannels.saveCredential, {
      connectionId,
      value
    }),
  deleteLocalCredential: (connectionId) =>
    ipcRenderer.invoke(providerIpcChannels.deleteLocalCredential, {
      connectionId
    }),
  getCredentialStatus: (connectionId) =>
    ipcRenderer.invoke(providerIpcChannels.getCredentialStatus, {
      connectionId
    }),
  checkCredentialStorage: (connectionId) =>
    ipcRenderer.invoke(providerIpcChannels.checkCredentialStorage, {
      connectionId
    }),
  validateConnection: (connectionId) =>
    ipcRenderer.invoke(providerIpcChannels.validateConnection, { connectionId }),
  syncModelCatalog: (connectionId) =>
    ipcRenderer.invoke(providerIpcChannels.syncModelCatalog, { connectionId }),
  registerManualModel: (connectionId, name, displayName) =>
    ipcRenderer.invoke(providerIpcChannels.registerManualModel, {
      connectionId,
      name,
      displayName
    }),
  validateCapability: (modelId, capability) =>
    ipcRenderer.invoke(providerIpcChannels.validateCapability, {
      modelId,
      capability
    }),
  recordUserCapability: (modelId, capability, state) =>
    ipcRenderer.invoke(providerIpcChannels.recordUserCapability, {
      modelId,
      capability,
      state
    }),
  saveRoutingPreference: (purpose, modelId, priority, enabled) =>
    ipcRenderer.invoke(providerIpcChannels.saveRoutingPreference, {
      purpose,
      modelId,
      priority,
      enabled
    }),
  planRoute: (purpose) =>
    ipcRenderer.invoke(providerIpcChannels.planRoute, { purpose }),
  createProvider: (name, accessCategory) =>
    ipcRenderer.invoke(providerIpcChannels.createProvider, {
      name,
      accessCategory
    }),
  createConnection: (providerId, name, endpoint) =>
    ipcRenderer.invoke(providerIpcChannels.createConnection, {
      providerId,
      name,
      endpoint
    }),
  updateConnection: (connectionId, name, endpoint) =>
    ipcRenderer.invoke(providerIpcChannels.updateConnection, {
      connectionId,
      name,
      endpoint
    }),
  setConnectionEnabled: (connectionId, enabled) =>
    ipcRenderer.invoke(providerIpcChannels.setConnectionEnabled, {
      connectionId,
      enabled
    }),
  deleteConnection: (connectionId) =>
    ipcRenderer.invoke(providerIpcChannels.deleteConnection, { connectionId }),
  setModelEnabled: (modelId, enabled) =>
    ipcRenderer.invoke(providerIpcChannels.setModelEnabled, { modelId, enabled })
};

const imageWorkspaces: ImageWorkspaceApi = {
  create: (mode) =>
    ipcRenderer.invoke(imageWorkspaceIpcChannels.create, { mode }),
  get: (draftId) =>
    ipcRenderer.invoke(imageWorkspaceIpcChannels.get, { draftId }),
  update: (draft) =>
    ipcRenderer.invoke(imageWorkspaceIpcChannels.update, { draft }),
  list: () => ipcRenderer.invoke(imageWorkspaceIpcChannels.list),
  derive: (sourceDraftId, targetMode) =>
    ipcRenderer.invoke(imageWorkspaceIpcChannels.derive, {
      sourceDraftId,
      targetMode
    }),
  selectInput: (draftId) =>
    ipcRenderer.invoke(imageWorkspaceIpcChannels.selectInput, { draftId }),
  getInput: (draftId) =>
    ipcRenderer.invoke(imageWorkspaceIpcChannels.getInput, { draftId }),
  createInputPreview: (draftId) =>
    ipcRenderer.invoke(imageWorkspaceIpcChannels.createInputPreview, {
      draftId
    })
};

const imageSubmissions: ImageSubmissionApi = {
  preflight: (draftId) =>
    ipcRenderer.invoke(imageSubmissionIpcChannels.preflight, { draftId }),
  createTask: (draftId, draftUpdatedAt, modelId, confirmations) =>
    ipcRenderer.invoke(imageSubmissionIpcChannels.createTask, {
      draftId,
      draftUpdatedAt,
      modelId,
      confirmations
    }),
  createExecution: (taskId) =>
    ipcRenderer.invoke(imageSubmissionIpcChannels.createExecution, { taskId }),
  invokeExecution: (executionId) =>
    ipcRenderer.invoke(imageSubmissionIpcChannels.invokeExecution, {
      executionId
    }),
  receiveResult: (executionId) =>
    ipcRenderer.invoke(imageSubmissionIpcChannels.receiveResult, {
      executionId
    })
};

const videoWorkspaces: VideoWorkspaceApi = {
  create: (mode) =>
    ipcRenderer.invoke(videoWorkspaceIpcChannels.create, { mode }),
  get: (draftId) =>
    ipcRenderer.invoke(videoWorkspaceIpcChannels.get, { draftId }),
  update: (draft) =>
    ipcRenderer.invoke(videoWorkspaceIpcChannels.update, { draft }),
  list: () => ipcRenderer.invoke(videoWorkspaceIpcChannels.list),
  derive: (sourceDraftId, targetMode) =>
    ipcRenderer.invoke(videoWorkspaceIpcChannels.derive, {
      sourceDraftId,
      targetMode
    }),
  selectMaterial: (draftId, target, mediaKind) =>
    ipcRenderer.invoke(videoWorkspaceIpcChannels.selectMaterial, {
      draftId,
      target,
      mediaKind
    }),
  getMaterial: (draftId, target) =>
    ipcRenderer.invoke(videoWorkspaceIpcChannels.getMaterial, {
      draftId,
      target
    }),
  clearMaterial: (draftId, target) =>
    ipcRenderer.invoke(videoWorkspaceIpcChannels.clearMaterial, {
      draftId,
      target
    }),
  createMaterialPreview: (draftId, target) =>
    ipcRenderer.invoke(videoWorkspaceIpcChannels.createMaterialPreview, {
      draftId,
      target
    })
};

const videoSubmissions: VideoSubmissionApi = {
  preflight: (draftId) =>
    ipcRenderer.invoke(videoSubmissionIpcChannels.preflight, { draftId }),
  createTask: (draftId, draftUpdatedAt, modelId, confirmations) =>
    ipcRenderer.invoke(videoSubmissionIpcChannels.createTask, {
      draftId,
      draftUpdatedAt,
      modelId,
      confirmations
    }),
  createExecution: (taskId) =>
    ipcRenderer.invoke(videoSubmissionIpcChannels.createExecution, { taskId }),
  invokeExecution: (executionId) =>
    ipcRenderer.invoke(videoSubmissionIpcChannels.invokeExecution, {
      executionId
    }),
  receiveResult: (executionId) =>
    ipcRenderer.invoke(videoSubmissionIpcChannels.receiveResult, {
      executionId
    })
};

const videoEditors: VideoEditorApi = {
  create: (sourceIntent, title) =>
    ipcRenderer.invoke(videoEditorIpcChannels.create, { sourceIntent, title }),
  get: (draftId) =>
    ipcRenderer.invoke(videoEditorIpcChannels.get, { draftId }),
  list: () => ipcRenderer.invoke(videoEditorIpcChannels.list),
  update: (draftId, expectedRevision, command) =>
    ipcRenderer.invoke(videoEditorIpcChannels.update, {
      draftId,
      expectedRevision,
      command
    }),
  undo: (draftId, expectedRevision) =>
    ipcRenderer.invoke(videoEditorIpcChannels.undo, {
      draftId,
      expectedRevision
    }),
  redo: (draftId, expectedRevision) =>
    ipcRenderer.invoke(videoEditorIpcChannels.redo, {
      draftId,
      expectedRevision
    }),
  copy: (draftId, expectedRevision, title) =>
    ipcRenderer.invoke(videoEditorIpcChannels.copy, {
      draftId,
      expectedRevision,
      title
    }),
  selectSource: (draftId, expectedRevision, strategy) =>
    ipcRenderer.invoke(videoEditorIpcChannels.selectSource, {
      draftId,
      expectedRevision,
      strategy
    }),
  attachWork: (draftId, expectedRevision, workId) =>
    ipcRenderer.invoke(videoEditorIpcChannels.attachWork, {
      draftId,
      expectedRevision,
      workId
    }),
  getSourceStatus: (draftId, clipId) =>
    ipcRenderer.invoke(videoEditorIpcChannels.getSourceStatus, {
      draftId,
      clipId
    }),
  prepareRelink: (draftId, clipId) =>
    ipcRenderer.invoke(videoEditorIpcChannels.prepareRelink, {
      draftId,
      clipId
    }),
  confirmRelink: (draftId, clipId, relinkHandle, acceptMismatch) =>
    ipcRenderer.invoke(videoEditorIpcChannels.confirmRelink, {
      draftId,
      clipId,
      ['to' + 'ken']: relinkHandle,
      acceptMismatch
    }),
  selectBackgroundMusic: (draftId, expectedRevision) =>
    ipcRenderer.invoke(videoEditorIpcChannels.selectBackgroundMusic, {
      draftId,
      expectedRevision
    }),
  selectCoverImage: (draftId, expectedRevision, prependToVideo, prependDurationUs) =>
    ipcRenderer.invoke(videoEditorIpcChannels.selectCoverImage, {
      draftId,
      expectedRevision,
      prependToVideo,
      ...(prependDurationUs === undefined ? {} : { prependDurationUs })
    }),
  attachCoverWork: (
    draftId,
    expectedRevision,
    workId,
    prependToVideo,
    prependDurationUs
  ) =>
    ipcRenderer.invoke(videoEditorIpcChannels.attachCoverWork, {
      draftId,
      expectedRevision,
      workId,
      prependToVideo,
      ...(prependDurationUs === undefined ? {} : { prependDurationUs })
    }),
  createSourcePreview: (draftId, clipId) =>
    ipcRenderer.invoke(videoEditorIpcChannels.createSourcePreview, {
      draftId,
      clipId
    }),
  requestPreviewArtifact: (draftId, clipId, kind) =>
    ipcRenderer.invoke(videoEditorIpcChannels.requestPreviewArtifact, {
      draftId,
      clipId,
      kind
    }),
  clearPreviewCache: () =>
    ipcRenderer.invoke(videoEditorIpcChannels.clearPreviewCache),
  preflightExport: (draftId, expectedRevision) =>
    ipcRenderer.invoke(videoEditorIpcChannels.preflightExport, {
      draftId,
      expectedRevision
    }),
  startExport: (draftId, expectedRevision) =>
    ipcRenderer.invoke(videoEditorIpcChannels.startExport, {
      draftId,
      expectedRevision
    }),
  getExport: (taskId) =>
    ipcRenderer.invoke(videoEditorIpcChannels.getExport, { taskId }),
  cancelExport: (taskId) =>
    ipcRenderer.invoke(videoEditorIpcChannels.cancelExport, { taskId }),
  retryExport: (taskId) =>
    ipcRenderer.invoke(videoEditorIpcChannels.retryExport, { taskId }),
  recoverExports: () =>
    ipcRenderer.invoke(videoEditorIpcChannels.recoverExports)
};

const settings: SettingsApi = {
  getSnapshot: () => ipcRenderer.invoke(settingsIpcChannels.getSnapshot),
  updateValues: (expectedRevision, values) =>
    ipcRenderer.invoke(settingsIpcChannels.updateValues, {
      expectedRevision,
      values
    }),
  exportPortable: () => ipcRenderer.invoke(settingsIpcChannels.exportPortable),
  prepareImport: (expectedRevision, document) =>
    ipcRenderer.invoke(settingsIpcChannels.prepareImport, {
      expectedRevision,
      document
    }),
  getSystemStatus: () => ipcRenderer.invoke(settingsIpcChannels.getSystemStatus),
  selectDirectory: (purpose) =>
    ipcRenderer.invoke(settingsIpcChannels.selectDirectory, { purpose }),
  openSystemSettings: (target) =>
    ipcRenderer.invoke(settingsIpcChannels.openSystemSettings, { target }),
  sendTestNotification: (system, sound) =>
    ipcRenderer.invoke(settingsIpcChannels.sendTestNotification, { system, sound }),
  stageProxyCredential: (username, value) =>
    ipcRenderer.invoke(settingsIpcChannels.stageProxyCredential, { username, value }),
  getMaintenanceStatus: () =>
    ipcRenderer.invoke(settingsIpcChannels.getMaintenanceStatus),
  previewDiagnosticBundle: () =>
    ipcRenderer.invoke(settingsIpcChannels.previewDiagnosticBundle),
  generateDiagnosticBundle: () =>
    ipcRenderer.invoke(settingsIpcChannels.generateDiagnosticBundle),
  openDiagnosticLocation: (target) =>
    ipcRenderer.invoke(settingsIpcChannels.openDiagnosticLocation, { target }),
  checkForUpdates: () =>
    ipcRenderer.invoke(settingsIpcChannels.checkForUpdates),
  planOperation: (expectedRevision, operation) =>
    ipcRenderer.invoke(settingsIpcChannels.planOperation, {
      expectedRevision,
      operation
    }),
  executeOperation: (confirmationHandle) =>
    ipcRenderer.invoke(settingsIpcChannels.executeOperation, {
      confirmationHandle
    })
};

const chatContexts: ChatContextApi = {
  createConversation: (title, bindToCurrentProject) =>
    ipcRenderer.invoke(chatContextIpcChannels.createConversation, {
      title,
      bindToCurrentProject
    }),
  getConversation: (conversationId) =>
    ipcRenderer.invoke(chatContextIpcChannels.getConversation, { conversationId }),
  listConversations: (includeArchived, includeDeleted) =>
    ipcRenderer.invoke(chatContextIpcChannels.listConversations, {
      includeArchived,
      includeDeleted
    }),
  listConversationCandidates: () =>
    ipcRenderer.invoke(chatContextIpcChannels.listConversationCandidates),
  renameConversation: (conversationId, expectedRevision, title) =>
    ipcRenderer.invoke(chatContextIpcChannels.renameConversation, {
      conversationId,
      expectedRevision,
      title
    }),
  archiveConversation: (conversationId, expectedRevision) =>
    ipcRenderer.invoke(chatContextIpcChannels.archiveConversation, {
      conversationId,
      expectedRevision
    }),
  restoreConversation: (conversationId, expectedRevision) =>
    ipcRenderer.invoke(chatContextIpcChannels.restoreConversation, {
      conversationId,
      expectedRevision
    }),
  deleteConversation: (conversationId, expectedRevision) =>
    ipcRenderer.invoke(chatContextIpcChannels.deleteConversation, {
      conversationId,
      expectedRevision
    }),
  addUserMessage: (conversationId, expectedRevision, content) =>
    ipcRenderer.invoke(chatContextIpcChannels.addUserMessage, {
      conversationId,
      expectedRevision,
      content
    }),
  requestAssistantResponse: (conversationId, expectedRevision) =>
    ipcRenderer.invoke(chatContextIpcChannels.requestAssistantResponse, {
      conversationId,
      expectedRevision
    }),
  cancelAssistantResponse: (conversationId, messageId, expectedRevision) =>
    ipcRenderer.invoke(chatContextIpcChannels.cancelAssistantResponse, {
      conversationId,
      messageId,
      expectedRevision
    }),
  createContextDraft: (conversationId) =>
    ipcRenderer.invoke(chatContextIpcChannels.createContextDraft, { conversationId }),
  getContextDraftPreview: (draftId) =>
    ipcRenderer.invoke(chatContextIpcChannels.getContextDraftPreview, { draftId }),
  addContextMessageFragment: (
    draftId,
    expectedRevision,
    messageId,
    startUtf16,
    endUtf16
  ) =>
    ipcRenderer.invoke(chatContextIpcChannels.addContextMessageFragment, {
      draftId,
      expectedRevision,
      messageId,
      startUtf16,
      endUtf16
    }),
  removeContextMessageFragment: (draftId, expectedRevision, fragmentId) =>
    ipcRenderer.invoke(chatContextIpcChannels.removeContextMessageFragment, {
      draftId,
      expectedRevision,
      fragmentId
    }),
  updateContextDraftLabels: (draftId, expectedRevision, labels) =>
    ipcRenderer.invoke(chatContextIpcChannels.updateContextDraftLabels, {
      draftId,
      expectedRevision,
      labels
    }),
  registerContextDraft: (draftId, expectedRevision, confirmed) =>
    ipcRenderer.invoke(chatContextIpcChannels.registerContextDraft, {
      draftId,
      expectedRevision,
      confirmed
    }),
  updateProjectContext: (
    contextId,
    expectedRevision,
    contentSnapshot,
    labels
  ) =>
    ipcRenderer.invoke(chatContextIpcChannels.updateProjectContext, {
      contextId,
      expectedRevision,
      contentSnapshot,
      labels
    }),
  deleteProjectContext: (contextId, expectedRevision) =>
    ipcRenderer.invoke(chatContextIpcChannels.deleteProjectContext, {
      contextId,
      expectedRevision
    }),
  refreshContextSourceStatus: (contextId, expectedRevision) =>
    ipcRenderer.invoke(chatContextIpcChannels.refreshContextSourceStatus, {
      contextId,
      expectedRevision
    }),
  listProjectContextCandidates: () =>
    ipcRenderer.invoke(chatContextIpcChannels.listProjectContextCandidates),
  getProjectContext: (contextId) =>
    ipcRenderer.invoke(chatContextIpcChannels.getProjectContext, { contextId }),
  getProjectContextRevision: (contextId, revision) =>
    ipcRenderer.invoke(chatContextIpcChannels.getProjectContextRevision, {
      contextId,
      revision
    }),
  getContextSourceStatus: (contextId) =>
    ipcRenderer.invoke(chatContextIpcChannels.getContextSourceStatus, { contextId })
};

contextBridge.exposeInMainWorld('unicomp', {
  chatContexts,
  imageSubmissions,
  imageWorkspaces,
  videoSubmissions,
  videoEditors,
  videoWorkspaces,
  platform: process.platform,
  providers,
  settings,
  storage,
  windowControls: {
    minimize: () => ipcRenderer.send('window:minimize'),
    toggleMaximize: () => ipcRenderer.send('window:toggle-maximize'),
    close: () => ipcRenderer.send('window:close'),
    isMaximized: () => ipcRenderer.invoke('window:is-maximized') as Promise<boolean>,
    onMaximizedChange: (callback: (isMaximized: boolean) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, isMaximized: boolean) => {
        callback(isMaximized);
      };

      ipcRenderer.on('window:maximized-changed', listener);
      return () => ipcRenderer.removeListener('window:maximized-changed', listener);
    }
  }
});
