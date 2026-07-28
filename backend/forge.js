// Forge orchestration: owns in-memory generation sessions (one per Forge
// flow visit) and drives per-state frame generation through whichever
// provider adapter is currently configured (backend/providers/). Everything
// that talks to fs (writing the final pack) lives in backend/packWriter.js —
// this file only ever holds image buffers in memory.
'use strict';

const crypto = require('crypto');
const { nativeImage } = require('electron');
const keyStore = require('./keyStore');
const providers = require('./providers');
const { ForgeError } = require('./forgeError');

// Row order matches shared/characterPacks.js's QUICK_PACK_ROW_ORDER exactly
// (and frontend/app.js's STATES array) — this is what makes the assembled
// spritesheet a valid quick-pack-shaped 8x9 grid Founder Pet already knows
// how to read.
const STATE_ORDER = ['idle', 'walk', 'typing', 'thinking', 'celebrate', 'tired', 'alert', 'talking', 'working'];

// 4 real generated frames per state, not 8. Founder Pet's own default
// character uses 8 columns/state, but that's 8 *paid* API calls per state
// (72 total per character) — MoteKin generates 4, then repeats them
// (1,2,3,4,1,2,3,4) to fill the required 8-column grid width. A loop reading
// 8 frames where frames 5-8 repeat 1-4 is visually identical to a native
// 4-frame loop played twice; nothing is lost but real money and wait time.
const FRAMES_PER_STATE = 4;
const GRID_COLUMNS = 8; // final spritesheet's column count — unrelated to STATE_GRID_ROWS/COLS below

// --- per-state generation strategy: one grid image, not 4 separate calls ---
//
// Originally each state's 4 frames were 4 independent API calls (all
// referencing the same anchor frame). That fixed *state-to-state* drift, but
// each of those 4 calls is still its own independent generation, so nothing
// stopped the model from drifting *within* a state — e.g. frame 2 of
// "typing" coming back with different hair/shirt-color than frame 1, even
// though both referenced the same anchor. A single generation is internally
// self-consistent by construction (it's one image, one forward pass), so
// asking for all 4 poses laid out in ONE image and slicing them apart
// afterward eliminates that class of drift outright, and cuts a state from
// 4 calls to 1 (9 calls per character instead of 36).
//
// 2x2 over a 1x4 strip: a 1x4 strip needs a ~4:1 wide image, which none of
// the 3 providers offer as a selectable size/aspect ratio (OpenAI's images
// API only offers square or 3:2-ish sizes; Stability/Gemini's img2img output
// shape tracks the roughly-square reference image we're sending in). A 2x2
// grid stays close to square, which is what every provider already produces
// by default, so no size/aspect-ratio parameter needs to change anywhere.
const STATE_GRID_ROWS = 2;
const STATE_GRID_COLS = 2;

// Below this per-cell pixel size, a "successfully sliced" image is more
// likely a decode artifact or a provider that just ignored the grid
// instruction and returned one regular image than an actual clean 2x2 grid
// — see sliceGridImage()'s structural sanity check.
const MIN_GRID_CELL_SIZE = 200;

// Matches assets/pet.json's frameWidth/frameHeight exactly, so a forged
// character's spritesheet comes out the same resolution as Founder Pet's
// own bundled default rather than whatever raw size each provider happens
// to return (OpenAI 1024x1024, etc) — the renderer-side canvas compositor
// downscales every generated frame into a FRAME_SIZE square cell.
const FRAME_SIZE = 192;

// The anchor/lock strategy: STATE_ORDER's first entry ('idle') is generated
// first, from the real uploaded photo — same as every state used to be.
// Every *other* state then reuses that one generated idle frame as its
// reference image (session.anchorFrame, set in generateStateFrames below)
// instead of re-sending the original photo. Feeding an already-stylized
// frame of the SAME character back in as reference locks in the art style,
// proportions and design far more tightly than asking the model to
// reinterpret a real photo from scratch 9 separate times — that repeated
// reinterpretation was the actual source of the drift between states seen
// before this change.
const ANCHOR_STATE = STATE_ORDER[0]; // 'idle'

// img2img/edit "how much can the model deviate from the reference" knobs
// (currently only meaningful to backend/providers/stability.js — OpenAI's
// edits endpoint uses input_fidelity instead, set unconditionally in
// generateStateFrames below; Gemini has no equivalent parameter at all).
// Two different values on purpose: the anchor call is still translating a
// *real photo* into stylized art, so it needs room to actually restyle
// (STRENGTH_FROM_PHOTO). Every call after that is reproducing an *already
// stylized* reference with only the pose changing, which needs to stay much
// closer to its input (STRENGTH_FROM_ANCHOR) or the model redesigns the
// character a little every time — the same drift problem, just one call
// removed.
const STRENGTH_FROM_PHOTO = 0.55;
const STRENGTH_FROM_ANCHOR = 0.3;

// Carried into the anchor (idle) call's prompt only — this is where the
// character design is actually established, from the real photo.
const CHARACTER_DESCRIPTOR = 'a small chibi/mascot-style desktop companion character based on the ' +
  'person in the attached reference photo — keep their hairstyle, hair color, skin tone, and any ' +
  'glasses or facial hair, and echo their outfit\'s color palette. Simple flat cel-shaded character ' +
  'design, big head small body proportions, front-facing 3/4 view, single character only, no props, ' +
  'no text, no watermark, no signature, plain white background, centered and fully visible within frame.';

// Carried into every *other* state's prompt, where the reference image is
// already the generated anchor frame, not the real photo — deliberately
// explicit and repetitive about "same character, only the pose changes"
// rather than trusting the model to infer that from a shorter description,
// since underspecifying this is what let the model quietly redesign details
// (face shape, hair, outfit color) on each independent call before.
const IDENTITY_LOCK_INSTRUCTION = 'The attached reference image IS the character — an already fully ' +
  'designed character. Reproduce this EXACT SAME character: identical face shape, identical hairstyle ' +
  'and hair color, identical facial hair if any, identical clothing and identical clothing colors, ' +
  'identical art style and line weight, identical color palette. Do not redesign, restyle, or ' +
  'reinterpret the character in any way. Same character, different pose only — the ONLY thing that ' +
  'should change is the pose/action described below.';

const STATE_PROMPTS = {
  idle: 'standing still in a relaxed idle pose, arms resting at sides, calm neutral expression',
  walk: 'mid-stride walking pose facing to the left, one leg forward, dynamic walking animation frame',
  typing: 'standing at a small keyboard, both hands typing, focused expression looking down',
  thinking: 'one hand on chin, thoughtful pondering pose, looking upward and to the side',
  celebrate: 'both arms raised up in celebration, joyful triumphant expression, little jump',
  tired: 'slouched posture, drooping eyes, yawning, low-energy sleepy pose',
  alert: 'startled alert pose, wide eyes, sudden surprised reaction, leaning back slightly',
  talking: 'mid-speech pose, mouth open speaking, one hand gesturing outward',
  working: 'focused determined pose at a small desk/laptop, leaning in, concentrating'
};

// Primary path: one prompt asking for all FRAMES_PER_STATE poses laid out in
// a single STATE_GRID_COLS x STATE_GRID_ROWS image. The layout/order and the
// "identical in every quadrant" language are deliberately explicit and
// repeated — same reasoning as IDENTITY_LOCK_INSTRUCTION below: underspecifying
// this is exactly what let quadrants (and, before that, separate calls)
// drift from each other.
function buildGridPrompt(stateKey, usingAnchor) {
  const gridLayoutInstruction = `Generate ONE single image containing a ${STATE_GRID_COLS}x${STATE_GRID_ROWS} ` +
    `grid of ${FRAMES_PER_STATE} frames of this character, arranged left-to-right then top-to-bottom: ` +
    `top-left = frame 1, top-right = frame 2, bottom-left = frame 3, bottom-right = frame 4. All ` +
    `${FRAMES_PER_STATE} quadrants must show the EXACT SAME character with EXACTLY the same hair color, ` +
    `hairstyle, skin tone, clothing, and clothing colors in every single quadrant — do not vary these ` +
    `between quadrants, only the pose changes. Leave a thin visible gap between quadrants so the image ` +
    `can be cut apart cleanly along a simple ${STATE_GRID_COLS}x${STATE_GRID_ROWS} grid.`;
  const posePrompt = `Pose across all ${FRAMES_PER_STATE} frames: ${STATE_PROMPTS[stateKey]} — a smooth, ` +
    `subtle progression through this pose from frame 1 to frame ${FRAMES_PER_STATE} (slight limb/weight ` +
    `shift only) so they can loop into a smooth animation.`;

  if (usingAnchor) {
    return `${IDENTITY_LOCK_INSTRUCTION} ${gridLayoutInstruction} ${posePrompt} Same character, different ` +
      `pose only, in every quadrant.`;
  }
  return `${CHARACTER_DESCRIPTOR} ${gridLayoutInstruction} ${posePrompt}`;
}

// Fallback path (used only if grid generation fails structurally for this
// provider — see sliceGridImage()/generateStateFrames()): the original
// one-call-per-frame prompt, unchanged from before this change. Costs 4
// calls instead of 1 for whichever state needs it.
function buildFallbackFramePrompt(stateKey, frameIndex, usingAnchor) {
  const framingInstruction = `This is animation frame ${frameIndex + 1} of ${FRAMES_PER_STATE} for this ` +
    `pose — a subtle variation from the other frames (slight limb/weight shift) so the frames can loop ` +
    `into a smooth animation, but the character's identity, proportions, colors and outfit must stay ` +
    `identical across all frames.`;
  if (usingAnchor) {
    return `${IDENTITY_LOCK_INSTRUCTION} Pose: ${STATE_PROMPTS[stateKey]}. ${framingInstruction} Same ` +
      `character, different pose only.`;
  }
  return `${CHARACTER_DESCRIPTOR} Pose: ${STATE_PROMPTS[stateKey]}. ${framingInstruction}`;
}

// Slices a single generated grid image into FRAMES_PER_STATE separate frame
// buffers, in the same top-left/top-right/bottom-left/bottom-right = frame
// 1/2/3/4 order requested in buildGridPrompt(). Returns { ok:false, reason }
// instead of throwing for any structural problem (undecodable image, or
// dimensions that don't look like a clean grid) — this is deliberately a
// *mechanical* sanity check, not a semantic one: it can't tell whether the 4
// quadrants actually look like a good walk cycle, only whether the image is
// even shaped like the grid we asked for. See generateStateFrames() for what
// happens on failure (falls back to 4 separate calls, logs why).
function sliceGridImage(buffer) {
  let image;
  try {
    image = nativeImage.createFromBuffer(buffer);
  } catch (err) {
    return { ok: false, reason: `could not decode the returned image (${err.message})` };
  }
  if (image.isEmpty()) {
    return { ok: false, reason: 'returned image could not be decoded (empty result)' };
  }

  const { width, height } = image.getSize();
  const cellWidth = Math.floor(width / STATE_GRID_COLS);
  const cellHeight = Math.floor(height / STATE_GRID_ROWS);

  if (cellWidth < MIN_GRID_CELL_SIZE || cellHeight < MIN_GRID_CELL_SIZE) {
    return {
      ok: false,
      reason: `image (${width}x${height}) is too small to slice into a clean ${STATE_GRID_COLS}x` +
        `${STATE_GRID_ROWS} grid (${cellWidth}x${cellHeight} per cell, need at least ${MIN_GRID_CELL_SIZE}px)`
    };
  }

  const aspectRatio = width / height;
  if (aspectRatio < 0.5 || aspectRatio > 2) {
    return {
      ok: false,
      reason: `image aspect ratio (${width}x${height}, ${aspectRatio.toFixed(2)}:1) doesn't look like a ` +
        `${STATE_GRID_COLS}x${STATE_GRID_ROWS} grid — the provider likely ignored the grid instruction ` +
        `and returned a single regular image instead`
    };
  }

  const frames = [];
  for (let row = 0; row < STATE_GRID_ROWS; row++) {
    for (let col = 0; col < STATE_GRID_COLS; col++) {
      const cropped = image.crop({ x: col * cellWidth, y: row * cellHeight, width: cellWidth, height: cellHeight });
      frames.push({ buffer: cropped.toPNG(), mimeType: 'image/png' });
    }
  }
  return { ok: true, frames };
}

// sessionId -> { provider, apiKey, originalPhoto: {buffer,mimeType}, anchorFrame: {buffer,mimeType}|null,
//                seed, gridModeDisabled, frames: { [stateKey]: [{buffer,mimeType}, ...] } }
const sessions = new Map();

function startSession({ buffer, mimeType }) {
  const key = keyStore.loadDecryptedKey();
  if (!key) throw new ForgeError('auth', 'No API key is stored. Go back to Key Exchange and connect one first.');
  const sessionId = crypto.randomUUID();
  sessions.set(sessionId, {
    provider: key.provider,
    apiKey: key.apiKey,
    originalPhoto: { buffer, mimeType },
    anchorFrame: null,
    // One seed per session, reused on every call (not re-rolled per frame),
    // passed to whichever provider adapter actually supports it
    // (backend/providers/stability.js, backend/providers/gemini.js — see
    // their own comments for what each does/doesn't guarantee). Never 0:
    // several providers treat a seed of exactly 0 as "pick one randomly"
    // rather than as a literal seed value.
    seed: crypto.randomInt(1, 2147483647),
    // Flips true the first time this session's provider fails the
    // structural grid-quality check (sliceGridImage()) — every state after
    // that goes straight to the 4-call fallback instead of spending a call
    // on a grid attempt that's already shown it won't work for this
    // provider. Session-scoped (not persisted) since it's meant as "this
    // provider misbehaved just now," not a permanent verdict.
    gridModeDisabled: false,
    frames: {}
  });
  return { sessionId, provider: key.provider };
}

function getSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) throw new ForgeError('unknown', 'This forge session has expired or was already closed. Start over from Key Exchange.');
  return session;
}

// Generates all frames for one state. Primary path: one grid-image API call
// (see buildGridPrompt()/sliceGridImage() above) — one call, self-consistent
// by construction. If that call's result doesn't structurally look like a
// clean grid, falls back to the original 4-separate-calls path for this
// state (see generateStateFramesFallback() below) and disables grid mode for
// the rest of this session, so later states don't each waste a doomed grid
// attempt on a provider that's already shown it won't comply. Nothing is
// stored on the session until a state's frames are fully resolved (grid or
// fallback), so a failed/retried state never leaves stale partial frames
// behind.
//
// Reference-image selection is the core of the anchor strategy: the anchor
// state (idle) always uses the real photo; every other state uses
// session.anchorFrame if one exists yet. If idle hasn't successfully
// generated yet (e.g. it's still queued, or failed and hasn't been retried),
// this falls back to the real photo for that call too rather than blocking —
// the caller gets `usingAnchor: false` back and can retry later, once idle
// has succeeded, to pick up the tighter anchor-based reference.
async function generateStateFrames(sessionId, stateKey) {
  if (!STATE_ORDER.includes(stateKey)) throw new ForgeError('unknown', `Unknown state "${stateKey}".`);
  const session = getSession(sessionId);

  const isAnchorState = stateKey === ANCHOR_STATE;
  const usingAnchor = !isAnchorState && !!session.anchorFrame;
  const referencePhoto = usingAnchor ? session.anchorFrame : session.originalPhoto;
  const strength = usingAnchor ? STRENGTH_FROM_ANCHOR : STRENGTH_FROM_PHOTO;

  let frames;
  let usedGridMode = false;
  let gridFallbackReason = null;

  if (!session.gridModeDisabled) {
    const gridImage = await providers.generateFrame(session.provider, {
      referencePhoto,
      prompt: buildGridPrompt(stateKey, usingAnchor),
      apiKey: session.apiKey,
      seed: session.seed,
      strength,
      inputFidelity: 'high'
    });
    const sliced = sliceGridImage(gridImage.buffer);
    if (sliced.ok) {
      frames = sliced.frames;
      usedGridMode = true;
    } else {
      gridFallbackReason = sliced.reason;
      console.warn(`[motekin] grid generation failed for provider "${session.provider}" on state ` +
        `"${stateKey}": ${sliced.reason}. Falling back to 4 separate calls for this state, and disabling ` +
        `grid mode for the rest of this session.`);
      session.gridModeDisabled = true;
    }
  }

  if (!frames) {
    frames = await generateStateFramesFallback(session, stateKey, referencePhoto, strength, usingAnchor);
  }

  session.frames[stateKey] = frames;
  // Locks in (or re-locks in, on a manual regen of idle) the anchor every
  // other state will reference from here on.
  if (isAnchorState) session.anchorFrame = frames[0];
  return { frames, usingAnchor, usedGridMode, gridFallbackReason };
}

// The original one-call-per-frame path (4 sequential calls), used when grid
// generation isn't available for this state/session — either because a
// prior state in this session already showed this provider doesn't comply
// with the grid instruction (session.gridModeDisabled), or because *this*
// state's own grid attempt just failed that check (see generateStateFrames()
// above, which already made that one grid call before falling back here —
// so a state falling back this way costs 1 (failed grid) + 4 (fallback) = 5
// calls, not 4; only later states in the same session skip straight to 4).
async function generateStateFramesFallback(session, stateKey, referencePhoto, strength, usingAnchor) {
  const frames = [];
  for (let i = 0; i < FRAMES_PER_STATE; i++) {
    const prompt = buildFallbackFramePrompt(stateKey, i, usingAnchor);
    const frame = await providers.generateFrame(session.provider, {
      referencePhoto,
      prompt,
      apiKey: session.apiKey,
      seed: session.seed,
      strength,
      inputFidelity: 'high'
    });
    frames.push(frame);
  }
  return frames;
}

function endSession(sessionId) {
  sessions.delete(sessionId);
}

module.exports = {
  STATE_ORDER,
  FRAMES_PER_STATE,
  GRID_COLUMNS,
  FRAME_SIZE,
  startSession,
  generateStateFrames,
  endSession
};
