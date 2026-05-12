const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('appUpdater', {
  check: () => ipcRenderer.invoke('updater:check'),
  install: () => ipcRenderer.invoke('updater:install'),
  onState: (callback) => {
    const handler = (_event, state) => callback(state);
    ipcRenderer.on('updater:state', handler);
    return () => ipcRenderer.removeListener('updater:state', handler);
  }
});

contextBridge.exposeInMainWorld('appNative', {
  pickFolder: (initialDirectory) => ipcRenderer.invoke('dialog:pickFolder', initialDirectory)
});
