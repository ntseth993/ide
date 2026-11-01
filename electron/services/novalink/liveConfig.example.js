'use strict';
/**
 * Example of the file `scripts/generate-live-config.js` writes at build time
 * to `electron/services/novalink/liveConfig.generated.js`. The real generated
 * file is gitignored; copy this shape into place only for local experimentation
 * and remember the loader falls back to `process.env.NOVALINK_LIVE_URL` in dev.
 */
module.exports = { baseUrl: 'https://link.your-domain.example' };
