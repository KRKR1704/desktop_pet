// Character-pack discovery/validation, shared between Founder Pet's main
// process (main.js) and MoteKin's main process (motekin-main.js), so both
// apps agree on exactly what counts as a valid pack. Originally lived
// inline in main.js; extracted here rather than duplicated when MoteKin's
// dashboard needed the same scan. Behavior is unchanged from the original —
// callers now pass in the directories explicitly (appRootDir/assetsDir)
// instead of the functions closing over main.js's own __dirname.
'use strict';

const fs = require('fs');
const path = require('path');
const { imageSize } = require('image-size');

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

// Keyed by assetsDir, so this stays correct even if it's ever called for
// more than one reference location in the same process.
const referenceAtlasCache = new Map();

// The reference atlas (<assetsDir>/pet.json) is the single source of truth
// for per-frame animation timing. Quick-packs read their durations/fps from
// here directly rather than a hardcoded copy, so they can't silently drift
// out of sync with it if the reference is ever retimed.
function getReferenceAtlas(assetsDir) {
  if (!referenceAtlasCache.has(assetsDir)) {
    const referencePath = path.join(assetsDir, 'pet.json');
    referenceAtlasCache.set(assetsDir, JSON.parse(fs.readFileSync(referencePath, 'utf8')));
  }
  return referenceAtlasCache.get(assetsDir);
}

// Builds an in-memory atlas (same shape as a hand-written pet.json) for a
// quick-pack image, given its actual pixel dimensions. Frame size is derived
// from the image, not hardcoded, so this works for any resolution sheet that
// follows the fixed 8x9 grid/row-order convention.
function generateQuickPackAtlas(imageWidth, imageHeight, assetsDir) {
  const frameWidth = imageWidth / QUICK_PACK_COLUMNS;
  const frameHeight = imageHeight / QUICK_PACK_ROWS;
  const frames = {};
  const animations = {};
  const referenceAtlas = getReferenceAtlas(assetsDir);

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
// (just a spritesheet image, atlas auto-generated). assetsDir is the bundled
// default character's folder (<appRootDir>/assets), used as the reference
// atlas for quick-pack timing regardless of which pack is being resolved.
function resolvePackDir(dir, assetsDir) {
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

  return { valid: true, imageFile, atlas: generateQuickPackAtlas(width, height, assetsDir) };
}

// Scans for character packs: the built-in default (<appRootDir>/assets,
// always available), every valid subfolder of <externalResourcesDir>/characters,
// and — for a smooth upgrade from v1.1/v1.2 — a legacy
// <externalResourcesDir>/custom folder if one still exists. Invalid folders
// are skipped with a clear console error rather than crashing the app.
//
// appRootDir and externalResourcesDir are passed in rather than derived here
// so this stays correct for any caller: Founder Pet's main.js resolves
// externalResourcesDir differently depending on app.isPackaged (see
// getExternalResourcesDir() there), and MoteKin's motekin-main.js mirrors
// that same logic independently since it's a separate Electron app.
function scanCharacterPacks({ appRootDir, externalResourcesDir }) {
  const packs = [];
  const defaultDir = path.join(appRootDir, 'assets');
  const defaultCheck = resolvePackDir(defaultDir, defaultDir);
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

  const charactersDir = path.join(externalResourcesDir, 'characters');
  if (fs.existsSync(charactersDir)) {
    for (const entry of fs.readdirSync(charactersDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(charactersDir, entry.name);
      const check = resolvePackDir(dir, defaultDir);
      if (check.valid) {
        packs.push({ id: entry.name, label: entry.name, dir, imageFile: check.imageFile, atlas: check.atlas });
      } else {
        console.error(`[dpet] Skipping character pack "characters/${entry.name}/" (${check.reason}).`);
      }
    }
  }

  const legacyCustomDir = path.join(externalResourcesDir, 'custom');
  if (fs.existsSync(legacyCustomDir)) {
    const check = resolvePackDir(legacyCustomDir, defaultDir);
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

module.exports = {
  REQUIRED_STATES,
  QUICK_PACK_IMAGE_FILENAMES,
  QUICK_PACK_COLUMNS,
  QUICK_PACK_ROWS,
  resolvePackDir,
  scanCharacterPacks,
  generateQuickPackAtlas,
  getReferenceAtlas
};
