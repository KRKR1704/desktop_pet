const { app, BrowserWindow, ipcMain, screen, Menu, Tray, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

const FRAME_SIZE = 192;
const REQUIRED_STATES = ['idle', 'walk', 'alert', 'tired', 'thinking', 'celebrate', 'talking'];

let win;
let tray;
let assetFolder = 'assets';
let launchOnStartupEnabled = false;

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

function getConfigPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(getConfigPath(), 'utf8'));
  } catch {
    return {};
  }
}

function saveConfig(config) {
  try {
    fs.writeFileSync(getConfigPath(), JSON.stringify(config));
  } catch (err) {
    console.error(`[dpet] Failed to save config: ${err.message}`);
  }
}

// Reconciles our persisted preference with the OS-level login item setting on
// every launch, so the two can't silently drift apart (e.g. user removed it
// via Windows Settings directly).
function initLaunchOnStartup() {
  const config = loadConfig();
  launchOnStartupEnabled =
    typeof config.launchOnStartup === 'boolean' ? config.launchOnStartup : app.getLoginItemSettings().openAtLogin;
  app.setLoginItemSettings({ openAtLogin: launchOnStartupEnabled });
}

function setLaunchOnStartup(enabled) {
  launchOnStartupEnabled = enabled;
  app.setLoginItemSettings({ openAtLogin: enabled });
  saveConfig({ launchOnStartup: enabled });
  updateTrayMenu();
}

// Simple filled-circle placeholder, built as a raw RGBA buffer so it never
// depends on decoding an image file (used when cropping the real sprite fails).
function buildPlaceholderTrayIcon() {
  const size = 32;
  const buffer = Buffer.alloc(size * size * 4);
  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2 - 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const dx = x - cx + 0.5;
      const dy = y - cy + 0.5;
      const inside = dx * dx + dy * dy <= r * r;
      buffer[i] = 0xff;
      buffer[i + 1] = 0xa5;
      buffer[i + 2] = 0x00;
      buffer[i + 3] = inside ? 0xff : 0;
    }
  }
  return nativeImage.createFromBuffer(buffer, { width: size, height: size });
}

// assets/tray-icon.png is a pre-cropped PNG generated at dev time by
// scripts/generate-tray-icon.js (see that file for why: nativeImage can't
// reliably decode the WebP spritesheet directly in the main process). Custom
// characters loaded from custom/ don't ship their own tray icon, so this is
// always the default character's icon regardless of which asset folder is active.
function buildTrayIcon() {
  const iconPath = path.join(__dirname, 'assets', 'tray-icon.png');
  const icon = nativeImage.createFromPath(iconPath);
  if (icon.isEmpty()) {
    console.error(`[dpet] Could not load tray icon from ${iconPath}; using placeholder icon instead.`);
    return buildPlaceholderTrayIcon();
  }
  return icon;
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: 'Founder Pet', enabled: false },
    { type: 'separator' },
    {
      label: 'Show/Hide Pet',
      click: () => {
        if (win.isVisible()) win.hide();
        else win.show();
      }
    },
    { type: 'separator' },
    {
      label: 'Launch on Startup',
      type: 'checkbox',
      checked: launchOnStartupEnabled,
      click: (menuItem) => setLaunchOnStartup(menuItem.checked)
    },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() }
  ]);
}

function updateTrayMenu() {
  if (!tray) return;
  try {
    tray.setContextMenu(buildTrayMenu());
  } catch (err) {
    console.error(`[dpet] Failed to build/set tray menu: ${err.stack || err.message}`);
  }
}

function createTray() {
  tray = new Tray(buildTrayIcon());
  tray.setToolTip('Founder Pet');
  updateTrayMenu();
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
  initLaunchOnStartup();
  createTray();
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
