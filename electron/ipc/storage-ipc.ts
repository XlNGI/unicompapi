import { BrowserWindow, dialog, ipcMain } from 'electron';
import {
  StorageIpcController,
  ProjectSessionController,
  StorageProjectSessionRegistry
} from '../../src/platform';
import { storageIpcChannels } from '../../src/shared/storage-ipc';

export function registerStorageIpcHandlers(): void {
  const sessionRegistry = new StorageProjectSessionRegistry();
  const choosePath = async (
    properties: Electron.OpenDialogOptions['properties']
  ) => {
    const window = BrowserWindow.getFocusedWindow();
    const options: Electron.OpenDialogOptions = { properties };
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options);

    return result.canceled ? undefined : result.filePaths[0];
  };
  const controller = new StorageIpcController({
    getSession: () => sessionRegistry.get(),
    chooseRelinkFile: () => choosePath(['openFile']),
    chooseBackupFile: () => choosePath(['openFile'])
  });
  const projectController = new ProjectSessionController({
    registry: sessionRegistry,
    chooseProjectDirectory: () => choosePath(['openDirectory']),
    beforeSessionChange: () => controller.waitForMutations()
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
  ipcMain.handle(storageIpcChannels.restoreBackup, (_event, request: unknown) =>
    controller.restoreBackup(request)
  );
  ipcMain.handle(storageIpcChannels.rebuildIndex, () =>
    controller.rebuildIndex()
  );
  ipcMain.handle(storageIpcChannels.openProject, () =>
    projectController.openProject()
  );
  ipcMain.handle(storageIpcChannels.closeProject, () =>
    projectController.closeProject()
  );
  ipcMain.handle(storageIpcChannels.getProjectSession, () =>
    projectController.getProjectSession()
  );
}
