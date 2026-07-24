# Founder Pet

A tiny, transparent, always-on-top desktop pet. It sits on your screen, idles, wanders around, and reacts a bit like a real desktop buddy — built with Electron and a custom sprite character.

## Features

- **Idle animation** — loops by default when the pet isn't doing anything else.
- **Random walking** — every 15-40s it picks a random spot on screen and walks there, facing the correct direction (no moonwalking).
- **Drag-to-move** — click and hold to pick it up, drag it anywhere, drop it and it settles back into idle.
- **Mood states** — every couple of minutes it randomly plays a bit of personality: tired, thinking, celebrate, or talking, then goes back to idle. No input needed, it just happens.
- **Click reaction** — a quick click (not a drag) makes it play a celebrate animation once, then settle back to idle.
- **Right-click to quit** — right-click the pet for a Quit option (there's no window frame/taskbar icon, so this is the way out).
- **System tray icon** — a tray icon with "Show/Hide Pet", "Launch on Startup", and "Quit", as a second, more discoverable way to control the app.
- **Launch on Startup** — a checkbox in the tray menu to register/unregister the app as a login item; the preference is remembered across restarts.

## Project structure

```
main.js           Electron main process — creates the transparent/frameless
                  always-on-top window, clamps its position to the screen,
                  and handles IPC (position updates, right-click quit menu).
preload.js        Exposes a small, safe `window.petAPI` bridge to the
                  renderer (contextIsolation is on, no direct Node access
                  from the UI).
renderer/         The actual pet UI — plain HTML/JS on a canvas, no framework.
  animator.js       Generic sprite animator: reads an atlas and draws
                    whatever frames/state it's told to, nothing hardcoded.
  petApp.js         The pet's state machine — idle/walk/drag/mood logic,
                    timers, and mouse handling all live here.
assets/           spritesheet.webp + pet.json (the actual character art
                  and its animation data). Shipped default character.
                  tray-icon.png is a pre-cropped PNG of the idle frame,
                  used for the system tray icon (see below).
custom/           optional — drop your own spritesheet.webp + pet.json here
                  to override the default character (see below).
scripts/          generate-tray-icon.js — dev-time script that regenerates
                  assets/tray-icon.png, not run by the app itself.
```

## How the sprite system works

The pet's look and animations come entirely from two files in `assets/`:

- **`spritesheet.webp`** — one sprite sheet image, sliced into a grid of frames.
- **`pet.json`** — a TexturePacker-style atlas describing every frame's position in the sheet, its duration, and how frames group into named animations (`idle`, `walk`, `thinking`, `celebrate`, etc.).

`animator.js` doesn't know anything about specific animations — it just reads whichever state it's told to play from the atlas, draws the right sub-rectangle of the sheet each tick, and loops using each frame's duration. `petApp.js` is the layer that decides *when* to play `idle` vs `walk` vs a mood state, and handles things like flipping the sprite horizontally when walking in different directions.

The system tray icon is a separate, pre-cropped `assets/tray-icon.png` rather than a runtime crop of `spritesheet.webp` — Electron's main-process `nativeImage` can't reliably decode this WebP file outside a renderer. If you change the default character's idle frame, regenerate it with `npx electron scripts/generate-tray-icon.js`. Custom characters loaded from `custom/` always use this same default tray icon; they don't get their own.

## Using your own character

You can replace the default Founder Pet art with your own character without touching any code:

1. Create a `custom/` folder in the project root (next to `assets/`).
2. Drop in your own `spritesheet.webp` and `pet.json`.
3. Start the app (`npm start`). On startup it checks for `custom/spritesheet.webp` and `custom/pet.json` — if both exist and `pet.json` is valid, it loads your character instead of the default. Otherwise it falls back to the bundled `assets/` character.

Your `pet.json` must be a TexturePacker-style atlas with the same shape as `assets/pet.json`:

- A `frames` object keyed by frame name, each with `frame` (`x`/`y`/`w`/`h` into the sheet), `sourceSize`, and `spriteSourceSize`.
- An `animations` object mapping state names to `{ frames: [...], fps, loop, anchor }`.
- `animations` **must** include every state the app drives directly: `idle`, `walk`, `alert`, `tired`, `thinking`, `celebrate`, `talking`. (`typing` and `working` are accepted but currently unused — see "Out of scope" below.)

If any of those states are missing, or `pet.json` doesn't parse as valid JSON, the app logs a console error explaining exactly what's wrong and falls back to the default character rather than crashing.

`spritesheet.webp` just needs to be a single image containing every frame referenced in `pet.json` — grid layout, dimensions, and frame count are entirely up to you since everything is read from the atlas.

## Setup

Requires **Node.js** and **npm**.

```bash
npm install
npm start
```

## Out of scope (for now)

These are intentionally not built in this version:

- Typing/working states tied to real keyboard/activity monitoring
- Sound
- Multiple pets at once

The `typing` and `working` animations technically exist in `pet.json`, they're just not wired up to anything yet.
