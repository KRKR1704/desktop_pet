// Cross-process control channel between Founder Pet (main.js, the server —
// it already owns the live activePets map and spawnPet/destroyPet) and
// MoteKin (motekin-main.js, the client). They're separate Electron
// processes, so MoteKin's dashboard can't call Founder Pet's in-memory
// functions directly; this is a tiny local IPC pipe for exactly two
// commands: "set-active" (spawn/destroy a pack) and "list-active" (read the
// live activePets keys). Both sides require the same PIPE_NAME/getPipePath
// from here so they can't drift apart.
'use strict';

const path = require('path');
const os = require('os');

const PIPE_NAME = 'dpet-founder-pet-control';

// Windows named pipes live in a virtual namespace and need no filesystem
// cleanup. POSIX Unix-domain sockets are real files — controlServer.js is
// responsible for unlinking a stale one before listening.
function getPipePath() {
  if (process.platform === 'win32') return `\\\\.\\pipe\\${PIPE_NAME}`;
  return path.join(os.tmpdir(), `${PIPE_NAME}.sock`);
}

module.exports = { PIPE_NAME, getPipePath };
