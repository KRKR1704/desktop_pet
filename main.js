const { app, BrowserWindow, ipcMain, screen, Menu, Tray, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { execFileSync } = require('child_process');
const { uIOhook } = require('uiohook-napi');
const { imageSize } = require('image-size');

// Pins app.getName() to a single consistent value for the app's whole
// lifetime, once packaged. Without this, app.getName() was observed
// returning different values ("Founder Pet" vs "founder-pet") at different
// points once packaged, which made Electron's own
// getLoginItemSettings()/setLoginItemSettings() registry-key naming
// inconsistent with itself (confirmed while testing the packaged build's
// Launch on Startup — see fixLoginItemRegistryQuoting()). Scoped to
// app.isPackaged only: app.getName() also drives the default
// app.getPath('userData') location, and dev mode's existing config file
// already lives under the un-renamed path — no need to relocate it, since
// dev mode (electron.exe, no space in its path) never hit this bug anyway.
if (app.isPackaged) app.setName('Founder Pet');

const FRAME_SIZE = 192;
const REQUIRED_STATES = ['idle', 'walk', 'alert', 'tired', 'thinking', 'celebrate', 'talking'];

// Quick-pack mode: a character folder with just a spritesheet image and no
// pet.json. The grid shape and row order below match assets/pet.json exactly
// (see CREATING_A_CHARACTER.md), so any image built to this same layout can
// have a working atlas generated for it automatically.
const QUICK_PACK_IMAGE_FILENAMES = ['spritesheet.webp', 'spritesheet.png', 'spritesheet.jpg'];
const QUICK_PACK_COLUMNS = 8;
const QUICK_PACK_ROWS = 9;
const QUICK_PACK_ROW_ORDER = ['idle', 'walk', 'typing', 'thinking', 'celebrate', 'tired', 'alert', 'talking', 'working'];
// Only used as a last-resort fallback if assets/pet.json is ever missing a
// state entirely (shouldn't happen — it's the bundled, trusted reference).
// Per-state/per-frame timing itself always comes from getReferenceAtlas()
// below, not a hardcoded guess — see generateQuickPackAtlas().
const QUICK_PACK_FALLBACK_FPS = 8;
const QUICK_PACK_FALLBACK_DURATION_MS = 125;

let cachedReferenceAtlas = null;
// The reference atlas (assets/pet.json) is the single source of truth for
// per-frame animation timing. Quick-packs read their durations/fps from here
// directly rather than a hardcoded copy, so they can't silently drift out of
// sync with it if the reference is ever retimed.
function getReferenceAtlas() {
  if (!cachedReferenceAtlas) {
    const referencePath = path.join(__dirname, 'assets', 'pet.json');
    cachedReferenceAtlas = JSON.parse(fs.readFileSync(referencePath, 'utf8'));
  }
  return cachedReferenceAtlas;
}

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

let tray;
let settingsWin = null;
let launchOnStartupEnabled = false;
let petSettings = {
  walkFrequency: 'normal',
  moodFrequency: 'normal',
  paused: false,
  reactToActivity: true
};

// availablePacks: [{ id, label, dir (absolute path to the folder containing
// spritesheet.webp + pet.json) }], built once at startup by scanCharacterPacks().
let availablePacks = [];
// activePets: packId -> { packId, pack, win, bubbleWin } — one running pet
// instance per active character pack.
const activePets = new Map();

// Activity detection (typing/working) state — see startActivityMonitoring().
let activityMonitoringActive = false;
let isTyping = false;
let isWorking = false;
let lastKeydownAt = 0;
let typingCheckTimer = null;
let workingPollTimer = null;
let currentActivityState = null; // null | 'typing' | 'working'
let cachedActiveWindowFn = null;

// In dev, characters/ and custom/ live at the project root next to main.js
// (same as __dirname). Once packaged, main.js's code lives inside app.asar —
// a read-only archive — so a user-writable characters/ folder has to live
// somewhere real on disk instead. Electron ships such "extra resources" in
// process.resourcesPath, a real directory alongside app.asar, so that's what
// we use once packaged (see the "extraResources" entry in the electron-builder
// config, which copies the repo's characters/ folder there at build time).
// assets/ (the bundled default character) is NOT affected by this — it ships
// inside the asar either way, which is fine since it's read-only bundled
// content and Electron's fs/fetch/nativeImage all read asar contents transparently.
function getExternalResourcesDir() {
  return app.isPackaged ? process.resourcesPath : __dirname;
}

// Builds an in-memory atlas (same shape as a hand-written pet.json) for a
// quick-pack image, given its actual pixel dimensions. Frame size is derived
// from the image, not hardcoded, so this works for any resolution sheet that
// follows the fixed 8x9 grid/row-order convention.
function generateQuickPackAtlas(imageWidth, imageHeight) {
  const frameWidth = imageWidth / QUICK_PACK_COLUMNS;
  const frameHeight = imageHeight / QUICK_PACK_ROWS;
  const frames = {};
  const animations = {};
  const referenceAtlas = getReferenceAtlas();

  QUICK_PACK_ROW_ORDER.forEach((state, rowIndex) => {
    // Per-frame durations for this state, read straight from the reference
    // atlas (indexed by column/frame position, not just one value reused for
    // the whole state) — so a quick-pack's timing always matches whatever
    // assets/pet.json actually specifies, frame for frame.
    const referenceAnim = referenceAtlas.animations[state];
    const referenceDurations = referenceAnim
      ? referenceAnim.frames.map((frameName) => referenceAtlas.frames[frameName].duration || QUICK_PACK_FALLBACK_DURATION_MS)
      : [];

    const frameNames = [];
    for (let col = 0; col < QUICK_PACK_COLUMNS; col++) {
      const frameName = `${state}_${col + 1}`;
      const duration = referenceDurations[col] !== undefined ? referenceDurations[col] : QUICK_PACK_FALLBACK_DURATION_MS;
      frames[frameName] = {
        frame: { x: col * frameWidth, y: rowIndex * frameHeight, w: frameWidth, h: frameHeight },
        rotated: false,
        trimmed: false,
        spriteSourceSize: { x: 0, y: 0, w: frameWidth, h: frameHeight },
        sourceSize: { w: frameWidth, h: frameHeight },
        duration
      };
      frameNames.push(frameName);
    }
    animations[state] = {
      frames: frameNames,
      fps: (referenceAnim && referenceAnim.fps) || QUICK_PACK_FALLBACK_FPS,
      loop: true,
      // Horizontal center, near-bottom "feet" position — scaled from the
      // reference character's 192x192 frame (anchor 96,180) to whatever
      // frame size this image actually has. Not currently read by
      // animator.js, but kept for shape-consistency with hand-written packs.
      anchor: { x: frameWidth / 2, y: frameHeight * (180 / 192) }
    };
  });

  return {
    meta: {
      name: 'Quick Pack',
      frameWidth,
      frameHeight,
      columns: QUICK_PACK_COLUMNS,
      rows: QUICK_PACK_ROWS,
      defaultState: 'idle'
    },
    frames,
    animations
  };
}

// Resolves a character pack folder into either a full pack (spritesheet.webp
// + hand-written pet.json, validated the same way as always) or a quick pack
// (just a spritesheet image, atlas auto-generated). Shared by every character
// pack source (the built-in default, characters/*, and the legacy custom/
// folder) so each rule is defined exactly once.
function resolvePackDir(dir) {
  const atlasPath = path.join(dir, 'pet.json');

  if (fs.existsSync(atlasPath)) {
    const sheetPath = path.join(dir, 'spritesheet.webp');
    if (!fs.existsSync(sheetPath)) {
      return { valid: false, reason: 'has pet.json but is missing spritesheet.webp' };
    }

    let atlas;
    try {
      atlas = JSON.parse(fs.readFileSync(atlasPath, 'utf8'));
    } catch (err) {
      return { valid: false, reason: `pet.json is not valid JSON (${err.message})` };
    }

    const animations = atlas.animations || {};
    const missing = REQUIRED_STATES.filter((s) => !animations[s]);
    if (missing.length > 0) {
      return {
        valid: false,
        reason: `pet.json is missing required animation state(s): ${missing.join(', ')} ` +
          `(every pack must define: ${REQUIRED_STATES.join(', ')})`
      };
    }

    return { valid: true, imageFile: 'spritesheet.webp', atlas: null };
  }

  // No pet.json — try quick-pack mode: a single spritesheet image laid out
  // as a fixed 8-column x 9-row grid (see CREATING_A_CHARACTER.md).
  const imageFile = QUICK_PACK_IMAGE_FILENAMES.find((name) => fs.existsSync(path.join(dir, name)));
  if (!imageFile) {
    return { valid: false, reason: 'no pet.json and no spritesheet.webp/.png/.jpg found' };
  }

  let dimensions;
  try {
    dimensions = imageSize(fs.readFileSync(path.join(dir, imageFile)));
  } catch (err) {
    return { valid: false, reason: `could not read ${imageFile} dimensions (${err.message})` };
  }

  const { width, height } = dimensions;
  if (!width || !height || width % QUICK_PACK_COLUMNS !== 0 || height % QUICK_PACK_ROWS !== 0) {
    return {
      valid: false,
      reason: `${imageFile} is ${width}x${height}, which doesn't divide evenly into an ` +
        `${QUICK_PACK_COLUMNS}x${QUICK_PACK_ROWS} grid (quick-pack images must be a multiple of ` +
        `${QUICK_PACK_COLUMNS} pixels wide and ${QUICK_PACK_ROWS} pixels tall)`
    };
  }

  return { valid: true, imageFile, atlas: generateQuickPackAtlas(width, height) };
}

// Scans for character packs: the built-in default (assets/, always available),
// every valid subfolder of characters/, and — for a smooth upgrade from
// v1.1/v1.2 — a legacy custom/ folder if one still exists. Invalid folders are
// skipped with a clear console error rather than crashing the app.
function scanCharacterPacks() {
  const packs = [];

  const defaultDir = path.join(__dirname, 'assets');
  const defaultCheck = resolvePackDir(defaultDir);
  if (defaultCheck.valid) {
    packs.push({
      id: 'founder-pet',
      label: 'Founder Pet',
      dir: defaultDir,
      imageFile: defaultCheck.imageFile,
      atlas: defaultCheck.atlas
    });
  } else {
    console.error(`[dpet] Bundled default character in assets/ failed validation (${defaultCheck.reason}).`);
  }

  const externalDir = getExternalResourcesDir();
  const charactersDir = path.join(externalDir, 'characters');
  if (fs.existsSync(charactersDir)) {
    for (const entry of fs.readdirSync(charactersDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(charactersDir, entry.name);
      const check = resolvePackDir(dir);
      if (check.valid) {
        packs.push({ id: entry.name, label: entry.name, dir, imageFile: check.imageFile, atlas: check.atlas });
      } else {
        console.error(`[dpet] Skipping character pack "characters/${entry.name}/" (${check.reason}).`);
      }
    }
  }

  const legacyCustomDir = path.join(externalDir, 'custom');
  if (fs.existsSync(legacyCustomDir)) {
    const check = resolvePackDir(legacyCustomDir);
    if (check.valid) {
      packs.push({
        id: 'custom',
        label: 'Custom (legacy)',
        dir: legacyCustomDir,
        imageFile: check.imageFile,
        atlas: check.atlas
      });
    } else {
      console.error(`[dpet] Legacy custom/ folder failed validation (${check.reason}); skipping it.`);
    }
  }

  return packs;
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
// keys (e.g. launchOnStartup vs. petSettings vs. activePetPacks) don't clobber each other.
function updateConfig(partial) {
  const config = { ...loadConfig(), ...partial };
  saveConfig(config);
  return config;
}

// Electron's app.setLoginItemSettings writes process.execPath to the Windows
// Run registry key WITHOUT quoting it (a known, unpatched-in-our-Electron-
// version issue: GHSA-jfqx-fxh3-c62j). That's harmless in dev (electron.exe's
// path has no spaces) but breaks for real once packaged, since this app's own
// install path can contain spaces ("Founder Pet.exe") — an unquoted value
// with a space gets misparsed as "...\Founder" + arg "Pet.exe" by anything
// reading the Run key, Electron's own getLoginItemSettings() readback included.
// Confirmed via the actual registry entry while testing the packaged build.
//
// Rewriting under a name reconstructed from app.getName() turned out to be
// unreliable — app.getName() returned different casings/spellings ("Founder
// Pet" vs "founder-pet") at different points, so a guessed name missed the
// entry Electron actually wrote and created an unrelated duplicate instead
// (also confirmed while testing). Matching on the *value* — find whichever
// Run key entry's path resolves to our own exe, regardless of its name — is
// robust to that inconsistency.
function fixLoginItemRegistryQuoting() {
  if (process.platform !== 'win32' || !app.isPackaged) return;
  if (!app.getLoginItemSettings().openAtLogin) return;
  const runKey = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
  try {
    const output = execFileSync('reg', ['query', runKey], { encoding: 'utf8' });
    for (const line of output.split(/\r?\n/)) {
      const parts = line.trim().split(/\s{2,}/);
      if (parts.length < 3 || parts[1] !== 'REG_SZ') continue;
      const [name, , ...valueParts] = parts;
      const value = valueParts.join('  ');
      const unquoted = value.replace(/^"|"$/g, '');
      if (path.resolve(unquoted) !== path.resolve(process.execPath)) continue;
      if (value.startsWith('"') && value.endsWith('"')) continue; // already correctly quoted
      execFileSync('reg', ['add', runKey, '/v', name, '/t', 'REG_SZ', '/d', `"${process.execPath}"`, '/f'], { stdio: 'ignore' });
    }
  } catch (err) {
    console.error(`[dpet] Failed to fix up startup registry entry quoting: ${err.message}`);
  }
}

// Reconciles our persisted preferences with the OS-level login item setting
// on every launch, so the two can't silently drift apart (e.g. user removed
// it via Windows Settings directly), and seeds petSettings from disk.
function initSettings() {
  const config = loadConfig();
  launchOnStartupEnabled =
    typeof config.launchOnStartup === 'boolean' ? config.launchOnStartup : app.getLoginItemSettings().openAtLogin;
  app.setLoginItemSettings({ openAtLogin: launchOnStartupEnabled });
  fixLoginItemRegistryQuoting();

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

// Activity/settings apply globally, so every active pet window gets the same push.
function pushActivityState(newState) {
  if (newState === currentActivityState) return;
  currentActivityState = newState;
  for (const pet of activePets.values()) {
    if (pet.win && !pet.win.isDestroyed()) pet.win.webContents.send('activity-changed', currentActivityState);
  }
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
  fixLoginItemRegistryQuoting();
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
  const payload = resolveSettingsPayload();
  for (const pet of activePets.values()) {
    if (pet.win && !pet.win.isDestroyed()) pet.win.webContents.send('settings-changed', payload);
  }
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
// reliably decode the WebP spritesheet directly in the main process). The
// system tray icon always shows the default character regardless of which
// packs are active — it identifies the app, not any one running pet.
function buildTrayIcon() {
  const iconPath = path.join(__dirname, 'assets', 'tray-icon.png');
  const icon = nativeImage.createFromPath(iconPath);
  if (icon.isEmpty()) {
    console.error(`[dpet] Could not load tray icon from ${iconPath}; using placeholder icon instead.`);
    return buildPlaceholderTrayIcon();
  }
  return icon;
}

// Pet management (which packs are running) lives in the Settings window now,
// not the tray — native tray menus close after every single click, which was
// clunky for checking/unchecking several pets in one sitting. See
// get-available-packs / set-pet-active IPC handlers and createSettingsWindow().
function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: 'Founder Pet', enabled: false },
    { type: 'separator' },
    {
      label: 'Show/Hide All Pets',
      click: () => {
        const pets = [...activePets.values()];
        const anyVisible = pets.some((pet) => pet.win.isVisible());
        for (const pet of pets) {
          if (anyVisible) {
            pet.win.hide();
            hideBubble(pet);
          } else {
            pet.win.show();
          }
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

// Small always-on-top window that shows a line of text above a pet during its
// "talking" mood. Each pet instance gets its own, so multiple pets can talk
// independently. Kept as a second window rather than resizing the pet's own
// window, since FRAME_SIZE is baked into its clamp/position math throughout this file.
function createBubbleWindow() {
  const bubbleWin = new BrowserWindow({
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
  return bubbleWin;
}

function positionBubbleWindow(pet) {
  if (!pet.bubbleWin || pet.bubbleWin.isDestroyed() || !pet.win || pet.win.isDestroyed()) return;
  const petBounds = pet.win.getBounds();
  const wa = displayForPosition(petBounds.x, petBounds.y).workArea;
  let x = petBounds.x + Math.round((FRAME_SIZE - BUBBLE_WIDTH) / 2);
  let y = petBounds.y - BUBBLE_HEIGHT - 4;
  x = clamp(x, wa.x, wa.x + wa.width - BUBBLE_WIDTH);
  y = clamp(y, wa.y, wa.y + wa.height - BUBBLE_HEIGHT);
  pet.bubbleWin.setBounds({ x, y, width: BUBBLE_WIDTH, height: BUBBLE_HEIGHT });
}

function showBubble(pet) {
  if (!pet.bubbleWin || pet.bubbleWin.isDestroyed()) return;
  const line = BUBBLE_LINES[Math.floor(Math.random() * BUBBLE_LINES.length)];
  pet.bubbleWin.webContents
    .executeJavaScript(`document.getElementById('text').textContent = ${JSON.stringify(line)};`)
    .catch((err) => console.error(`[dpet] Failed to set bubble text: ${err.message}`));
  positionBubbleWindow(pet);
  pet.bubbleWin.showInactive();
}

function hideBubble(pet) {
  if (!pet.bubbleWin || pet.bubbleWin.isDestroyed()) return;
  pet.bubbleWin.hide();
}

function createSettingsWindow() {
  // Rescan on every open so a characters/ folder added (or removed) since the
  // app started — or since Settings was last closed — shows up without
  // needing a full app restart.
  availablePacks = scanCharacterPacks();

  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.focus();
    return;
  }
  settingsWin = new BrowserWindow({
    width: 320,
    height: 460,
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
// Electron's screen module rather than assuming the primary display, so each
// pet is always clamped/walked within whatever monitor it's actually on.
function displayForPosition(x, y) {
  const center = { x: x + FRAME_SIZE / 2, y: y + FRAME_SIZE / 2 };
  return screen.getDisplayNearestPoint(center);
}

function currentWorkAreaForWindow(browserWindow) {
  const bounds = browserWindow.getBounds();
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

// index staggers each new pet's starting spot horizontally from the bottom-right
// corner so simultaneously-spawned pets don't start stacked exactly on top of
// each other. No collision avoidance beyond this initial placement — out of scope.
function createPetWindow(index) {
  const primary = screen.getPrimaryDisplay();
  const wa = primary.workArea;
  const stagger = index * (FRAME_SIZE + 20);
  const startX = Math.max(wa.x, wa.x + wa.width - FRAME_SIZE - 40 - stagger);
  const startY = wa.y + wa.height - FRAME_SIZE;

  const petWin = new BrowserWindow({
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

  petWin.setAlwaysOnTop(true, 'screen-saver');
  petWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  petWin.setIgnoreMouseEvents(false);
  petWin.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  return petWin;
}

function findPetByWindow(browserWindow) {
  if (!browserWindow) return null;
  for (const pet of activePets.values()) {
    if (pet.win === browserWindow) return pet;
  }
  return null;
}

function persistActivePetPacks() {
  updateConfig({ activePetPacks: [...activePets.keys()] });
}

function spawnPet(packId, { persist = true } = {}) {
  if (activePets.has(packId)) return;
  const pack = availablePacks.find((p) => p.id === packId);
  if (!pack) {
    console.error(`[dpet] Cannot activate unknown character pack "${packId}".`);
    return;
  }

  const petWin = createPetWindow(activePets.size);
  const bubbleWin = createBubbleWindow();
  const pet = { packId, pack, win: petWin, bubbleWin };
  activePets.set(packId, pet);

  petWin.on('closed', () => {
    if (activePets.get(packId) === pet) activePets.delete(packId);
  });

  if (persist) persistActivePetPacks();
}

function destroyPet(packId) {
  const pet = activePets.get(packId);
  if (!pet) return;
  activePets.delete(packId);
  if (pet.bubbleWin && !pet.bubbleWin.isDestroyed()) pet.bubbleWin.destroy();
  if (pet.win && !pet.win.isDestroyed()) pet.win.destroy();
  persistActivePetPacks();
}

// Reads which packs were active last time from the config file and spawns
// them. Falls back to just the default pack on first run, or if every saved
// pack id is no longer available (e.g. its folder was deleted).
function initActivePetsFromConfig() {
  const config = loadConfig();
  let idsToActivate = Array.isArray(config.activePetPacks) ? config.activePetPacks : [];
  if (idsToActivate.length === 0) idsToActivate = ['founder-pet'];

  for (const id of idsToActivate) {
    if (availablePacks.some((p) => p.id === id)) {
      spawnPet(id, { persist: false });
    } else {
      console.error(`[dpet] Saved active character pack "${id}" is no longer available; skipping.`);
    }
  }

  if (activePets.size === 0 && availablePacks.some((p) => p.id === 'founder-pet')) {
    spawnPet('founder-pet', { persist: false });
  }

  persistActivePetPacks();
}

app.whenReady().then(() => {
  availablePacks = scanCharacterPacks();
  initSettings();
  initActivePetsFromConfig();
  createTray();
  if (petSettings.reactToActivity) startActivityMonitoring();
});

// No auto-quit on window-all-closed: with multiple pets it's normal and
// expected to reach zero active pet windows (user unchecked all of them in
// the Pets menu) without wanting the whole app to exit. Only the explicit
// Quit menu item (app.quit()) ends the app now.

app.on('before-quit', () => {
  stopActivityMonitoring();
});

ipcMain.handle('get-display-bounds', (event) => {
  const pet = findPetByWindow(BrowserWindow.fromWebContents(event.sender));
  return pet ? currentWorkAreaForWindow(pet.win) : screen.getPrimaryDisplay().workArea;
});

// Returns { baseUrl, imageFile, atlas }. baseUrl is an absolute file:// URL
// rather than a relative folder name — a relative path (e.g.
// '../characters/xyz/pet.json') can't reliably reach characters/xyz once
// packaged, because renderer/index.html is loaded from inside app.asar while
// characters/ lives in the real, external process.resourcesPath directory —
// a relative path from inside the asar can't "escape" it to a sibling real
// folder. An absolute file:// URL works uniformly whether the pack lives
// inside the asar (assets/) or in a real external directory
// (characters/, custom/). atlas is non-null for quick-packs (auto-generated,
// no pet.json to fetch) and null for full packs (renderer fetches pet.json itself).
ipcMain.handle('get-asset-folder', (event) => {
  const pet = findPetByWindow(BrowserWindow.fromWebContents(event.sender));
  const pack = pet ? pet.pack : { dir: path.join(__dirname, 'assets'), imageFile: 'spritesheet.webp', atlas: null };
  return { baseUrl: pathToFileURL(pack.dir).href, imageFile: pack.imageFile, atlas: pack.atlas };
});

ipcMain.handle('get-window-position', (event) => {
  const pet = findPetByWindow(BrowserWindow.fromWebContents(event.sender));
  return pet ? pet.win.getPosition() : [0, 0];
});

ipcMain.on('set-window-position', (event, { x, y }) => {
  const pet = findPetByWindow(BrowserWindow.fromWebContents(event.sender));
  if (!pet) return;
  const clamped = clampToWorkArea(x, y);
  pet.win.setBounds({ x: Math.round(clamped.x), y: Math.round(clamped.y), width: FRAME_SIZE, height: FRAME_SIZE });
  if (pet.bubbleWin && pet.bubbleWin.isVisible()) positionBubbleWindow(pet);
});

ipcMain.on('show-bubble', (event) => {
  const pet = findPetByWindow(BrowserWindow.fromWebContents(event.sender));
  if (pet) showBubble(pet);
});

ipcMain.on('hide-bubble', (event) => {
  const pet = findPetByWindow(BrowserWindow.fromWebContents(event.sender));
  if (pet) hideBubble(pet);
});

ipcMain.handle('get-settings', () => resolveSettingsPayload());

ipcMain.handle('get-pet-settings', () => ({ ...petSettings }));

ipcMain.handle('update-pet-settings', (event, partial) => updatePetSettings(partial));

ipcMain.handle('get-available-packs', () =>
  availablePacks.map((pack) => ({ id: pack.id, label: pack.label, active: activePets.has(pack.id) }))
);

ipcMain.handle('set-pet-active', (event, { packId, active }) => {
  if (active) spawnPet(packId);
  else destroyPet(packId);
  return availablePacks.map((pack) => ({ id: pack.id, label: pack.label, active: activePets.has(pack.id) }));
});

ipcMain.on('show-context-menu', (event) => {
  const senderWindow = BrowserWindow.fromWebContents(event.sender);
  const menu = Menu.buildFromTemplate([
    { label: 'Founder Pet', enabled: false },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() }
  ]);
  menu.popup({ window: senderWindow });
});
