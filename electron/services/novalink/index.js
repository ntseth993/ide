'use strict';
/**
 * NovaLink Live — public barrel.
 *
 * The desktop app no longer carries a LAN/Bluetooth peer-to-peer stack. This
 * folder is the internet-connected NovaLink Live client only. Anything that
 * talks to link-server goes through `createNovaLinkLive`, and nothing else.
 */
const { createLiveClient, LiveError } = require('./liveClient');

function createNovaLink(deps) {
  return { service: createLiveClient(deps) };
}

module.exports = { createNovaLink, createLiveClient, LiveError };
