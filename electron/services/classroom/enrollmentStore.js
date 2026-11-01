'use strict';
/**
 * Classroom enrollment store.
 *
 * Persists the student's enrollment state (class ID, teacher name, join code)
 * in the OS secret store so it survives app restarts. Exposes a simple API
 * the IPC layer and activity reporter consume.
 *
 * The enrollment is stored under the secret name `novalink-classroom` as a
 * JSON string. The secret store encrypts it at rest via Electron safeStorage.
 */
const SECRET_NAME = 'novalink-classroom';

function createEnrollmentStore({ secretStore, logger }) {
  /** @type {{classId, enrollmentId, teacherId, className, joinCode, enrolledAt}|null} */
  let cached = null;
  let loaded = false;

  async function load() {
    if (loaded) return cached;
    try {
      const raw = await secretStore.getSecret(SECRET_NAME);
      cached = raw ? JSON.parse(raw) : null;
    } catch (error) {
      logger.warn?.('failed to read classroom enrollment', { error: error.message });
      cached = null;
    }
    loaded = true;
    return cached;
  }

  async function save(enrollment) {
    cached = enrollment;
    loaded = true;
    if (enrollment) {
      await secretStore.setSecret(SECRET_NAME, JSON.stringify(enrollment));
    } else {
      await secretStore.clearSecret(SECRET_NAME);
    }
  }

  /** Check if this device is currently enrolled in a class. */
  async function isEnrolled() {
    const enrollment = await load();
    return Boolean(enrollment && enrollment.enrollmentId);
  }

  /** Get the current enrollment state (null if not enrolled). */
  async function getStatus() {
    return await load();
  }

  /**
   * Enroll in a class via join code. Calls the link-server REST API through
   * the existing liveClient HTTP layer.
   * @param {string} joinCode - 6-char code from the teacher
   * @param {string} deviceLabel - optional label for this machine
   * @param {object} client - the liveClient instance (has .request() for REST calls)
   */
  async function enroll(joinCode, deviceLabel, client) {
    const code = String(joinCode || '').trim().toUpperCase();
    if (code.length !== 6) {
      throw new Error('Join code must be exactly 6 characters.');
    }
    if (!client) throw new Error('NovaLink is not connected.');

    const response = await client.request('POST', '/api/admin/enroll', {
      joinCode: code,
      deviceLabel: deviceLabel || require('os').hostname(),
    });

    const enrollment = {
      enrollmentId: response.enrollmentId,
      classId: response.classId,
      className: response.className,
      teacherId: response.teacherId,
      joinCode: code,
      enrolledAt: Date.now(),
    };
    await save(enrollment);
    logger.info?.('classroom enrolled', { enrollmentId: enrollment.enrollmentId, classId: enrollment.classId });
    return enrollment;
  }

  /** Remove the enrollment from this device. */
  async function unenroll(client) {
    const enrollment = await load();
    if (!enrollment) return { ok: true, reason: 'not enrolled' };
    try {
      if (client) {
        await client.request('DELETE', `/api/admin/enroll/${enrollment.enrollmentId}`, {});
      }
    } catch (error) {
      logger.warn?.('unenroll server call failed (clearing local anyway)', { error: error.message });
    }
    await save(null);
    logger.info?.('classroom unenrolled', { enrollmentId: enrollment.enrollmentId });
    return { ok: true };
  }

  /** Invalidate the cache (e.g. after a server event says enrollment changed). */
  function invalidate() {
    loaded = false;
    cached = null;
  }

  return {
    isEnrolled,
    getStatus,
    enroll,
    unenroll,
    invalidate,
    load,
  };
}

module.exports = { createEnrollmentStore, SECRET_NAME };
