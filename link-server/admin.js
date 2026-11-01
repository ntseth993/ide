'use strict';
/**
 * Classroom Monitor: admin REST endpoints + enrollment logic.
 *
 * All routes here require `role === 'admin'` (checked via `accounts.isAdmin`).
 * A teacher creates classes, gets join codes, and subscribes to student activity.
 * Students enroll by submitting a join code — after that their activity events
 * flow through the WebSocket hub to the teacher's dashboard.
 */
const crypto = require('crypto');
const { ApiError, text } = require('./validate');

/** Generate a 6-char uppercase alphanumeric join code. */
function generateJoinCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1 to avoid confusion
  const bytes = crypto.randomBytes(6);
  return Array.from(bytes, (b) => chars[b % chars.length]).join('');
}

function createAdmin({ store, accounts, config, logger, now = Date.now }) {
  // ---------------------------------------------------------------------------
  // Guards
  // ---------------------------------------------------------------------------

  function requireAdmin(userId) {
    if (!accounts.isAdmin(userId)) {
      throw new ApiError(403, 'admin_required', 'This endpoint requires an administrator account.');
    }
  }

  // ---------------------------------------------------------------------------
  // Classes CRUD
  // ---------------------------------------------------------------------------

  function createClass({ teacherId, name }) {
    requireAdmin(teacherId);
    const className = text(name, { field: 'class name', max: 120 });
    const id = crypto.randomUUID();
    // Ensure uniqueness by retrying on collision (astronomically unlikely with 32^6)
    let joinCode;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      joinCode = generateJoinCode();
      const existing = store.get('SELECT id FROM classes WHERE join_code = ?', joinCode);
      if (!existing) break;
      if (attempt === 9) throw new ApiError(500, 'code_collision', 'Failed to generate a unique join code. Try again.');
    }
    store.run(
      'INSERT INTO classes (id, teacher_user_id, name, join_code, created_at_ms) VALUES (?, ?, ?, ?, ?)',
      id, teacherId, className, joinCode, now(),
    );
    logger.info?.('class created', { classId: id, teacherId, name: className });
    return { id, teacherId, name: className, joinCode, createdAt: now() };
  }

  function listClasses(teacherId) {
    requireAdmin(teacherId);
    return store.all(
      'SELECT id, teacher_user_id, name, join_code, created_at_ms FROM classes WHERE teacher_user_id = ? ORDER BY created_at_ms DESC',
      teacherId,
    ).map((row) => ({
      id: row.id,
      name: row.name,
      joinCode: row.join_code,
      createdAt: Number(row.created_at_ms),
      studentCount: Number(store.get('SELECT COUNT(*) AS n FROM enrollments WHERE class_id = ?', row.id).n),
    }));
  }

  function deleteClass({ teacherId, classId }) {
    requireAdmin(teacherId);
    const cls = store.get('SELECT id, teacher_user_id FROM classes WHERE id = ?', classId);
    if (!cls) throw new ApiError(404, 'no_such_class', 'Class not found.');
    if (cls.teacher_user_id !== teacherId) throw new ApiError(403, 'not_yours', 'You do not own this class.');
    store.run('DELETE FROM classes WHERE id = ?', classId);
    logger.info?.('class dissolved', { classId, teacherId });
    return { ok: true };
  }

  function getClass(classId) {
    const row = store.get('SELECT id, teacher_user_id, name, join_code, created_at_ms FROM classes WHERE id = ?', classId);
    if (!row) return null;
    return { id: row.id, teacherId: row.teacher_user_id, name: row.name, joinCode: row.join_code, createdAt: Number(row.created_at_ms) };
  }

  // ---------------------------------------------------------------------------
  // Enrollment
  // ---------------------------------------------------------------------------

  function enroll({ userId, joinCode, deviceLabel }) {
    const code = String(joinCode || '').trim().toUpperCase();
    if (code.length !== 6) throw new ApiError(400, 'bad_code', 'Join code must be 6 characters.');
    const cls = store.get('SELECT id, teacher_user_id, name FROM classes WHERE join_code = ?', code);
    if (!cls) throw new ApiError(404, 'no_such_class', 'No class matches that join code.');

    const id = crypto.randomUUID();
    const timestamp = now();
    const label = text(deviceLabel, { field: 'device label', max: 60, required: false }) || 'device';

    store.run(
      `INSERT INTO enrollments (id, class_id, student_user_id, device_label, enrolled_at_ms, last_seen_ms)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(class_id, student_user_id) DO UPDATE SET device_label = excluded.device_label, last_seen_ms = excluded.last_seen_ms`,
      id, cls.id, userId, label, timestamp, timestamp,
    );
    const enrollment = store.get('SELECT id FROM enrollments WHERE class_id = ? AND student_user_id = ?', cls.id, userId);
    logger.info?.('student enrolled', { enrollmentId: enrollment.id, classId: cls.id, userId });
    return {
      enrollmentId: enrollment.id,
      classId: cls.id,
      className: cls.name,
      teacherId: cls.teacher_user_id,
    };
  }

  function unenroll({ userId, enrollmentId }) {
    const row = store.get('SELECT id, student_user_id FROM enrollments WHERE id = ?', enrollmentId);
    if (!row) throw new ApiError(404, 'no_such_enrollment', 'Enrollment not found.');
    if (row.student_user_id !== userId) throw new ApiError(403, 'not_yours', 'This is not your enrollment.');
    store.run('DELETE FROM enrollments WHERE id = ?', enrollmentId);
    logger.info?.('student unenrolled', { enrollmentId, userId });
    return { ok: true };
  }

  function getEnrollmentForUser(userId) {
    const rows = store.all(
      `SELECT e.id, e.class_id, e.device_label, e.enrolled_at_ms, e.last_seen_ms, c.name, c.teacher_user_id
         FROM enrollments e JOIN classes c ON c.id = e.class_id
        WHERE e.student_user_id = ?`,
      userId,
    );
    return rows.map((r) => ({
      enrollmentId: r.id,
      classId: r.class_id,
      className: r.name,
      teacherId: r.teacher_user_id,
      deviceLabel: r.device_label,
      enrolledAt: Number(r.enrolled_at_ms),
      lastSeenAt: Number(r.last_seen_ms),
    }));
  }

  function listStudents(teacherId, classId) {
    requireAdmin(teacherId);
    const cls = store.get('SELECT id FROM classes WHERE id = ? AND teacher_user_id = ?', classId, teacherId);
    if (!cls) throw new ApiError(404, 'no_such_class', 'Class not found or not yours.');
    return store.all(
      `SELECT e.id, e.student_user_id, e.device_label, e.enrolled_at_ms, e.last_seen_ms,
              u.username, u.display_name
         FROM enrollments e JOIN users u ON u.id = e.student_user_id
        WHERE e.class_id = ? AND u.deleted_at_ms IS NULL
        ORDER BY u.display_name ASC`,
      classId,
    ).map((row) => ({
      enrollmentId: row.id,
      studentId: row.student_user_id,
      username: row.username,
      displayName: row.display_name,
      deviceLabel: row.device_label,
      enrolledAt: Number(row.enrolled_at_ms),
      lastSeenAt: Number(row.last_seen_ms),
    }));
  }

  // ---------------------------------------------------------------------------
  // Activity events
  // ---------------------------------------------------------------------------

  function storeEvent({ enrollmentId, eventType, payload }) {
    const validTypes = ['editor.snapshot', 'file.open', 'file.rename', 'terminal.command', 'ai.prompt', 'app.focus'];
    if (!validTypes.includes(eventType)) {
      throw new ApiError(400, 'bad_event_type', `Event type must be one of: ${validTypes.join(', ')}`);
    }
    const body = typeof payload === 'string' ? payload : JSON.stringify(payload || {});
    store.run(
      'INSERT INTO activity_events (enrollment_id, event_type, payload, created_at_ms) VALUES (?, ?, ?, ?)',
      enrollmentId, eventType, body, now(),
    );
    // Touch last_seen on the enrollment
    store.run('UPDATE enrollments SET last_seen_ms = ? WHERE id = ?', now(), enrollmentId);
  }

  function getEvents({ teacherId, classId, since, limit = 200 }) {
    requireAdmin(teacherId);
    const cls = store.get('SELECT id FROM classes WHERE id = ? AND teacher_user_id = ?', classId, teacherId);
    if (!cls) throw new ApiError(404, 'no_such_class', 'Class not found or not yours.');
    const capped = Math.min(Number(limit) || 200, 500);
    const sinceTs = Number(since) || 0;
    return store.all(
      `SELECT ae.id, ae.enrollment_id, ae.event_type, ae.payload, ae.created_at_ms,
              e.student_user_id, u.username, u.display_name
         FROM activity_events ae
         JOIN enrollments e ON e.id = ae.enrollment_id
         JOIN users u ON u.id = e.student_user_id
        WHERE e.class_id = ? AND ae.created_at_ms > ?
        ORDER BY ae.created_at_ms DESC
        LIMIT ?`,
      classId, sinceTs, capped,
    ).map((row) => ({
      id: Number(row.id),
      enrollmentId: row.enrollment_id,
      studentId: row.student_user_id,
      studentName: row.display_name,
      username: row.username,
      eventType: row.event_type,
      payload: JSON.parse(row.payload),
      timestamp: Number(row.created_at_ms),
    }));
  }

  /** Prune events older than config.adminRetentionHours. Called on startup + periodically. */
  function pruneEvents() {
    const cutoff = now() - config.adminRetentionHours * 60 * 60 * 1000;
    const result = store.run('DELETE FROM activity_events WHERE created_at_ms < ?', cutoff);
    if (result.changes) logger.info?.('pruned old activity events', { removed: result.changes, cutoff: new Date(cutoff).toISOString() });
    return result.changes || 0;
  }

  // ---------------------------------------------------------------------------
  // Route registration helper (called from routes.js or server.js)
  // ---------------------------------------------------------------------------

  function registerRoutes(router) {
    router.add('POST', '/api/admin/classes', async (ctx) => {
      const user = await ctx.requireUser();
      return { status: 201, body: createClass({ teacherId: user.id, name: ctx.body.name }) };
    });

    router.add('GET', '/api/admin/classes', async (ctx) => {
      const user = await ctx.requireUser();
      return { items: listClasses(user.id) };
    });

    router.add('DELETE', '/api/admin/classes/:id', async (ctx) => {
      const user = await ctx.requireUser();
      return deleteClass({ teacherId: user.id, classId: ctx.params.id });
    });

    router.add('GET', '/api/admin/classes/:id/students', async (ctx) => {
      const user = await ctx.requireUser();
      return { items: listStudents(user.id, ctx.params.id) };
    });

    router.add('GET', '/api/admin/classes/:id/events', async (ctx) => {
      const user = await ctx.requireUser();
      return { items: getEvents({ teacherId: user.id, classId: ctx.params.id, since: ctx.query.since, limit: ctx.query.limit }) };
    });

    router.add('POST', '/api/admin/enroll', async (ctx) => {
      const user = await ctx.requireUser();
      return { status: 201, body: enroll({ userId: user.id, joinCode: ctx.body.joinCode, deviceLabel: ctx.body.deviceLabel }) };
    });

    router.add('DELETE', '/api/admin/enroll/:id', async (ctx) => {
      const user = await ctx.requireUser();
      return unenroll({ userId: user.id, enrollmentId: ctx.params.id });
    });

    router.add('GET', '/api/admin/my-enrollments', async (ctx) => {
      const user = await ctx.requireUser();
      return { items: getEnrollmentForUser(user.id) };
    });
  }

  return {
    requireAdmin,
    createClass,
    listClasses,
    deleteClass,
    getClass,
    enroll,
    unenroll,
    getEnrollmentForUser,
    listStudents,
    storeEvent,
    getEvents,
    pruneEvents,
    registerRoutes,
    generateJoinCode,
  };
}

module.exports = { createAdmin, generateJoinCode };
