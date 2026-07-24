const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('settingsAPI', {
  getPetSettings: () => ipcRenderer.invoke('get-pet-settings'),
  updatePetSettings: (partial) => ipcRenderer.invoke('update-pet-settings', partial)
});
