#!/usr/bin/env node
/**
 * `nova` launcher for development / `npm i -g` usage.
 *
 * This shim REQUIRES Node.js and is only used when NovaCode is run from a
 * checkout or installed through npm. The packaged installers ship plain
 * shell shims (bin/nova.cmd, bin/nova) that call the bundled Electron
 * binary directly, so end users never need Node.js to run `nova`.
 */
const { spawn } = require('child_process');
const path = require('path');

let electron;
try {
  // require('electron') resolves to the path of the local electron binary.
  electron = require('electron');
} catch {
  process.stderr.write(
    'nova: could not find the electron binary. Install dependencies first (npm install).\n',
  );
  process.exit(1);
}

const appDir = path.join(__dirname, '..');
const args = process.argv.slice(2);

const child = spawn(electron, [appDir, ...args], {
  stdio: ['ignore', 'inherit', 'inherit'],
  windowsHide: false,
});

child.on('error', (error) => {
  process.stderr.write(`nova: failed to start NovaCode: ${error.message}\n`);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) process.exit(1);
  process.exit(typeof code === 'number' ? code : 0);
});
