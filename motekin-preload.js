const { contextBridge, ipcRenderer } = require('electron');

// The dashboard's pet list is real, backed by main.js's character-pack scan
// and Founder Pet's control channel. The forge screens (Key/Intake/Forge/
// Review/Deploy) are now backed by real image generation too (see
// backend/) — apiKey plaintext never crosses this bridge in either
// direction: saveKey() sends it in once to be encrypted+stored, and nothing
// ever reads it back out to the renderer afterwards (see backend/keyStore.js).
contextBridge.exposeInMainWorld('motekin', {
  getCharacterPacks: () => ipcRenderer.invoke('motekin:get-character-packs'),
  setPetActive: (packId, active) => ipcRenderer.invoke('motekin:set-pet-active', { packId, active }),

  getProviders: () => ipcRenderer.invoke('motekin:get-providers'),
  getForgeConfig: () => ipcRenderer.invoke('motekin:get-forge-config'),
  getKeyStatus: () => ipcRenderer.invoke('motekin:key-status'),
  saveKey: (provider, apiKey) => ipcRenderer.invoke('motekin:save-key', { provider, apiKey }),
  clearKey: () => ipcRenderer.invoke('motekin:clear-key'),

  forgeStart: (photoBase64, photoMimeType) => ipcRenderer.invoke('motekin:forge-start', { photoBase64, photoMimeType }),
  forgeGenerateState: (sessionId, stateKey) => ipcRenderer.invoke('motekin:forge-generate-state', { sessionId, stateKey }),
  forgeCancel: (sessionId) => ipcRenderer.invoke('motekin:forge-cancel', { sessionId }),
  forgeDeploy: (sessionId, charName, spritesheetDataUrl) => ipcRenderer.invoke('motekin:forge-deploy', { sessionId, charName, spritesheetDataUrl })
});
