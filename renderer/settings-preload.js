const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('settingsAPI', {
  getPetSettings: () => ipcRenderer.invoke('get-pet-settings'),
  updatePetSettings: (partial) => ipcRenderer.invoke('update-pet-settings', partial),
  getAvailablePacks: () => ipcRenderer.invoke('get-available-packs'),
  setPetActive: (packId, active) => ipcRenderer.invoke('set-pet-active', { packId, active })
});
