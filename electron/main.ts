import { app, BrowserWindow, ipcMain, net, protocol, shell } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { registerStorageIpcHandlers } from './ipc/storage-ipc';
import { registerProviderIpcHandlers } from './ipc/provider-ipc';

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
  return getWindowFromEvent(event)?.isMaximized() ?? false;
});

function createMainWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1080,
    minHeight: 720,
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

  if (isDev && process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
    return;
  }

  mainWindow.loadFile(path.join(__dirname, '../../dist/index.html'));
}

app.whenReady().then(() => {
  protocol.handle('unicomp-media', (request) => {
    const url = new URL(request.url);
    const token = url.hostname === 'local' ? url.pathname.slice(1) : '';
    const target = token ? mediaHandles.resolve(token) : undefined;
    return target
      ? net.fetch(pathToFileURL(target).toString(), {
          method: request.method,
          headers: request.headers
        })
      : new Response('Media handle not found', { status: 404 });
  });
  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
