import { app, dialog, ipcMain, safeStorage } from 'electron';
import path from 'node:path';
import {
  CleanupService,
  ApplicationDataService,
  DirectoryMigrationService,
  DiagnosticsService,
  JsonDirectoryRegistry,
  JsonSettingsRepository,
  MediaSettingsStatusService,
  NotificationService,
  PerformancePolicyService,
  PrivacyPermissionService,
  ProxyService,
  SecureCredentialVault,
  ShortcutService,
  SettingsController,
  UpdatesService
} from '../../src/platform';
import {
  directoryPurposes,
  settingsIpcChannels
} from '../../src/shared/settings-ipc';
import {
  ElectronNotificationAdapter,
  ElectronDiagnosticLocationAdapter,
  ElectronDirectoryAuthorizationAdapter,
  ElectronPermissionAdapter,
  ElectronProxyAdapter,
  ElectronShortcutAdapter,
  enforceMinimumRendererPermissions
} from './settings-platform-adapters';

export interface SettingsIpcLifecycle {
  activate(): Promise<void>;
  getRuntimePolicy(): Promise<{
    readonly continueInBackground: boolean;
    readonly preventSleepWhileActive: boolean;
    readonly pauseOnLowBattery: boolean;
  }>;
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
  const directoryAuthorization = new ElectronDirectoryAuthorizationAdapter();
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
      directoryAuthorization,
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
    },
    {
      diagnostics: new DiagnosticsService(
        userDataPath,
        undefined,
        new ElectronDiagnosticLocationAdapter(userDataPath)
      ),
      updates: new UpdatesService(app.getVersion()),
      applicationData: new ApplicationDataService(userDataPath)
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
      properties: ['openDirectory', 'createDirectory'],
      securityScopedBookmarks: process.platform === 'darwin'
    });
    if (selected.canceled || selected.filePaths.length !== 1) {
      return { ok: true as const, value: null };
    }
    const bookmark = selected.bookmarks?.[0];
    return controller.registerSelectedDirectory(
      purpose,
      selected.filePaths[0],
      bookmark
        ? { kind: 'macos_security_scoped_bookmark', bookmark }
        : { kind: 'native_picker' }
    );
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
  ipcMain.handle(settingsIpcChannels.getMaintenanceStatus, () =>
    controller.getMaintenanceStatus()
  );
  ipcMain.handle(settingsIpcChannels.previewDiagnosticBundle, () =>
    controller.previewDiagnosticBundle()
  );
  ipcMain.handle(settingsIpcChannels.generateDiagnosticBundle, async () => {
    const selected = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
      title: '选择诊断包保存位置'
    });
    if (selected.canceled || selected.filePaths.length !== 1) {
      return { ok: true as const, value: null };
    }
    return controller.generateDiagnosticBundle(selected.filePaths[0]);
  });
  ipcMain.handle(settingsIpcChannels.openDiagnosticLocation, (_event, input) => {
    const target = input && typeof input === 'object' && 'target' in input
      ? input.target
      : undefined;
    return controller.openDiagnosticLocation(target);
  });
  ipcMain.handle(settingsIpcChannels.checkForUpdates, () =>
    controller.checkForUpdates()
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
    async getRuntimePolicy() {
      const current = await repository.load();
      return {
        continueInBackground: current.document.performance.continueInBackground,
        preventSleepWhileActive: current.document.performance.preventSleepWhileActive,
        pauseOnLowBattery: current.document.performance.pauseOnLowBattery
      };
    },
    dispose() {
      shortcuts.release();
      directoryAuthorization.dispose();
      proxy.dispose();
      proxyAdapter.dispose();
    }
  };
}
