import { app, dialog, ipcMain } from 'electron';
import path from 'node:path';
import {
  CleanupService,
  DirectoryMigrationService,
  JsonDirectoryRegistry,
  JsonSettingsRepository,
  MediaSettingsStatusService,
  PerformancePolicyService,
  SettingsController
} from '../../src/platform';
import {
  directoryPurposes,
  settingsIpcChannels
} from '../../src/shared/settings-ipc';

export function registerSettingsIpcHandlers(): void {
  const userDataPath = app.getPath('userData');
  const repository = new JsonSettingsRepository(
    path.join(userDataPath, 'settings', 'settings.json')
  );
  const directoryRegistry = new JsonDirectoryRegistry(
    path.join(userDataPath, 'settings', 'directories.json')
  );
  const controller = new SettingsController(
    repository,
    undefined,
    undefined,
    undefined,
    {
      userDataPath,
      directoryRegistry,
      directoryMigration: new DirectoryMigrationService(directoryRegistry),
      cleanup: new CleanupService(userDataPath, directoryRegistry),
      performance: new PerformancePolicyService(),
      media: new MediaSettingsStatusService()
    }
  );

  ipcMain.handle(settingsIpcChannels.getSnapshot, () =>
    controller.getSnapshot()
  );
  ipcMain.handle(settingsIpcChannels.updateValues, (_event, input) =>
    controller.updateValues(input)
  );
  ipcMain.handle(settingsIpcChannels.exportPortable, () =>
    controller.exportPortable()
  );
  ipcMain.handle(settingsIpcChannels.prepareImport, (_event, input) =>
    controller.prepareImport(input)
  );
  ipcMain.handle(settingsIpcChannels.getSystemStatus, () =>
    controller.getSystemStatus()
  );
  ipcMain.handle(settingsIpcChannels.selectDirectory, async (_event, input) => {
    const purpose = input && typeof input === 'object' && 'purpose' in input
      ? input.purpose
      : undefined;
    if (!directoryPurposes.includes(purpose as (typeof directoryPurposes)[number])) {
      return {
        ok: false as const,
        error: { code: 'invalid_request' as const, message: 'Directory purpose is invalid' }
      };
    }
    const selected = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory']
    });
    if (selected.canceled || selected.filePaths.length !== 1) {
      return { ok: true as const, value: null };
    }
    return controller.registerSelectedDirectory(purpose, selected.filePaths[0]);
  });
  ipcMain.handle(settingsIpcChannels.planOperation, (_event, input) =>
    controller.planOperation(input)
  );
  ipcMain.handle(settingsIpcChannels.executeOperation, (_event, input) =>
    controller.executeOperation(input)
  );
}
