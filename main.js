const { app, BrowserWindow, ipcMain, screen, Menu } = require('electron');
const path = require('path');
const fs = require('fs');

const FRAME_SIZE = 192;
const REQUIRED_STATES = ['idle', 'walk', 'alert', 'tired', 'thinking', 'celebrate', 'talking'];

let win;
let assetFolder = 'assets';

// Checks for a user-supplied custom/spritesheet.webp + custom/pet.json pair and
// validates the atlas has every state petApp.js depends on. Falls back to the
// bundled assets/ folder (and logs why) rather than letting the renderer crash
// on a missing state or malformed JSON.
function resolveAssetFolder() {
  const customDir = path.join(__dirname, 'custom');
  const customSheet = path.join(customDir, 'spritesheet.webp');
  const customAtlas = path.join(customDir, 'pet.json');

  if (!fs.existsSync(customSheet) || !fs.existsSync(customAtlas)) {
    return 'assets';
  }

  let atlas;
  try {
    atlas = JSON.parse(fs.readFileSync(customAtlas, 'utf8'));
  } catch (err) {
    console.error(`[dpet] custom/pet.json is not valid JSON (${err.message}). Falling back to the default character.`);
    return 'assets';
  }

  const animations = atlas.animations || {};
  const missing = REQUIRED_STATES.filter((s) => !animations[s]);
  if (missing.length > 0) {
    console.error(
      `[dpet] custom/pet.json is missing required animation state(s): ${missing.join(', ')}. ` +
      `Every custom pet.json must define: ${REQUIRED_STATES.join(', ')}. Falling back to the default character.`
    );
    return 'assets';
  }

  console.log('[dpet] Loading custom character from custom/');
  return 'custom';
}

function currentWorkArea() {
  const bounds = win.getBounds();
  const center = { x: bounds.x + FRAME_SIZE / 2, y: bounds.y + FRAME_SIZE / 2 };
  const display = screen.getDisplayNearestPoint(center);
  return display.workArea;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function clampToWorkArea(x, y) {
  const wa = currentWorkArea();
  const clampedX = clamp(x, wa.x, wa.x + wa.width - FRAME_SIZE);
  const clampedY = clamp(y, wa.y, wa.y + wa.height - FRAME_SIZE);
  return { x: clampedX, y: clampedY };
}

function createWindow() {
  const primary = screen.getPrimaryDisplay();
  const wa = primary.workArea;
  const startX = wa.x + wa.width - FRAME_SIZE - 40;
  const startY = wa.y + wa.height - FRAME_SIZE;

  win = new BrowserWindow({
    width: FRAME_SIZE,
    height: FRAME_SIZE,
    x: startX,
    y: startY,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setIgnoreMouseEvents(false);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  assetFolder = resolveAssetFolder();
  createWindow();
});

app.on('window-all-closed', () => {
  app.quit();
});

ipcMain.handle('get-display-bounds', () => currentWorkArea());

ipcMain.handle('get-asset-folder', () => assetFolder);

ipcMain.handle('get-window-position', () => win.getPosition());

ipcMain.on('set-window-position', (event, { x, y }) => {
  const clamped = clampToWorkArea(x, y);
  win.setBounds({ x: Math.round(clamped.x), y: Math.round(clamped.y), width: FRAME_SIZE, height: FRAME_SIZE });
});

ipcMain.on('show-context-menu', () => {
  const menu = Menu.buildFromTemplate([
    { label: 'Founder Pet', enabled: false },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() }
  ]);
  menu.popup({ window: win });
});
