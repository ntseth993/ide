'use strict';
/**
 * Classroom Monitor: WebSocket frame routing for activity reporting + live viewing.
 *
 * New frame types handled over the existing /link socket:
 *
 *   Student → Server:
 *     { type: 'classroom.identify', enrollmentId, classId }
 *       — sent once after auth to link the socket to a class enrollment.
 *     { type: 'activity.report', eventType, payload }
 *       — a single activity event from the student's IDE.
 *
 *   Teacher → Server:
 *     { type: 'admin.subscribe', classId }
 *       — start receiving live events for a class.
 *     { type: 'admin.unsubscribe' }
 *       — stop receiving.
 *     { type: 'admin.snapshot', enrollmentId }
 *       — request the latest event from a specific student immediately.
 *
 *   Server → Teacher:
 *     { type: 'admin.event', ... }
 *       — a live activity event forwarded from a student.
 *     { type: 'admin.snapshot_response', ... }
 *       — response to a snapshot request.
 *
 * Design: the hub maintains two maps:
 *   - studentClass: sessionId → { enrollmentId, classId }
 *   - adminSubs:    sessionId → classId (teacher watching this class)
 *
 * An activity.report from a student is stored + fanned out to all admin sockets
 * subscribed to that student's class.
 */
const { ApiError, requiredId, text } = require('./validate');

function createAdminHub({ store, admin, hub, accounts, logger, now = Date.now }) {
  /** @type {Map<string, {enrollmentId: string, classId: string}>} sessionId -> enrollment info */
  const studentClass = new Map();
  /** @type {Map<string, string>} sessionId -> classId (teacher subscription) */
  const adminSubs = new Map();

  // ---------------------------------------------------------------------------
  // Frame handlers (called from events.js onEvent dispatch)
  // ---------------------------------------------------------------------------

  function handleIdentify(record, message) {
    const enrollmentId = requiredId(message.enrollmentId, 'enrollment id');
    const classId = requiredId(message.classId, 'class id');
    // Verify the enrollment belongs to this user
    const row = store.get('SELECT id, class_id, student_user_id FROM enrollments WHERE id = ?', enrollmentId);
    if (!row || row.student_user_id !== record.userId) {
      throw new ApiError(403, 'invalid_enrollment', 'This enrollment does not belong to you.');
    }
    if (row.class_id !== classId) {
      throw new ApiError(400, 'class_mismatch', 'Enrollment and class id do not match.');
    }
    studentClass.set(record.session.id, { enrollmentId, classId });
    record.link.send({ type: 'classroom.identified', enrollmentId, classId, ok: true });
    logger.debug?.('student identified for classroom', { userId: record.userId, enrollmentId, classId });
  }

  function handleActivityReport(record, message) {
    const enrollment = studentClass.get(record.session.id);
    if (!enrollment) {
      throw new ApiError(400, 'not_enrolled', 'Send classroom.identify before reporting activity.');
    }
    const eventType = text(message.eventType, { field: 'event type', max: 60 });
    const payload = message.payload || {};
    // Store the event
    admin.storeEvent({ enrollmentId: enrollment.enrollmentId, eventType, payload });
    // Fan out to subscribed admins
    const teacherId = store.get('SELECT c.teacher_user_id FROM classes c WHERE c.id = ?', enrollment.classId)?.teacher_user_id;
    if (teacherId) {
      const user = accounts.rowToUser(accounts.findUserById(record.userId));
      const event = {
        type: 'admin.event',
        enrollmentId: enrollment.enrollmentId,
        classId: enrollment.classId,
        studentId: record.userId,
        studentName: user?.displayName || 'Unknown',
        username: user?.username || '',
        eventType,
        payload,
        timestamp: now(),
      };
      // hub.sendTo delivers to all live sockets of the teacher
      hub.sendTo(teacherId, event);
    }
  }

  function handleAdminSubscribe(record, message) {
    const classId = requiredId(message.classId, 'class id');
    // Verify admin role and class ownership
    if (!accounts.isAdmin(record.userId)) {
      throw new ApiError(403, 'admin_required', 'Only admin accounts can subscribe to class events.');
    }
    const cls = store.get('SELECT id, teacher_user_id FROM classes WHERE id = ?', classId);
    if (!cls || cls.teacher_user_id !== record.userId) {
      throw new ApiError(404, 'no_such_class', 'Class not found or not yours.');
    }
    adminSubs.set(record.session.id, classId);
    record.link.send({ type: 'admin.subscribed', classId, ok: true });
    logger.debug?.('admin subscribed to class', { userId: record.userId, classId });
  }

  function handleAdminUnsubscribe(record) {
    adminSubs.delete(record.session.id);
    record.link.send({ type: 'admin.unsubscribed', ok: true });
  }

  function handleAdminSnapshot(record, message) {
    const enrollmentId = requiredId(message.enrollmentId, 'enrollment id');
    if (!accounts.isAdmin(record.userId)) {
      throw new ApiError(403, 'admin_required', 'Only admin accounts can request snapshots.');
    }
    // Get the latest event for this enrollment
    const latest = store.get(
      'SELECT event_type, payload, created_at_ms FROM activity_events WHERE enrollment_id = ? ORDER BY created_at_ms DESC LIMIT 1',
      enrollmentId,
    );
    record.link.send({
      type: 'admin.snapshot_response',
      enrollmentId,
      event: latest ? { eventType: latest.event_type, payload: JSON.parse(latest.payload), timestamp: Number(latest.created_at_ms) } : null,
    });
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /** Clean up maps when a socket closes. */
  function onSocketClosed(record) {
    studentClass.delete(record.session.id);
    adminSubs.delete(record.session.id);
  }

  /**
   * Returns a map of frame type → handler that events.js merges into its HANDLERS.
   */
  function frameHandlers() {
    return {
      'classroom.identify': handleIdentify,
      'activity.report': handleActivityReport,
      'admin.subscribe': handleAdminSubscribe,
      'admin.unsubscribe': handleAdminUnsubscribe,
      'admin.snapshot': handleAdminSnapshot,
    };
  }

  /** List of valid frame types this module handles (for CLIENT_EVENTS whitelist). */
  function managedEvents() {
    return ['classroom.identify', 'activity.report', 'admin.subscribe', 'admin.unsubscribe', 'admin.snapshot'];
  }

  return {
    frameHandlers,
    managedEvents,
    onSocketClosed,
    studentClass,
    adminSubs,
  };
}

module.exports = { createAdminHub };
