'use strict';

// ---------------------------------------------------------------------------
// MoteKin renderer. The dashboard's pet list is real — window.motekin (see
// motekin-preload.js/motekin-main.js) reads Founder Pet's actual character
// packs and live active/inactive state, and Activate/Deactivate really
// spawn/close that pet in Founder Pet. The forge flow (Key/Intake/Forge/
// Review/Deploy) is now real too: Key Exchange saves an encrypted API key
// (backend/keyStore.js), Intake reads a real photo file, Forge calls the
// configured provider's real API per state (backend/forge.js + backend/
// providers/), Review can trigger a real regen per state, and Deploy
// composites the generated frames into a real spritesheet.webp + pet.json
// on disk (backend/packWriter.js) and copies it into Founder Pet's
// characters/ folder.
// ---------------------------------------------------------------------------

// Row order must match backend/forge.js's STATE_ORDER (and, in turn,
// shared/characterPacks.js's QUICK_PACK_ROW_ORDER) exactly — this is what
// makes the assembled spritesheet a valid quick-pack-shaped grid.
const STATES = [
  { key: 'idle', label: 'IDLE' }, { key: 'walk', label: 'WALK' }, { key: 'typing', label: 'TYPING' },
  { key: 'thinking', label: 'THINKING' }, { key: 'celebrate', label: 'CELEBRATE' }, { key: 'tired', label: 'TIRED' },
  { key: 'alert', label: 'ALERT' }, { key: 'talking', label: 'TALKING' }, { key: 'working', label: 'WORKING' }
];
const NAV_LABELS = ['KEY', 'INTAKE', 'FORGE', 'REVIEW', 'DEPLOY'];

const state = {
  view: 'dashboard', // 'dashboard' | 'forge'
  step: 0,
  maxReached: 0,

  providersList: [], // [{id,label,keyPlaceholder,keyHelpUrl,costNote}], loaded via loadForgeMeta()
  forgeConfig: { states: STATES.map((s) => s.key), framesPerState: 4, gridColumns: 8, frameSize: 192 }, // overwritten by loadForgeMeta(); these defaults match backend/forge.js
  keyStatus: { hasKey: false, provider: null }, // loaded via loadForgeMeta(); drives the "key on file, skip straight through" behavior
  provider: '',
  apiKey: '',
  changingKey: false, // true once the user explicitly asks to replace an on-file key
  keySaving: false,
  keySaveError: null,

  photoDropped: false,
  photoBase64: null,
  photoMimeType: null,
  photoPreviewUrl: null,
  photoError: null,

  sessionId: null, // backend/forge.js generation session, created on entering step 2
  genStatuses: new Array(9).fill('pending'), // 'pending' | 'active' | 'done' | 'failed'
  genFrames: new Array(9).fill(null), // per-state array of generated-frame data URLs
  genErrors: new Array(9).fill(null), // per-state { message, kind } for failed states
  genIndex: -1,
  genPulseIndex: -1,
  logLines: [],

  approvals: new Array(9).fill('pending'),
  justApproved: -1,
  justRegenerated: -1, // Review-screen tile index mid-flash from a just-completed regen (solid-fill confirm, see step3Html)
  charName: '',
  spawning: false,
  spawnError: null,

  packs: [], // real character packs, loaded via loadPacks()
  packsLoading: true,
  packsError: null, // set if the get-character-packs IPC call itself fails
  actionError: null // set if the last activate/deactivate call failed
};

// packId -> data URL of that pack's cropped idle-frame preview, or `null` if
// generating it failed (fall back to the placeholder tile). Kept outside
// `state` since it's a derived cache, not UI state, and shouldn't be reset
// by re-renders.
const previewCache = {};
// Loaded Image objects for generated frames, keyed by data URL, so
// assembleSpritesheet() doesn't reload the same frame image repeatedly when
// it's duplicated across grid columns (see buildFrameGrid()).
const frameImageCache = new Map();

let genPulseTimer = null;
let justApprovedTimer = null;
let justRegeneratedTimer = null;

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// state transitions
// ---------------------------------------------------------------------------

function canProceed(step) {
  if (step === 0) {
    if (state.keyStatus.hasKey && !state.changingKey) return true;
    return state.apiKey.trim().length > 0 && !!state.provider;
  }
  if (step === 1) return state.photoDropped;
  if (step === 2) return state.genStatuses.every((s) => s === 'done');
  if (step === 3) return state.approvals.every((a) => a === 'approved');
  return true;
}

// A forge session holds generated image buffers in the main process's
// memory (backend/forge.js) until it's explicitly deployed or cancelled —
// free it whenever the user abandons a run rather than letting sessions pile
// up for the life of the app.
function cancelForgeSessionIfAny() {
  if (state.sessionId) {
    window.motekin.forgeCancel(state.sessionId);
    state.sessionId = null;
  }
}

function onGoDashboard() {
  cancelForgeSessionIfAny();
  state.view = 'dashboard';
  render();
  loadPacks();
}

function onForgeNew() {
  cancelForgeSessionIfAny();
  if (genPulseTimer) clearTimeout(genPulseTimer);
  if (justApprovedTimer) clearTimeout(justApprovedTimer);
  if (justRegeneratedTimer) clearTimeout(justRegeneratedTimer);
  // If a key's already on file, skip the Key Exchange step entirely and
  // land straight on Intake — the nav pill for KEY is still reachable (it's
  // within maxReached) if the user wants to change provider/key.
  const skipKeyStep = state.keyStatus.hasKey;
  Object.assign(state, {
    view: 'forge',
    step: skipKeyStep ? 1 : 0,
    maxReached: skipKeyStep ? 1 : 0,
    provider: state.keyStatus.provider || state.provider,
    apiKey: '',
    changingKey: false,
    keySaveError: null,
    photoDropped: false,
    photoBase64: null,
    photoMimeType: null,
    photoPreviewUrl: null,
    photoError: null,
    sessionId: null,
    genStatuses: new Array(9).fill('pending'),
    genFrames: new Array(9).fill(null),
    genErrors: new Array(9).fill(null),
    genIndex: -1,
    genPulseIndex: -1,
    logLines: [],
    approvals: new Array(9).fill('pending'),
    justApproved: -1,
    justRegenerated: -1,
    charName: '',
    spawnError: null
  });
  render();
}

// Loads the real character-pack list (Founder Pet's assets/ + characters/
// scan, plus its live active/inactive state) and kicks off preview-frame
// generation for any pack not already cached.
async function loadPacks() {
  state.packsLoading = true;
  state.packsError = null;
  render();
  try {
    state.packs = await window.motekin.getCharacterPacks();
  } catch (err) {
    state.packs = [];
    state.packsError = err.message || String(err);
  }
  state.packsLoading = false;
  render();

  for (const pack of state.packs) {
    if (pack.id in previewCache) continue;
    buildPreview(pack);
  }
}

// Loads provider metadata, forge sizing config, and current key status —
// all real, from backend/. Called once at startup.
async function loadForgeMeta() {
  try {
    const [providersList, forgeConfig, keyStatus] = await Promise.all([
      window.motekin.getProviders(),
      window.motekin.getForgeConfig(),
      window.motekin.getKeyStatus()
    ]);
    state.providersList = providersList;
    state.forgeConfig = forgeConfig;
    state.keyStatus = keyStatus;
    if (!state.provider) state.provider = keyStatus.provider || (providersList[0] && providersList[0].id) || '';
  } catch (err) {
    // Non-fatal: the dashboard itself doesn't need this. Forge entry will
    // just show whatever defaults are already in state.
    console.error('[motekin] failed to load forge metadata:', err);
  }
  render();
}

// Crops just the pack's first idle-animation frame out of its full
// spritesheet and turns it into a data URL — the same trimmed-vs-not
// technique renderer/animator.js uses to draw a live frame, just applied
// once to a static offscreen canvas instead of every animation tick.
async function buildPreview(pack) {
  try {
    const atlas = pack.atlas || (await (await fetch(`${pack.baseUrl}/pet.json`)).json());
    const anim = atlas.animations.idle || atlas.animations[atlas.meta.defaultState] || Object.values(atlas.animations)[0];
    const frameData = atlas.frames[anim.frames[0]];
    const { frame, spriteSourceSize, sourceSize } = frameData;

    const image = await loadImage(`${pack.baseUrl}/${pack.imageFile}`);
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');

    if (frame.w !== sourceSize.w || frame.h !== sourceSize.h) {
      canvas.width = sourceSize.w;
      canvas.height = sourceSize.h;
      ctx.drawImage(image, frame.x, frame.y, frame.w, frame.h, spriteSourceSize.x, spriteSourceSize.y, frame.w, frame.h);
    } else {
      canvas.width = frame.w;
      canvas.height = frame.h;
      ctx.drawImage(image, frame.x, frame.y, frame.w, frame.h, 0, 0, frame.w, frame.h);
    }

    previewCache[pack.id] = canvas.toDataURL('image/png');
  } catch (err) {
    previewCache[pack.id] = null; // falls back to the placeholder tile
  }
  render();
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

async function toggleActivate(packId, currentlyActive) {
  state.actionError = null;
  render();
  const result = await window.motekin.setPetActive(packId, !currentlyActive);
  if (result.ok) {
    state.packs = state.packs.map((p) => (p.id === packId ? { ...p, active: !currentlyActive } : p));
  } else {
    state.actionError = result.error;
  }
  render();
}

function goStep(n) {
  if (n > state.step && !canProceed(state.step)) return;
  if (n > state.maxReached) return;
  state.step = n;
  render();
  if (n === 2 && state.genIndex === -1) beginGen();
}

async function onNext() {
  if (!canProceed(state.step)) return;

  if (state.step === 0 && (state.changingKey || !state.keyStatus.hasKey)) {
    const saved = await saveKeyIfNeeded();
    if (!saved) return;
  }
  if (state.step === 1 && !state.sessionId) {
    const started = await startForgeSession();
    if (!started) return;
  }

  const next = state.step + 1;
  state.step = next;
  state.maxReached = Math.max(state.maxReached, next);
  render();
  if (next === 2 && state.genIndex === -1) beginGen();
}

function onBack() {
  state.step = Math.max(0, state.step - 1);
  render();
}

async function saveKeyIfNeeded() {
  state.keySaving = true;
  state.keySaveError = null;
  render();
  const result = await window.motekin.saveKey(state.provider, state.apiKey);
  state.keySaving = false;
  if (!result.ok) {
    state.keySaveError = result.error;
    render();
    return false;
  }
  state.keyStatus = { hasKey: true, provider: state.provider };
  state.changingKey = false;
  state.apiKey = ''; // plaintext never needs to live in renderer state past the point it's been saved
  render();
  return true;
}

async function startForgeSession() {
  state.photoError = null;
  render();
  const result = await window.motekin.forgeStart(state.photoBase64, state.photoMimeType);
  if (!result.ok) {
    state.photoError = result.error;
    render();
    return false;
  }
  state.sessionId = result.sessionId;
  return true;
}

function onProviderSelect(providerId) {
  if (state.provider === providerId) return;
  state.provider = providerId;
  render();
}

function onChangeKey() {
  state.changingKey = true;
  state.apiKey = '';
  state.keySaveError = null;
  render();
}

function onApiKeyInput(value) {
  state.apiKey = value;
  updateNextButtonState();
}

function onCharNameInput(value) {
  state.charName = value;
  updateSpawnButtonState();
}

// Triggered by clicking the drop target — opens the real (hidden) file
// picker. The actual photo bytes are captured in handlePhotoFile(), fired
// from either this picker's change event or a real drag-and-drop (see the
// delegated dragover/drop listeners near the bottom of this file).
function onDropPhoto() {
  const input = document.getElementById('photoFileInput');
  if (input) input.click();
}

function handlePhotoFile(file) {
  if (!file) return;
  if (!file.type || !file.type.startsWith('image/')) {
    state.photoError = 'Please choose an image file.';
    render();
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    const match = /^data:([^;]+);base64,(.+)$/.exec(String(reader.result));
    if (!match) {
      state.photoError = 'Could not read that file.';
      render();
      return;
    }
    state.photoMimeType = match[1];
    state.photoBase64 = match[2];
    state.photoPreviewUrl = String(reader.result);
    state.photoDropped = true;
    state.photoError = null;
    render();
    updateNextButtonState();
  };
  reader.onerror = () => {
    state.photoError = 'Could not read that file.';
    render();
  };
  reader.readAsDataURL(file);
}

// Sequentially forges all 9 states, one real provider call-batch at a time
// (matches the UI's own "nine states, one at a time" framing, and avoids
// bursting past provider rate limits). A state failing doesn't stop the
// rest of the sequence — it's marked 'failed' and left for a manual retry
// (retryState()) so one bad generation can't silently break the whole flow.
async function beginGen() {
  state.genIndex = 0;
  state.logLines = ['[00.0s] intake locked :: beginning forge sequence'];
  render();

  for (let i = 0; i < STATES.length; i++) {
    await runStateGeneration(i);
  }

  state.genIndex = STATES.length;
  const failedCount = state.genStatuses.filter((s) => s === 'failed').length;
  state.logLines.push(failedCount === 0
    ? '[ok] sequence complete :: 9/9 states ready'
    : `[warn] sequence complete :: ${9 - failedCount}/9 ready, ${failedCount} failed (retry below)`);
  state.logLines = state.logLines.slice(-8);
  render();
}

// idle (STATES[0]) is always the anchor state, generated from the real
// photo — see backend/forge.js. Every other state uses the generated idle
// frame as its reference *once idle has actually succeeded*; this is just
// the client-side prediction for the "about to forge" log line (the
// authoritative answer comes back from the IPC call itself as
// result.usingAnchor, logged separately below).
function willUseAnchor(i) {
  return STATES[i].key !== 'idle' && state.genStatuses[0] === 'done';
}

async function runStateGeneration(i) {
  state.genIndex = i;
  state.genStatuses[i] = 'active';
  const referenceNote = STATES[i].key === 'idle'
    ? 'from original photo (this becomes the anchor)'
    : willUseAnchor(i) ? 'using anchor reference' : 'from original photo (anchor not ready yet)';
  // 4 frames of this state are requested as ONE grid image in a single API
  // call (see backend/forge.js's buildGridPrompt/sliceGridImage) — a single
  // generation is self-consistent by construction, which is what keeps
  // frames within a state from drifting from each other (different hair/
  // outfit colors between frames of the same pose). Only falls back to the
  // old 4-separate-calls approach if a provider's output doesn't actually
  // look like a clean grid — see the [warn]/[fallback] log line below.
  state.logLines.push(`[..] forging ${STATES[i].label.toLowerCase()} state :: ${referenceNote} :: 1 call, 2x2 grid`);
  state.logLines = state.logLines.slice(-8);
  render();

  const result = await window.motekin.forgeGenerateState(state.sessionId, STATES[i].key);
  if (result.ok) {
    state.genStatuses[i] = 'done';
    state.genFrames[i] = result.frames.map((f) => f.dataUrl);
    state.genErrors[i] = null;
    const usedNote = result.usingAnchor ? 'used anchor reference (identity locked)' : 'used original photo';
    const gridNote = result.usedGridMode
      ? '1 call, sliced from grid'
      : result.gridFallbackReason
        ? `grid failed (${result.gridFallbackReason}) — fell back to 4 calls, grid mode off for rest of session`
        : '4 separate calls (grid mode off for this session)';
    state.logLines.push(`[ok] ${STATES[i].label.toLowerCase()} frame set rendered (${result.frames.length} frames, ${usedNote}, ${gridNote})`);
    state.genPulseIndex = i;
    if (genPulseTimer) clearTimeout(genPulseTimer);
    genPulseTimer = setTimeout(() => {
      state.genPulseIndex = -1;
      render();
    }, 450);
  } else {
    state.genStatuses[i] = 'failed';
    state.genErrors[i] = { message: result.error, kind: result.errorKind };
    state.approvals[i] = 'pending';
    state.logLines.push(`[fail] ${STATES[i].label.toLowerCase()} :: ${result.error}`);
  }
  state.logLines = state.logLines.slice(-8);
  render();
}

// Re-runs generation for a single state — used both by a FAILED tile's
// retry control on the Forge screen and by the Review screen's REGEN
// button. Either way it's a real provider call, not a UI-only reset. On
// success, briefly flags the tile for the calm solid-fill confirm on the
// Review screen (see step3Html's regenConfirm handling) — no pop/bounce,
// no shake, just a clean color-fill flash, same spirit as approve's
// ring-flash but visually distinct so the two don't read as identical.
async function retryState(i) {
  if (state.genStatuses[i] === 'active') return;
  state.approvals[i] = 'pending';
  await runStateGeneration(i);
  if (state.genStatuses[i] === 'done') {
    state.justRegenerated = i;
    render();
    if (justRegeneratedTimer) clearTimeout(justRegeneratedTimer);
    justRegeneratedTimer = setTimeout(() => {
      if (state.justRegenerated === i) state.justRegenerated = -1;
      render();
    }, 700);
  }
}

function approve(i) {
  if (state.genStatuses[i] !== 'done') return;
  state.approvals[i] = 'approved';
  state.justApproved = i;
  render();
  if (justApprovedTimer) clearTimeout(justApprovedTimer);
  justApprovedTimer = setTimeout(() => {
    if (state.justApproved === i) state.justApproved = -1;
    render();
  }, 700);
}

function regen(i) {
  retryState(i);
}

// Composites every state's generated frames into one spritesheet image
// matching Founder Pet's fixed 8-column x 9-row quick-pack grid (see
// shared/characterPacks.js). Each state generated only
// forgeConfig.framesPerState real frames (4, not 8 — see backend/forge.js
// for why), so columns beyond that repeat the same frames
// (0,1,2,3,0,1,2,3): visually identical to a native 4-frame loop played
// twice, just shaped to fit the grid. Each source frame is drawn with a
// center-cropped "cover" fit into its FRAME_SIZE square cell, since
// providers don't all return the same aspect ratio.
async function assembleSpritesheet() {
  const { frameSize, gridColumns } = state.forgeConfig;
  const rows = STATES.length;
  const canvas = document.createElement('canvas');
  canvas.width = frameSize * gridColumns;
  canvas.height = frameSize * rows;
  const ctx = canvas.getContext('2d');

  for (let row = 0; row < rows; row++) {
    const frames = state.genFrames[row];
    if (!frames || frames.length === 0) throw new Error(`No generated frames for state "${STATES[row].key}".`);
    for (let col = 0; col < gridColumns; col++) {
      const dataUrl = frames[col % frames.length];
      const image = await getCachedFrameImage(dataUrl);
      drawCover(ctx, image, col * frameSize, row * frameSize, frameSize, frameSize);
    }
  }

  return canvas.toDataURL('image/webp', 0.92);
}

async function getCachedFrameImage(dataUrl) {
  if (frameImageCache.has(dataUrl)) return frameImageCache.get(dataUrl);
  const image = await loadImage(dataUrl);
  frameImageCache.set(dataUrl, image);
  return image;
}

// Scales `image` to fully cover a `w`x`h` box centered at (x,y), cropping
// any overflow — avoids squashing non-square provider output into a square
// grid cell.
function drawCover(ctx, image, x, y, w, h) {
  const scale = Math.max(w / image.width, h / image.height);
  const drawW = image.width * scale;
  const drawH = image.height * scale;
  const dx = x + (w - drawW) / 2;
  const dy = y + (h - drawH) / 2;
  ctx.drawImage(image, dx, dy, drawW, drawH);
}

async function onSpawn() {
  if (!state.charName.trim() || !canProceed(3) || state.spawning) return;
  state.spawning = true;
  state.spawnError = null;
  updateSpawnButtonState();
  render();

  try {
    const spritesheetDataUrl = await assembleSpritesheet();
    const result = await window.motekin.forgeDeploy(state.sessionId, state.charName, spritesheetDataUrl);
    if (!result.ok) throw new Error(result.error);

    state.sessionId = null; // consumed by forge-deploy on the main-process side
    state.spawning = false;
    state.view = 'dashboard';
    render();
    loadPacks();
  } catch (err) {
    state.spawning = false;
    state.spawnError = err.message || String(err);
    updateSpawnButtonState();
    render();
  }
}

// ---------------------------------------------------------------------------
// direct DOM updates (used for keystroke-level input changes so the focused
// input never gets torn down and rebuilt mid-typing)
// ---------------------------------------------------------------------------

function updateNextButtonState() {
  const btn = document.getElementById('nextBtn');
  if (!btn) return;
  const ok = canProceed(state.step);
  btn.disabled = !ok;
  btn.style.opacity = ok ? '1' : '.4';
}

function updateSpawnButtonState() {
  const btn = document.getElementById('spawnBtn');
  if (!btn) return;
  const disabled = !state.charName.trim() || state.spawning;
  btn.disabled = disabled;
  btn.style.opacity = state.charName.trim() ? '1' : '.4';
}

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

function render() {
  renderTopbarMid();
  renderContent();
  renderFooter();
}

function renderTopbarMid() {
  const el = document.getElementById('topbarMid');
  if (state.view === 'forge') {
    const steps = NAV_LABELS.map((label, i) => {
      const active = i === state.step;
      const reached = i <= state.maxReached;
      const barColor = active ? '#FF204E' : reached ? '#A0153E' : 'rgba(160,21,62,.35)';
      const barGlow = active ? '0 0 10px 2px rgba(255,32,78,.7)' : 'none';
      const textColor = active ? '#F4F1EE' : 'rgba(244,241,238,.4)';
      return `
        <button class="nav-step" onclick="goStep(${i})">
          <span class="nav-step-bar" style="background:${barColor};box-shadow:${barGlow};"></span>
          <span class="nav-step-label" style="color:${textColor};">${label}</span>
        </button>`;
    }).join('');
    el.innerHTML = `
      <div class="nav-steps-wrap">
        <div class="nav-steps">${steps}</div>
        <button class="exit-btn" onclick="onGoDashboard()">EXIT &times;</button>
      </div>`;
  } else {
    el.innerHTML = `<div class="home-base-label">HOME BASE</div>`;
  }
}

function renderContent() {
  const el = document.getElementById('content');
  if (state.view === 'dashboard') {
    el.innerHTML = dashboardHtml();
  } else if (state.step === 0) {
    el.innerHTML = step0Html();
  } else if (state.step === 1) {
    el.innerHTML = step1Html();
  } else if (state.step === 2) {
    el.innerHTML = step2Html();
  } else if (state.step === 3) {
    el.innerHTML = step3Html();
  } else {
    el.innerHTML = step4Html();
  }
}

function renderFooter() {
  const el = document.getElementById('forgeFooter');
  if (state.view !== 'forge') {
    el.className = 'forge-footer';
    el.innerHTML = '';
    return;
  }
  el.className = 'forge-footer visible';

  const showBack = state.step > 0;
  const showNext = state.step < 4;
  const nextOk = canProceed(state.step);
  const nextLabel = state.step === 0 ? (state.keySaving ? 'CONNECTING…' : 'CONNECT') : state.step === 1 ? 'ANALYZE' : state.step === 2 ? 'REVIEW' : 'CONFIRM';

  const backHtml = showBack
    ? `<button class="btn-back" onclick="onBack()">&larr; BACK</button>`
    : `<div></div>`;
  const nextHtml = showNext
    ? `<button id="nextBtn" class="btn-next" onclick="onNext()" ${nextOk && !state.keySaving ? '' : 'disabled'} style="opacity:${nextOk && !state.keySaving ? 1 : .4};">${nextLabel} &rarr;</button>`
    : '';

  el.innerHTML = backHtml + nextHtml;
}

function dashboardHtml() {
  const errorBanner = state.actionError
    ? `<div class="dash-error-banner">${escapeHtml(state.actionError)}</div>`
    : '';

  if (state.packsError) {
    return `
      <div class="screen">
        <div class="eyebrow">COMPANION GALLERY</div>
        <h1 class="dash-h1">YOUR COMPANIONS</h1>
        <div class="empty-state">
          <div class="crosshair-lg"><span class="h"></span><span class="v"></span></div>
          <div class="empty-state-title">COULDN'T READ CHARACTER PACKS</div>
          <p>${escapeHtml(state.packsError)}</p>
          <button class="btn-primary" onclick="loadPacks()">RETRY</button>
        </div>
      </div>`;
  }

  // Defensive per point 5 of the spec: this shouldn't happen since the
  // bundled default (assets/) is always a valid pack, but a scan can
  // theoretically come back empty (e.g. assets/ itself failed validation).
  if (!state.packsLoading && state.packs.length === 0) {
    return `
      <div class="screen">
        <div class="eyebrow">COMPANION GALLERY</div>
        <h1 class="dash-h1">YOUR COMPANIONS</h1>
        <div class="empty-state">
          <div class="crosshair-lg"><span class="h"></span><span class="v"></span></div>
          <div class="empty-state-title">NOTHING FORGED YET</div>
          <p>Your gallery's empty. Feed MoteKin a photo and an API key, and it'll forge your first companion in under two minutes.</p>
          <button class="btn-primary" onclick="onForgeNew()">FORGE YOUR FIRST COMPANION &rarr;</button>
        </div>
      </div>`;
  }

  const cards = state.packs.map((p) => {
    const borderColor = p.active ? '#FF204E' : 'rgba(160,21,62,.4)';
    const glow = p.active ? '0 0 20px 1px rgba(255,32,78,.2)' : 'none';
    const dotColor = p.active ? '#FF204E' : 'rgba(244,241,238,.35)';
    const dotAnim = p.active ? 'pulseDot 1.8s ease-in-out infinite' : 'none';
    const statusText = p.active ? 'ACTIVE' : 'INACTIVE';
    const toggleText = p.active ? '#FF204E' : 'rgba(244,241,238,.7)';
    const toggleLabel = p.active ? 'DEACTIVATE' : 'ACTIVATE';
    const preview = previewCache[p.id];
    const thumb = preview
      ? `<img class="pet-thumb-img" src="${preview}" alt="${escapeHtml(p.label)}"/>`
      : `<span>IDLE / LOOP</span>`;
    return `
      <div class="pet-card" style="border-color:${borderColor};box-shadow:${glow};">
        <div class="pet-thumb">${thumb}</div>
        <div class="pet-row">
          <span class="pet-name">${escapeHtml(p.label)}</span>
          <div class="pet-status">
            <span class="pet-status-dot" style="background:${dotColor};animation:${dotAnim};"></span>
            <span class="pet-status-text" style="color:${dotColor};">${statusText}</span>
          </div>
        </div>
        <button class="pet-toggle-btn" style="color:${toggleText};" data-action="toggle-activate" data-pack-id="${escapeHtml(p.id)}" data-pack-active="${p.active}">${toggleLabel}</button>
      </div>`;
  }).join('');

  return `
    <div class="screen">
      <div class="eyebrow">COMPANION GALLERY</div>
      <h1 class="dash-h1">YOUR COMPANIONS</h1>
      ${errorBanner}
      <div class="pet-grid">
        ${cards}
        <div class="forge-new-tile" onclick="onForgeNew()">
          <div class="crosshair-sm"><span class="h"></span><span class="v"></span></div>
          <span class="forge-new-label">+ FORGE NEW<br/>COMPANION</span>
        </div>
      </div>
    </div>`;
}

function step0Html() {
  const rows = [
    { k: 'ENCRYPTION', v: 'OS-BACKED (safeStorage)' },
    { k: 'TRANSMISSION', v: 'DIRECT TO PROVIDER ONLY' },
    { k: 'STORAGE', v: 'DEVICE-ONLY' },
    { k: 'THIRD PARTIES', v: 'ZERO' }
  ].map((row) => `
    <div class="telemetry-row">
      <span class="k">${row.k}</span>
      <span class="v">${row.v}</span>
    </div>`).join('');

  const showKeyOnFile = state.keyStatus.hasKey && !state.changingKey;
  const currentProviderMeta = state.providersList.find((p) => p.id === state.keyStatus.provider);

  let keyPanelHtml;
  if (showKeyOnFile) {
    keyPanelHtml = `
      <div class="key-panel">
        <div class="key-panel-label">KEY ON FILE</div>
        <div class="key-onfile-row">
          <span class="key-onfile-provider">${escapeHtml((currentProviderMeta && currentProviderMeta.label) || state.keyStatus.provider)}</span>
          <span class="key-onfile-dots">••••••••••••••••</span>
        </div>
        <button class="btn-change-key" onclick="onChangeKey()">CHANGE PROVIDER / KEY</button>
      </div>`;
  } else {
    const providerButtons = state.providersList.map((p) => {
      const active = state.provider === p.id;
      return `<button class="provider-btn ${active ? 'active' : ''}" onclick="onProviderSelect('${p.id}')">${escapeHtml(p.label)}</button>`;
    }).join('');
    const selectedMeta = state.providersList.find((p) => p.id === state.provider);
    const placeholder = (selectedMeta && selectedMeta.keyPlaceholder) || 'paste your api key';
    const errorHtml = state.keySaveError
      ? `<div class="key-save-error">${escapeHtml(state.keySaveError)}</div>`
      : '';
    keyPanelHtml = `
      <div class="provider-select-row">${providerButtons}</div>
      <div class="key-panel">
        <div class="key-panel-label">PASTE KEY BELOW</div>
        <div class="key-input-row">
          <span class="prompt-chevron">&gt;</span>
          <input id="apiKeyInput" class="key-input" type="password" placeholder="${escapeHtml(placeholder)}" value="${escapeHtml(state.apiKey)}" oninput="onApiKeyInput(this.value)"/>
          <span class="blink-cursor"></span>
        </div>
      </div>
      ${errorHtml}`;
  }

  return `
    <div class="screen">
      <div class="step0-grid">
        <div>
          <div class="eyebrow">STEP 01 // KEY EXCHANGE</div>
          <h1 class="step-h1">AUTHENTICATE<br/>THE FORGE</h1>
          <p class="step-copy">MoteKin needs your own image-generation API key to forge a sprite that's actually yours. It never leaves this machine except to call that provider's API directly &mdash; no relay, no cloud copy, no one peeking over its shoulder.</p>
          ${keyPanelHtml}
          <div class="key-hint">Stored locally, encrypted at rest via your OS's secure storage. We physically cannot see it. Neither can Founder Pet.</div>
        </div>
        <div class="telemetry-panel">
          <div class="telemetry-title">SECURITY TELEMETRY</div>
          ${rows}
        </div>
      </div>
      <div class="motion-note">MOTION &mdash; headline glitch-settles in on entry; input cursor blinks steady; key field has a soft red inner glow on focus, no harsh flash.</div>
    </div>`;
}

function step1Html() {
  const dropped = state.photoDropped;
  const statusText = dropped ? 'SUBJECT LOCKED' : 'AWAITING SUBJECT';
  const statusColor = dropped ? '#FF204E' : 'rgba(244,241,238,.4)';
  const targetBody = dropped
    ? `<div class="drop-filled">
         <div class="scan-sweep"></div>
         <div class="drop-filled-body">${state.photoPreviewUrl ? `<img class="drop-filled-img" src="${state.photoPreviewUrl}" alt="reference photo"/>` : `<span>SUBJECT.JPG</span>`}</div>
       </div>`
    : `<div class="drop-empty">
         <div class="drop-empty-ring"><div class="drop-empty-dot"></div></div>
         <div class="drop-empty-title">DRAG PHOTO INTO TARGET</div>
         <div class="drop-empty-sub">or click to choose a file</div>
       </div>`;

  const providerMeta = state.providersList.find((p) => p.id === state.provider);
  const costNote = (providerMeta && providerMeta.costNote) ||
    'Forging makes real, paid API calls to your selected provider using your own key.';
  const photoErrorHtml = state.photoError
    ? `<div class="key-save-error">${escapeHtml(state.photoError)}</div>`
    : '';

  return `
    <div class="screen">
      <div class="step1-grid">
        <div>
          <div class="eyebrow">STEP 02 // INTAKE</div>
          <h1 class="step-h1 md">FEED THE<br/>SCANNER</h1>
          <p class="step1-copy">One clear photo of you, face visible. MoteKin's engine strips it down to shape, palette and attitude &mdash; then rebuilds it as a creature that fits in a tray icon.</p>
          <div class="intake-status" style="color:${statusColor};">${statusText}</div>
          <div class="cost-note">${escapeHtml(costNote)}</div>
        </div>
        <div>
          <div class="drop-target ${dropped ? 'dropped' : ''}" onclick="onDropPhoto()">
            <div class="corner tl"></div><div class="corner tr"></div>
            <div class="corner bl"></div><div class="corner br"></div>
            ${targetBody}
          </div>
          ${photoErrorHtml}
        </div>
      </div>
      <div class="motion-note">MOTION &mdash; crosshair corners hold steady while idle; on drop, a red sweep light passes down the frame twice, then settles into a locked still with a faint standing glow.</div>
    </div>`;
}

function step2Html() {
  const tiles = STATES.map((st, i) => {
    const status = state.genStatuses[i];
    const statusText = status === 'active' ? 'FORGING…' : status === 'done' ? 'READY' : status === 'failed' ? 'FAILED — TAP TO RETRY' : 'QUEUED';
    const statusColor = status === 'active' ? '#FF204E' : status === 'done' ? '#F4F1EE' : status === 'failed' ? '#FFB020' : 'rgba(244,241,238,.35)';
    const borderColor = status === 'active' ? '#FF204E' : status === 'done' ? '#A0153E' : status === 'failed' ? '#FFB020' : 'rgba(160,21,62,.3)';
    const blockOpacity = status === 'pending' ? 0.25 : 1;
    const pulseAnim = status === 'active'
      ? 'tilePulse 1.4s ease-in-out infinite'
      : (i === state.genPulseIndex ? 'popIn .4s ease-out' : 'none');
    const preview = state.genFrames[i] && state.genFrames[i][0];
    const block = preview
      ? `<img class="tile-preview-img" src="${preview}" alt="${escapeHtml(st.label)}"/>`
      : `<div class="block" style="opacity:${blockOpacity};"></div>`;
    const clickable = status === 'failed' ? `onclick="retryState(${i})"` : '';
    return `
      <div class="gen-tile ${status === 'failed' ? 'failed' : ''}" style="border-color:${borderColor};animation:${pulseAnim};" ${clickable}>
        ${block}
        <span class="tile-label">${st.label}</span>
        <span class="tile-status" style="color:${statusColor};">${statusText}</span>
      </div>`;
  }).join('');

  const logLines = state.logLines.map((line) => `<div class="log-line">${escapeHtml(line)}</div>`).join('');
  const framesPerState = state.forgeConfig.framesPerState;
  const framesDone = state.genStatuses.filter((g) => g === 'done').length * framesPerState;
  const providerMeta = state.providersList.find((p) => p.id === state.provider);
  const overallStatus = state.genIndex >= 9 ? 'COMPLETE' : state.genIndex >= 0 ? `FORGING ${STATES[state.genIndex] ? STATES[state.genIndex].label : ''}` : 'STANDBY';

  return `
    <div class="screen">
      <div class="eyebrow">STEP 03 // FORGE SEQUENCE</div>
      <h1 class="step-h1 sm">NINE STATES,<br/>ONE AT A TIME</h1>
      <div class="step2-grid">
        <div class="gen-tiles">${tiles}</div>
        <div class="log-panel">
          <div class="log-title">LIVE LOG</div>
          <div class="log-lines">${logLines}</div>
          <div class="log-stats">
            FRAMES RENDERED: ${framesDone} / ${9 * framesPerState}<br/>
            PROVIDER: ${escapeHtml((providerMeta && providerMeta.label) || state.provider || '—')}<br/>
            STATE: ${overallStatus}
          </div>
        </div>
      </div>
      <div class="motion-note">MOTION &mdash; the active tile pulses a slow red glow like it's breathing; on completion it snaps a quick checkmark pop-in and the glow drops to a steady low ember. Log lines type on one at a time.</div>
    </div>`;
}

function step3Html() {
  const tiles = STATES.map((st, i) => {
    const approved = state.approvals[i] === 'approved';
    const justApproved = state.justApproved === i;
    const justRegenerated = state.justRegenerated === i;
    const status = state.genStatuses[i];
    // Ring-flash (approve) and solid-fill (regen) are both pure box-shadow/
    // background transitions — no transform, no scale, no translate — by
    // design: that's what keeps these calm instead of shaky/jittery. Never
    // both at once (a regen always resets approvals[i] to 'pending' first,
    // see retryState()), but regen wins if it ever were possible.
    const flashAnim = justRegenerated ? 'regenConfirm .7s ease-out' : justApproved ? 'flashApprove .7s ease-out' : 'none';
    const borderColor = approved ? '#FF204E' : status === 'failed' ? '#FFB020' : 'rgba(160,21,62,.4)';
    const preview = state.genFrames[i] && state.genFrames[i][0];
    const thumb = preview
      ? `<img class="review-thumb-img" src="${preview}" alt="${escapeHtml(st.label)}"/>`
      : `<span>${st.label}</span>`;
    // Always rendered (never conditionally inserted/removed) so a status
    // message appearing/disappearing never shifts the buttons below it —
    // that layout jump, not any actual animation, was what read as a
    // "shake" before this fix.
    const statusText = status === 'active'
      ? 'REGENERATING&hellip;'
      : status === 'failed'
        ? escapeHtml((state.genErrors[i] && state.genErrors[i].message) || 'FAILED')
        : '&nbsp;';
    const statusLine = `<div class="review-status ${status === 'failed' ? 'failed' : ''}">${statusText}</div>`;
    const approveDisabled = status !== 'done';
    const regenDisabled = status === 'active';
    return `
      <div class="review-tile" style="border-color:${borderColor};animation:${flashAnim};">
        <div class="review-thumb">${thumb}</div>
        ${statusLine}
        <div class="review-actions">
          <button class="btn-approve ${approved ? 'approved' : ''}" onclick="approve(${i})" ${approveDisabled ? 'disabled' : ''}>APPROVE</button>
          <button class="btn-regen" onclick="regen(${i})" ${regenDisabled ? 'disabled' : ''}>REGEN</button>
        </div>
      </div>`;
  }).join('');

  return `
    <div class="screen">
      <div class="eyebrow">STEP 04 // INSPECTION</div>
      <h1 class="step-h1 sm">LOOK IT OVER<br/>BEFORE IT'S ALIVE</h1>
      <div class="review-grid">${tiles}</div>
      <div class="motion-note">MOTION &mdash; approving a tile fires a quick red ring-flash outward from the card and its border locks to a steady glow; a successful regen fires a calm solid-fill flash across the tile and fades out &mdash; no pop, no bounce, no shake, just a clean confirm.</div>
    </div>`;
}

function step4Html() {
  const spawnDisabled = !state.charName.trim() || state.spawning;
  const spawnOpacity = state.charName.trim() ? 1 : 0.4;
  const spawnLabel = state.spawning ? 'MATERIALIZING…' : 'SPAWN IN FOUNDER PET &rarr;';
  const previewFrame = state.genFrames[0] && state.genFrames[0][0];
  const previewBody = previewFrame
    ? `<img class="deploy-preview-img" src="${previewFrame}" alt="idle preview"/>`
    : `<span>IDLE / LOOP</span>`;
  const spawnErrorHtml = state.spawnError
    ? `<div class="key-save-error">${escapeHtml(state.spawnError)}</div>`
    : '';

  return `
    <div class="screen">
      <div class="step4-grid">
        <div class="deploy-preview">
          <div class="deploy-preview-box">${previewBody}</div>
          <div class="deploy-preview-caption">9 / 9 states forged &middot; approved</div>
        </div>
        <div>
          <div class="eyebrow">STEP 05 // DEPLOYMENT</div>
          <h1 class="step-h1 md">IT'S READY.<br/>NAME IT.</h1>
          <div class="name-panel">
            <div class="name-panel-label">CHARACTER NAME</div>
            <div class="name-input-row">
              <span class="prompt-chevron">&gt;</span>
              <input id="charNameInput" class="name-input" placeholder="e.g. GRIST" value="${escapeHtml(state.charName)}" oninput="onCharNameInput(this.value)"/>
            </div>
          </div>
          <button id="spawnBtn" class="btn-spawn" onclick="onSpawn()" ${spawnDisabled ? 'disabled' : ''} style="opacity:${spawnOpacity};">${spawnLabel}</button>
          <div class="spawn-hint">Drops straight into the tray as an active pet. No restart needed.</div>
          ${spawnErrorHtml}
        </div>
      </div>
      <div class="motion-note">MOTION &mdash; idle preview loops a slow breathing scale+glow; on spawn, button flashes bright then the whole panel briefly glitches out as if handing off to Founder Pet.</div>
    </div>`;
}

// ---------------------------------------------------------------------------
// particles (generated once, animated purely via CSS — not part of render())
// ---------------------------------------------------------------------------

function initParticles() {
  const layer = document.getElementById('particlesLayer');
  const frag = document.createDocumentFragment();
  for (let i = 0; i < 22; i++) {
    const left = Math.random() * 100;
    const top = Math.random() * 100;
    const size = 2 + Math.random() * 4;
    const dur = 6 + Math.random() * 8;
    const delay = Math.random() * 6;
    const div = document.createElement('div');
    div.className = 'particle';
    div.style.left = `${left}%`;
    div.style.top = `${top}%`;
    div.style.width = `${size}px`;
    div.style.height = `${size}px`;
    div.style.animationDuration = `${dur}s`;
    div.style.animationDelay = `${delay}s`;
    frag.appendChild(div);
  }
  layer.appendChild(frag);
}

// Delegated listener for controls whose args come from real, arbitrary
// pack data (folder names) rather than a fixed numeric index — inline
// onclick="fn('${p.id}')" would break (or worse, inject) if an id ever
// contained a quote, so this reads it back out of data-* attributes instead.
document.getElementById('content').addEventListener('click', (e) => {
  const el = e.target.closest('[data-action="toggle-activate"]');
  if (!el) return;
  toggleActivate(el.dataset.packId, el.dataset.packActive === 'true');
});

// Real drag-and-drop photo intake for the Intake screen's drop target. The
// target itself is torn down and rebuilt on every render() (innerHTML
// swap), so listeners are delegated on the stable #content container rather
// than attached to the target element directly.
document.getElementById('content').addEventListener('dragover', (e) => {
  if (e.target.closest('.drop-target')) e.preventDefault();
});
document.getElementById('content').addEventListener('drop', (e) => {
  if (!e.target.closest('.drop-target')) return;
  e.preventDefault();
  const file = e.dataTransfer.files && e.dataTransfer.files[0];
  handlePhotoFile(file);
});
document.getElementById('photoFileInput').addEventListener('change', (e) => {
  const file = e.target.files && e.target.files[0];
  handlePhotoFile(file);
  e.target.value = ''; // allow re-choosing the same file later
});

initParticles();
render();
loadPacks();
loadForgeMeta();
