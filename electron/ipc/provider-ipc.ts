import { app, ipcMain } from 'electron';
import path from 'node:path';
import {
  JsonProviderRegistryStore,
  ProviderRegistryController
} from '../../src/platform';
import { providerIpcChannels } from '../../src/shared/provider-ipc';

export function registerProviderIpcHandlers(): void {
  const controller = new ProviderRegistryController(
    new JsonProviderRegistryStore(
      path.join(app.getPath('userData'), 'provider-registry.json')
    )
  );
  ipcMain.handle(providerIpcChannels.getRegistry, () =>
    controller.getRegistry()
  );
}
