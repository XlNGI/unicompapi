import { app, dialog, ipcMain, safeStorage } from 'electron';
import path from 'node:path';
import {
  CleanupService,
  DirectoryMigrationService,
  JsonDirectoryRegistry,
  JsonSettingsRepository,
  MediaSettingsStatusService,
  NotificationService,
  PerformancePolicyService,
  PrivacyPermissionService,
  ProxyService,
  SecureCredentialVault,
  ShortcutService,
  SettingsController
} from '../../src/platform';
import {
  directoryPurposes,
  settingsIpcChannels
} from '../../src/shared/settings-ipc';
import {
  ElectronNotificationAdapter,
  ElectronPermissionAdapter,
  ElectronProxyAdapter,
  ElectronShortcutAdapter,
  enforceMinimumRendererPermissions
} from './settings-platform-adapters';

export interface SettingsIpcLifecycle {
  activate(): Promise<void>;
  dispose(): void;
}

export function registerSettingsIpcHandlers(): SettingsIpcLifecycle {
  const userDataPath = app.getPath('userData');
  const repository = new JsonSettingsRepository(
    path.join(userDataPath, 'settings', 'settings.json')
  );
  const directoryRegistry = new JsonDirectoryRegistry(
    path.join(userDataPath, 'settings', 'directories.json')
  );
  const proxyAdapter = new ElectronProxyAdapter();
  const proxy = new ProxyService(
    proxyAdapter,
    new SecureCredentialVault(
      path.join(userDataPath, 'settings', 'proxy-credentials.json'),
      {
        isAvailable: () => safeStorage.isEncryptionAvailable(),
        protect: (value) => safeStorage.encryptString(value),
        unprotect: (value) => safeStorage.decryptString(Buffer.from(value))
      }
    )
  );
  const shortcuts = new ShortcutService(
    process.platform === 'darwin' ? 'macos' : 'windows',
    new ElectronShortcutAdapter()
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
    },
    {
      privacy: new PrivacyPermissionService(new ElectronPermissionAdapter()),
      proxy,
      notifications: new NotificationService(new ElectronNotificationAdapter()),
      shortcuts
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
  ipcMain.handle(settingsIpcChannels.openSystemSettings, (_event, input) => {
    const target = input && typeof input === 'object' && 'target' in input
      ? input.target
      : undefined;
    return controller.openSystemSettings(target);
  });
  ipcMain.handle(settingsIpcChannels.sendTestNotification, (_event, input) => {
    const system = input && typeof input === 'object' && 'system' in input
      ? input.system
      : undefined;
    const sound = input && typeof input === 'object' && 'sound' in input
      ? input.sound
      : undefined;
    return controller.sendTestNotification(system, sound);
  });
  ipcMain.handle(settingsIpcChannels.stageProxyCredential, (_event, input) =>
    controller.stageProxyCredential(input)
  );
  ipcMain.handle(settingsIpcChannels.planOperation, (_event, input) =>
    controller.planOperation(input)
  );
  ipcMain.handle(settingsIpcChannels.executeOperation, (_event, input) =>
    controller.executeOperation(input)
  );

  return {
    async activate() {
      enforceMinimumRendererPermissions();
      let current;
      try {
        current = await repository.load();
      } catch {
        return;
      }
      await Promise.allSettled([
        proxy.activate(current.document.network.proxy),
        shortcuts.activate(current.document.shortcuts)
      ]);
    },
    dispose() {
      shortcuts.release();
      proxy.dispose();
      proxyAdapter.dispose();
    }
  };
}
