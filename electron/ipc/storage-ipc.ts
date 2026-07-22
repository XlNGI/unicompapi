import { BrowserWindow, dialog, ipcMain } from 'electron';
import {
  StorageIpcController,
  type StorageProjectSession
} from '../../src/platform';
import { storageIpcChannels } from '../../src/shared/storage-ipc';

let activeProjectSession: StorageProjectSession | undefined;

export function setActiveStorageProjectSession(
  session: StorageProjectSession | undefined
): void {
  activeProjectSession = session;
}

export function registerStorageIpcHandlers(): void {
  const controller = new StorageIpcController({
    getSession: () => activeProjectSession,
    chooseRelinkFile: async () => {
      const window = BrowserWindow.getFocusedWindow();
      const options: Electron.OpenDialogOptions = {
        properties: ['openFile']
      };
      const result = window
        ? await dialog.showOpenDialog(window, options)
        : await dialog.showOpenDialog(options);

      return result.canceled ? undefined : result.filePaths[0];
    }
  });

  ipcMain.handle(storageIpcChannels.probeFile, (_event, request: unknown) =>
    controller.probeFile(request)
  );
  ipcMain.handle(storageIpcChannels.verifyFile, (_event, request: unknown) =>
    controller.verifyFile(request)
  );
  ipcMain.handle(storageIpcChannels.relinkFile, (_event, request: unknown) =>
    controller.relinkFile(request)
  );
  ipcMain.handle(storageIpcChannels.rebuildIndex, () =>
    controller.rebuildIndex()
  );
}
