// @vitest-environment node
'use strict';
/**
 * Tests for the Classroom Monitor server-side modules:
 * - admin.js: class CRUD, enrollment, activity storage
 * - adminHub.js: WS frame routing (identify, activity.report, subscribe)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
const path = require('path');
const fs = require('fs');
const os = require('os');

const { openDatabase } = require('../../link-server/db');
const { createAccounts } = require('../../link-server/accounts');
const { createRateLimiter } = require('../../link-server/rateLimit');
const { createAdmin, generateJoinCode } = require('../../link-server/admin');
const { createAdminHub } = require('../../link-server/adminHub');

let tmpDir;
let store;
let admin;
let adminHub;
let accounts;
let config;
let limiter;
let mockHub;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'classroom-test-'));
  config = {
    host: '127.0.0.1', port: 0, isLoopback: true, dataDir: tmpDir,
    dbFile: path.join(tmpDir, 'test.sqlite'), filesDir: tmpDir, tmpDir,
    serverSecret: 'test-secret', trustProxy: false, tls: null,
    insecurePlaintextAllowed: true, registrationOpen: true, inviteCode: '',
    passwordMinLength: 12, sessionTtlMs: 30 * 24 * 3600 * 1000,
    limits: { maxJsonBytes: 65536, maxMessageChars: 8000, maxFileBytes: 1048576, maxAvatarBytes: 2097152, maxFrameBytes: 1048576, pageSizeDefault: 50, pageSizeMax: 200, searchResultsMax: 100, groupMembersMax: 16, attachmentsPerMessage: 8, attachmentTtlMs: 2592000000 },
    rateLimits: { generalPerMin: 10000, authPerMin: 10000, messagePerMin: 10000, uploadPerMin: 10000, upgradePerMin: 10000, authFailLimit: 100, authFailWindowMs: 60000 },
    rtc: { iceServers: [], turnConfigured: false, callTimeoutMs: 45000 },
    presence: { pingMs: 20000, deadMs: 60000, awayMinutes: 10 },
    logLevel: 'silent', corsOrigin: '', hostname: 'test',
    adminBootstrapUsername: 'teacher',
    adminRetentionHours: 24,
  };
  store = openDatabase({ filePath: config.dbFile, logger: { info() {}, warn() {}, error() {}, debug() {} } });
  limiter = createRateLimiter({ config, logger: console });
  accounts = createAccounts({ store, config, logger: { info() {}, warn() {}, error() {}, debug() {} }, limiter });
  admin = createAdmin({ store, accounts, config, logger: { info() {}, warn() {}, error() {}, debug() {} } });

  // Mock hub for adminHub
  const sent = [];
  mockHub = {
    sendTo: (userId, event) => { sent.push({ userId, event }); return 1; },
    _sent: sent,
  };
  adminHub = createAdminHub({
    store, admin, hub: mockHub, accounts,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  });
});

afterEach(() => {
  store.close();
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup: on Windows the SQLite handle can linger for a
    // tick after close(). Vitest's temp-scan will sweep it up.
  }
});

describe('generateJoinCode', () => {
  it('produces 6-char uppercase alphanumeric codes', () => {
    for (let i = 0; i < 20; i++) {
      const code = generateJoinCode();
      expect(code).toMatch(/^[A-Z2-9]{6}$/);
    }
  });
});

describe('admin.js — class CRUD', () => {
  let teacherId;

  beforeEach(() => {
    const result = accounts.register({ username: 'teacher', password: 'Xk9mR2vLp8nQ' });
    teacherId = result.user.id;
  });

  it('creates a class with a unique join code', () => {
    const cls = admin.createClass({ teacherId, name: 'Period 1 CS' });
    expect(cls.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(cls.joinCode).toHaveLength(6);
    expect(cls.name).toBe('Period 1 CS');
  });

  it('lists classes for the teacher', () => {
    admin.createClass({ teacherId, name: 'A' });
    admin.createClass({ teacherId, name: 'B' });
    const list = admin.listClasses(teacherId);
    expect(list).toHaveLength(2);
    expect(list.map((c) => c.name).sort()).toEqual(['A', 'B']);
  });

  it('rejects non-admin users from creating classes', () => {
    const student = accounts.register({ username: 'student', password: 'studentpass99' });
    expect(() => admin.createClass({ teacherId: student.user.id, name: 'Hack' }))
      .toThrow(/administrator/i);
  });

  it('deletes a class and its enrollments', () => {
    const cls = admin.createClass({ teacherId, name: 'Temp' });
    const student = accounts.register({ username: 'temp-student', password: 'studentpass99' });
    admin.enroll({ userId: student.user.id, joinCode: cls.joinCode });
    admin.deleteClass({ teacherId, classId: cls.id });
    expect(admin.getClass(cls.id)).toBeNull();
    expect(admin.getEnrollmentForUser(student.user.id)).toHaveLength(0);
  });
});

describe('admin.js — enrollment', () => {
  let teacherId, cls;

  beforeEach(() => {
    const result = accounts.register({ username: 'teacher', password: 'Xk9mR2vLp8nQ' });
    teacherId = result.user.id;
    cls = admin.createClass({ teacherId, name: 'Test Class' });
  });

  it('enrolls a student via join code', () => {
    const student = accounts.register({ username: 'alice', password: 'studentpass99' });
    const enrollment = admin.enroll({ userId: student.user.id, joinCode: cls.joinCode, deviceLabel: 'laptop-1' });
    expect(enrollment.classId).toBe(cls.id);
    expect(enrollment.className).toBe('Test Class');
    expect(enrollment.enrollmentId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('rejects invalid join codes', () => {
    const student = accounts.register({ username: 'bob', password: 'studentpass99' });
    expect(() => admin.enroll({ userId: student.user.id, joinCode: 'XXXXXX' }))
      .toThrow(/No class matches/i);
  });

  it('is idempotent (re-enroll updates device label)', () => {
    const student = accounts.register({ username: 'carol', password: 'studentpass99' });
    admin.enroll({ userId: student.user.id, joinCode: cls.joinCode, deviceLabel: 'old' });
    admin.enroll({ userId: student.user.id, joinCode: cls.joinCode, deviceLabel: 'new' });
    const enrollments = admin.getEnrollmentForUser(student.user.id);
    expect(enrollments).toHaveLength(1);
  });

  it('unenrolls a student', () => {
    const student = accounts.register({ username: 'dave', password: 'studentpass99' });
    const enrollment = admin.enroll({ userId: student.user.id, joinCode: cls.joinCode });
    admin.unenroll({ userId: student.user.id, enrollmentId: enrollment.enrollmentId });
    expect(admin.getEnrollmentForUser(student.user.id)).toHaveLength(0);
  });
});

describe('admin.js — activity events', () => {
  let teacherId, cls, enrollmentId, studentId;

  beforeEach(() => {
    const result = accounts.register({ username: 'teacher', password: 'Xk9mR2vLp8nQ' });
    teacherId = result.user.id;
    cls = admin.createClass({ teacherId, name: 'Events' });
    const student = accounts.register({ username: 'eve', password: 'studentpass99' });
    studentId = student.user.id;
    const enrollment = admin.enroll({ userId: studentId, joinCode: cls.joinCode });
    enrollmentId = enrollment.enrollmentId;
  });

  it('stores and retrieves events', () => {
    admin.storeEvent({ enrollmentId, eventType: 'editor.snapshot', payload: { path: 'a.js', content: 'hello' } });
    admin.storeEvent({ enrollmentId, eventType: 'terminal.command', payload: { command: 'ls -la' } });
    const events = admin.getEvents({ teacherId, classId: cls.id, since: 0 });
    expect(events).toHaveLength(2);
    expect(events[0].eventType).toBe('terminal.command'); // DESC order
    expect(events[1].payload.path).toBe('a.js');
  });

  it('rejects unknown event types', () => {
    expect(() => admin.storeEvent({ enrollmentId, eventType: 'invalid.type', payload: {} }))
      .toThrow(/Event type must be/i);
  });

  it('prunes events older than retention window', () => {
    admin.storeEvent({ enrollmentId, eventType: 'app.focus', payload: { focused: true } });
    // Manually backdate
    store.run('UPDATE activity_events SET created_at_ms = ? WHERE enrollment_id = ?', Date.now() - 25 * 3600 * 1000, enrollmentId);
    const pruned = admin.pruneEvents();
    expect(pruned).toBe(1);
    const events = admin.getEvents({ teacherId, classId: cls.id, since: 0 });
    expect(events).toHaveLength(0);
  });
});

describe('adminHub.js — WS frame routing', () => {
  let teacherId, cls, studentId, enrollmentId;

  function makeRecord(userId, sessionId) {
    const sent = [];
    return {
      userId, session: { id: sessionId, userId },
      link: { send: (msg) => sent.push(msg), close() {} },
      _sent: sent,
    };
  }

  beforeEach(() => {
    const result = accounts.register({ username: 'teacher', password: 'Xk9mR2vLp8nQ' });
    teacherId = result.user.id;
    cls = admin.createClass({ teacherId, name: 'Hub Test' });
    const student = accounts.register({ username: 'frank', password: 'studentpass99' });
    studentId = student.user.id;
    const enrollment = admin.enroll({ userId: studentId, joinCode: cls.joinCode });
    enrollmentId = enrollment.enrollmentId;
  });

  it('classroom.identify links a student socket', () => {
    const record = makeRecord(studentId, 'sess-1');
    const handlers = adminHub.frameHandlers();
    handlers['classroom.identify'](record, { enrollmentId, classId: cls.id });
    expect(record._sent[0].type).toBe('classroom.identified');
    expect(adminHub.studentClass.get('sess-1')).toEqual({ enrollmentId, classId: cls.id });
  });

  it('rejects identify for wrong enrollment', () => {
    const record = makeRecord(studentId, 'sess-2');
    const handlers = adminHub.frameHandlers();
    expect(() => handlers['classroom.identify'](record, { enrollmentId: 'fake-id', classId: cls.id }))
      .toThrow(/uuid/i);
  });

  it('activity.report stores event and notifies teacher', () => {
    const record = makeRecord(studentId, 'sess-3');
    const handlers = adminHub.frameHandlers();
    handlers['classroom.identify'](record, { enrollmentId, classId: cls.id });
    mockHub._sent.length = 0;
    handlers['activity.report'](record, { eventType: 'editor.snapshot', payload: { path: 'x.js' } });
    expect(mockHub._sent.length).toBe(1);
    expect(mockHub._sent[0].userId).toBe(teacherId);
    expect(mockHub._sent[0].event.type).toBe('admin.event');
    expect(mockHub._sent[0].event.eventType).toBe('editor.snapshot');
  });

  it('admin.subscribe validates admin role', () => {
    const record = makeRecord(studentId, 'sess-4'); // student, not admin
    const handlers = adminHub.frameHandlers();
    expect(() => handlers['admin.subscribe'](record, { classId: cls.id }))
      .toThrow(/Only admin/i);
  });

  it('onSocketClosed cleans up maps', () => {
    const record = makeRecord(studentId, 'sess-5');
    const handlers = adminHub.frameHandlers();
    handlers['classroom.identify'](record, { enrollmentId, classId: cls.id });
    expect(adminHub.studentClass.has('sess-5')).toBe(true);
    adminHub.onSocketClosed(record);
    expect(adminHub.studentClass.has('sess-5')).toBe(false);
  });
});
