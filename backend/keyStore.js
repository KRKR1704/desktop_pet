// Local, encrypted-at-rest storage for the user's own image-generation API
// key + which provider it belongs to. Lives entirely in MoteKin's own
// userData dir (Electron names it after app.getName() -> "MoteKin", set in
// motekin-main.js before app ready), completely separate from Founder Pet's
// own config.json.
//
// Uses Electron's safeStorage (OS keychain/DPAPI-backed on each platform)
// rather than a plain JSON file, so the "encrypted at rest, we cannot see
// it" claim in the Key Exchange UI copy is actually true: safeStorage.
// encryptString() encrypts with a key that never leaves the OS's secure
// storage, not something this app manages or could accidentally log.
//
// Only the encrypted blob touches disk. Decryption happens in-process, on
// demand, right before a generation call — the decrypted key is never
// written back to disk and never sent to the renderer (see motekin-main.js's
// IPC handlers: only key *status*, i.e. { hasKey, provider }, crosses that
// boundary, never the plaintext key itself).
'use strict';

const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');

function getKeyFilePath() {
  return path.join(app.getPath('userData'), 'forge-key.json');
}

function readRaw() {
  try {
    const raw = fs.readFileSync(getKeyFilePath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.provider !== 'string' || typeof parsed.encryptedKey !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

// { provider } only — used to drive the "key on file" UI without ever
// touching the encrypted payload.
function getStatus() {
  const raw = readRaw();
  return raw ? { hasKey: true, provider: raw.provider } : { hasKey: false, provider: null };
}

// Encrypts and persists. Throws if the OS-level encryption backend isn't
// available (e.g. no keychain on this machine/session) rather than silently
// falling back to plaintext, since the UI explicitly promises encryption.
function saveKey(provider, apiKey) {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('OS-level secure storage is not available on this machine, so the key cannot be encrypted at rest.');
  }
  const encryptedKey = safeStorage.encryptString(apiKey).toString('base64');
  const payload = { provider, encryptedKey };
  fs.mkdirSync(path.dirname(getKeyFilePath()), { recursive: true });
  fs.writeFileSync(getKeyFilePath(), JSON.stringify(payload), 'utf8');
}

// Decrypts and returns { provider, apiKey }, or null if nothing is stored.
// Only ever called from backend/forge.js right before a generation call.
function loadDecryptedKey() {
  const raw = readRaw();
  if (!raw) return null;
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('OS-level secure storage is not available on this machine, so the stored key cannot be decrypted.');
  }
  const apiKey = safeStorage.decryptString(Buffer.from(raw.encryptedKey, 'base64'));
  return { provider: raw.provider, apiKey };
}

function clearKey() {
  try {
    fs.unlinkSync(getKeyFilePath());
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

module.exports = { getStatus, saveKey, loadDecryptedKey, clearKey };
