import { app, BrowserWindow, ipcMain, net, protocol, shell } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { registerStorageIpcHandlers } from './ipc/storage-ipc';
import { registerProviderIpcHandlers } from './ipc/provider-ipc';
import { registerSettingsIpcHandlers } from './ipc/settings-ipc';

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

const mediaHandles = registerStorageIpcHandlers();
registerProviderIpcHandlers();
const settingsLifecycle = registerSettingsIpcHandlers();

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
    minWidth: 1080,
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
    shell.openExternal(url);
    return { action: 'deny' };
  });

  const sendMaximizedState = () => {
    mainWindow.webContents.send('window:maximized-changed', mainWindow.isMaximized());
  };

  mainWindow.on('maximize', sendMaximizedState);
  mainWindow.on('unmaximize', sendMaximizedState);
  mainWindow.on('enter-full-screen', sendMaximizedState);
  mainWindow.on('leave-full-screen', sendMaximizedState);
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
  protocol.handle('unicomp-media', async (request) => {
    const url = new URL(request.url);
    const token = url.hostname === 'local' ? url.pathname.slice(1) : '';
    const entry = token ? mediaHandles.resolveEntry(token) : undefined;
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

app.on('before-quit', () => {
  settingsLifecycle.dispose();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
