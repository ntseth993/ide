/**
 * NovaCode IDE - Electron main process.
 *
 * Responsibilities: application lifecycle, hardened window creation,
 * Content-Security-Policy enforcement, service wiring, and IPC
 * registration. All privileged work (filesystem, terminal, AI network
 * calls, secret storage) lives in this process; the renderer is fully
 * sandboxed and only sees the explicit preload bridge.
 */
const { app, BrowserWindow, session, protocol, shell, Menu, dialog, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

const logger = require('./logger');
const { createSettingsService } = require('./services/settingsService');
const { createSecretStore } = require('./services/secretStore');
const { createTerminalService } = require('./services/terminalService');
const { createChangeHistory } = require('./services/changeHistory');
const { parseLaunchArgs } = require('./services/launchArgs');
const { createExtensionService } = require('./services/extensionService');
const { createExtensionRegistry } = require('./services/extensionRegistry');
const { createRuntimeService } = require('./services/runtimeService');
const { createAuthService } = require('./services/authService');
const { createAuthFlow } = require('./services/authFlow');
const fsService = require('./services/fsService');
const { createAiService } = require('./services/aiService');
const { createNovaLink } = require('./services/novalink');
const { registerIpc } = require('./ipc/registerIpc');
const { buildMenuTemplate } = require('./menu');
const { loadEnv } = require('./services/env');

// Load gitignored .env (OAuth client ids, API keys) before any service reads
// process.env. Real environment variables always take precedence.
loadEnv();

// Serve the built renderer from a custom scheme so we can attach strict
// security headers to file content (plain file:// responses cannot carry
// headers). Registered before app.ready.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

let mainWindow = null;
let terminalService = null;
let aiService = null;
let changeHistory = null;
let extensionService = null;
let runtimeService = null;
let authService = null;
let authFlow = null;
let novalinkService = null;
let pendingOpenRequest = null;

// CLI entry (`nova`, `nova .`, `nova <folder|file>`): parse the launcher's
// arguments before any window exists so --help/--version answer instantly,
// and a workspace target is captured for the window that gets created.
const cliArgs = process.argv.slice(app.isPackaged ? 1 : 2);
const launchIntent = parseLaunchArgs(cliArgs, { version: app.getVersion() });
if (launchIntent.kind === 'version' || launchIntent.kind === 'help') {
  process.stdout.write(`${launchIntent.text}\n`);
  app.exit(0);
} else if (launchIntent.kind === 'error') {
  process.stderr.write(`${launchIntent.text}\n`);
  app.exit(1);
} else if (launchIntent.kind === 'open') {
  pendingOpenRequest = buildOpenRequest(launchIntent.target);
  if (pendingOpenRequest.kind === 'error') {
    process.stderr.write(`${pendingOpenRequest.message}\n`);
    app.exit(1);
  }
}

/**
 * Convert a CLI target into an open request the renderer can execute.
 * A bare `.` resolves against the inherited working directory of the
 * launcher shim, which is the directory the user invoked `nova .` from.
 */
function buildOpenRequest(target) {
  const resolved = path.resolve(target);
  let stat = null;
  try {
    stat = fs.statSync(resolved);
  } catch {
    stat = null;
  }
  if (!stat) {
    return { kind: 'error', message: `nova: path does not exist: ${resolved}` };
  }
  return stat.isDirectory()
    ? { kind: 'workspace', path: resolved }
    : { kind: 'file', path: resolved };
}

/** Deliver an open request to the renderer once its bridge is listening. */
function requestOpen(request) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  logger.info('cli open request', request);
  const send = () => mainWindow?.webContents.send('workspace:request', request);
  if (mainWindow.webContents.isLoading()) {
    mainWindow.webContents.once('did-finish-load', send);
  } else {
    send();
  }
}

const DIST_DIR = path.join(__dirname, '..', 'dist');
const USER_DATA = app.getPath('userData');

const DEV_SERVER_URL = 'http://localhost:5173';
const APP_ORIGIN = 'app://novacode';

/* --- window appearance ---------------------------------------------------------
   The renderer owns the theme palettes (src/themes.js), so it tells the main
   process which canvas color and light/dark scheme a theme resolves to. That
   keeps native surfaces — window background while loading, the OS title bar and
   system dialog chrome — on the same page as the app itself. The last value is
   remembered on disk so a restart opens straight into the right appearance.
   ------------------------------------------------------------------------- */
const APPEARANCE_PATH = path.join(USER_DATA, 'novacode-appearance.json');
const DEFAULT_APPEARANCE = { background: '#070b14', kind: 'dark' };
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

function sanitizeAppearance(value) {
  const source = value && typeof value === 'object' ? value : {};
  const background = HEX_COLOR.test(String(source.background || ''))
    ? String(source.background).toLowerCase()
    : DEFAULT_APPEARANCE.background;
  const kind = source.kind === 'light' ? 'light' : 'dark';
  return { background, kind };
}

function readStoredAppearance() {
  try {
    return sanitizeAppearance(JSON.parse(fs.readFileSync(APPEARANCE_PATH, 'utf8')));
  } catch {
    return { ...DEFAULT_APPEARANCE };
  }
}

let lastAppearance = readStoredAppearance();

/** Apply (and by default remember) the native half of the current theme. */
function applyAppearance(payload) {
  const appearance = sanitizeAppearance(payload);
  const changed = appearance.background !== lastAppearance.background || appearance.kind !== lastAppearance.kind;
  lastAppearance = appearance;
  nativeTheme.themeSource = appearance.kind;
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setBackgroundColor(appearance.background);
  if (changed) {
    // Fire-and-forget: appearance is a nicety, never worth blocking the app.
    fspWriteFile(APPEARANCE_PATH, JSON.stringify(appearance));
  }
  return { ok: true, ...appearance };
}

function fspWriteFile(filePath, data) {
  fs.promises.writeFile(filePath, data, 'utf8').catch((error) => {
    logger.warn?.('could not remember window appearance', { error: error.message });
  });
}

/** Strict CSP for packaged builds; relaxed only for the Vite dev server. */
function buildCsp() {
  const isDev = !app.isPackaged;
  const scriptSrc = isDev ? "'self' 'unsafe-inline'" : "'self'";
  const connectSrc = isDev ? "'self' ws://localhost:5173 http://localhost:5173" : "'self'";
  return [
    "default-src 'self'",
    `script-src ${scriptSrc}`,
    "style-src 'self' 'unsafe-inline'",
    // open-vsx.org 302-redirects icon/file URLs to its CDN, so both hosts must
    // be allowed or every marketplace icon is silently blocked.
    "img-src 'self' data: blob: https://open-vsx.org https://openvsx.eclipsecontent.org",
    "font-src 'self' data:",
    "worker-src 'self' blob:",
    `connect-src ${connectSrc}`,
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

function applySecurityHeaders() {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    if (!app.isPackaged && details.url.startsWith(DEV_SERVER_URL)) {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [buildCsp()],
        },
      });
      return;
    }
    callback({ responseHeaders: details.responseHeaders });
  });
}

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
};

/** app://novacode/<path> -> files under dist/, with security headers. */
function registerAppProtocol() {
  protocol.handle('app', async (request) => {
    try {
      const requestUrl = new URL(request.url);
      let relativePath = decodeURIComponent(requestUrl.pathname).replace(/^\/+/, '');
      if (!relativePath) relativePath = 'index.html';
      let filePath = path.normalize(path.join(DIST_DIR, relativePath));
      if (!filePath.startsWith(DIST_DIR)) {
        return new Response('Forbidden', { status: 403 });
      }
      if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        filePath = path.join(DIST_DIR, 'index.html');
      }
      const fileResponse = await net_fetchFile(filePath);
      return fileResponse;
    } catch (error) {
      logger.error('app protocol error', { url: request.url, error: error.message });
      return new Response('Internal error', { status: 500 });
    }
  });
}

async function net_fetchFile(filePath) {
  const response = await fetch(pathToFileURL(filePath).toString());
  const mime = MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
  return new Response(await response.arrayBuffer(), {
    status: response.status,
    headers: {
      'Content-Type': mime,
      'Content-Security-Policy': buildCsp(),
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 960,
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: lastAppearance.background,
    autoHideMenuBar: true,
    title: 'NovaCode IDE',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      enableRemoteModule: false,
      spellcheck: false,
    },
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Match the remembered theme before the renderer paints its first frame.
  nativeTheme.themeSource = lastAppearance.kind;

  // No popups; external links go to the system browser over http(s) only.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // Block in-window navigation away from our own origins.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const allowed = app.isPackaged
      ? url.startsWith(APP_ORIGIN)
      : url.startsWith(DEV_SERVER_URL);
    if (!allowed) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });

  if (app.isPackaged) {
    mainWindow.loadURL(`${APP_ORIGIN}/index.html`);
  } else {
    mainWindow.loadURL(DEV_SERVER_URL);
  }

  // The renderer only learns its theme after the settings IPC round-trip, so
  // tint the canvas with the remembered colour as soon as the DOM exists —
  // otherwise a light theme flashes dark for the first frames.
  mainWindow.webContents.on('dom-ready', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.insertCSS(
      `:root{--nc-startup-bg:${lastAppearance.background};}`,
    ).catch(() => { /* cosmetic only */ });
  });
}

/**
 * Native application menu. Menu clicks dispatch command ids to the
 * renderer, where the shared command registry executes them; native
 * roles (undo/redo/cut/copy/paste) are handled by Chromium directly.
 */
function installMenu() {
  const send = (commandId) => mainWindow?.webContents.send('menu:command', commandId);
  const menu = Menu.buildFromTemplate(buildMenuTemplate({
    send,
    showAbout: () => {
      dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: 'About NovaCode',
        message: `NovaCode IDE ${app.getVersion()}`,
        detail: `Local-first AI code editor\nElectron ${process.versions.electron} · Node ${process.versions.node} · Chromium ${process.versions.chrome}`,
        buttons: ['OK'],
      });
    },
    showDocs: () => {
      dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: 'NovaCode Documentation',
        message: 'NovaCode documentation',
        detail: [
          'README.md — setup, scripts, and feature overview.',
          'docs/EXTENSIONS.md — extension manifest format and developer guide.',
          'docs/LANGUAGES.md — language support matrix and runtime setup.',
        ].join('\n'),
        buttons: ['OK'],
      });
    },
  }));
  Menu.setApplicationMenu(menu);
}

function wireServices() {
  logger.init(USER_DATA);
  logger.info('novacode starting', { version: app.getVersion(), packaged: app.isPackaged });

  installMenu();

  const settingsService = createSettingsService(path.join(USER_DATA, 'novacode-settings.json'));
  const secretStore = createSecretStore({
    filePath: path.join(USER_DATA, 'novacode-secrets.json'),
    safeStorage: require('electron').safeStorage,
    logger,
  });

  terminalService = createTerminalService({
    logger,
    onEvent: (payload) => mainWindow?.webContents.send('terminal:event', payload),
  });

  authService = createAuthService({
    filePath: path.join(USER_DATA, 'novacode-accounts.json'),
    logger,
  });

  // Browser sign-in: opens the default browser at a loopback page and pushes
  // the resulting session back into the renderer.
  authFlow = createAuthFlow({
    authService,
    logger,
    // Providers that require an exact redirect-uri match (GitHub) need a fixed
    // loopback port; otherwise we bind an ephemeral one (fine for Google).
    port: Number(process.env.NOVACODE_AUTH_PORT) || 0,
    readSecret: (name) => secretStore.getSecret(name),
    openBrowser: (url) => shell.openExternal(url),
    onSession: (account) => {
      mainWindow?.webContents.send('auth:session', account);
      if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
      }
    },
  });

  aiService = createAiService({
    logger,
    secretStore,
    auth: authService,
    onEvent: (payload) => mainWindow?.webContents.send('ai:event', payload),
  });

  changeHistory = createChangeHistory({
    filePath: path.join(USER_DATA, 'novacode-history.jsonl'),
    readFile: (root, target) => fsService.readFile(root, target),
    writeFile: (root, target, content) => fsService.writeFile(root, target, content),
    remove: (root, target) => fsService.remove(root, target),
    logger,
  });

  extensionService = createExtensionService({
    userDataDir: path.join(USER_DATA, 'extensions'),
    appVersion: app.getVersion(),
    logger,
  });

  const extensionRegistry = createExtensionRegistry({ extensions: extensionService, logger });

  runtimeService = createRuntimeService({ logger });

  // NovaLink peer-to-peer collaboration (local-network transport + an honest
  // Bluetooth transport). It streams a single state snapshot to the renderer.
  novalinkService = createNovaLink({
    userDataDir: USER_DATA,
    logger,
    onEvent: (payload) => mainWindow?.webContents.send('novalink:event', payload),
  }).service;
  novalinkService.start().catch((error) => logger.error('novalink start failed', { error: error.message }));

  return { settingsService, secretStore, changeHistory, extensionService, extensionRegistry, runtimeService, authService, authFlow };
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
    // A second `nova <path>` launch forwards its target into this window.
    const args = argv.slice(app.isPackaged ? 1 : 2);
    const next = parseLaunchArgs(args, { version: app.getVersion() });
    if (next.kind === 'open') {
      // Bad paths are forwarded too: the renderer shows them as toasts.
      requestOpen(buildOpenRequest(next.target));
    }
  });

  app.whenReady().then(() => {
    applySecurityHeaders();
    if (app.isPackaged) registerAppProtocol();

    const { settingsService, secretStore, changeHistory: history, extensionService: extensions, extensionRegistry: registry, runtimeService: runtime, authFlow: auth } = wireServices();
    registerIpc({
      getWindow: () => mainWindow,
      settings: settingsService,
      secretStore,
      terminal: terminalService,
      ai: aiService,
      auth,
      history,
      extensions,
      registry,
      runtime,
      novalink: novalinkService,
      applyAppearance,
      logger,
    });

    createWindow();

    // Honor `nova <folder|file>` on first launch, after the renderer is up.
    if (pendingOpenRequest) {
      const request = pendingOpenRequest;
      pendingOpenRequest = null;
      requestOpen(request);
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    terminalService?.dispose();
    aiService?.dispose();
    authFlow?.cancel?.();
    novalinkService?.dispose();
  });
}
