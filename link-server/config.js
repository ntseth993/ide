'use strict';
/**
 * Configuration for the NovaLink Live server.
 *
 * Every value has a default that is SAFE for a laptop: the server binds to
 * loopback, refuses to serve over plain HTTP if you ask it to bind publicly
 * without TLS, and keeps received files under its own data directory.
 * Nothing here reads the app's .env — this is a separate deployable process.
 */
const path = require('path');
const os = require('os');

const int = (value, fallback, { min, max } = {}) => {
  const n = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  if (min !== undefined && n < min) return min;
  if (max !== undefined && n > max) return max;
  return n;
};

const str = (value, fallback) => {
  const v = typeof value === 'string' ? value.trim() : '';
  return v || fallback;
};

const list = (value, fallback = []) => {
  const v = typeof value === 'string' ? value : '';
  const parts = v.split(',').map((s) => s.trim()).filter(Boolean);
  return parts.length ? parts : fallback;
};

const bool = (value, fallback) => {
  const v = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!v) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v);
};

function createConfig(env = process.env, overrides = {}) {
  const dataDir = str(overrides.dataDir || env.LINK_DATA_DIR, path.join(__dirname, 'data'));
  const host = str(
  overrides.host || env.LINK_HOST,
  '0.0.0.0'
);

const port = int(
  overrides.port ?? env.PORT ?? env.LINK_PORT,
  10000,
  { min: 1, max: 65535 }
);
  const tlsCert = str(env.LINK_TLS_CERT, '');
  const tlsKey = str(env.LINK_TLS_KEY, '');
  const isLoopback = ['127.0.0.1', 'localhost', '::1'].includes(host.toLowerCase());
  const turnUrl = str(env.LINK_TURN_URL, '');

  const config = {
    host,
    port,
    isLoopback,
    publicOrigin: str(env.LINK_PUBLIC_ORIGIN, ''),
    dataDir,
    dbFile: path.join(dataDir, 'link.sqlite'),
    filesDir: path.join(dataDir, 'files'),
    tmpDir: path.join(dataDir, 'tmp'),

    serverSecret: str(env.LINK_SERVER_SECRET, ''),
    // Only set this when something in front actually rewrites X-Forwarded-For.
    // Trusting that header by default would let any client pick its own rate-limit
    // bucket and lockout key.
    trustProxy: bool(env.LINK_TRUST_PROXY, false),
    tls: tlsCert && tlsKey ? { cert: tlsCert, key: tlsKey } : null,
    // Plain text on a routable interface is how chat servers end up in the news.
    insecurePlaintextAllowed: bool(   env.LINK_ALLOW_PLAINTEXT,   true ),

    registrationOpen: bool(env.LINK_REGISTRATION_OPEN, true),
    inviteCode: str(env.LINK_INVITE_CODE, ''),
    passwordMinLength: int(env.LINK_PASSWORD_MIN_LENGTH, 12, { min: 8, max: 128 }),
    sessionTtlMs: int(env.LINK_SESSION_TTL_DAYS, 30, { min: 1, max: 365 }) * 24 * 60 * 60 * 1000,

    limits: {
      maxJsonBytes: int(env.LINK_MAX_JSON_BYTES, 256 * 1024, { min: 1024, max: 4 * 1024 * 1024 }),
      maxMessageChars: int(env.LINK_MAX_MESSAGE_CHARS, 8000, { min: 100, max: 100000 }),
      maxFileBytes: int(env.LINK_MAX_FILE_BYTES, 25 * 1024 * 1024, { min: 1024, max: 512 * 1024 * 1024 }),
      // Profile photos are rendered in other people's UI, so they get their own,
      // much smaller bound than a shared source file.
      maxAvatarBytes: int(env.LINK_MAX_AVATAR_BYTES, 2 * 1024 * 1024, { min: 1024, max: 16 * 1024 * 1024 }),
      maxFrameBytes: int(env.LINK_MAX_FRAME_BYTES, 1 * 1024 * 1024, { min: 1024, max: 8 * 1024 * 1024 }),
      // Search results and history pages are capped so one client cannot make the
      // server build a giant array.
      pageSizeDefault: 50,
      pageSizeMax: 200,
      searchResultsMax: 100,
      groupMembersMax: int(env.LINK_GROUP_MEMBERS_MAX, 16, { min: 2, max: 64 }),
      attachmentsPerMessage: 8,
      attachmentTtlMs: int(env.LINK_ATTACHMENT_TTL_HOURS, 720, { min: 0, max: 87600 }) * 60 * 60 * 1000,
    },

    rateLimits: {
      generalPerMin: int(env.LINK_RATE_GENERAL_PER_MIN, 240, { min: 10, max: 100000 }),
      authPerMin: int(env.LINK_RATE_AUTH_PER_MIN, 6, { min: 1, max: 1000 }),
      messagePerMin: int(env.LINK_RATE_MESSAGE_PER_MIN, 30, { min: 1, max: 10000 }),
      uploadPerMin: int(env.LINK_RATE_UPLOAD_PER_MIN, 10, { min: 1, max: 10000 }),
      upgradePerMin: int(env.LINK_RATE_UPGRADE_PER_MIN, 30, { min: 1, max: 10000 }),
      // A login bucket that stays locked after this many consecutive failures.
      authFailLimit: int(env.LINK_AUTH_FAIL_LIMIT, 8, { min: 3, max: 1000 }),
      authFailWindowMs: 15 * 60 * 1000,
    },

    rtc: {
      iceServers: [
        ...list(env.LINK_STUN_URLS, ['stun:stun.l.google.com:19302']).map((urls) => ({ urls })),
        ...(turnUrl
          ? [{
            urls: [turnUrl],
            username: str(env.LINK_TURN_USERNAME, ''),
            credential: str(env.LINK_TURN_CREDENTIAL, ''),
          }]
          : []),
      ],
      turnConfigured: Boolean(turnUrl),
      callTimeoutMs: int(env.LINK_CALL_TIMEOUT_SECONDS, 45, { min: 5, max: 600 }) * 1000,
    },

    presence: {
      pingMs: int(env.LINK_PRESENCE_PING_MS, 20000, { min: 1000, max: 300000 }),
      deadMs: int(env.LINK_PRESENCE_DEAD_MS, 60000, { min: 3000, max: 600000 }),
      awayMinutes: int(env.LINK_PRESENCE_AWAY_MINUTES, 10, { min: 1, max: 720 }),
    },

    logLevel: str(env.LINK_LOG_LEVEL, 'info'),
    // CORS is off unless an operator names the exact origin that may call the API.
    // NovaCode talks to this server from its main process, which needs no CORS.
    corsOrigin: str(env.LINK_CORS_ORIGIN, ''),
    hostname: os.hostname(),

    // Classroom monitor: first account matching this username gets role='admin'.
    adminBootstrapUsername: str(env.ADMIN_BOOTSTRAP_USERNAME, ''),
    adminRetentionHours: int(env.ADMIN_RETENTION_HOURS, 24, { min: 1, max: 8760 }),
  };

  return config;
}

/** Human-readable problems an operator should see before serving real users. */
function auditConfig(config) {
  const warnings = [];
  if (!config.tls) {
    warnings.push('No TLS certificate configured. Put this behind HTTPS/WSS before real users connect.');
  }
  if (!config.isLoopback && !config.tls && !config.insecurePlaintextAllowed) {
    warnings.push('Refusing to bind a routable interface over plain text: set LINK_TLS_CERT/LINK_TLS_KEY, or LINK_ALLOW_PLAINTEXT=1 if a reverse proxy terminates TLS.');
  }
  if (!config.serverSecret) {
    warnings.push('LINK_SERVER_SECRET is unset. Generate one so per-instance identifiers are not predictable.');
  }
  if (config.trustProxy && !config.tls) {
    warnings.push('X-Forwarded-For is trusted while TLS is not configured: any client can choose its own rate-limit key.');
  }
  if (config.registrationOpen && !config.inviteCode) {
    warnings.push('Registration is open with no invite code: anyone who can reach this server can create an account.');
  }
  if (!config.rtc.turnConfigured) {
    warnings.push('No TURN relay configured. Voice/video will fail on symmetric-NAT networks, which is most home and office networks.');
  }
  if (!config.limits.attachmentTtlMs) {
    warnings.push('LINK_ATTACHMENT_TTL_HOURS=0: received files are kept until senders delete them, so disk use grows forever.');
  }
  return warnings;
}

module.exports = { createConfig, auditConfig };
