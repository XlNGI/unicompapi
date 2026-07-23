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
    })
};

contextBridge.exposeInMainWorld('unicomp', {
  imageWorkspaces,
  platform: process.platform,
  providers,
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
