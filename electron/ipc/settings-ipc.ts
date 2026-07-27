import { app, ipcMain } from 'electron';
import path from 'node:path';
import { JsonSettingsRepository, SettingsController } from '../../src/platform';
import { settingsIpcChannels } from '../../src/shared/settings-ipc';

export function registerSettingsIpcHandlers(): void {
  const repository = new JsonSettingsRepository(
    path.join(app.getPath('userData'), 'settings', 'settings.json')
  );
  const controller = new SettingsController(repository);

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
  ipcMain.handle(settingsIpcChannels.planOperation, (_event, input) =>
    controller.planOperation(input)
  );
  ipcMain.handle(settingsIpcChannels.executeOperation, (_event, input) =>
    controller.executeOperation(input)
  );
}
