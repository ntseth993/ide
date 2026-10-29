/**
 * NovaLink Bluetooth transport.
 *
 * What this file does — and does not — claim, honestly:
 *
 *   It CAN (and does) talk to the real OS Bluetooth stack on Windows via
 *   PowerShell, using only Node built-ins:
 *     • enumerate the Bluetooth adapter and infer its power state
 *       (Windows disables the adapter device when Bluetooth is toggled off),
 *     • read the Bluetooth Support Service (bthserv) status, so we can tell
 *       "no adapter" from "adapter present but Bluetooth is off", and report a
 *       structured capability (adapterPresent / powered / serviceRunning /
 *       canScan / discoverable) for the UI,
 *     • attempt to ENABLE the adapter when it is disabled,
 *     • enumerate ALL surrounding Bluetooth devices the OS can see (any
 *       device — phones, headphones, other PCs — not just NovaCode), marking
 *       which are currently connected, so the UI shows what is really around.
 *
 *   It CANNOT (and never pretends to):
 *     • discover arbitrary *unpaired* BLE advertisers on Windows from pure
 *       Node — that needs a native BLE stack; we show what the OS reports,
 *     • move NovaLink data (chat/code/files) between two desktop apps —
 *       Web Bluetooth is central-only/GATT, Classic SPP is not exposed to
 *       Node/Electron, and BLE peripheral mode is not reliable here,
 *     • so `supported` stays false for messaging: connect()/send() reject
 *       loudly instead of simulating a connection. Discovery results are
 *       labelled "OS-visible devices", never fake NovaLink peers.
 *
 * The Transport interface is implemented fully, so a future native Bluetooth
 * module (validated on two real devices) drops in beside this one without any
 * service or UI changes.
 */
const { spawn } = require('child_process');
const os = require('os');
const { EventEmitter } = require('events');

const UNSUPPORTED_REASON =
  'Bluetooth chat/code/file exchange between two desktop apps is not reliably ' +
  'supported on Windows 11 + Electron 44 without a native Bluetooth module (Web ' +
  'Bluetooth is central-only/GATT and cannot stream arbitrary data app-to-app). ' +
  'Bluetooth here is used for real adapter status, enabling, and device discovery ' +
  'only. Use the Local network transport for NovaLink messaging today.';

/** Device-class list query — returns adapter + all OS-known Bluetooth devices. */
const LIST_DEVICES_CMD =
  "Get-PnpDevice -Class Bluetooth -ErrorAction SilentlyContinue | " +
  "Select-Object FriendlyName, InstanceId, Status, ConfigManagerErrorCode | " +
  "ConvertTo-Json -Compress";

/**
 * The Bluetooth Support Service (bthserv) must be running for the stack to
 * work at all — a reliable, non-async signal of real system support.
 */
const SERVICE_CMD =
  "Get-Service bthserv -ErrorAction SilentlyContinue | Select-Object Name, Status | ConvertTo-Json -Compress";

/** Enable a specific adapter device (fails without elevation → caller falls back). */
const ENABLE_DEVICE_CMD_TPL =
  "Enable-PnpDevice -InstanceId '{id}' -Confirm:$false -ErrorAction Stop";

/** Deep-link page where the user can flip the Bluetooth toggle themselves. */
const OPEN_SETTINGS_CMD = "Start-Process 'ms-settings:bluetooth'";

/**
 * Run one PowerShell command, never throw, always settle quickly.
 * Injectable via `runPowerShell` so the module is testable without a PC radio.
 * @returns {Promise<{ok:boolean, stdout:string, stderr:string, code:number|undefined}>}
 */
function runPowerShell(command, { timeoutMs = 6000 } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let child;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { if (child && child.exitCode === null) child.kill(); } catch { /* ignore */ }
      resolve(result);
    };
    try {
      child = spawn('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command,
      ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      return finish({ ok: false, stdout: '', stderr: error.message, code: undefined });
    }
    let out = '';
    let err = '';
    child.stdout?.on('data', (chunk) => { out += chunk; });
    child.stderr?.on('data', (chunk) => { err += chunk; });
    const timer = setTimeout(() => finish({ ok: false, stdout: out, stderr: 'Timed out.', code: undefined }), timeoutMs);
    timer.unref?.();
    child.on('error', (error) => finish({ ok: false, stdout: out, stderr: error.message, code: undefined }));
    child.on('close', (code) => finish({ ok: code === 0, stdout: out, stderr: err, code }));
  });
}

/** ConvertTo-Json collapses a single object; normalize both shapes to arrays. */
function parseDeviceJson(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return [];
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows
    .filter((r) => r && (r.InstanceId || r.FriendlyName))
    .map((r) => ({
      name: r.FriendlyName || 'Unknown device',
      instanceId: r.InstanceId || '',
      status: r.Status || 'Unknown',
      configErrorCode: Number.isFinite(r.ConfigManagerErrorCode) ? r.ConfigManagerErrorCode : null,
    }));
}

/** Heuristic: is this row the local radio/adapter rather than a peripheral? */
function isAdapterRow(row) {
  const name = String(row.name || '').toLowerCase();
  return row.status !== undefined && (
    /bluetooth.*(adapter|radio|host|module|dongle|usb)/.test(name)
    || name === 'microsoft radio control driver'
    || /radio/.test(String(row.instanceId || '').toLowerCase())
  );
}

/**
 * Windows disables the adapter device (error code 22) when Bluetooth is
 * switched off at the OS level, so PnP state doubles as a power reading.
 * @returns {'on'|'off'|'absent'|'unknown'}
 */
function derivePowerState(devices) {
  const adapters = devices.filter(isAdapterRow);
  if (!adapters.length) return devices.length ? 'unknown' : 'absent';
  if (adapters.some((a) => a.status === 'OK')) return 'on';
  if (adapters.some((a) => a.configErrorCode === 22 || a.status !== 'OK')) return 'off';
  return 'unknown';
}

async function probeWindowsBluetooth({ runPs = runPowerShell } = {}) {
  const [devResult, svcResult] = await Promise.all([
    runPs(LIST_DEVICES_CMD),
    runPs(SERVICE_CMD),
  ]);
  const serviceRunning = parseServiceStatus(svcResult.stdout) === 'Running';
  if (!devResult.ok && !devResult.stdout.trim()) {
    return { devices: [], power: 'unknown', serviceRunning, detail: (devResult.stderr || 'Bluetooth query failed.').trim().slice(0, 200) };
  }
  const devices = parseDeviceJson(devResult.stdout);
  return {
    devices,
    power: derivePowerState(devices),
    serviceRunning,
    detail: devResult.stderr?.trim().slice(0, 200) || null,
  };
}

/** Legacy-friendly summary kept for detectAdapter()'s public contract. */
function detectAdapter({ platform = process.platform, runProbe } = {}) {
  if (platform === 'win32') {
    if (runProbe) return runProbe();
    return probeWindowsBluetooth().then(({ devices, power, detail }) => {
      if (power === 'absent') return { state: 'absent', detail: 'No Bluetooth devices enumerated.' };
      if (power === 'off') return { state: 'present', powered: false, detail: detail || 'Adapter present but Bluetooth is switched off.' };
      if (power === 'on') return { state: 'present', powered: true, detail: `${devices.length} Bluetooth device(s) enumerated.` };
      return { state: 'unknown', detail: detail || 'Adapter state could not be determined.' };
    }).catch((error) => ({ state: 'unknown', detail: `Probe failed: ${error.message}` }));
  }
  return Promise.resolve({ state: 'unknown', detail: `No adapter probe for "${platform}".` });
}

/** Read the bthserv status ('Running' | 'Stopped' | null) from Get-Service JSON. */
function parseServiceStatus(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const row = Array.isArray(parsed) ? parsed[0] : parsed;
  return (row && (row.Status || row.status)) || null;
}

/**
 * Turn the raw probe into an honest, structured capability report the UI can
 * render verbatim. Data transfer over the raw radio is reported as unsupported
 * with the concrete workaround, never faked as available.
 */
function deriveCapability({ devices, power, serviceRunning }) {
  const adapterPresent = devices.some(isAdapterRow) || power !== 'absent';
  const powered = power === 'on';
  return {
    adapterPresent,
    powered,
    power,
    serviceRunning: Boolean(serviceRunning),
    canScan: adapterPresent && powered,
    // Best-effort: Windows marks the radio discoverable only when it is on and
    // the stack is running; we cannot read IsDiscoverable without a native call.
    discoverable: powered && Boolean(serviceRunning),
    dataSupported: false,
    dataReason: UNSUPPORTED_REASON,
    dataWorkaround:
      'To actually send messages/files/images over Bluetooth, pair the two PCs and connect them through a Bluetooth network (PAN) — NovaLink then runs over that link with its existing encrypted transport. Otherwise use the Wi-Fi / Ethernet Local network transport today.',
  };
}

function createBluetoothTransport({ logger = console, platform = process.platform, runPs = runPowerShell } = {}) {
  const events = new EventEmitter();
  let running = false;
  const log = (level, message, meta) => {
    if (logger && typeof logger[level] === 'function') logger[level](message, meta);
  };

  const rejectUnsupported = (action) => {
    const error = new Error(`NovaLink Bluetooth ${action} is not supported on this platform. ${UNSUPPORTED_REASON}`);
    error.code = 'ENOVALINK_BT_UNSUPPORTED';
    events.emit('error', { message: error.message });
    log?.('warn', 'novalink bluetooth action rejected', { action });
    throw error;
  };

  async function probe() {
    if (platform !== 'win32') {
      return { devices: [], power: 'unknown', detail: `No Bluetooth probe implemented for "${platform}".` };
    }
    return probeWindowsBluetooth({ runPs });
  }

  return {
    id: 'bluetooth',
    label: 'Bluetooth',
    kind: 'bluetooth',
    supported: false, // messaging stays unsupported; discovery/enable are real
    on: (event, cb) => events.on(event, cb),
    off: (event, cb) => events.off(event, cb),

    async getStatus() {
      const { devices, power, serviceRunning, detail } = await probe();
      const capability = deriveCapability({ devices, power, serviceRunning });
      return {
        available: running && power === 'on',
        supported: false,
        reason: UNSUPPORTED_REASON,
        hostname: os.hostname(),
        power, // 'on' | 'off' | 'absent' | 'unknown'
        serviceRunning,
        discoverable: capability.discoverable,
        capability,
        deviceCount: devices.length,
        adapters: devices.filter(isAdapterRow).map((a) => ({
          kind: 'bluetooth',
          label: a.name,
          state: a.status === 'OK' ? 'present' : 'disabled',
          detail: a.status,
        })),
        detail: detail || (power === 'off' ? 'Bluetooth adapter is off — enable it to scan.' : null),
      };
    },

    async start() { running = true; },
    async stop() { running = false; },

    // NovaLink pairing peers would be fake; emit none. Surrounding-device
    // discovery is a separate, explicitly-labelled capability (scanDevices).
    async scan() {
      events.emit('peers', []);
    },

    /**
     * Turn Bluetooth on. Tries to re-enable the adapter device; when Windows
     * refuses without elevation or a soft radio-off is in play, opens the
     * Bluetooth settings page so the user flips the toggle (honest fallback,
     * never a silent "success").
     */
    async enable() {
      if (platform !== 'win32') {
        return { ok: false, needsUserAction: false, detail: `Enabling Bluetooth is not implemented for "${platform}".` };
      }
      const { devices, power } = await probe();
      if (power === 'on') return { ok: true, alreadyOn: true, detail: 'Bluetooth is already on.' };
      if (power === 'absent') {
        return { ok: false, needsUserAction: false, detail: 'No Bluetooth adapter was found on this machine.' };
      }
      const adapter = devices.find(isAdapterRow) || devices[0];
      if (adapter?.instanceId) {
        const cmd = ENABLE_DEVICE_CMD_TPL.replace('{id}', adapter.instanceId.replace(/'/g, "''"));
        const result = await runPs(cmd, { timeoutMs: 10000 });
        const after = await probe();
        if (after.power === 'on') {
          return { ok: true, detail: `Bluetooth adapter "${adapter.name}" enabled.` };
        }
        if (!result.ok) {
          log?.('warn', 'novalink bluetooth enable denied', { stderr: result.stderr?.slice(0, 160) });
        }
      }
      // Adapter listed but we could not switch it on programmatically (UAC or
      // radio-level off): open Settings and tell the user exactly that.
      await runPs(OPEN_SETTINGS_CMD, { timeoutMs: 5000 });
      return {
        ok: false,
        needsUserAction: true,
        detail: 'NovaCode could not switch Bluetooth on by itself (Windows may require admin approval or the Bluetooth toggle). The Bluetooth settings page was opened — turn Bluetooth on, then scan again.',
      };
    },

    /** All Bluetooth devices the OS can see — any device, not just NovaCode. */
    async scanDevices() {
      const { devices, power, serviceRunning, detail } = await probe();
      const capability = deriveCapability({ devices, power, serviceRunning });
      return {
        ok: power !== 'absent',
        power,
        serviceRunning,
        capability,
        scannedAt: Date.now(),
        devices: devices.map((d) => ({
          name: d.name,
          status: d.status,
          isAdapter: isAdapterRow(d),
          connected: !isAdapterRow(d) && d.status === 'OK',
        })),
        detail,
      };
    },

    addPeer() { /* no-op: never fabricate a Bluetooth peer */ },
    async connect() { rejectUnsupported('connection'); },
    async send() { rejectUnsupported('send'); },
    async close() { return { ok: false }; },

    listPeers: () => [],
    connectedIds: () => [],
  };
}

module.exports = {
  createBluetoothTransport,
  detectAdapter,
  probeWindowsBluetooth,
  parseDeviceJson,
  parseServiceStatus,
  derivePowerState,
  deriveCapability,
  UNSUPPORTED_REASON,
};
