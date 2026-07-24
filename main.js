const { app, BrowserWindow, ipcMain, screen, Menu, Tray, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { uIOhook } = require('uiohook-napi');

const FRAME_SIZE = 192;
const REQUIRED_STATES = ['idle', 'walk', 'alert', 'tired', 'thinking', 'celebrate', 'talking'];

// Easy-to-edit list of lines the speech bubble can show while "talking" plays.
const BUBBLE_LINES = [
  'shipping something 🚀',
  'debugging...',
  'coffee time',
  'just thinking',
  'almost done building this'
];
const BUBBLE_WIDTH = 240;
const BUBBLE_HEIGHT = 70;

// Walk/mood frequency presets the settings window offers. Values match the
// original hardcoded defaults for 'normal', so behavior is unchanged out of the box.
const WALK_FREQUENCY_PRESETS = {
  often: { min: 8000, max: 20000 },
  normal: { min: 15000, max: 40000 },
  rare: { min: 30000, max: 90000 }
};
const MOOD_FREQUENCY_PRESETS = {
  often: { min: 45000, max: 120000 },
  normal: { min: 90000, max: 240000 },
  rare: { min: 180000, max: 480000 }
};

// Easy-to-extend list of "working" apps. Matched case-insensitively against
// the active window's title, owner process name, and owner path — add more
// entries here (e.g. another editor or terminal) without touching any logic.
const WORKING_APP_MATCHERS = [
  'code.exe',
  'visual studio code',
  'windowsterminal.exe',
  'windows terminal',
  'powershell.exe',
  'pwsh.exe',
  'cmd.exe',
  'conhost.exe',
  'mintty.exe',
  'git bash'
];
const TYPING_ACTIVE_WINDOW_MS = 1500; // "typing" stays active this long after the last keypress
const TYPING_CHECK_INTERVAL_MS = 500;
const WORKING_POLL_INTERVAL_MS = 1500;

let win;
let tray;
let bubbleWin;
let settingsWin = null;
let assetFolder = 'assets';
let launchOnStartupEnabled = false;
let petSettings = {
  walkFrequency: 'normal',
  moodFrequency: 'normal',
  paused: false,
  reactToActivity: true
};

// Activity detection (typing/working) state — see startActivityMonitoring().
let activityMonitoringActive = false;
let isTyping = false;
let isWorking = false;
let lastKeydownAt = 0;
let typingCheckTimer = null;
let workingPollTimer = null;
let currentActivityState = null; // null | 'typing' | 'working'
let cachedActiveWindowFn = null;

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

// Merges into the persisted config rather than overwriting it, so unrelated
// keys (e.g. launchOnStartup vs. petSettings) don't clobber each other.
function updateConfig(partial) {
  const config = { ...loadConfig(), ...partial };
  saveConfig(config);
  return config;
}

// Reconciles our persisted preferences with the OS-level login item setting
// on every launch, so the two can't silently drift apart (e.g. user removed
// it via Windows Settings directly), and seeds petSettings from disk.
function initSettings() {
  const config = loadConfig();
  launchOnStartupEnabled =
    typeof config.launchOnStartup === 'boolean' ? config.launchOnStartup : app.getLoginItemSettings().openAtLogin;
  app.setLoginItemSettings({ openAtLogin: launchOnStartupEnabled });

  if (WALK_FREQUENCY_PRESETS[config.walkFrequency]) petSettings.walkFrequency = config.walkFrequency;
  if (MOOD_FREQUENCY_PRESETS[config.moodFrequency]) petSettings.moodFrequency = config.moodFrequency;
  if (typeof config.paused === 'boolean') petSettings.paused = config.paused;
  if (typeof config.reactToActivity === 'boolean') petSettings.reactToActivity = config.reactToActivity;
}

function isWorkingWindowMatch(activeWin) {
  if (!activeWin) return false;
  const haystack = [activeWin.title, activeWin.owner && activeWin.owner.name, activeWin.owner && activeWin.owner.path]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return WORKING_APP_MATCHERS.some((matcher) => haystack.includes(matcher.toLowerCase()));
}

function pushActivityState(newState) {
  if (newState === currentActivityState) return;
  currentActivityState = newState;
  if (win && !win.isDestroyed()) win.webContents.send('activity-changed', currentActivityState);
}

function recomputeActivityState() {
  pushActivityState(isWorking ? 'working' : isTyping ? 'typing' : null);
}

function onGlobalKeydown() {
  lastKeydownAt = Date.now();
  if (!isTyping) {
    isTyping = true;
    recomputeActivityState();
  }
}

function checkTypingTimeout() {
  if (isTyping && Date.now() - lastKeydownAt >= TYPING_ACTIVE_WINDOW_MS) {
    isTyping = false;
    recomputeActivityState();
  }
}

async function getActiveWindowFn() {
  if (!cachedActiveWindowFn) {
    ({ activeWindow: cachedActiveWindowFn } = await import('get-windows'));
  }
  return cachedActiveWindowFn;
}

async function checkWorkingWindow() {
  let activeWin = null;
  try {
    const activeWindow = await getActiveWindowFn();
    activeWin = await activeWindow();
  } catch (err) {
    console.error(`[dpet] Failed to query the active window: ${err.message}`);
  }
  const nowWorking = isWorkingWindowMatch(activeWin);
  if (nowWorking !== isWorking) {
    isWorking = nowWorking;
    recomputeActivityState();
  }
}

// Starts the global keyboard hook + active-window polling that drive the
// "typing"/"working" states. Gated by petSettings.reactToActivity so the
// user can turn this off entirely (see updatePetSettings).
function startActivityMonitoring() {
  if (activityMonitoringActive) return;
  activityMonitoringActive = true;
  try {
    uIOhook.on('keydown', onGlobalKeydown);
    uIOhook.start();
  } catch (err) {
    console.error(`[dpet] Failed to start global keyboard hook (typing detection disabled): ${err.message}`);
  }
  typingCheckTimer = setInterval(checkTypingTimeout, TYPING_CHECK_INTERVAL_MS);
  workingPollTimer = setInterval(checkWorkingWindow, WORKING_POLL_INTERVAL_MS);
  checkWorkingWindow();
}

function stopActivityMonitoring() {
  if (!activityMonitoringActive) return;
  activityMonitoringActive = false;
  try {
    uIOhook.off('keydown', onGlobalKeydown);
    uIOhook.stop();
  } catch (err) {
    console.error(`[dpet] Failed to stop global keyboard hook: ${err.message}`);
  }
  clearInterval(typingCheckTimer);
  clearInterval(workingPollTimer);
  typingCheckTimer = null;
  workingPollTimer = null;
  isTyping = false;
  isWorking = false;
  pushActivityState(null);
}

function setLaunchOnStartup(enabled) {
  launchOnStartupEnabled = enabled;
  app.setLoginItemSettings({ openAtLogin: enabled });
  updateConfig({ launchOnStartup: enabled });
  updateTrayMenu();
}

// Resolves the current presets into the concrete numeric ranges petApp.js
// applies, keeping preset-name knowledge out of the renderer.
function resolveSettingsPayload() {
  return {
    walkDelay: WALK_FREQUENCY_PRESETS[petSettings.walkFrequency] || WALK_FREQUENCY_PRESETS.normal,
    moodDelay: MOOD_FREQUENCY_PRESETS[petSettings.moodFrequency] || MOOD_FREQUENCY_PRESETS.normal,
    paused: petSettings.paused
  };
}

function pushSettingsToPet() {
  if (win && !win.isDestroyed()) win.webContents.send('settings-changed', resolveSettingsPayload());
}

function updatePetSettings(partial) {
  const prevReactToActivity = petSettings.reactToActivity;
  Object.assign(petSettings, partial);
  updateConfig(partial);
  if (typeof partial.reactToActivity === 'boolean' && partial.reactToActivity !== prevReactToActivity) {
    if (petSettings.reactToActivity) startActivityMonitoring();
    else stopActivityMonitoring();
  }
  pushSettingsToPet();
  return { ...petSettings };
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
        if (win.isVisible()) {
          win.hide();
          hideBubble();
        } else {
          win.show();
        }
      }
    },
    { type: 'separator' },
    {
      label: 'Launch on Startup',
      type: 'checkbox',
      checked: launchOnStartupEnabled,
      click: (menuItem) => setLaunchOnStartup(menuItem.checked)
    },
    { label: 'Settings...', click: () => createSettingsWindow() },
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

// Small always-on-top window that shows a line of text above the pet during
// the "talking" mood. Kept as a second window (per the isolation requirement)
// rather than resizing the pet's own window, since FRAME_SIZE is baked into
// its clamp/position math throughout this file.
function createBubbleWindow() {
  bubbleWin = new BrowserWindow({
    width: BUBBLE_WIDTH,
    height: BUBBLE_HEIGHT,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: false,
    show: false
  });
  bubbleWin.setIgnoreMouseEvents(true);
  bubbleWin.setAlwaysOnTop(true, 'screen-saver');
  bubbleWin.loadFile(path.join(__dirname, 'renderer', 'bubble.html'));
}

function positionBubbleWindow() {
  if (!bubbleWin) return;
  const petBounds = win.getBounds();
  const wa = displayForPosition(petBounds.x, petBounds.y).workArea;
  let x = petBounds.x + Math.round((FRAME_SIZE - BUBBLE_WIDTH) / 2);
  let y = petBounds.y - BUBBLE_HEIGHT - 4;
  x = clamp(x, wa.x, wa.x + wa.width - BUBBLE_WIDTH);
  y = clamp(y, wa.y, wa.y + wa.height - BUBBLE_HEIGHT);
  bubbleWin.setBounds({ x, y, width: BUBBLE_WIDTH, height: BUBBLE_HEIGHT });
}

function showBubble() {
  if (!bubbleWin) return;
  const line = BUBBLE_LINES[Math.floor(Math.random() * BUBBLE_LINES.length)];
  bubbleWin.webContents
    .executeJavaScript(`document.getElementById('text').textContent = ${JSON.stringify(line)};`)
    .catch((err) => console.error(`[dpet] Failed to set bubble text: ${err.message}`));
  positionBubbleWindow();
  bubbleWin.showInactive();
}

function hideBubble() {
  if (!bubbleWin) return;
  bubbleWin.hide();
}

function createSettingsWindow() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.focus();
    return;
  }
  settingsWin = new BrowserWindow({
    width: 320,
    height: 340,
    useContentSize: true, // width/height are the web content area, not including OS title bar/border chrome
    resizable: false,
    minimizable: false,
    maximizable: false,
    title: 'Founder Pet Settings',
    webPreferences: {
      preload: path.join(__dirname, 'renderer', 'settings-preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  settingsWin.setMenuBarVisibility(false);
  settingsWin.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
    console.error(`[dpet] Settings window failed to load: ${errorCode} ${errorDescription}`);
  });
  settingsWin.loadFile(path.join(__dirname, 'renderer', 'settings.html'));
  settingsWin.on('closed', () => {
    settingsWin = null;
  });
}

// Resolves which display a given top-left pet-window position is on, using
// Electron's screen module rather than assuming the primary display, so the
// pet is always clamped/walked within whatever monitor it's actually on.
function displayForPosition(x, y) {
  const center = { x: x + FRAME_SIZE / 2, y: y + FRAME_SIZE / 2 };
  return screen.getDisplayNearestPoint(center);
}

function currentWorkArea() {
  const bounds = win.getBounds();
  return displayForPosition(bounds.x, bounds.y).workArea;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

// Clamps against the display nearest the *target* point (not the window's
// current, pre-move bounds), so dragging across a monitor boundary clamps to
// the monitor being dragged onto rather than the one being dragged from.
function clampToWorkArea(x, y) {
  const wa = displayForPosition(x, y).workArea;
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
  initSettings();
  createTray();
  createBubbleWindow();
  if (petSettings.reactToActivity) startActivityMonitoring();
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', () => {
  stopActivityMonitoring();
});

ipcMain.handle('get-display-bounds', () => currentWorkArea());

ipcMain.handle('get-asset-folder', () => assetFolder);

ipcMain.handle('get-window-position', () => win.getPosition());

ipcMain.on('set-window-position', (event, { x, y }) => {
  const clamped = clampToWorkArea(x, y);
  win.setBounds({ x: Math.round(clamped.x), y: Math.round(clamped.y), width: FRAME_SIZE, height: FRAME_SIZE });
  if (bubbleWin && bubbleWin.isVisible()) positionBubbleWindow();
});

ipcMain.on('show-bubble', () => showBubble());

ipcMain.on('hide-bubble', () => hideBubble());

ipcMain.handle('get-settings', () => resolveSettingsPayload());

ipcMain.handle('get-pet-settings', () => ({ ...petSettings }));

ipcMain.handle('update-pet-settings', (event, partial) => updatePetSettings(partial));

ipcMain.on('show-context-menu', () => {
  const menu = Menu.buildFromTemplate([
    { label: 'Founder Pet', enabled: false },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() }
  ]);
  menu.popup({ window: win });
});
