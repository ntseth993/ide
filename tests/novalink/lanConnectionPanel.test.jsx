/**
 * LanConnectionPanel — the compact LAN connection surface.
 *
 * It renders against the mocked preload bridge (tests/setup.js). We assert the
 * user-facing contract: the state badge, expand/collapse, discovering a host and
 * connecting to it (handing the host id to the main process), the manual-IP
 * fallback, and the host on/off toggle. The panel never touches a socket itself
 * and never signs in — so the test never expects credential arguments here.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import LanConnectionPanel from '../../src/components/NovaLinkLive/LanConnectionPanel.jsx';
import { mockNova } from '../setup.js';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  // Restore the idle defaults that other files rely on.
  mockNova.novalinkLanScan.mockResolvedValue({ scanning: true, hosts: [] });
  mockNova.novalinkLanStatus.mockResolvedValue({ scanning: false, hosts: [] });
  mockNova.novalinkLanHostStatus.mockResolvedValue({ running: false, port: 10000, host: '0.0.0.0', ips: [], urls: [], lastError: null });
  mockNova.novalinkLanSelectHost.mockResolvedValue({ ok: true, baseUrl: 'http://192.168.1.42:10000', name: 'Lab-PC', host: 'lab', ips: ['192.168.1.42'], port: 10000, tls: false });
  mockNova.novalinkLanManualConnect.mockResolvedValue({ ok: true, baseUrl: 'http://192.168.1.9:10000' });
  mockNova.novalinkLanStartHost.mockResolvedValue({ running: true, port: 10000, host: '0.0.0.0', ips: ['192.168.1.42'], urls: ['http://192.168.1.42:10000'], lastError: null });
  mockNova.novalinkLanStopHost.mockResolvedValue({ running: false, port: 10000, host: '0.0.0.0', ips: [], urls: [], lastError: null });
});

const DISCONNECTED = { configured: false, baseUrl: '', signedIn: false, connected: false, ready: false };

function openPanel(status = DISCONNECTED) {
  render(<LanConnectionPanel status={status} onNotify={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: /lan options/i }));
}

describe('LanConnectionPanel', () => {
  it('renders a Disconnected badge and stays collapsed until opened', () => {
    render(<LanConnectionPanel status={DISCONNECTED} onNotify={vi.fn()} />);
    expect(screen.getByText(/disconnected/i)).toBeInTheDocument();
    // Host list is hidden until the user expands LAN options.
    expect(screen.queryByRole('button', { name: /search the network/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /lan options/i }));
    expect(screen.getByRole('button', { name: /search the network/i })).toBeInTheDocument();
  });

  it('searches the network and lists a discovered host, then connects by id', async () => {
    mockNova.novalinkLanScan.mockResolvedValueOnce({
      scanning: false,
      hosts: [{ id: 'srv-1', name: 'Lab-PC', host: 'lab', ips: ['192.168.1.42'], port: 10000, tls: false, baseUrl: 'http://192.168.1.42:10000' }],
    });
    openPanel();
    fireEvent.click(screen.getByRole('button', { name: /search the network/i }));
    await waitFor(() => expect(mockNova.novalinkLanScan).toHaveBeenCalledTimes(1));
    // The host row appears; its badge should leave "Disconnected".
    expect(await screen.findByText('Lab-PC')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^connect$/i }));
    await waitFor(() => expect(mockNova.novalinkLanSelectHost).toHaveBeenCalledWith({ hostId: 'srv-1' }));
  });

  it('shows the searching state and a stop control while scanning with no hosts', async () => {
    // scan resolves with still-scanning and no hosts, mimicking "keep looking".
    mockNova.novalinkLanScan.mockResolvedValueOnce({ scanning: true, hosts: [] });
    openPanel();
    fireEvent.click(screen.getByRole('button', { name: /search the network/i }));
    expect(await screen.findByRole('button', { name: /stop searching/i })).toBeInTheDocument();
  });

  it('connects by manual IP as a multicast fallback', async () => {
    openPanel();
    fireEvent.change(screen.getByLabelText(/host ip address/i), { target: { value: '192.168.1.9' } });
    fireEvent.change(screen.getByLabelText(/port/i), { target: { value: '10000' } });
    fireEvent.click(screen.getByRole('button', { name: /connect by ip/i }));
    await waitFor(() => expect(mockNova.novalinkLanManualConnect).toHaveBeenCalledTimes(1));
    expect(mockNova.novalinkLanManualConnect).toHaveBeenCalledWith({ address: '192.168.1.9', port: 10000, tls: false });
  });

  it('toggles this machine into hosting mode', async () => {
    openPanel();
    fireEvent.click(screen.getByRole('button', { name: /start hosting/i }));
    await waitFor(() => expect(mockNova.novalinkLanStartHost).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/running on port 10000/i)).toBeInTheDocument();
  });

  it('surfaces a spawn failure from the host status instead of pretending', async () => {
    mockNova.novalinkLanStartHost.mockResolvedValueOnce({ running: false, port: 10000, host: '0.0.0.0', ips: [], urls: [], lastError: 'NovaLink host exited (code 1). SQLITE_CANTOPEN' });
    openPanel();
    fireEvent.click(screen.getByRole('button', { name: /start hosting/i }));
    expect(await screen.findByText(/SQLITE_CANTOPEN/i)).toBeInTheDocument();
  });

  it('shows a Connected badge when the underlying client reports ready', () => {
    render(<LanConnectionPanel status={{ configured: true, baseUrl: 'http://192.168.1.42:10000', signedIn: true, connected: true, ready: true }} onNotify={vi.fn()} />);
    expect(screen.getByText(/connected/i)).toBeInTheDocument();
  });
});
