'use strict';
/**
 * Persistent store — Node's built-in SQLite (`node:sqlite`), no npm dependency.
 *
 * Why this file exists: NovaLink Live's promises ("messages survive a restart",
 * "the database is the source of truth", "presence is not faked") are only true
 * if rows go to disk. Everything above this layer talks SQL through the small
 * helpers here, which also enforce one hard rule of the driver:
 *
 *   SQLite cannot bind JavaScript booleans or `undefined`.
 *
 * A driver error thrown from inside a request handler would surface as a 500, so
 * `normalize()` converts booleans to 0/1 and `undefined` to NULL, and refuses
 * anything else that cannot be stored (objects, functions, symbols, NaN) rather
 * than silently coercing it into a different meaning.
 */
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

// Bumping this means writing a matching entry in MIGRATIONS below. The server
// refuses to start against a newer database than it understands.
//
// NovaLink Live has never shipped, so SCHEMA_V1 is still edited in place rather
// than padded with migrations for a database that exists nowhere: the first
// release cut is what freezes it, and this file says so on purpose.
const SCHEMA_VERSION = 1;

const SCHEMA_V1 = `
CREATE TABLE users (
  id             TEXT PRIMARY KEY,
  username       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name   TEXT NOT NULL,
  bio            TEXT NOT NULL DEFAULT '',
  avatar_id      TEXT,
  identity_key   TEXT,
  password_hash  TEXT NOT NULL,
  created_at_ms  INTEGER NOT NULL,
  last_active_ms INTEGER NOT NULL DEFAULT 0,
  deleted_at_ms  INTEGER
);

CREATE TABLE user_privacy (
  user_id                TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  presence_visible_to    TEXT NOT NULL DEFAULT 'contacts',  -- contacts | everyone | nobody
  contact_requests_from  TEXT NOT NULL DEFAULT 'everyone',  -- everyone | nobody
  appear_offline         INTEGER NOT NULL DEFAULT 0,
  show_last_active       INTEGER NOT NULL DEFAULT 1,
  read_receipts_enabled  INTEGER NOT NULL DEFAULT 1,
  calls_enabled          INTEGER NOT NULL DEFAULT 1,
  attachments_enabled    INTEGER NOT NULL DEFAULT 1,
  updated_at_ms          INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE sessions (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash     TEXT NOT NULL UNIQUE,
  device_label   TEXT NOT NULL DEFAULT '',
  created_at_ms  INTEGER NOT NULL,
  last_seen_ms   INTEGER NOT NULL DEFAULT 0,
  expires_at_ms  INTEGER NOT NULL,
  revoked_at_ms  INTEGER
);
CREATE INDEX sessions_user ON sessions(user_id);

-- Directed connection graph. Two rows per accepted pair keeps "who is my
-- contact" a single indexed lookup in either direction.
CREATE TABLE connections (
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contact_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (user_id, contact_id)
);
CREATE INDEX connections_contact ON connections(contact_id);

CREATE TABLE connection_requests (
  id             TEXT PRIMARY KEY,
  requester_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  addressee_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  state          TEXT NOT NULL DEFAULT 'pending', -- pending|accepted|rejected|canceled|blocked|expired
  note           TEXT NOT NULL DEFAULT '',        -- the requester's own words, for the addressee
  created_at_ms  INTEGER NOT NULL,
  resolved_at_ms INTEGER,
  UNIQUE (requester_id, addressee_id)
);
CREATE INDEX requests_addressee ON connection_requests(addressee_id, state);

CREATE TABLE blocks (
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (user_id, blocked_id)
);

CREATE TABLE reports (
  id           TEXT PRIMARY KEY,
  reporter_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reported_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason       TEXT NOT NULL,
  detail       TEXT NOT NULL DEFAULT '',
  state        TEXT NOT NULL DEFAULT 'open',
  created_at_ms INTEGER NOT NULL
);

CREATE TABLE conversations (
  id                TEXT PRIMARY KEY,
  kind              TEXT NOT NULL,             -- direct | group
  direct_key        TEXT UNIQUE,               -- sorted member ids, only for direct
  title             TEXT NOT NULL DEFAULT '',
  created_by        TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at_ms     INTEGER NOT NULL,
  last_message_at_ms INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE conversation_members (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role            TEXT NOT NULL DEFAULT 'member',
  joined_at_ms    INTEGER NOT NULL,
  last_read_seq   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX members_user ON conversation_members(user_id);

CREATE TABLE messages (
  id             TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  seq            INTEGER NOT NULL,
  sender_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body           TEXT NOT NULL DEFAULT '',
  language       TEXT,
  reply_to_id    TEXT,
  client_id      TEXT,
  created_at_ms  INTEGER NOT NULL,
  edited_at_ms   INTEGER,
  deleted_at_ms  INTEGER
);
CREATE UNIQUE INDEX messages_seq ON messages(conversation_id, seq);
-- A retried send must not create a second message. Only rows that carry a
-- client id participate, so partial-index semantics are exactly right here.
CREATE UNIQUE INDEX messages_client_id ON messages(conversation_id, sender_id, client_id)
  WHERE client_id IS NOT NULL;
CREATE INDEX messages_conversation_time ON messages(conversation_id, created_at_ms DESC);

CREATE TABLE reactions (
  message_id      TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji           TEXT NOT NULL,
  created_at_ms   INTEGER NOT NULL,
  PRIMARY KEY (message_id, user_id, emoji)
);

CREATE TABLE attachments (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
  uploader_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  file_name       TEXT NOT NULL,
  stored_name     TEXT NOT NULL,
  mime_type       TEXT NOT NULL,
  kind            TEXT NOT NULL,       -- image | text | document | archive
  byte_size       INTEGER NOT NULL,
  sha256          TEXT NOT NULL,
  created_at_ms   INTEGER NOT NULL,
  expires_at_ms   INTEGER,
  deleted_at_ms   INTEGER
);
CREATE INDEX attachments_conversation ON attachments(conversation_id);
CREATE INDEX attachments_expiry ON attachments(expires_at_ms);

-- Messages and attachments are linked through a join so a message can carry
-- several files and an attachment can be re-referenced without copying bytes.
CREATE TABLE message_attachments (
  message_id    TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  attachment_id TEXT NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
  PRIMARY KEY (message_id, attachment_id)
);

CREATE TABLE calls (
  id               TEXT PRIMARY KEY,
  conversation_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  initiator_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mode             TEXT NOT NULL,        -- audio | video
  state            TEXT NOT NULL DEFAULT 'ringing',
  created_at_ms    INTEGER NOT NULL,
  answered_at_ms   INTEGER,
  ended_at_ms      INTEGER,
  end_reason       TEXT NOT NULL DEFAULT ''
);
CREATE INDEX calls_conversation ON calls(conversation_id, created_at_ms DESC);

CREATE TABLE call_participants (
  call_id     TEXT NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  state       TEXT NOT NULL DEFAULT 'invited',  -- invited|joined|declined|left|missed
  joined_at_ms  INTEGER,
  left_at_ms    INTEGER,
  PRIMARY KEY (call_id, user_id)
);

CREATE TABLE presence_overrides (
  user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  status   TEXT NOT NULL,               -- online | away | busy
  since_ms INTEGER NOT NULL,
  PRIMARY KEY (user_id, device_id)
);
`;

// FTS5 is used when the bundled SQLite was compiled with it (Node's is). When it
// is not, search degrades to a LIKE scan — still correct, just slower — and the
// server logs which mode it chose instead of pretending.
const FTS_V1 = `
CREATE VIRTUAL TABLE messages_fts USING fts5(
  body,
  content='messages',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER messages_fts_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, body) VALUES (new.rowid, new.body);
END;
CREATE TRIGGER messages_fts_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, body) VALUES('delete', old.rowid, old.body);
END;
CREATE TRIGGER messages_fts_au AFTER UPDATE OF body ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, body) VALUES('delete', old.rowid, old.body);
  INSERT INTO messages_fts(rowid, body) VALUES (new.rowid, new.body);
END;
`;

const MIGRATIONS = {
  1: [SCHEMA_V1],
};

function normalize(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('cannot bind a non-finite number to SQLite');
    return value;
  }
  if (typeof value === 'string' || Buffer.isBuffer(value)) return value;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'bigint') return value;
  throw new Error(`cannot bind a ${typeof value} value to SQLite`);
}

function openDatabase({ filePath, logger = console, readonly = false } = {}) {
  const dir = path.dirname(filePath);
  if (!readonly) fs.mkdirSync(dir, { recursive: true });

  const db = new DatabaseSync(filePath, { readonly });
  db.exec('PRAGMA foreign_keys = ON');
  if (!readonly) {
    // WAL is what lets a reader (a presence sweep) and a writer (an incoming
    // message) share one file without one of them failing with SQLITE_BUSY.
    try { db.exec('PRAGMA journal_mode = WAL'); } catch (error) { logger.warn?.('WAL unavailable', { error: error.message }); }
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA synchronous = NORMAL');
  }

  const version = Number(db.prepare('PRAGMA user_version').get().user_version || 0);
  if (version > SCHEMA_VERSION) {
    db.close();
    throw new Error(`database is schema v${version} but this server understands v${SCHEMA_VERSION}; upgrade the server`);
  }

  const statements = new Map();
  function prepare(sql) {
    let stmt = statements.get(sql);
    if (!stmt) {
      stmt = db.prepare(sql);
      statements.set(sql, stmt);
    }
    return stmt;
  }

  const api = {
    db,
    filePath,
    get version() { return Number(db.prepare('PRAGMA user_version').get().user_version || 0); },
    exec: (sql) => db.exec(sql),
    run(sql, ...params) {
      return prepare(sql).run(...params.map(normalize));
    },
    get(sql, ...params) {
      const row = prepare(sql).get(...params.map(normalize));
      return row ? { ...row } : null;
    },
    all(sql, ...params) {
      return prepare(sql).all(...params.map(normalize)).map((row) => ({ ...row }));
    },
    /** Run `fn` inside one transaction; a throw rolls everything back. */
    transaction(fn) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = fn(api);
        db.exec('COMMIT');
        return result;
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch { /* the rollback failure is not the interesting one */ }
        throw error;
      }
    },
    close() {
      statements.clear();
      db.close();
    },
  };

  if (!readonly && version < SCHEMA_VERSION) {
    for (let step = version + 1; step <= SCHEMA_VERSION; step += 1) {
      const statementsForStep = MIGRATIONS[step] || [];
      api.transaction(() => {
        for (const sql of statementsForStep) db.exec(sql);
        db.exec(`PRAGMA user_version = ${step}`);
      });
      logger.info?.('database migrated', { to: step });
    }
    // FTS is optional at runtime, so it is applied after the base schema and its
    // absence recorded rather than letting the whole boot fail.
    try {
      db.exec(FTS_V1);
      api.searchMode = 'fts5';
      logger.info?.('message search using fts5');
    } catch (error) {
      api.searchMode = 'like';
      logger.warn?.('fts5 unavailable, conversation search falls back to LIKE scanning', { error: error.message });
    }
  } else {
    try {
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='messages_fts'").get();
      api.searchMode = 'fts5';
    } catch {
      api.searchMode = 'like';
    }
  }

  return api;
}

module.exports = { openDatabase, normalize, SCHEMA_VERSION, SCHEMA_V1, FTS_V1 };
