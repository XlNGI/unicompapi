import { ipcMain } from 'electron';
import {
  ProviderRegistryController,
  type JsonProviderRegistryStore,
  type ProviderManagementFramework
} from '../../src/platform';
import {
  providerIpcChannels,
  type ProviderFrameworkResult,
  type ProviderTemplateSummaryDto
} from '../../src/shared/provider-ipc';

export function registerProviderIpcHandlers(options: {
  readonly registry: JsonProviderRegistryStore;
  readonly management: ProviderManagementFramework;
}): void {
  const registry = new ProviderRegistryController(options.registry);

  ipcMain.handle(providerIpcChannels.getRegistry, () => registry.getRegistry());
  ipcMain.handle(providerIpcChannels.listTemplates, () => listTemplates(options.management));
  ipcMain.handle(providerIpcChannels.createConnection, (_event, input) =>
    options.management.createConnection(input)
  );
  ipcMain.handle(providerIpcChannels.rotateCredential, (_event, input) =>
    options.management.rotateCredential(input)
  );
  ipcMain.handle(providerIpcChannels.validateConnection, (_event, input) =>
    options.management.validateConnection(input)
  );
  ipcMain.handle(providerIpcChannels.syncModelCatalog, (_event, input) =>
    options.management.syncModelCatalog(input)
  );
  ipcMain.handle(providerIpcChannels.registerExactModel, (_event, input) =>
    options.management.registerExactModel(input)
  );
  ipcMain.handle(providerIpcChannels.setConnectionEnabled, (_event, input) =>
    options.management.setConnectionEnabled(input)
  );
  ipcMain.handle(providerIpcChannels.setModelEnabled, (_event, input) =>
    options.management.setModelEnabled(input)
  );
  ipcMain.handle(providerIpcChannels.deleteConnection, (_event, input) =>
    options.management.deleteConnection(input)
  );
}

function listTemplates(
  management: ProviderManagementFramework
): ProviderFrameworkResult<readonly ProviderTemplateSummaryDto[]> {
  try {
    return { ok: true, value: management.listTemplates() };
  } catch {
    return {
      ok: false,
      error: {
        code: 'provider_management_failed',
        message: 'Provider templates are unavailable'
      }
    };
  }
}
