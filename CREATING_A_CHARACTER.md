# Making your own Founder Pet character

So you want to make your own little desktop buddy? Nice — here's everything you need, no coding required. You just need one image.

## The short version

1. (Optional) Make a reference sheet of your character with an AI image tool, so you know what they look like from a few angles/moods.
2. Make **one image**: a grid of your character in 9 different poses, laid out in a specific order (below).
3. Save it and drop it into a folder. Done — restart the app and your character shows up.

That's genuinely it. No code, no config files, nothing else to learn.

## Step 1: (Optional) Get a reference for your character

If you already know exactly what your character looks like, skip this. Otherwise, it helps to generate a reference image first — a few views of your character (front, maybe a 3/4 view, maybe a couple of expressions) using whatever AI image generator you like (ChatGPT/DALL-E, Midjourney, whatever you've got). This is just for you to look at while making the real sprite sheet — it doesn't get used by the app directly.

A prompt like *"character reference sheet, front view and side view, simple flat cartoon style, [describe your character]"* is a good starting point.

## Step 2: Make the actual sprite sheet

This is the one image the app actually uses. Here's exactly what it needs to be:

- **A grid: 8 columns × 9 rows.** Think of it like a big checkerboard with 8 boxes across and 9 boxes down — 72 boxes total.
- **Each row is a different mood/pose**, always in this exact order, top to bottom:

  | Row | Pose | What it should look like |
  |---|---|---|
  | 1 | **idle** | Standing neutral pose, repeated 8 times with tiny variations — like breathing or blinking. This is what your pet looks like just chilling. |
  | 2 | **walk** | A side-view walking cycle — legs stepping, like a little sprite walking across a screen. |
  | 3 | **typing** | Sitting or standing like they're at a keyboard, hands/fingers moving. |
  | 4 | **thinking** | Hand on chin, or looking up/to the side — a "hmm, pondering" pose. |
  | 5 | **celebrate** | Arms up, jumping, excited — like they just shipped something. |
  | 6 | **tired** | Slouched, yawning, droopy eyes — worn out. |
  | 7 | **alert** | Surprised or startled — this plays when someone picks the pet up with the mouse. |
  | 8 | **talking** | Mouth/gesture mid-speech, like they're chatting away. |
  | 9 | **working** | Focused, heads-down at a desk/laptop pose. |

- **Each row has 8 frames** (columns) — these are the individual animation frames for that pose. They should be small variations of the same pose (e.g. for "idle", maybe a subtle breathing loop across the 8 frames; for "walk", the 8 frames are the walking cycle steps). If you're not sure what to put in all 8, even just 2-3 real poses repeated to fill the row works fine — it just won't look as smooth.
- **Transparent background.** No white or colored background — export as a PNG (or WebP) with transparency, not JPG (JPG can't do transparency, so avoid it if you can — see note below).
- **Every cell should be the same size.** The app figures out how big each frame is by dividing your image's total width by 8 and height by 9 — so as long as your grid is even, any resolution works (e.g. a 1536×1728 image gives 192×192 frames; a 800×900 image gives 100×100 frames — both are fine).

If you want a starting template to see the exact layout in action, look at `assets/spritesheet.webp` in this project — that's the built-in character, laid out exactly this way.

## Step 3: Save it and drop it in

1. Save your finished grid image as **`spritesheet.png`** (PNG is easiest since it supports transparency reliably — `.webp` also works if that's what your tool exports, and `.jpg` works too but only use that if you don't need transparency, since JPG can't have a see-through background).
2. Make a new folder inside the app's `characters/` folder, named after your character — for example `characters/robo-buddy/`.
3. Put your image inside that folder. That's the *only* file it needs.
4. Right-click the Founder Pet tray icon → **Settings**, look under "Pets" — your character's name should be listed there. Check the box next to it to bring them to life. (If you already had Settings open before adding the folder, close it and open it again — it double-checks for new characters every time it opens.)

```
characters/
  robo-buddy/
    spritesheet.png     <- that's it, just this one file
```

## Troubleshooting

- **My character doesn't show up under Pets in Settings.** Double-check the folder name has no typos, and that the image is directly inside it (not in a sub-sub-folder). Also check the image's width is evenly divisible by 8 and its height by 9 — if it's not, the app will skip it (it won't crash, but it also won't appear). Try closing and reopening Settings, too.
- **The pose in the wrong row plays for the wrong thing.** Double check your row order matches the table above exactly — it has to be idle, walk, typing, thinking, celebrate, tired, alert, talking, working, top to bottom, no exceptions.

## Want more control? (for the more technical folks)

Everything above is the "quick" way — one image, zero configuration, fixed layout. If you want custom animation speeds, a different number of frames per pose, or frames that aren't all the same size, you can hand-write a `pet.json` file alongside your `spritesheet.webp`/`.png` instead — that's the original, fully-flexible character format this app has always supported. See the "Character packs" section in `README.md` for that format. You don't need any of that for a normal character though — the quick way above covers it.
