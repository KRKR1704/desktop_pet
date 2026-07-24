# Founder Pet

A tiny, transparent, always-on-top desktop pet. It sits on your screen, idles, wanders around, and reacts a bit like a real desktop buddy — built with Electron and a custom sprite character.

## Features

- **Idle animation** — loops by default when the pet isn't doing anything else.
- **Random walking** — every 15-40s it picks a random spot on screen and walks there, facing the correct direction (no moonwalking).
- **Drag-to-move** — click and hold to pick it up, drag it anywhere, drop it and it settles back into idle.
- **Mood states** — every couple of minutes it randomly plays a bit of personality: tired, thinking, celebrate, or talking, then goes back to idle. No input needed, it just happens.
- **Click reaction** — a quick click (not a drag) makes it play a celebrate animation once, then settle back to idle.
- **Right-click to quit** — right-click a pet for a Quit option (there's no window frame/taskbar icon, so this is the way out). Quits the whole app, all pets included.
- **System tray icon** — a tray icon with a "Pets" submenu, "Show/Hide All Pets", "Launch on Startup", "Settings...", and "Quit", as a second, more discoverable way to control the app.
- **Launch on Startup** — a checkbox in the tray menu to register/unregister the app as a login item; the preference is remembered across restarts.
- **Speech bubbles** — a small bubble with a random line ("shipping something 🚀", "debugging...", etc.) appears above a pet while it's in the `talking` mood, follows it if it moves, and disappears when talking ends.
- **Multi-monitor aware** — walking and dragging clamp to whichever display a pet is currently on, not just the primary display; drag one onto another monitor and it stays within that monitor's bounds.
- **Settings panel** — "Settings..." in the tray menu opens a small window to adjust how often pets walk/have a mood, or pause them in place entirely. Applies globally to every active pet. Settings persist across restarts.
- **Activity-tied states** — plays a `typing` pose while you're actively typing anywhere on the system, or a `working` pose while a code editor/terminal is focused, in preference to idle wandering/moods. Can be turned off entirely from Settings. See "Activity-tied states" below, including a privacy note.
- **Multiple character packs / pets** — run more than one pet at once, each a different character, toggled on/off from the tray's "Pets" submenu. See "Character packs" below.
- **Installable** — `npm run dist` produces a real Windows installer (.exe), so the app can be installed and run without Node.js, npm, or a source checkout. See "Building an installer" below.

## Project structure

```
main.js           Electron main process — owns every pet window, the shared
                  bubble/settings windows, the tray menu, activity detection,
                  and all IPC. Each pet window is looked up by its
                  BrowserWindow (via event.sender) so multiple pets don't
                  share state in the main process either.
preload.js        Exposes a small, safe `window.petAPI` bridge to the
                  renderer (contextIsolation is on, no direct Node access
                  from the UI). Identical for every pet window — the main
                  process figures out which pet is asking.
renderer/         The actual pet UI — plain HTML/JS on a canvas, no framework.
                  Each pet window loads this fresh, so its state machine
                  (idle/walk/drag/mood/activity) is fully independent per pet
                  with zero extra code — this is "for free" because it's a
                  separate renderer process per window.
  animator.js       Generic sprite animator: reads an atlas and draws
                    whatever frames/state it's told to, nothing hardcoded.
  petApp.js         The pet's state machine — idle/walk/drag/mood logic,
                    timers, and mouse handling all live here.
  bubble.html       Tiny overlay window showing the speech bubble text.
                    One instance per active pet.
  settings.html/js/-preload.js
                    The (single, shared) settings window UI and its own
                    contextBridge API, separate from the pet's own preload.js.
assets/           spritesheet.webp + pet.json — the bundled default
                  character ("Founder Pet"), always available as a pack.
                  tray-icon.png is a pre-cropped PNG of the idle frame,
                  used for the system tray icon (see below).
characters/       additional character packs live here, one subfolder per
                  pack (see "Character packs" below). In dev this is the
                  folder at the project root; once installed, it's a real
                  folder next to the installed app (see "Character packs"
                  for exactly where) — either way it's a normal folder on
                  disk you can drop new packs into, never inside the app's
                  packaged archive.
custom/           legacy from v1.1/v1.2's single-custom-character feature —
                  still recognized as one extra pack for a smooth upgrade,
                  but characters/ is the primary way to add packs going forward.
scripts/          generate-tray-icon.js / generate-app-icon.js — dev-time
                  scripts that regenerate assets/tray-icon.png and
                  buildResources/icon.{png,ico}. Not run by the app itself.
buildResources/   Inputs for npm run dist: the app/installer icon, and a
                  characters-seed/ folder (just a README) that ships as the
                  starter characters/ folder in a fresh install.
```

## How the sprite system works

Each character pack's look and animations come entirely from two files:

- **`spritesheet.webp`** — one sprite sheet image, sliced into a grid of frames.
- **`pet.json`** — a TexturePacker-style atlas describing every frame's position in the sheet, its duration, and how frames group into named animations (`idle`, `walk`, `thinking`, `celebrate`, etc.).

`animator.js` doesn't know anything about specific animations — it just reads whichever state it's told to play from the atlas, draws the right sub-rectangle of the sheet each tick, and loops using each frame's duration. `petApp.js` is the layer that decides *when* to play `idle` vs `walk` vs a mood state, and handles things like flipping the sprite horizontally when walking in different directions. Both are completely pack-agnostic — they just fetch whatever atlas/sheet the main process told that window to use.

The system tray icon is a separate, pre-cropped `assets/tray-icon.png` rather than a runtime crop of `spritesheet.webp` — Electron's main-process `nativeImage` can't reliably decode this WebP file outside a renderer. If you change the default character's idle frame, regenerate it with `npx electron scripts/generate-tray-icon.js`. The tray icon always shows the default character regardless of which packs are active — it identifies the app, not any one running pet.

## Character packs

A character pack is just a folder with a `spritesheet.webp` + `pet.json` pair. On startup the app scans for all valid packs:

1. The bundled default in `assets/` (always available, called "Founder Pet").
2. Every subfolder of `characters/` that has a valid pair.
3. A legacy `custom/` folder at the project root, if you still have one from v1.1/v1.2 (shown as "Custom (legacy)").

**To add your own pack:** create `characters/your-pack-name/`, drop in your own `spritesheet.webp` and `pet.json`, and restart the app. It'll show up in the tray's "Pets" submenu automatically — no config file editing needed. Pack folder names become both the pack's internal id and its menu label, so keep them short and readable.

**Where `characters/` actually lives** depends on how you're running the app, and this matters if you're looking for the folder:

- **Running from source** (`npm start`): `characters/` at the project root, next to `assets/`.
- **Installed via the installer**: a real folder at `<install folder>\resources\characters\` (e.g. `%LOCALAPPDATA%\Programs\Founder Pet\resources\characters\` for the default per-user install location) — it ships with a `README.md` inside explaining the same thing. It is **not** inside `resources\app.asar` (the packaged app code) — that's a single archive file, not something you can drop folders into. `assets/` (the bundled default character) *does* ship inside the asar, which is fine since it's read-only and Electron reads asar contents transparently; `characters/` has to be a real folder outside it specifically so it stays writable after install.

This distinction is also why the app talks to character packs via absolute `file://` URLs internally rather than relative paths — a relative path from a file living inside the asar can't "escape" it to reach a real sibling folder on disk.

Your `pet.json` must be a TexturePacker-style atlas with the same shape as `assets/pet.json`:

- A `frames` object keyed by frame name, each with `frame` (`x`/`y`/`w`/`h` into the sheet), `sourceSize`, and `spriteSourceSize`.
- An `animations` object mapping state names to `{ frames: [...], fps, loop, anchor }`.
- `animations` **must** include every state the app drives directly: `idle`, `walk`, `alert`, `tired`, `thinking`, `celebrate`, `talking`. `typing` and `working` are optional — if a pack doesn't define them, that pet just keeps showing whatever pose it was already in rather than crashing.

If a pack's `pet.json` is missing a required state, or doesn't parse as valid JSON, that pack is skipped with a clear console error explaining what's wrong — it just won't appear as an option, the app doesn't crash. This validation logic lives in one place (`validatePackDir` in `main.js`) and is reused for every pack source, so the rule is defined exactly once.

`spritesheet.webp` just needs to be a single image containing every frame referenced in `pet.json` — grid layout, dimensions, and frame count are entirely up to you since everything is read from the atlas.

## Running multiple pets

Open the tray menu → "Pets" — every discovered character pack is listed as a checkbox. Checking one spawns an independent pet window for that pack; unchecking it closes just that pet (and its speech bubble window), leaving any other active pets running untouched. Each pet has its own idle/walk/drag/mood/activity state machine and its own screen-position clamping — there's no coordination or collision-avoidance between pets by design (out of scope for this version, so pets can end up overlapping if you run several).

- **Show/Hide All Pets** in the tray toggles visibility of every currently-active pet together.
- **Quit** in the tray (or right-clicking any pet) closes every active pet and speech bubble and exits the app fully.
- Which packs were active is saved to the same local config file as the other settings, and restored automatically the next time the app starts.
- Settings (walk/mood frequency, pause, react-to-activity) are global — they apply to every active pet at once. Per-pet individual settings aren't implemented yet.

## Speech bubbles

The lines the bubble can show live in `BUBBLE_LINES` near the top of `main.js` — a plain array of strings, easy to edit without touching any logic. Each active pet gets its own bubble window (`renderer/bubble.html`), not part of the pet's own 192x192 window, so it can extend above the pet without changing the pet window's size/position math. It's shown/hidden by `petApp.js` alongside the `talking` mood state and repositioned automatically whenever that pet moves.

## Multi-monitor behavior

Walking and dragging clamp to whichever display is nearest a pet's current (or, mid-drag, target) position via Electron's `screen.getDisplayNearestPoint` — not hardcoded to the primary display. Drag a pet onto another monitor and its subsequent random walks will use that monitor's bounds. This is resolved independently per pet window.

## Settings

"Settings..." in the tray menu opens a small window with:

- **Walk frequency** / **Mood frequency** — Often/Normal/Rare presets that adjust how wide the random interval is before a pet next walks or plays a mood animation.
- **Pause Pet** — stops pets from starting new walks/moods (they settle to idle and stay there) without quitting the app. Dragging and clicking still work while paused.
- **React to activity** — see "Activity-tied states" below.

All settings are global (applied to every active pet) and saved to the same local config file as which pets are active and Launch on Startup, restored on the next app launch.

## Activity-tied states

Every active pet plays a `typing` pose while you're actively typing anywhere on the system, and a `working` pose when a code editor or terminal is the focused window (both take priority over idle wandering/moods, but never interrupt an active walk-to-target or an active drag — those finish naturally first; if both typing and a recognized "working" window are true at once, `working` wins since it's the more specific state).

- **Typing detection** — "typing" is considered active if there's been a keypress anywhere on the system within the last ~1.5s, and switches back off ~1.5s after you stop.
- **Working detection** — the focused window's title/process is checked roughly every 1.5s against `WORKING_APP_MATCHERS` near the top of `main.js` — a plain array of substrings (currently VS Code and a handful of common Windows terminals). Add more apps by adding more strings there; no other code needs to change.
- **Turning it off** — "React to activity" in Settings disables this entirely (stops the keyboard hook and window polling) and pets go back to pure idle/walk/mood behavior. Persisted like the other settings.

**Privacy note:** this feature only ever checks *whether* a key was just pressed and *which app* is currently focused. It does not log, store, buffer, or transmit which keys were pressed, or any window/document content — no keystroke or window content ever leaves memory or gets written anywhere. The only thing kept in memory is a timestamp of the last keypress and a boolean derived from the focused window's title/process name, both discarded on the next check.

**Packages used:**
- [`uiohook-napi`](https://www.npmjs.com/package/uiohook-napi) for the global keyboard hook (detecting *that* a key was pressed, system-wide, regardless of which window has focus). Chosen over the older `iohook` (unmaintained) — this is its actively-maintained N-API-based replacement, ships prebuilt binaries for Windows so no compiler is needed, and N-API is ABI-stable across Node/Electron versions.
- [`get-windows`](https://www.npmjs.com/package/get-windows) for active-window detection (title/process of whatever's focused). This is the current name for what used to be published as `active-win`, which is now deprecated in favor of it — same maintainer (sindresorhus), same approach, actively maintained.

**A note on this dev environment:** global input hooks did not receive events in the sandbox this was built in (tested via synthetic input up to the raw `SendInput` Win32 API — the hook starts without error but genuinely receives nothing), which appears to be a restriction of that environment rather than the library. Active-window detection, by contrast, worked correctly and was verified against real window switches. If typing detection doesn't seem to trigger on your machine, check that no security software is blocking the global hook, and that the app has whatever input-monitoring permission your OS requires.

## Setup

Requires **Node.js** and **npm**.

```bash
npm install
npm start
```

## Building an installer

```bash
npm install
npm run dist
```

This runs [electron-builder](https://www.electron.build/) and produces a Windows NSIS installer at `dist\Founder Pet Setup <version>.exe`, plus an unpacked build at `dist\win-unpacked\Founder Pet.exe` you can run directly without installing (useful for a quick check). Both are gitignored — `npm run dist` regenerates them, they're not checked into the repo.

The installer defaults to a per-user install (no admin rights needed, `perMachine: false` in the build config) with a directory-choice page (`allowToChangeInstallationDirectory: true`) rather than a silent one-click install, so you can see/pick where it lands.

A few things that specifically needed attention to make packaging work correctly (all verified against an actual built installer, not just assumed):

- **Native modules** (`get-windows`, `uiohook-napi`) ship prebuilt `.node` binaries. Electron can't `require()` a native addon from inside the asar archive, so the build config unpacks them (`"asarUnpack": ["**/*.node"]`) — Electron then transparently redirects reads for those specific files to the unpacked copy alongside the archive. Also: `electron-builder`'s automatic native-module rebuild step tried to recompile `get-windows` from source and failed (no Visual Studio Build Tools available) — since both modules already ship working prebuilt binaries for this platform, that rebuild step is unnecessary and disabled (`"npmRebuild": false`).
- **`characters/`** ships as a real folder (via `extraResources`, from `buildResources/characters-seed/`) alongside the asar rather than inside it, specifically so it stays writable after install — see "Character packs" above.
- **Launch on Startup**, once packaged, hit two real Electron quirks, both confirmed against the actual Windows registry while testing a built installer:
  1. `app.setLoginItemSettings` writes the exe path to the registry *without quoting it* (a known, unpatched-in-our-Electron-version issue). That's invisible in dev (`electron.exe`'s path has no spaces) but breaks for real once packaged, since `Founder Pet.exe`'s own install path can contain a space — an unquoted value with a space gets misread as two tokens. Fixed by rewriting the same registry value with proper quoting immediately after Electron's own call (`fixLoginItemRegistryQuoting()` in `main.js`).
  2. `app.getName()` was observed returning inconsistent values ("Founder Pet" vs "founder-pet") at different points once packaged, which also makes Electron's own registry-key naming inconsistent with itself. Fixed by pinning the name once with `app.setName('Founder Pet')` early in `main.js`, scoped to `app.isPackaged` only (dev mode's config file already lives under the un-renamed path, and never needed this fix in the first place).
- **App/installer icon**: electron-builder has its own built-in PNG→ICO conversion, but it failed in the environment this was built in with a WASM memory error unrelated to the icon itself. Worked around by converting ahead of time with `png-to-ico` instead (`npx electron scripts/generate-app-icon.js` regenerates `buildResources/icon.png` + `icon.ico` from the default character's idle frame — rerun it if you change the default character's art).

## Out of scope (for now)

These are intentionally not built in this version:

- Sound
- Collision avoidance between multiple pets
- Per-pet individual settings (settings are global across all active pets)
- Auto-update (the installer installs a fixed version; re-running a newer installer will update it, but there's no in-app update check)
- macOS/Linux packaging (Windows NSIS only, matching the dev platform)
