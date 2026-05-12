const { app, BrowserWindow, shell, dialog, Menu, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');
const { autoUpdater } = require('electron-updater');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const userDataDir = app.getPath('userData');
const dataDir = path.join(userDataDir, 'data');
const envPath = path.join(userDataDir, '.env');

if (!fs.existsSync(userDataDir)) fs.mkdirSync(userDataDir, { recursive: true });
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

// Seed the user's .env from the bundled template on first launch so they have something to edit.
if (!fs.existsSync(envPath)) {
  const templateCandidates = [
    path.join(PROJECT_ROOT, '.env.template'),
    path.join(process.resourcesPath || '', '.env.template')
  ];
  for (const candidate of templateCandidates) {
    if (candidate && fs.existsSync(candidate)) {
      fs.copyFileSync(candidate, envPath);
      console.log(`Seeded default .env at ${envPath}`);
      break;
    }
  }
}

dotenv.config({ path: envPath });
process.env.DATA_DIR = dataDir;
process.env.ENV_FILE_PATH = envPath;
if (!process.env.PORT) process.env.PORT = '3000';
if (!process.env.APP_BASE_URL) process.env.APP_BASE_URL = `http://localhost:${process.env.PORT}`;

let serverReadyPromise = null;
function startServer() {
  if (serverReadyPromise) return serverReadyPromise;
  try {
    const serverModule = require(path.join(PROJECT_ROOT, 'server.js'));
    serverReadyPromise = serverModule.ready;
  } catch (err) {
    serverReadyPromise = Promise.reject(err);
  }
  return serverReadyPromise;
}

let mainWindow = null;

function appUrl() {
  return process.env.APP_BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
}

function createWindow() {
  const customIcon = path.join(PROJECT_ROOT, 'build', 'icon.ico');
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 880,
    minHeight: 600,
    title: 'Etsy Draft Listing Assistant',
    backgroundColor: '#f6f2ea',
    show: false,
    ...(fs.existsSync(customIcon) ? { icon: customIcon } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  // Open OAuth and external links in the user's default browser instead of a child Electron window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Prevent navigation away from our embedded server.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const target = new URL(url);
    const ours = new URL(appUrl());
    if (target.host !== ours.host) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  mainWindow.webContents.once('did-finish-load', () => {
    // Replay last known updater state to the page after navigation/load so the version
    // chip reflects reality if the window reloads.
    broadcastUpdaterState();
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  return mainWindow;
}

async function loadAppIntoWindow(win) {
  try {
    await startServer();
    await win.loadURL(appUrl());
  } catch (err) {
    console.error('Failed to start the embedded server:', err);
    const message = err && err.code === 'EADDRINUSE'
      ? `Port ${process.env.PORT} is already in use. Close any other app using that port and try again.`
      : `The app could not start its background service:\n\n${err && err.message ? err.message : String(err)}`;
    dialog.showErrorBox('Etsy Draft Listing Assistant', message);
    app.quit();
  }
}

// ─── Auto-updater state machine ────────────────────────────
let updaterState = {
  status: 'idle',
  currentVersion: app.getVersion(),
  latestVersion: null,
  percent: 0,
  error: null,
  packaged: app.isPackaged
};

function broadcastUpdaterState() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('updater:state', updaterState);
  }
}

function setUpdaterState(patch) {
  updaterState = { ...updaterState, ...patch };
  broadcastUpdaterState();
}

let updaterEventsRegistered = false;
function registerUpdaterEvents() {
  if (updaterEventsRegistered) return;
  updaterEventsRegistered = true;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on('checking-for-update', () => {
    setUpdaterState({ status: 'checking', error: null });
  });
  autoUpdater.on('update-available', (info) => {
    setUpdaterState({ status: 'downloading', latestVersion: info.version, percent: 0, error: null });
  });
  autoUpdater.on('update-not-available', (info) => {
    setUpdaterState({ status: 'latest', latestVersion: info ? info.version : updaterState.currentVersion });
  });
  autoUpdater.on('download-progress', (p) => {
    setUpdaterState({ status: 'downloading', percent: Math.round(p.percent || 0) });
  });
  autoUpdater.on('update-downloaded', async (info) => {
    setUpdaterState({ status: 'ready', latestVersion: info.version, percent: 100 });
    const choice = await dialog.showMessageBox({
      type: 'info',
      buttons: ['Install and restart', 'Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'Update ready',
      message: `Etsy Draft Listing Assistant ${info.version} is ready to install.`,
      detail: 'The app will close briefly, install the update, then reopen.'
    });
    if (choice.response === 0) {
      autoUpdater.quitAndInstall(true, true);
    }
  });
  autoUpdater.on('error', (err) => {
    setUpdaterState({ status: 'error', error: (err && err.message) ? err.message : String(err) });
  });
}

let updateCheckInFlight = false;

async function checkForUpdates() {
  if (!app.isPackaged) {
    setUpdaterState({ status: 'unsupported' });
    console.log('[updater] skipped: not running from a packaged build');
    return;
  }
  if (updateCheckInFlight) return;
  registerUpdaterEvents();
  updateCheckInFlight = true;
  try {
    await autoUpdater.checkForUpdates();
  } catch (err) {
    setUpdaterState({ status: 'error', error: (err && err.message) ? err.message : String(err) });
  } finally {
    updateCheckInFlight = false;
  }
}

ipcMain.handle('updater:check', async () => {
  await checkForUpdates();
  return updaterState;
});

ipcMain.handle('updater:install', async () => {
  if (updaterState.status !== 'ready') return { ok: false, reason: 'not-ready' };
  autoUpdater.quitAndInstall(true, true);
  return { ok: true };
});

app.whenReady().then(async () => {
  if (process.platform === 'win32') {
    Menu.setApplicationMenu(buildAppMenu());
  }
  const win = createWindow();
  await loadAppIntoWindow(win);
  // Initial state push so the chip can render the current version immediately.
  broadcastUpdaterState();
  // Kick off the update check after the window is ready so the UI is responsive even if
  // GitHub is slow.
  setTimeout(() => {
    checkForUpdates().catch((err) => {
      console.warn('[updater] background check failed:', err && err.message);
    });
  }, 4000);
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('activate', async () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    const win = createWindow();
    await loadAppIntoWindow(win);
  }
});

function buildAppMenu() {
  const isMac = process.platform === 'darwin';
  return Menu.buildFromTemplate([
    {
      label: 'File',
      submenu: [
        {
          label: 'Open config folder',
          click: () => shell.openPath(userDataDir)
        },
        {
          label: 'Check for updates',
          click: () => {
            checkForUpdates().catch((err) => {
              dialog.showErrorBox('Update check failed', err && err.message ? err.message : String(err));
            });
          }
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' }
      ]
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    { role: 'windowMenu' }
  ]);
}
