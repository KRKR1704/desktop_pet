const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('petAPI', {
  getDisplayBounds: () => ipcRenderer.invoke('get-display-bounds'),
  getWindowPosition: () => ipcRenderer.invoke('get-window-position'),
  setWindowPosition: (x, y) => ipcRenderer.send('set-window-position', { x, y }),
  showContextMenu: () => ipcRenderer.send('show-context-menu'),
  getAssetFolder: () => ipcRenderer.invoke('get-asset-folder')
});
