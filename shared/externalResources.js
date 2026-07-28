// Resolves the directory where user-writable "extra resources" (character
// packs) live on disk. Founder Pet (main.js) and MoteKin (motekin-main.js)
// are two separate Electron main processes, so this can't just be computed
// once and shared at runtime — each calls it for itself — but the
// resolution logic itself only needs to be written once.
'use strict';

// In dev, characters/ lives at the project root next to the calling
// main.js/motekin-main.js (its own __dirname, passed in as projectRootDir).
// Once packaged, that code lives inside app.asar — a read-only archive — so
// a user-writable characters/ folder has to live somewhere real on disk
// instead. Electron ships such "extra resources" in process.resourcesPath, a
// real directory alongside app.asar, so that's what's used once packaged
// (see the "extraResources" entry in Founder Pet's electron-builder config,
// which copies the repo's characters/ folder there at build time — MoteKin
// has no build config of its own yet, so app.isPackaged is always false for
// it today, but this keeps both apps' resolution logic identical if that
// ever changes). assets/ (the bundled default character) is NOT affected by
// this either way — it ships inside the asar regardless, which is fine
// since it's read-only bundled content and Electron's fs/fetch/nativeImage
// all read asar contents transparently.
function getExternalResourcesDir(app, projectRootDir) {
  return app.isPackaged ? process.resourcesPath : projectRootDir;
}

module.exports = { getExternalResourcesDir };
