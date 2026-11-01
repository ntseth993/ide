'use strict';
/**
 * Rate limiting and authentication lockouts.
 *
 * Why this is not just "requests per minute": a chat server has four different
 * abuse shapes.
 *
 *   - anonymous endpoints (register/login)  -> credential stuffing
 *   - authenticated writes (messages)       -> spam / disk exhaustion
 *   - uploads                               -> storage exhaustion
 *   - the socket itself                     -> event flood
 *
 * Each gets its own bucket so blocking spam does not block reading, and every
 * bucket is keyed on the *remote identity* the server actually knows (a session
 * id, or the socket address) rather than a client-supplied user id.
 *
 * Buckets are held in memory and pruned: a hostile client rotating source
 * addresses must not be able to grow this Map without bound.
 */
const BUCKETS = {
  general: { capacity: 240, windowMs: 60_000 },
  auth: { capacity: 6, windowMs: 60_000 },
  message: { capacity: 30, windowMs: 60_000 },
  upload: { capacity: 10, windowMs: 60_000 },
  // Opening a socket is cheaper for an attacker than sending a message, so the
  // rate at which one address may create connections is its own bucket.
  upgrade: { capacity: 30, windowMs: 60_000 },
  events: { capacity: 120, windowMs: 60_000 },
};

const MAX_BUCKETS = 50_000;

function createRateLimiter({ config, logger = console, now = Date.now } = {}) {
  const limits = { ...BUCKETS };
  if (config?.rateLimits) {
    limits.general.capacity = config.rateLimits.generalPerMin;
    limits.auth.capacity = config.rateLimits.authPerMin;
    limits.message.capacity = config.rateLimits.messagePerMin;
    limits.upload.capacity = config.rateLimits.uploadPerMin;
    limits.upgrade.capacity = config.rateLimits.upgradePerMin;
  }

  const buckets = new Map(); // "bucket|key" -> { tokens, refreshedAt }
  const failures = new Map(); // "bucket|key" -> { count, firstAt, lockedUntil }

  function take(bucket, key, cost = 1) {
    const limit = limits[bucket] || limits.general;
    const id = `${bucket}|${key}`;
    const timestamp = now();
    let entry = buckets.get(id);
    if (!entry) {
      // Eviction on pressure rather than a growing leak. Oldest-refreshed first.
      if (buckets.size >= MAX_BUCKETS) {
        const oldest = [...buckets.entries()].sort((a, b) => a[1].refreshedAt - b[1].refreshedAt)[0];
        if (oldest) buckets.delete(oldest[0]);
      }
      entry = { tokens: limit.capacity, refreshedAt: timestamp };
      buckets.set(id, entry);
    }
    const elapsed = Math.max(0, timestamp - entry.refreshedAt);
    entry.tokens = Math.min(limit.capacity, entry.tokens + (elapsed / limit.windowMs) * limit.capacity);
    entry.refreshedAt = timestamp;
    if (entry.tokens < cost) {
      const needed = cost - entry.tokens;
      return { allowed: false, retryAfterMs: Math.ceil((needed / limit.capacity) * limit.windowMs) };
    }
    entry.tokens -= cost;
    return { allowed: true, remaining: Math.floor(entry.tokens) };
  }

  /**
   * Track a failed authentication so repeat attempts from one source stop being
   * cheap. Returns the lockout when one tripped.
   */
  function recordFailure(key, { limit = 8, windowMs = 15 * 60_000 } = {}) {
    const timestamp = now();
    const id = `authfail|${key}`;
    const entry = failures.get(id) || { count: 0, firstAt: timestamp, lockedUntil: 0 };
    if (timestamp - entry.firstAt > windowMs) {
      entry.count = 0;
      entry.firstAt = timestamp;
    }
    entry.count += 1;
    if (entry.count >= limit) {
      entry.lockedUntil = timestamp + windowMs;
      entry.count = 0;
      entry.firstAt = timestamp + windowMs;
    }
    failures.set(id, entry);
    if (entry.lockedUntil > timestamp) return entry.lockedUntil - timestamp;
    return 0;
  }

  function lockedFor(key) {
    const entry = failures.get(`authfail|${key}`);
    if (!entry) return 0;
    return Math.max(0, entry.lockedUntil - now());
  }

  function clearFailures(key) {
    failures.delete(`authfail|${key}`);
  }

  // Buckets for addresses that stopped sending anything are noise; drop them.
  const sweeper = setInterval(() => {
    const cutoff = now() - 10 * 60_000;
    for (const [id, entry] of buckets) if (entry.refreshedAt < cutoff) buckets.delete(id);
    for (const [id, entry] of failures) if ((entry.lockedUntil || entry.firstAt) < cutoff) failures.delete(id);
  }, 60_000);
  sweeper.unref?.();

  return {
    take,
    recordFailure,
    lockedFor,
    clearFailures,
    limits,
    size: () => buckets.size,
    close: () => clearInterval(sweeper),
    logger,
  };
}

module.exports = { createRateLimiter, BUCKETS };
