/**
 * NovaLink Bluetooth transport tests.
 *
 * The transport drives real PowerShell on Windows, but every OS call goes
 * through an injectable `runPs`, so these tests exercise the actual logic
 * (adapter/power detection, enabling, surrounding-device enumeration, and the
 * honest refusal to simulate a data connection) without touching a radio.
 */
import { describe, it, expect } from 'vitest';
import {
  createBluetoothTransport,
  parseDeviceJson,
  derivePowerState,
} from '../../electron/services/novalink/bluetoothTransport';

const silentLogger = { warn() {}, error() {}, log() {} };

function adapterRow(disabled) {
  return {
    FriendlyName: 'Realtek Bluetooth Adapter',
    InstanceId: 'USB\\VID_0BDA&PID_8771',
    Status: disabled ? 'Error' : 'OK',
    ConfigManagerErrorCode: disabled ? 22 : 0,
  };
}
const peripheralRow = {
  FriendlyName: 'JBL Flip 6',
  InstanceId: 'BTHENUM\\{0000110B}&_DEV',
  Status: 'OK',
  ConfigManagerErrorCode: 0,
};

/** A scripted PowerShell stand-in that reports/changes a Bluetooth state. */
function fakePowerShell({ disabled = false, enableWorks = true, hasAdapter = true } = {}) {
  const calls = [];
  let adapterDisabled = disabled;
  const runPs = async (command) => {
    calls.push(command);
    if (command.includes('Get-PnpDevice')) {
      const rows = [];
      if (hasAdapter) rows.push(adapterRow(adapterDisabled));
      if (hasAdapter && !adapterDisabled) rows.push(peripheralRow);
      return { ok: true, stdout: JSON.stringify(rows), stderr: '', code: 0 };
    }
    if (command.includes('Enable-PnpDevice')) {
      if (enableWorks) adapterDisabled = false;
      return enableWorks
        ? { ok: true, stdout: '', stderr: '', code: 0 }
        : { ok: false, stdout: '', stderr: 'Access is denied.', code: 1 };
    }
    if (command.includes('ms-settings:bluetooth')) {
      return { ok: true, stdout: '', stderr: '', code: 0 };
    }
    return { ok: false, stdout: '', stderr: 'unexpected command', code: 1 };
  };
  return { runPs, calls };
}

describe('novalink bluetoothTransport — parsing helpers', () => {
  it('normalizes a single-object ConvertTo-Json and arrays to a device list', () => {
    expect(parseDeviceJson(JSON.stringify(adapterRow(false)))).toHaveLength(1);
    const two = parseDeviceJson(JSON.stringify([adapterRow(false), peripheralRow]));
    expect(two.map((d) => d.name)).toEqual(['Realtek Bluetooth Adapter', 'JBL Flip 6']);
    expect(parseDeviceJson('')).toEqual([]);
    expect(parseDeviceJson('not json')).toEqual([]);
  });

  it('derives power state from the adapter device (on / off / absent)', () => {
    // derivePowerState consumes parseDeviceJson-normalized rows, as in production.
    const on = parseDeviceJson(JSON.stringify([adapterRow(false), peripheralRow]));
    const off = parseDeviceJson(JSON.stringify([adapterRow(true)]));
    expect(derivePowerState(on)).toBe('on');
    expect(derivePowerState(off)).toBe('off');
    expect(derivePowerState([])).toBe('absent');
  });
});

describe('novalink bluetoothTransport — status + discovery', () => {
  it('reports real power state and stays unsupported for messaging', async () => {
    const { runPs } = fakePowerShell({ disabled: false });
    const bt = createBluetoothTransport({ logger: silentLogger, platform: 'win32', runPs });
    const status = await bt.getStatus();
    expect(status.supported).toBe(false);
    expect(status.power).toBe('on');
    expect(status.deviceCount).toBe(2); // adapter + a speaker — "any bluetooth"
  });

  it('enumerates all OS-visible devices, not only NovaCode', async () => {
    const { runPs } = fakePowerShell();
    const bt = createBluetoothTransport({ logger: silentLogger, platform: 'win32', runPs });
    const scan = await bt.scanDevices();
    expect(scan.ok).toBe(true);
    expect(scan.devices.map((d) => d.name)).toContain('JBL Flip 6');
    expect(scan.devices.find((d) => d.name === 'Realtek Bluetooth Adapter').isAdapter).toBe(true);
  });

  it('scan() never fabricates NovaLink peers', async () => {
    const { runPs } = fakePowerShell();
    const bt = createBluetoothTransport({ logger: silentLogger, platform: 'win32', runPs });
    const emitted = [];
    bt.on('peers', (peers) => emitted.push(peers));
    await bt.scan();
    expect(emitted).toEqual([[]]);
  });

  it('connect() and send() reject instead of simulating a connection', async () => {
    const { runPs } = fakePowerShell();
    const bt = createBluetoothTransport({ logger: silentLogger, platform: 'win32', runPs });
    await expect(bt.connect('x')).rejects.toThrow(/not supported/i);
    await expect(bt.send('x', {})).rejects.toThrow(/not supported/i);
  });
});

describe('novalink bluetoothTransport — enable', () => {
  it('turns a disabled adapter on and confirms via a re-probe', async () => {
    const { runPs, calls } = fakePowerShell({ disabled: true, enableWorks: true });
    const bt = createBluetoothTransport({ logger: silentLogger, platform: 'win32', runPs });
    const result = await bt.enable();
    expect(result.ok).toBe(true);
    expect(calls.some((c) => c.includes('Enable-PnpDevice'))).toBe(true);
    await bt.start();
    expect((await bt.getStatus()).power).toBe('on');
  });

  it('falls back to opening Bluetooth settings when Windows denies enabling', async () => {
    const { runPs, calls } = fakePowerShell({ disabled: true, enableWorks: false });
    const bt = createBluetoothTransport({ logger: silentLogger, platform: 'win32', runPs });
    const result = await bt.enable();
    expect(result.ok).toBe(false);
    expect(result.needsUserAction).toBe(true);
    expect(calls.some((c) => c.includes('ms-settings:bluetooth'))).toBe(true);
  });

  it('reports already-on without trying to enable', async () => {
    const { runPs, calls } = fakePowerShell({ disabled: false });
    const bt = createBluetoothTransport({ logger: silentLogger, platform: 'win32', runPs });
    const result = await bt.enable();
    expect(result).toMatchObject({ ok: true, alreadyOn: true });
    expect(calls.some((c) => c.includes('Enable-PnpDevice'))).toBe(false);
  });

  it('is honest about no adapter being present', async () => {
    const { runPs } = fakePowerShell({ hasAdapter: false });
    const bt = createBluetoothTransport({ logger: silentLogger, platform: 'win32', runPs });
    const result = await bt.enable();
    expect(result).toMatchObject({ ok: false, needsUserAction: false });
    expect(result.detail).toMatch(/No Bluetooth adapter/i);
  });

  it('declines on non-Windows platforms without touching the shell', async () => {
    const { runPs, calls } = fakePowerShell();
    const bt = createBluetoothTransport({ logger: silentLogger, platform: 'linux', runPs });
    const result = await bt.enable();
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});
