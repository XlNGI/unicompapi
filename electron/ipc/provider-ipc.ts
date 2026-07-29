import { ipcMain } from 'electron';
import {
  type ConnectionValidationPort,
  ProviderCapabilityController,
  ProviderCredentialController,
  ProviderRegistryController
} from '../../src/platform';
import type {
  JsonProviderRegistryStore,
  SecureCredentialVault
} from '../../src/platform';
import { providerIpcChannels } from '../../src/shared/provider-ipc';

export function registerProviderIpcHandlers(options: {
  readonly registry: JsonProviderRegistryStore;
  readonly credentialVault: SecureCredentialVault;
  readonly connectionValidation: ConnectionValidationPort;
}): void {
  const registry = options.registry;
  const controller = new ProviderRegistryController(registry);
  const credentialController = new ProviderCredentialController(
    registry,
    options.credentialVault
  );
  const capabilityController = new ProviderCapabilityController(registry, {
    connectionValidation: options.connectionValidation
  });
  ipcMain.handle(providerIpcChannels.getRegistry, () =>
    controller.getRegistry()
  );
  ipcMain.handle(providerIpcChannels.saveCredential, (_event, input) =>
    credentialController.saveCredential(input)
  );
  ipcMain.handle(providerIpcChannels.deleteLocalCredential, (_event, input) =>
    credentialController.deleteLocalCredential(input)
  );
  ipcMain.handle(providerIpcChannels.getCredentialStatus, (_event, input) =>
    credentialController.getCredentialStatus(input)
  );
  ipcMain.handle(providerIpcChannels.checkCredentialStorage, (_event, input) =>
    credentialController.checkCredentialStorage(input)
  );
  ipcMain.handle(providerIpcChannels.validateConnection, (_event, input) =>
    capabilityController.validateConnection(input)
  );
  ipcMain.handle(providerIpcChannels.syncModelCatalog, (_event, input) =>
    capabilityController.syncModelCatalog(input)
  );
  ipcMain.handle(providerIpcChannels.registerManualModel, (_event, input) =>
    capabilityController.registerManualModel(input)
  );
  ipcMain.handle(providerIpcChannels.validateCapability, (_event, input) =>
    capabilityController.validateCapability(input)
  );
  ipcMain.handle(providerIpcChannels.recordUserCapability, (_event, input) =>
    capabilityController.recordUserCapability(input)
  );
  ipcMain.handle(providerIpcChannels.saveRoutingPreference, (_event, input) =>
    capabilityController.saveRoutingPreference(input)
  );
  ipcMain.handle(providerIpcChannels.planRoute, (_event, input) =>
    capabilityController.planRoute(input)
  );
  ipcMain.handle(providerIpcChannels.createProvider, (_event, input) =>
    capabilityController.createProvider(input)
  );
  ipcMain.handle(providerIpcChannels.createConnection, (_event, input) =>
    capabilityController.createConnection(input)
  );
  ipcMain.handle(providerIpcChannels.updateConnection, (_event, input) =>
    capabilityController.updateConnection(input)
  );
  ipcMain.handle(providerIpcChannels.setConnectionEnabled, (_event, input) =>
    capabilityController.setConnectionEnabled(input)
  );
  ipcMain.handle(providerIpcChannels.deleteConnection, (_event, input) =>
    credentialController.deleteConnection(input)
  );
  ipcMain.handle(providerIpcChannels.setModelEnabled, (_event, input) =>
    capabilityController.setModelEnabled(input)
  );
}
