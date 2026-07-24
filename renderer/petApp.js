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

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

async function loadAtlas(folder) {
  const res = await fetch(`../${folder}/pet.json`);
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
  animator.play('idle');
  scheduleWalk();
}

function scheduleWalk() {
  clearTimeout(walkTimer);
  const delay = randomBetween(MIN_WALK_DELAY, MAX_WALK_DELAY);
  walkTimer = setTimeout(startWalk, delay);
}

function scheduleMood() {
  clearTimeout(moodTimer);
  const delay = randomBetween(MIN_MOOD_DELAY, MAX_MOOD_DELAY);
  moodTimer = setTimeout(startMood, delay);
}

async function startWalk() {
  if (state !== 'idle') {
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
  if (state !== 'idle') {
    scheduleMood();
    return;
  }
  const moodName = MOOD_STATES[Math.floor(Math.random() * MOOD_STATES.length)];
  const times = Math.random() < 0.5 ? 1 : 2;
  state = 'mood';
  animator.flip = false;
  playRepeated(moodName, times, () => {
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
  const folder = await window.petAPI.getAssetFolder();
  const atlas = await loadAtlas(folder);
  const image = await loadImage(`../${folder}/spritesheet.webp`);
  animator = new Animator(atlas, image);
  animator.play(atlas.meta.defaultState || 'idle');

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
