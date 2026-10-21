/**
 * Minimal, dependency-free .env loader.
 *
 * Reads a gitignored `.env` at the project root and populates process.env for
 * any key that isn't already set, so local secrets (OAuth client ids, API keys)
 * never have to be hard-coded or committed. Real environment variables always
 * win, which keeps CI/production overrides intact. Only ever called from the
 * Electron main process, before services read process.env.
 */
const fs = require('fs');
const path = require('path');

function parse(text) {
  const result = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key) result[key] = value;
  }
  return result;
}

/** Load `filePath` (default: <repoRoot>/.env) into process.env without clobbering. */
function loadEnv(filePath = path.join(__dirname, '..', '..', '.env')) {
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch {
    return {}; // No .env is a normal state (packaged builds, CI).
  }
  const parsed = parse(text);
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
  return parsed;
}

module.exports = { loadEnv, parse };
