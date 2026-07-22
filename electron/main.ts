import { createHash } from 'node:crypto';
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import path from 'node:path';
import {
  createStorageRecoveryApi,
  storageRecoveryChannels
} from '../src/platform/ipc';

const isDev = Boolean(process.env.VITE_DEV_SERVER_URL);
const isMac = process.platform === 'darwin';

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

const storageRecovery = createStorageRecoveryApi({
  getProjectRoot: (projectId) =>
    path.join(
      app.getPath('userData'),
      'projects',
      createHash('sha256').update(projectId).digest('hex')
    ),
  selectRelinkCandidate: async () => {
    const selection = await dialog.showOpenDialog({
      properties: ['openFile']
    });
    return selection.canceled ? undefined : selection.filePaths[0];
  }
});

ipcMain.handle(storageRecoveryChannels.probe, (_event, request) =>
  storageRecovery.probeFile(request)
);
ipcMain.handle(storageRecoveryChannels.verify, (_event, request) =>
  storageRecovery.verifyFile(request)
);
ipcMain.handle(storageRecoveryChannels.relink, (_event, request) =>
  storageRecovery.relinkFile(request)
);
ipcMain.handle(storageRecoveryChannels.rebuildIndex, (_event, request) =>
  storageRecovery.rebuildFileIndex(request)
);

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
