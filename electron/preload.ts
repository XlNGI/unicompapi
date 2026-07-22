import { contextBridge, ipcRenderer } from 'electron';
import {
  storageRecoveryChannels,
  type StorageRecoveryApi
} from '../src/platform/ipc';

const storageRecovery = {
  probeFile: (request) => ipcRenderer.invoke(storageRecoveryChannels.probe, request),
  verifyFile: (request) => ipcRenderer.invoke(storageRecoveryChannels.verify, request),
  relinkFile: (request) => ipcRenderer.invoke(storageRecoveryChannels.relink, request),
  rebuildFileIndex: (request) =>
    ipcRenderer.invoke(storageRecoveryChannels.rebuildIndex, request)
} satisfies StorageRecoveryApi;

contextBridge.exposeInMainWorld('unicomp', {
  platform: process.platform,
  storageRecovery,
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
