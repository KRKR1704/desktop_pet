const FRAME_SIZE = 192;
const WALK_SPEED = 70; // px/sec
const MIN_WALK_DELAY = 15000;
const MAX_WALK_DELAY = 40000;
const MIN_MOOD_DELAY = 90000; // 1.5 min
const MAX_MOOD_DELAY = 240000; // 4 min
const MOOD_STATES = ['tired', 'thinking', 'celebrate', 'talking'];
const DRAG_HOLD_STATE = 'alert';
const CLICK_MOVE_THRESHOLD = 5; // px of mouse movement before a mousedown/up counts as a drag, not a click
const CLICK_REACTION_STATE = 'celebrate';

const canvas = document.getElementById('stage');
const ctx = canvas.getContext('2d');

let animator = null;
let trackedX = 0;
let trackedY = 0;
let state = 'idle'; // idle | walk | drag | mood
let walking = null; // { startX, targetX, startTime, duration }
let dragInfo = null; // { grabDx, grabDy }
let mouseDownState = null; // state at the moment mousedown fired, to tell a click from a drag
let dragMoved = false;
let walkTimer = null;
let moodTimer = null;
let currentMoodName = null; // which MOOD_STATES entry is currently playing, if any
let walkDelayMin = MIN_WALK_DELAY;
let walkDelayMax = MAX_WALK_DELAY;
let moodDelayMin = MIN_MOOD_DELAY;
let moodDelayMax = MAX_MOOD_DELAY;
let petPaused = false;
let activityState = null; // null | 'typing' | 'working', pushed from main

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

// baseUrl is an absolute file:// URL to this pet's character pack folder
// (see the get-asset-folder IPC handler in main.js for why it's absolute
// rather than a relative path — packaging requires it).
async function loadAtlas(baseUrl) {
  const res = await fetch(`${baseUrl}/pet.json`);
  return res.json();
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

function playRepeated(stateName, times, onDone) {
  let count = 0;
  animator.onLoop = (s) => {
    if (s !== stateName) return;
    count += 1;
    if (count >= times) {
      animator.onLoop = null;
      onDone();
    }
  };
  animator.play(stateName);
}

function goIdle() {
  state = 'idle';
  animator.flip = false;
  animator.onLoop = null;
  applyBaselineAnimation();
  scheduleWalk();
}

// Whenever the pet returns to its resting state (walk/mood/reaction finished,
// or activity just started/stopped), this decides what "resting" looks like:
// plain idle, or a typing/working pose if activity detection says so. Pause
// always wins over activity, since the user explicitly asked it to just sit still.
function applyBaselineAnimation() {
  if (!petPaused && activityState) {
    animator.play(activityState);
  } else {
    animator.play('idle');
  }
}

function scheduleWalk() {
  clearTimeout(walkTimer);
  const delay = randomBetween(walkDelayMin, walkDelayMax);
  walkTimer = setTimeout(startWalk, delay);
}

function scheduleMood() {
  clearTimeout(moodTimer);
  const delay = randomBetween(moodDelayMin, moodDelayMax);
  moodTimer = setTimeout(startMood, delay);
}

// Applies settings pushed from main (initial load, and live updates from the
// settings window). Re-arming the timers here makes frequency changes take
// effect on the next tick rather than waiting for whatever delay was already
// in flight.
function applySettings(settings) {
  if (settings.walkDelay) {
    walkDelayMin = settings.walkDelay.min;
    walkDelayMax = settings.walkDelay.max;
  }
  if (settings.moodDelay) {
    moodDelayMin = settings.moodDelay.min;
    moodDelayMax = settings.moodDelay.max;
  }
  if (typeof settings.paused === 'boolean') applyPause(settings.paused);
}

function applyPause(paused) {
  petPaused = paused;
  if (paused && (state === 'walk' || state === 'mood')) {
    walking = null;
    animator.onLoop = null;
    if (currentMoodName === 'talking') window.petAPI.hideBubble();
    currentMoodName = null;
    goIdle();
    scheduleMood();
  }
}

// Typing/working take priority over the idle-loop and random mood states, but
// must never interrupt an active walk-to-target or an active drag — those are
// left alone here and will naturally pick up the current activityState once
// they finish (via goIdle -> applyBaselineAnimation). Only an in-progress
// *random* mood (tracked via currentMoodName) is preempted; the short
// click/drag-release reaction (state 'mood' but no currentMoodName) is left
// to finish since it's a direct response to something the user just did.
function applyActivityState(newActivity) {
  activityState = newActivity;
  if (newActivity && state === 'mood' && currentMoodName) {
    walking = null;
    animator.onLoop = null;
    if (currentMoodName === 'talking') window.petAPI.hideBubble();
    currentMoodName = null;
    goIdle();
    scheduleMood();
    return;
  }
  if (state === 'idle') {
    animator.onLoop = null;
    applyBaselineAnimation();
  }
}

async function startWalk() {
  if (petPaused || activityState || state !== 'idle') {
    scheduleWalk();
    return;
  }
  const wa = await window.petAPI.getDisplayBounds();
  const minX = wa.x;
  const maxX = wa.x + wa.width - FRAME_SIZE;
  if (maxX <= minX) {
    scheduleWalk();
    return;
  }
  const targetX = randomBetween(minX, maxX);
  const distance = Math.abs(targetX - trackedX);
  if (distance < 4) {
    scheduleWalk();
    return;
  }

  state = 'walk';
  animator.flip = targetX > trackedX;
  animator.onLoop = null;
  animator.play('walk');

  walking = {
    startX: trackedX,
    targetX,
    startTime: performance.now(),
    duration: (distance / WALK_SPEED) * 1000
  };
}

function updateWalk(now) {
  if (!walking) return;
  const t = Math.min(1, (now - walking.startTime) / walking.duration);
  const newX = lerp(walking.startX, walking.targetX, t);
  setPosition(newX, trackedY);

  if (t >= 1) {
    walking = null;
    goIdle();
  }
}

function startMood() {
  if (petPaused || activityState || state !== 'idle') {
    scheduleMood();
    return;
  }
  const moodName = MOOD_STATES[Math.floor(Math.random() * MOOD_STATES.length)];
  const times = Math.random() < 0.5 ? 1 : 2;
  state = 'mood';
  animator.flip = false;
  currentMoodName = moodName;
  if (moodName === 'talking') window.petAPI.showBubble();
  playRepeated(moodName, times, () => {
    if (moodName === 'talking') window.petAPI.hideBubble();
    currentMoodName = null;
    goIdle();
    scheduleMood();
  });
}

function setPosition(x, y) {
  trackedX = x;
  trackedY = y;
  window.petAPI.setWindowPosition(x, y);
}

function stopScheduledBehaviors() {
  clearTimeout(walkTimer);
  clearTimeout(moodTimer);
  walking = null;
}

function onMouseDown(e) {
  if (e.button !== 0) return;
  mouseDownState = state;
  dragMoved = false;
  if (currentMoodName === 'talking') {
    window.petAPI.hideBubble();
    currentMoodName = null;
  }
  stopScheduledBehaviors();
  state = 'drag';
  animator.onLoop = null;
  animator.freeze(DRAG_HOLD_STATE, 0);

  dragInfo = {
    grabScreenX: e.screenX,
    grabScreenY: e.screenY,
    originX: trackedX,
    originY: trackedY
  };

  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('mouseup', onMouseUp);
}

function onMouseMove(e) {
  if (!dragInfo) return;
  const dx = e.screenX - dragInfo.grabScreenX;
  const dy = e.screenY - dragInfo.grabScreenY;
  if (!dragMoved && Math.hypot(dx, dy) > CLICK_MOVE_THRESHOLD) dragMoved = true;
  setPosition(dragInfo.originX + dx, dragInfo.originY + dy);
}

async function onMouseUp() {
  document.removeEventListener('mousemove', onMouseMove);
  document.removeEventListener('mouseup', onMouseUp);
  dragInfo = null;
  animator.unfreeze();

  const pos = await window.petAPI.getWindowPosition();
  trackedX = pos[0];
  trackedY = pos[1];

  // A real click (negligible movement, and nothing else was already
  // animating when the mouse went down) gets its own reaction; anything
  // else falls back to the existing drag-release behavior.
  const wasClick = !dragMoved && mouseDownState === 'idle';
  const reactionState = wasClick ? CLICK_REACTION_STATE : 'alert';

  state = 'mood';
  playRepeated(reactionState, 1, () => {
    goIdle();
    scheduleMood();
  });
}

function onContextMenu(e) {
  e.preventDefault();
  window.petAPI.showContextMenu();
}

let lastTime = null;
function tick(now) {
  if (lastTime === null) lastTime = now;
  const dt = now - lastTime;
  lastTime = now;

  animator.update(dt);
  if (state === 'walk') updateWalk(now);
  animator.draw(ctx, FRAME_SIZE, FRAME_SIZE);

  requestAnimationFrame(tick);
}

async function init() {
  // atlas is non-null for quick-packs (auto-generated in main.js from a bare
  // spritesheet image, no pet.json on disk to fetch); for full packs it's
  // null and we fetch pet.json ourselves, same as always.
  const { baseUrl, imageFile, atlas: providedAtlas } = await window.petAPI.getAssetFolder();
  const atlas = providedAtlas || (await loadAtlas(baseUrl));
  const image = await loadImage(`${baseUrl}/${imageFile}`);
  animator = new Animator(atlas, image);
  animator.play(atlas.meta.defaultState || 'idle');

  const settings = await window.petAPI.getSettings();
  applySettings(settings);
  window.petAPI.onSettingsChanged((s) => {
    applySettings(s);
    scheduleWalk();
    scheduleMood();
  });
  window.petAPI.onActivityChanged((activity) => applyActivityState(activity));

  const pos = await window.petAPI.getWindowPosition();
  trackedX = pos[0];
  trackedY = pos[1];

  canvas.addEventListener('mousedown', onMouseDown);
  canvas.addEventListener('contextmenu', onContextMenu);

  scheduleWalk();
  scheduleMood();

  requestAnimationFrame(tick);
}

init();
