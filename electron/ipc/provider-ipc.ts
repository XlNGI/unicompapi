import { app, ipcMain, safeStorage } from 'electron';
import path from 'node:path';
import {
  JsonProviderRegistryStore,
  ProviderCredentialController,
  ProviderRegistryController,
  SecureCredentialVault
} from '../../src/platform';
import { providerIpcChannels } from '../../src/shared/provider-ipc';

export function registerProviderIpcHandlers(): void {
  const userDataPath = app.getPath('userData');
  const registry = new JsonProviderRegistryStore(
    path.join(userDataPath, 'provider-registry.json')
  );
  const controller = new ProviderRegistryController(registry);
  const credentialController = new ProviderCredentialController(
    registry,
    new SecureCredentialVault(
      path.join(userDataPath, 'secure-credentials.json'),
      {
        isAvailable: () => safeStorage.isEncryptionAvailable(),
        protect: (value) => safeStorage.encryptString(value),
        unprotect: (value) => safeStorage.decryptString(Buffer.from(value))
      }
    )
  );
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
}
