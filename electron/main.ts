import {
  app,
  BrowserWindow,
  ipcMain,
  net,
  powerMonitor,
  powerSaveBlocker,
  protocol,
  shell
} from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { registerStorageIpcHandlers } from './ipc/storage-ipc';
import { registerProviderIpcHandlers } from './ipc/provider-ipc';
import { registerSettingsIpcHandlers } from './ipc/settings-ipc';
import { registerChatContextIpcHandlers } from './ipc/chat-context-ipc';
import {
  deepSeekProviderPackageDescriptor,
  JsonProviderManagementAuditStore,
  JsonConnectionOutboundAuthorizationStore,
  klingProviderPackageDescriptor,
  newApiProviderPackageDescriptor,
  normalizeTrustedExternalUrl,
  ProviderManagementAdapterRegistry,
  ProviderManagementFramework,
  ProviderPackageRegistry,
  StorageProjectSessionRegistry,
  viduProviderPackageDescriptor,
  volcengineProviderPackageDescriptor
} from '../src/platform';
import { ElectronViduComposition } from './ipc/vidu-composition';

const isDev = Boolean(process.env.VITE_DEV_SERVER_URL);
const isMac = process.platform === 'darwin';

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
  viduProviderPackageDescriptor
]);
const providerManagement = new ProviderManagementFramework(
  providerPackages,
  viduComposition.registry,
  viduComposition.credentialVault,
  new ProviderManagementAdapterRegistry(providerPackages, []),
  new JsonProviderManagementAuditStore(
    path.join(app.getPath('userData'), 'provider-management-audit.json')
  )
);
const connectionAuthorizations = new JsonConnectionOutboundAuthorizationStore(
  path.join(app.getPath('userData'), 'connection-outbound-authorizations.json')
);
const projectSessionRegistry = new StorageProjectSessionRegistry();
const chatContextLifecycle = registerChatContextIpcHandlers({
  getSession: () => projectSessionRegistry.get(),
  providerRegistry: viduComposition.registry,
  providerPackages,
  connectionAuthorizations
});
const storageLifecycle = registerStorageIpcHandlers({
  sessionRegistry: projectSessionRegistry,
  providerPackages,
  connectionAuthorizations,
  additionalSessionChangeGuards: [chatContextLifecycle.waitForMutations],
  vidu: viduComposition,
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
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(path.join(__dirname, '../../dist/index.html'));
  }

  return mainWindow;
}

app.whenReady().then(async () => {
  await settingsLifecycle.activate();
  await viduComposition.registry.ensureFrozenViduCatalog();
  protocol.handle('unicomp-media', async (request) => {
    const url = new URL(request.url);
    const token = url.hostname === 'local' ? url.pathname.slice(1) : '';
    const entry = token ? storageLifecycle.resolveEntry(token) : undefined;
    if (!entry) {
      return new Response('Media handle not found', { status: 404 });
    }

    const response = await net.fetch(pathToFileURL(entry.target).toString(), {
      method: request.method,
      headers: request.headers
    });
    if (!entry.mimeType) {
      return response;
    }

    const headers = new Headers(response.headers);
    headers.set('content-type', entry.mimeType);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers
    });
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
