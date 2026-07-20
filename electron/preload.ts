import { contextBridge } from 'electron';

contextBridge.exposeInMainWorld('unicomp', {
  platform: process.platform
});
