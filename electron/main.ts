import {
  app,
  BrowserWindow,
  ipcMain,
  powerMonitor,
  powerSaveBlocker,
  protocol,
  shell
} from 'electron';
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { registerStorageIpcHandlers } from './ipc/storage-ipc';
import { registerProviderIpcHandlers } from './ipc/provider-ipc';
import { registerSettingsIpcHandlers } from './ipc/settings-ipc';
import { registerChatContextIpcHandlers } from './ipc/chat-context-ipc';
import {
  deepSeekProviderPackageDescriptor,
  JsonProviderManagementAuditStore,
  JsonRuntimeAuthorizationLedgerStore,
  klingProviderPackageDescriptor,
  newApiProviderPackageDescriptor,
  normalizeTrustedExternalUrl,
  unicompapiProviderPackageDescriptor,
  ProviderManagementAdapterRegistry,
  ProviderManagementFramework,
  ProviderPackageRegistry,
  RuntimeAuthorizationLedger,
  StorageProjectSessionRegistry,
  viduProviderPackageDescriptor,
  volcengineProviderPackageDescriptor
} from '../src/platform';
import { ElectronViduComposition } from './ipc/vidu-composition';
import { createLiveProviderManagementComposition } from './ipc/management-adapters';
import { LedgerRuntimeAuthorizationSync } from './ipc/runtime-authorization-sync';
import { createLocalMediaResponse } from './ipc/local-media-response';
import {
  autosaveDiagnosticsIpcChannel,
  isAutosaveDiagnosticsEvent
} from '../src/shared/autosave-diagnostics-ipc';

const isDev = Boolean(process.env.VITE_DEV_SERVER_URL);
const isMac = process.platform === 'darwin';
const rendererTraceEnabled = isDev || process.env.UNICOMP_RENDERER_TRACE === '1';

async function appendRendererTraceLine(line: string): Promise<void> {
  const logsDirectory = path.join(app.getPath('userData'), 'logs');
  await mkdir(logsDirectory, { recursive: true });
  await appendFile(path.join(logsDirectory, 'renderer-trace.log'), `${line}\n`, 'utf8');
}

let autosaveLogQueue: Promise<void> = Promise.resolve();
ipcMain.on(autosaveDiagnosticsIpcChannel, (_event, value: unknown) => {
  if (!isAutosaveDiagnosticsEvent(value)) return;
  const line = `${JSON.stringify({
    at: new Date().toISOString(),
    category: 'autosave',
    level: value.phase === 'failed' || value.phase === 'conflict' ? 'error' : 'info',
    ...value
  })}\n`;
  autosaveLogQueue = autosaveLogQueue.then(async () => {
    const logsDirectory = path.join(app.getPath('userData'), 'logs');
    await mkdir(logsDirectory, { recursive: true });
    await appendFile(path.join(logsDirectory, 'autosave.log'), line, 'utf8');
  }).catch(() => undefined);
});

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'unicomp-media',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true
    }
  }
]);

let sleepBlockerId: number | undefined;
let powerPolicyRead = Promise.resolve();
const settingsLifecycle = registerSettingsIpcHandlers();
const viduComposition = new ElectronViduComposition({
  getProxyMode: () => settingsLifecycle.getProxyMode()
});
const providerPackages = new ProviderPackageRegistry([
  deepSeekProviderPackageDescriptor,
  volcengineProviderPackageDescriptor,
  klingProviderPackageDescriptor,
  newApiProviderPackageDescriptor,
  unicompapiProviderPackageDescriptor,
  viduProviderPackageDescriptor
]);
const runtimeAuthorizationLedger = new RuntimeAuthorizationLedger(
  new JsonRuntimeAuthorizationLedgerStore(
    path.join(app.getPath('userData'), 'runtime-authorization-ledger.json')
  )
);
const runtimeAuthorizationSync = new LedgerRuntimeAuthorizationSync(
  runtimeAuthorizationLedger
);
const liveProviders = createLiveProviderManagementComposition({
  getProxyMode: () => settingsLifecycle.getProxyMode()
});
const providerManagement = new ProviderManagementFramework(
  providerPackages,
  viduComposition.registry,
  viduComposition.credentialVault,
  new ProviderManagementAdapterRegistry(
    providerPackages,
    liveProviders.adapters
  ),
  new JsonProviderManagementAuditStore(
    path.join(app.getPath('userData'), 'provider-management-audit.json')
  ),
  { runtimeAuthorization: runtimeAuthorizationSync }
);
const projectSessionRegistry = new StorageProjectSessionRegistry();
const chatContextLifecycle = registerChatContextIpcHandlers({
  getSession: () => projectSessionRegistry.get(),
  providerRegistry: viduComposition.registry,
  providerPackages,
  runtimeAuthorization: runtimeAuthorizationLedger,
  textSubmission: {
    credentialVault: viduComposition.credentialVault,
    deepSeekRuntime: liveProviders.deepSeekRuntime,
    newApiRuntime: liveProviders.newApiRuntime
  }
});
const storageLifecycle = registerStorageIpcHandlers({
  sessionRegistry: projectSessionRegistry,
  providerPackages,
  additionalSessionChangeGuards: [chatContextLifecycle.waitForMutations],
  vidu: viduComposition,
  runtimeAuthorization: runtimeAuthorizationLedger,
  textSubmission: {
    credentialVault: viduComposition.credentialVault,
    deepSeekRuntime: liveProviders.deepSeekRuntime,
    newApiRuntime: liveProviders.newApiRuntime,
    newApiImageDownloads: liveProviders.newApiImageDownloads
  },
  onActiveExportCountChanged: (count) => {
    powerPolicyRead = powerPolicyRead
      .then(async () => {
        const policy = await settingsLifecycle.getRuntimePolicy();
        updateSleepBlocker(count > 0 && policy.preventSleepWhileActive);
      })
      .catch(() => updateSleepBlocker(false));
  }
});
registerProviderIpcHandlers({
  registry: viduComposition.registry,
  management: providerManagement
});

function getWindowFromEvent(event: { sender: Electron.WebContents }): BrowserWindow | null {
  return BrowserWindow.fromWebContents(event.sender);
}

ipcMain.on('window:minimize', (event) => {
  getWindowFromEvent(event)?.minimize();
});

ipcMain.on('window:toggle-maximize', (event) => {
  const window = getWindowFromEvent(event);

  if (!window) {
    return;
  }

  if (window.isFullScreen()) {
    window.setFullScreen(false);
    return;
  }

  if (window.isMaximized()) {
    window.unmaximize();
    return;
  }

  window.maximize();
});

ipcMain.on('window:close', (event) => {
  getWindowFromEvent(event)?.close();
});

ipcMain.handle('window:is-maximized', (event) => {
  const window = getWindowFromEvent(event);
  return window ? window.isMaximized() || window.isFullScreen() : false;
});

function createMainWindow(): BrowserWindow {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 800,
    minHeight: 720,
    show: false,
    title: 'UniComp',
    backgroundColor: '#0B0F17',
    frame: isMac,
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void openTrustedExternalUrl(url);
    return { action: 'deny' };
  });
  if (rendererTraceEnabled) {
    mainWindow.webContents.on('console-message', (_event, ...args: unknown[]) => {
      const first = args[0];
      const details = first && typeof first === 'object'
        ? first as { level?: unknown; source?: unknown; lineNumber?: unknown; message?: unknown }
        : undefined;
      const level = details?.level ?? args[0] ?? '';
      const message = details?.message ?? args[1] ?? '';
      const source = details?.source ?? 'console-api';
      const line = details?.lineNumber ?? args[2] ?? 0;
      const lineText = `[renderer-console] ${level}:${source}:${line} ${message}`;
      console.log(lineText);
      void appendRendererTraceLine(lineText).catch(() => undefined);
    });
  }

  const sendMaximizedState = () => {
    mainWindow.webContents.send('window:maximized-changed', mainWindow.isMaximized());
  };

  mainWindow.on('maximize', sendMaximizedState);
  mainWindow.on('unmaximize', sendMaximizedState);
  mainWindow.on('enter-full-screen', sendMaximizedState);
  mainWindow.on('leave-full-screen', sendMaximizedState);
  mainWindow.on('closed', () => {
    if (!isMac) return;
    void settingsLifecycle.getRuntimePolicy()
      .then((policy) => policy.continueInBackground
        ? undefined
        : storageLifecycle.interruptActiveExports('background_processing_disabled'))
      .catch(() => undefined);
  });
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.focus();
  });

  if (isDev && process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, '../../dist/index.html'));
  }

  return mainWindow;
}

app.whenReady().then(async () => {
  await settingsLifecycle.activate();
  const registrySnapshot = await viduComposition.registry.load();
  await runtimeAuthorizationSync.reconcileConnections(registrySnapshot.connections);
  protocol.handle('unicomp-media', async (request) => {
    try {
      const url = new URL(request.url);
      const token = url.hostname === 'local' ? url.pathname.slice(1) : '';
      const entry = token ? storageLifecycle.resolveEntry(token) : undefined;
      if (!entry) {
        return new Response('Media handle not found', { status: 404 });
      }

      return await createLocalMediaResponse(
        entry.target,
        entry.mimeType,
        request.method,
        request.headers.get('range') ?? undefined
      );
    } catch {
      return new Response('Media handle unavailable', { status: 500 });
    }
  });
  createMainWindow();

  powerMonitor.on('suspend', () => {
    void storageLifecycle.interruptActiveExports('system_suspend').catch(() => undefined);
  });
  powerMonitor.on('lock-screen', () => {
    void storageLifecycle.interruptActiveExports('screen_locked').catch(() => undefined);
  });

  app.on('activate', () => {
    const [mainWindow] = BrowserWindow.getAllWindows();
    if (!mainWindow) {
      createMainWindow();
      return;
    }
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
});

let cleanupStarted = false;
let cleanupCompleted = false;
app.on('before-quit', (event) => {
  if (cleanupCompleted) return;
  event.preventDefault();
  if (cleanupStarted) return;
  cleanupStarted = true;
  void Promise.all([
    storageLifecycle.dispose(),
    chatContextLifecycle.interruptActiveResponses(),
    chatContextLifecycle.waitForMutations()
  ]).finally(() => {
    viduComposition.dispose();
    settingsLifecycle.dispose();
    updateSleepBlocker(false);
    cleanupCompleted = true;
    app.quit();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

function updateSleepBlocker(required: boolean): void {
  if (required) {
    if (sleepBlockerId === undefined || !powerSaveBlocker.isStarted(sleepBlockerId)) {
      sleepBlockerId = powerSaveBlocker.start('prevent-app-suspension');
    }
    return;
  }
  if (sleepBlockerId !== undefined && powerSaveBlocker.isStarted(sleepBlockerId)) {
    powerSaveBlocker.stop(sleepBlockerId);
  }
  sleepBlockerId = undefined;
}

async function openTrustedExternalUrl(rawUrl: string): Promise<void> {
  const trustedUrl = normalizeTrustedExternalUrl(rawUrl);
  if (!trustedUrl) return;
  await shell.openExternal(trustedUrl).catch(() => undefined);
}
