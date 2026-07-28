const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const net = require('net');
const { pathToFileURL } = require('url');
const { scanCharacterPacks } = require('./shared/characterPacks');
const { getPipePath } = require('./shared/controlChannel');
const { getExternalResourcesDir: resolveExternalResourcesDir } = require('./shared/externalResources');
const keyStore = require('./backend/keyStore');
const providers = require('./backend/providers');
const forge = require('./backend/forge');
const packWriter = require('./backend/packWriter');
const { ForgeError } = require('./backend/forgeError');

// Pins the taskbar/window title to "MoteKin" regardless of how the app is
// launched, mirroring Founder Pet's own app.setName() pattern in its main.js.
app.setName('MoteKin');

// See shared/externalResources.js for the resolution logic/reasoning
// (shared with Founder Pet's main.js, which does the exact same thing for
// its own __dirname).
function getExternalResourcesDir() {
  return resolveExternalResourcesDir(app, __dirname);
}

// Founder Pet persists which packs are active to config.json in its own
// userData dir, keyed off its own Electron app name — which is NOT the same
// as MoteKin's app name, so MoteKin can't just call its own
// app.getPath('userData') and expect to find it. Electron names the
// userData folder after app.getName(): "founder-pet" (from package.json's
// "name") in dev, or "Founder Pet" once packaged (main.js explicitly calls
// app.setName('Founder Pet') when app.isPackaged — see the comment at the
// top of main.js). Prefer the packaged name if it actually has a config
// file; otherwise assume dev mode, which is the only case that exists today.
function getFounderPetUserDataDir() {
  const appDataDir = app.getPath('appData');
  const packagedDir = path.join(appDataDir, 'Founder Pet');
  if (fs.existsSync(path.join(packagedDir, 'config.json'))) return packagedDir;
  return path.join(appDataDir, 'founder-pet');
}

// Best-effort, read-only fallback for "is this pack active" when Founder
// Pet's control server isn't reachable (see requestFounderPetControl below)
// — e.g. it's not running at all. Founder Pet's own persistActivePetPacks()
// writes this file synchronously right after every spawn/destroy, so while
// Founder Pet IS running this is just as accurate as asking it live.
function readFounderPetActivePackIds() {
  try {
    const configPath = path.join(getFounderPetUserDataDir(), 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return Array.isArray(config.activePetPacks) ? config.activePetPacks : [];
  } catch {
    return [];
  }
}

// Talks to Founder Pet's control server (see startControlServer() in
// main.js) over the local pipe both processes agree on via
// shared/controlChannel.js. One request per connection: write one JSON
// line, read one JSON line back, done. Rejects if Founder Pet isn't running
// (no listener on the pipe) or doesn't respond in time.
function requestFounderPetControl(msg, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(getPipePath());
    let settled = false;
    let buffer = '';

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error('Founder Pet did not respond in time'));
    }, timeoutMs);

    socket.on('connect', () => socket.write(`${JSON.stringify(msg)}\n`));
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
    });
    socket.on('end', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        resolve(JSON.parse(buffer.trim()));
      } catch (err) {
        reject(err);
      }
    });
    socket.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 1040,
    minHeight: 680,
    title: 'MoteKin',
    backgroundColor: '#00224D', // avoids a white flash before the page's own background paints
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'motekin-preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  win.loadFile(path.join(__dirname, 'frontend', 'index.html'));
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// Real character-pack data for the dashboard: the same scan Founder Pet
// itself runs (assets/ + characters/*), so both apps agree on what's valid.
// baseUrl/imageFile/atlas match the exact shape Founder Pet's own
// get-asset-folder IPC handler returns, so the renderer can crop a preview
// frame using the same technique as renderer/animator.js.
//
// Active/inactive: ask Founder Pet's live control server first (the actual
// in-memory activePets map of whichever instance is really running) rather
// than going straight to the persisted config file — a machine that's ever
// run both a packaged build and a dev build of Founder Pet ends up with two
// distinct userData folders (Electron names it after app.getName(), which
// differs between the two — see getFounderPetUserDataDir()), and guessing
// which one is "current" from file presence alone can silently pick the
// stale one. Only fall back to the file when Founder Pet isn't reachable at
// all (not running), which is the case that heuristic is actually for.
ipcMain.handle('motekin:get-character-packs', async () => {
  const packs = scanCharacterPacks({ appRootDir: __dirname, externalResourcesDir: getExternalResourcesDir() });
  let activeIds;
  try {
    const res = await requestFounderPetControl({ cmd: 'list-active' });
    activeIds = res.ok ? res.activePackIds : readFounderPetActivePackIds();
  } catch {
    activeIds = readFounderPetActivePackIds();
  }
  return packs.map((pack) => ({
    id: pack.id,
    label: pack.label,
    active: activeIds.includes(pack.id),
    baseUrl: pathToFileURL(pack.dir).href,
    imageFile: pack.imageFile,
    atlas: pack.atlas
  }));
});

ipcMain.handle('motekin:set-pet-active', async (event, { packId, active }) => {
  try {
    const res = await requestFounderPetControl({ cmd: 'set-active', packId, active });
    if (!res.ok) return { ok: false, error: res.error || 'Founder Pet rejected the request' };
    return { ok: true, activePackIds: res.activePackIds };
  } catch (err) {
    return { ok: false, error: `Founder Pet isn't reachable (${err.message}). Make sure it's running.` };
  }
});

// ---------------------------------------------------------------------------
// Forge: real image generation (see backend/). Key storage uses safeStorage
// (OS-backed encryption) and lives in MoteKin's own userData dir — see
// backend/keyStore.js for why that satisfies the "encrypted at rest, we
// cannot see it" claim in the Key Exchange UI copy. The decrypted key is
// never sent back to the renderer; only status ({hasKey, provider}) crosses
// that boundary. Generation calls happen here in the main process using the
// in-memory decrypted key, straight to the provider's real API endpoint.
// ---------------------------------------------------------------------------

// Shared by every forge-* handler below that can throw a ForgeError (as
// opposed to save-key/forge-deploy's plain {ok:false, error} — those don't
// carry a `kind` the renderer needs to act on, only forge session/generation
// errors do).
function forgeErrorResponse(err) {
  return { ok: false, error: err.message, errorKind: err instanceof ForgeError ? err.kind : 'unknown' };
}

ipcMain.handle('motekin:get-providers', () => providers.list());

ipcMain.handle('motekin:get-forge-config', () => ({
  states: forge.STATE_ORDER,
  framesPerState: forge.FRAMES_PER_STATE,
  gridColumns: forge.GRID_COLUMNS,
  frameSize: forge.FRAME_SIZE
}));

ipcMain.handle('motekin:key-status', () => keyStore.getStatus());

ipcMain.handle('motekin:save-key', (event, { provider, apiKey }) => {
  try {
    keyStore.saveKey(provider, apiKey);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('motekin:clear-key', () => {
  keyStore.clearKey();
  return { ok: true };
});

// photoBase64/photoMimeType come from a real <input type=file>/drag-drop
// read in the renderer (see frontend/app.js) — the mock "click to simulate
// intake" placeholder is gone now that real generation needs real photo
// bytes to send as image input to the provider.
ipcMain.handle('motekin:forge-start', (event, { photoBase64, photoMimeType }) => {
  try {
    const { sessionId, provider } = forge.startSession({ buffer: Buffer.from(photoBase64, 'base64'), mimeType: photoMimeType });
    return { ok: true, sessionId, provider };
  } catch (err) {
    return forgeErrorResponse(err);
  }
});

ipcMain.handle('motekin:forge-generate-state', async (event, { sessionId, stateKey }) => {
  try {
    const { frames, usingAnchor, usedGridMode, gridFallbackReason } = await forge.generateStateFrames(sessionId, stateKey);
    return {
      ok: true,
      usingAnchor,
      usedGridMode,
      gridFallbackReason,
      frames: frames.map((f) => ({ dataUrl: `data:${f.mimeType};base64,${f.buffer.toString('base64')}` }))
    };
  } catch (err) {
    return forgeErrorResponse(err);
  }
});

ipcMain.handle('motekin:forge-cancel', (event, { sessionId }) => {
  forge.endSession(sessionId);
  return { ok: true };
});

// spritesheetDataUrl is the already-composited 8x9 grid image, built by the
// renderer's <canvas> from every state's generated frames (see
// frontend/app.js) — canvas is the only place in this app that reliably
// encodes webp (same nativeImage limitation noted in the main Founder Pet
// main.js for *decoding* it applies to encoding too).
ipcMain.handle('motekin:forge-deploy', (event, { sessionId, charName, spritesheetDataUrl }) => {
  try {
    const match = /^data:([^;]+);base64,(.+)$/.exec(spritesheetDataUrl);
    if (!match) throw new Error('Assembled spritesheet was not a valid data URL.');
    const spritesheetBuffer = Buffer.from(match[2], 'base64');

    const generatedPetsDir = path.join(__dirname, 'generated-pets');
    const { slug } = packWriter.writePack({
      dpetRootDir: __dirname,
      generatedPetsDir,
      charName,
      spritesheetBuffer,
      frameWidth: forge.FRAME_SIZE,
      frameHeight: forge.FRAME_SIZE
    });
    const { packId } = packWriter.deployPack({ dpetRootDir: __dirname, generatedPetsDir, slug });

    forge.endSession(sessionId);
    return { ok: true, packId };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
