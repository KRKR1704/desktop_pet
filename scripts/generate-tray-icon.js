// Dev-time asset generator, not run by the app itself.
// Run with: npx electron scripts/generate-tray-icon.js
//
// Crops the idle animation's first frame out of assets/spritesheet.webp and
// saves it as assets/tray-icon.png. This runs the crop through a real Chromium
// <canvas>/<img> (via a throwaway hidden window) instead of Electron's main-process
// nativeImage decoder, because nativeImage.createFromPath silently fails to decode
// this WebP file in the main process (returns an empty image, no thrown error).
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const OUTPUT_SIZE = 64;

async function main() {
  const atlas = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets', 'pet.json'), 'utf8'));
  const idleFrameName = atlas.animations.idle.frames[0];
  const frame = atlas.frames[idleFrameName].frame;

  const tmpHtmlPath = path.join(ROOT, 'assets', '_tray-icon-gen.html');
  fs.writeFileSync(tmpHtmlPath, '<!doctype html><html><body></body></html>');

  const win = new BrowserWindow({ show: false });
  try {
    await win.loadFile(tmpHtmlPath);

    const dataUrl = await win.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
          const c = document.createElement('canvas');
          c.width = ${OUTPUT_SIZE};
          c.height = ${OUTPUT_SIZE};
          const ctx = c.getContext('2d');
          ctx.drawImage(img, ${frame.x}, ${frame.y}, ${frame.w}, ${frame.h}, 0, 0, ${OUTPUT_SIZE}, ${OUTPUT_SIZE});
          resolve(c.toDataURL('image/png'));
        };
        img.onerror = () => reject(new Error('failed to load spritesheet.webp'));
        img.src = 'spritesheet.webp';
      })
    `);

    const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
    fs.writeFileSync(path.join(ROOT, 'assets', 'tray-icon.png'), Buffer.from(base64, 'base64'));
    console.log('[generate-tray-icon] wrote assets/tray-icon.png');
  } finally {
    win.close();
    fs.unlinkSync(tmpHtmlPath);
  }

  app.quit();
}

app.whenReady().then(main).catch((err) => {
  console.error('[generate-tray-icon] failed:', err);
  app.exit(1);
});
