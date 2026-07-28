// Writes a forged character to disk: generated-pets/<slug>/ always gets the
// full pack (source of truth), and deployDeploy() additionally copies it
// into <dpetRoot>/characters/<slug>/ so Founder Pet and MoteKin's own
// dashboard pick it up immediately (both scan that exact folder via
// shared/characterPacks.js's scanCharacterPacks).
//
// The actual pixel compositing (drawing 36 generated frames into an 8x9
// grid) happens in the renderer via <canvas> — see frontend/app.js — since
// that's the only place in this app that can reliably decode/encode webp
// (documented main.js quirk: Electron's main-process nativeImage can't
// decode this project's webp assets; the same limitation blocks encoding
// too, canvas is the proven-working path). This module just takes the
// already-composited spritesheet bytes and writes the pack.
'use strict';

const fs = require('fs');
const path = require('path');
const { generateQuickPackAtlas } = require('../shared/characterPacks');

function slugify(name) {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || `pet-${Date.now()}`;
}

// dpetRootDir: the project root (motekin-main.js's own __dirname) — used to
// find assets/ (reference atlas for frame timing) and characters/ (deploy
// target). generatedPetsDir: where the source-of-truth copy always lands.
function writePack({ dpetRootDir, generatedPetsDir, charName, spritesheetBuffer, frameWidth, frameHeight }) {
  const slug = slugify(charName);
  const assetsDir = path.join(dpetRootDir, 'assets');
  const imageWidth = frameWidth * 8;
  const imageHeight = frameHeight * 9;
  const atlas = generateQuickPackAtlas(imageWidth, imageHeight, assetsDir);
  atlas.meta.name = charName.trim() || slug;

  const outDir = path.join(generatedPetsDir, slug);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'spritesheet.webp'), spritesheetBuffer);
  fs.writeFileSync(path.join(outDir, 'pet.json'), JSON.stringify(atlas, null, 2), 'utf8');

  return { slug, dir: outDir };
}

// Copies the just-written generated-pets/<slug>/ into <dpetRootDir>/characters/<slug>/
// so it shows up as an active-able pack without restarting either app.
function deployPack({ dpetRootDir, generatedPetsDir, slug }) {
  const sourceDir = path.join(generatedPetsDir, slug);
  const destDir = path.join(dpetRootDir, 'characters', slug);
  fs.mkdirSync(destDir, { recursive: true });
  for (const file of ['spritesheet.webp', 'pet.json']) {
    fs.copyFileSync(path.join(sourceDir, file), path.join(destDir, file));
  }
  return { packId: slug, dir: destDir };
}

module.exports = { writePack, deployPack };
