'use strict';
/**
 * NovaLink Live — public barrel.
 *
 * The desktop app carries no LAN/Bluetooth peer-to-peer *messaging* stack: all
 * traffic rides the internet-style NovaLink Live client in `liveClient.js`,
 * which talks to a `link-server` over its existing `/link` protocol.
 *
 * The two `lan*` modules are *not* a second protocol. They only solve the
 * "which address is the server?" problem on a local network:
 *   - `lanDiscovery.js` searches the LAN for a host that is already running
 *     `link-server` and yields a plain `http://ip:port` base URL;
 *   - `lanHost.js` starts/stops that same `link-server` process so this PC can
 *     be the host.
 * Both hand their result back to the one `createLiveClient` instance below —
 * nothing here opens its own sockets to the renderer or stores a second set of
 * credentials.
 */
const { createLiveClient, LiveError } = require('./liveClient');
const { createLanDiscovery, manualBaseUrl } = require('./lanDiscovery');
const { createLanHost } = require('./lanHost');

function createNovaLink(deps) {
  return { service: createLiveClient(deps) };
}

module.exports = { createNovaLink, createLiveClient, LiveError, createLanDiscovery, createLanHost, manualBaseUrl };
