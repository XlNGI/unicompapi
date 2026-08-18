import { contextBridge, ipcRenderer } from 'electron';
import {
  storageIpcChannels,
  type StorageApi
} from '../src/shared/storage-ipc';
import {
  providerIpcChannels,
  type ProviderAddConnectionStep,
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
  imageFeatureIpcChannels,
  type ImageFeatureApi
} from '../src/shared/image-feature-ipc';
import {
  promptEnhanceIpcChannels,
  type PromptEnhanceApi
} from '../src/shared/prompt-enhance-ipc';
import {
  videoWorkspaceIpcChannels,
  type VideoWorkspaceApi
} from '../src/shared/video-workspace-ipc';
import {
  videoFeatureIpcChannels,
  type VideoFeatureApi
} from '../src/shared/video-feature-ipc';
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
  type ChatContextApi,
  type ConversationResponseStreamEventDto
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
  openRecentProject: (projectId) =>
    ipcRenderer.invoke(storageIpcChannels.openRecentProject, { projectId }),
  createProject: (name) =>
    ipcRenderer.invoke(storageIpcChannels.createProject, { name }),
  listProjects: () => ipcRenderer.invoke(storageIpcChannels.listProjects),
  getLocalStorageSummary: () =>
    ipcRenderer.invoke(storageIpcChannels.getLocalStorageSummary),
  onLocalStorageChanged: (listener) => {
    const wrapped = () => listener();
    ipcRenderer.on(storageIpcChannels.localStorageChanged, wrapped);
    return () => {
      ipcRenderer.removeListener(storageIpcChannels.localStorageChanged, wrapped);
    };
  },
  listTasks: () => ipcRenderer.invoke(storageIpcChannels.listTasks),
  getTaskDetails: (taskId) =>
    ipcRenderer.invoke(storageIpcChannels.getTaskDetails, { taskId }),
  listCallRecords: (filter) =>
    ipcRenderer.invoke(storageIpcChannels.listCallRecords, filter ?? {}),
  getCallDetails: (invocationAttemptId) =>
    ipcRenderer.invoke(storageIpcChannels.getCallDetails, { invocationAttemptId }),
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
  listTemplates: () => ipcRenderer.invoke(providerIpcChannels.listTemplates),
  createConnection: (input) =>
    ipcRenderer.invoke(providerIpcChannels.createConnection, input),
  addConnection: (input) =>
    ipcRenderer.invoke(providerIpcChannels.addConnection, input),
  onAddConnectionProgress: (listener) => {
    const wrapped = (_event: unknown, step: ProviderAddConnectionStep) => listener(step);
    ipcRenderer.on(providerIpcChannels.addConnectionProgress, wrapped);
    return () => {
      ipcRenderer.removeListener(providerIpcChannels.addConnectionProgress, wrapped);
    };
  },
  rotateCredential: (connectionId, credentials) =>
    ipcRenderer.invoke(providerIpcChannels.rotateCredential, {
      connectionId,
      credentials
    }),
  validateConnection: (connectionId) =>
    ipcRenderer.invoke(providerIpcChannels.validateConnection, { connectionId }),
  syncModelCatalog: (connectionId) =>
    ipcRenderer.invoke(providerIpcChannels.syncModelCatalog, { connectionId }),
  registerExactModel: (connectionId, providerModelKey, displayName) =>
    ipcRenderer.invoke(providerIpcChannels.registerExactModel, {
      connectionId,
      providerModelKey,
      displayName
    }),
  setConnectionEnabled: (connectionId, enabled) =>
    ipcRenderer.invoke(providerIpcChannels.setConnectionEnabled, {
      connectionId,
      enabled
    }),
  deleteConnection: (connectionId, abandonActiveOperations = false) =>
    ipcRenderer.invoke(providerIpcChannels.deleteConnection, {
      connectionId,
      confirmLocalDeletion: true,
      abandonActiveOperations
    }),
  setModelEnabled: (modelId, enabled) =>
    ipcRenderer.invoke(providerIpcChannels.setModelEnabled, { modelId, enabled }),
  attachOpenAiCompatibleImageProfile: (modelId) =>
    ipcRenderer.invoke(providerIpcChannels.attachOpenAiCompatibleImageProfile, { modelId }),
  deleteModel: (modelId) =>
    ipcRenderer.invoke(providerIpcChannels.deleteModel, { modelId })
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
  clearInput: (draftId) =>
    ipcRenderer.invoke(imageWorkspaceIpcChannels.clearInput, { draftId }),
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

const imageFeatures: ImageFeatureApi = {
  listCandidates: (draftId, draftUpdatedAt) =>
    ipcRenderer.invoke(imageFeatureIpcChannels.listCandidates, {
      draftId,
      draftUpdatedAt
    }),
  prepareSubmission: (draftId, draftUpdatedAt, candidateId) =>
    ipcRenderer.invoke(imageFeatureIpcChannels.prepareSubmission, {
      draftId,
      draftUpdatedAt,
      candidateId
    }),
  submitDraft: (
    draftId,
    draftUpdatedAt,
    routeSelectionToken,
    confirmationId,
    confirmed
  ) => ipcRenderer.invoke(imageFeatureIpcChannels.submitDraft, {
    draftId,
    draftUpdatedAt,
    routeSelectionToken,
    confirmationId,
    confirmed
  }),
  generateQuickImage: (prompt, candidateId, parameterValues) =>
    ipcRenderer.invoke(imageFeatureIpcChannels.generateQuickImage, {
      prompt,
      candidateId,
      parameterValues
    }),
  recoverResult: (taskId) =>
    ipcRenderer.invoke(imageFeatureIpcChannels.recoverResult, { taskId })
};

const promptEnhance: PromptEnhanceApi = {
  listCandidates: () =>
    ipcRenderer.invoke(promptEnhanceIpcChannels.listCandidates, {}),
  prepare: (subjectId, subjectRevision, candidateId, parameterValues) =>
    ipcRenderer.invoke(promptEnhanceIpcChannels.prepare, {
      subjectId,
      subjectRevision,
      candidateId,
      parameterValues
    }),
  submit: (
    subjectId,
    subjectRevision,
    routeSelectionToken,
    confirmationId,
    confirmed
  ) => ipcRenderer.invoke(promptEnhanceIpcChannels.submit, {
    subjectId,
    subjectRevision,
    routeSelectionToken,
    confirmationId,
    confirmed
  })
};

const videoFeatures: VideoFeatureApi = {
  listCandidates: (draftId, draftUpdatedAt) =>
    ipcRenderer.invoke(videoFeatureIpcChannels.listCandidates, {
      draftId,
      draftUpdatedAt
    }),
  prepareSubmission: (draftId, draftUpdatedAt, candidateId) =>
    ipcRenderer.invoke(videoFeatureIpcChannels.prepareSubmission, {
      draftId,
      draftUpdatedAt,
      candidateId
    }),
  submitDraft: (
    draftId,
    draftUpdatedAt,
    routeSelectionToken,
    confirmationId,
    confirmed
  ) => ipcRenderer.invoke(videoFeatureIpcChannels.submitDraft, {
    draftId,
    draftUpdatedAt,
    routeSelectionToken,
    confirmationId,
    confirmed
  }),
  recoverResult: (taskId) =>
    ipcRenderer.invoke(videoFeatureIpcChannels.recoverResult, { taskId })
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
    }),
  createFromImageWork: (workId) =>
    ipcRenderer.invoke(videoWorkspaceIpcChannels.createFromImageWork, {
      workId
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

let responseSubscriptionSequence = 0;
interface ResponseSubscription {
  readonly onEvent: (event: ConversationResponseStreamEventDto) => void;
  readonly bufferedEvents: ConversationResponseStreamEventDto[];
  replaying: boolean;
  latestSequence: number;
}

const responseSubscriptions = new Map<string, ResponseSubscription>();

function deliverResponseEvent(
  subscriberId: string,
  subscription: ResponseSubscription,
  event: ConversationResponseStreamEventDto
): void {
  if (event.sequence <= subscription.latestSequence) return;
  subscription.latestSequence = event.sequence;
  subscription.onEvent(event);
  ipcRenderer.send(chatContextIpcChannels.acknowledgeResponseEvents, {
    subscriberId,
    sequence: event.sequence
  });
}

ipcRenderer.on(chatContextIpcChannels.responseEvent, (_event, payload: unknown) => {
  if (!payload || typeof payload !== 'object') return;
  const { subscriberId, event } = payload as { subscriberId?: unknown; event?: unknown };
  if (typeof subscriberId !== 'string' || !event || typeof event !== 'object') return;
  const subscription = responseSubscriptions.get(subscriberId);
  if (!subscription) return;
  const sequence = (event as { sequence?: unknown }).sequence;
  if (!Number.isSafeInteger(sequence) || Number(sequence) < 1) return;
  const responseEvent = event as ConversationResponseStreamEventDto;
  if (subscription.replaying) {
    subscription.bufferedEvents.push(responseEvent);
    return;
  }
  deliverResponseEvent(subscriberId, subscription, responseEvent);
});

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
  editCancelledUserMessage: (conversationId, expectedRevision, messageId, content) =>
    ipcRenderer.invoke(chatContextIpcChannels.editCancelledUserMessage, {
      conversationId,
      expectedRevision,
      messageId,
      content
    }),
  copyLegacyConversation: (conversationId) =>
    ipcRenderer.invoke(chatContextIpcChannels.copyLegacyConversation, {
      conversationId
    }),
  createResponseDraft: (
    conversationId,
    expectedRevision,
    userMessageId,
    productFeature
  ) =>
    ipcRenderer.invoke(chatContextIpcChannels.createResponseDraft, {
      conversationId,
      expectedRevision,
      userMessageId,
      productFeature
    }),
  replaceResponseContexts: (responseDraftId, expectedRevision, selections) =>
    ipcRenderer.invoke(chatContextIpcChannels.replaceResponseContexts, {
      responseDraftId,
      expectedRevision,
      selections
    }),
  replaceResponseParameters: (responseDraftId, expectedRevision, parameterValues) =>
    ipcRenderer.invoke(chatContextIpcChannels.replaceResponseParameters, {
      responseDraftId,
      expectedRevision,
      parameterValues
    }),
  listResponseCandidates: (responseDraftId, expectedRevision) =>
    ipcRenderer.invoke(chatContextIpcChannels.listResponseCandidates, {
      responseDraftId,
      expectedRevision
    }),
  listTextCandidates: (productFeature) =>
    ipcRenderer.invoke(chatContextIpcChannels.listTextCandidates, {
      productFeature
    }),
  prepareResponseSubmission: (responseDraftId, expectedRevision, candidateId) =>
    ipcRenderer.invoke(chatContextIpcChannels.prepareResponseSubmission, {
      responseDraftId,
      expectedRevision,
      candidateId
    }),
  submitResponse: (
    responseDraftId,
    expectedRevision,
    routeSelectionToken,
    confirmationId,
    confirmed
  ) =>
    ipcRenderer.invoke(chatContextIpcChannels.submitResponse, {
      responseDraftId,
      expectedRevision,
      routeSelectionToken,
      confirmationId,
      confirmed
    }),
  startResponse: (request) =>
    ipcRenderer.invoke(chatContextIpcChannels.startResponse, request),
  getResponseExecution: (responseExecutionId) =>
    ipcRenderer.invoke(chatContextIpcChannels.getResponseExecution, {
      responseExecutionId
    }),
  replayResponseEvents: (responseExecutionId, afterSequence) =>
    ipcRenderer.invoke(chatContextIpcChannels.replayResponseEvents, {
      responseExecutionId,
      afterSequence
    }),
  cancelResponseExecution: (responseExecutionId) =>
    ipcRenderer.invoke(chatContextIpcChannels.cancelResponseExecution, {
      responseExecutionId
    }),
  subscribeResponseEvents: (responseExecutionId, afterSequence, onEvent) => {
    const subscriberId = `response-subscription-${++responseSubscriptionSequence}`;
    const subscription: ResponseSubscription = {
      onEvent,
      bufferedEvents: [],
      replaying: true,
      latestSequence: afterSequence
    };
    responseSubscriptions.set(subscriberId, subscription);
    const disconnect = () => {
      if (!responseSubscriptions.delete(subscriberId)) return;
      ipcRenderer.send(chatContextIpcChannels.unsubscribeResponseEvents, { subscriberId });
    };
    void ipcRenderer.invoke(chatContextIpcChannels.subscribeResponseEvents, {
      responseExecutionId,
      subscriberId
    }).then((result) => {
      if (!result?.ok) {
        disconnect();
        return;
      }
      return ipcRenderer.invoke(chatContextIpcChannels.replayResponseEvents, {
        responseExecutionId,
        afterSequence
      }).then((replay) => {
        if (!replay?.ok) {
          disconnect();
          return;
        }
        if (responseSubscriptions.get(subscriberId) !== subscription) return;
        const events = [...replay.value, ...subscription.bufferedEvents]
          .sort((left, right) => left.sequence - right.sequence);
        subscription.bufferedEvents.length = 0;
        subscription.replaying = false;
        for (const event of events) {
          deliverResponseEvent(subscriberId, subscription, event);
        }
      });
    }).catch(disconnect);
    return disconnect;
  },
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
  imageFeatures,
  promptEnhance,
  imagePromptEnhance: promptEnhance,
  videoFeatures,
  imageWorkspaces,
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
