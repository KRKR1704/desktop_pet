// Dev-time asset generator, not run by the app itself.
// Run with: npx electron scripts/generate-app-icon.js
//
// Crops the idle animation's first frame out of assets/spritesheet.webp and
// saves a larger PNG (256x256, the recommended size for a Windows app icon)
// to buildResources/icon.png, then converts it to buildResources/icon.ico
// via png-to-ico (a pure-JS converter). electron-builder does have its own
// built-in PNG->ICO conversion, but it failed in this environment with a
// WASM memory allocation error unrelated to the icon itself — converting
// ahead of time ourselves sidesteps that tool entirely.
// Same PNG-cropping technique as scripts/generate-tray-icon.js — see that
// file for why this goes through a real Chromium <canvas> instead of
// Electron's main-process nativeImage decoder.
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const OUTPUT_SIZE = 256;

async function main() {
  const atlas = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets', 'pet.json'), 'utf8'));
  const idleFrameName = atlas.animations.idle.frames[0];
  const frame = atlas.frames[idleFrameName].frame;

  const tmpHtmlPath = path.join(ROOT, 'assets', '_app-icon-gen.html');
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
    const buildResourcesDir = path.join(ROOT, 'buildResources');
    fs.mkdirSync(buildResourcesDir, { recursive: true });
    const pngPath = path.join(buildResourcesDir, 'icon.png');
    fs.writeFileSync(pngPath, Buffer.from(base64, 'base64'));
    console.log('[generate-app-icon] wrote buildResources/icon.png');

    const { default: pngToIco } = await import('png-to-ico');
    const icoBuffer = await pngToIco(pngPath);
    fs.writeFileSync(path.join(buildResourcesDir, 'icon.ico'), icoBuffer);
    console.log('[generate-app-icon] wrote buildResources/icon.ico');
  } finally {
    win.close();
    fs.unlinkSync(tmpHtmlPath);
  }

  app.quit();
}

app.whenReady().then(main).catch((err) => {
  console.error('[generate-app-icon] failed:', err);
  app.exit(1);
});
