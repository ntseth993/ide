'use strict';
/**
 * Attachments: uploads, downloads, deletion and the expiry sweep.
 *
 * The client's word means nothing here. `Content-Type`, `Content-Length` and the
 * file name are all attacker-controlled, so:
 *
 *   - size is enforced by counting bytes *as they stream in*, then checked again
 *     against the recorded digest; the declared value only sets an early bound
 *   - the type is decided by the file's own leading bytes, never the declared
 *     MIME; what the server cannot classify is served as application/octet-stream
 *     with `Content-Disposition: attachment`, which is the boring, safe answer
 *   - formats that an OS will run on double-click (PE, ELF, Mach-O, and the
 *     Windows script/executable extensions) are refused outright: a chat file
 *     drop must not become a delivery channel
 *   - the stored file name is a generated uuid. The developer-supplied name is
 *     kept as a DISPLAY field only, so `../../.ssh/id_rsa` cannot influence the
 *     path and a name collision cannot overwrite anyone's file
 *   - every read and write re-checks conversation membership, so a valid
 *     attachment id in someone else's hands is useless
 *
 * Nothing on this path ever opens, runs, unpacks or renders a file server-side.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { ApiError, displayNameForFile, requiredId } = require('./validate');
const { refuseBody } = require('./http');
const { newId } = require('./credentials');

const SNIFF_BYTES = 8192;

// Magic-number signatures we recognise. `mime` is what the server will claim on
// download — it is derived from the bytes, so it is always true of the content.
const SIGNATURES = [
  { kind: 'image', mime: 'image/png', ext: 'png', test: (b) => b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a },
  { kind: 'image', mime: 'image/jpeg', ext: 'jpg', test: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { kind: 'image', mime: 'image/gif', ext: 'gif', test: (b) => b.slice(0, 6).toString('latin1') === 'GIF87a' || b.slice(0, 6).toString('latin1') === 'GIF89a' },
  { kind: 'image', mime: 'image/webp', ext: 'webp', test: (b) => b.slice(0, 4).toString('latin1') === 'RIFF' && b.slice(8, 12).toString('latin1') === 'WEBP' },
  { kind: 'image', mime: 'image/bmp', ext: 'bmp', test: (b) => b.slice(0, 2).toString('latin1') === 'BM' && b.length > 54 },
  { kind: 'image', mime: 'image/svg+xml', ext: 'svg', test: (b) => /^\s*<svg[\s>]/i.test(b.slice(0, 512).toString('utf8')) && /<\?xml|xmlns/i.test(b.slice(0, 512).toString('utf8')) },
  { kind: 'document', mime: 'application/pdf', ext: 'pdf', test: (b) => b.slice(0, 5).toString('latin1') === '%PDF-' },
  { kind: 'archive', mime: 'application/zip', ext: 'zip', test: (b) => b[0] === 0x50 && b[1] === 0x4b && (b[2] === 0x03 || b[2] === 0x05 || b[2] === 0x07) },
  { kind: 'archive', mime: 'application/gzip', ext: 'gz', test: (b) => b[0] === 0x1f && b[1] === 0x8b },
  { kind: 'archive', mime: 'application/x-7z-compressed', ext: '7z', test: (b) => b.slice(0, 6).toString('latin1') === '7z\xbc\xaf\x27\x1c' },
  { kind: 'document', mime: 'audio/mpeg', ext: 'mp3', test: (b) => b.slice(0, 3).toString('latin1') === 'ID3' },
  { kind: 'document', mime: 'video/mp4', ext: 'mp4', test: (b) => b.length > 12 && b.slice(4, 8).toString('latin1') === 'ftyp' },
  { kind: 'document', mime: 'audio/wav', ext: 'wav', test: (b) => b.slice(0, 4).toString('latin1') === 'RIFF' && b.slice(8, 12).toString('latin1') === 'WAVE' },
];

// Refused by content signature: these are the things a double-click runs.
const BLOCKED_SIGNATURES = [
  { name: 'windows-executable', test: (b) => b.slice(0, 2).toString('latin1') === 'MZ' },
  { name: 'elf-binary', test: (b) => b[0] === 0x7f && b.slice(1, 4).toString('latin1') === 'ELF' },
  { name: 'mach-o-binary', test: (b) => [0xfeedface, 0xfeedfacf, 0xcaffface, 0xcafffadf].some((m) => b.readUInt32LE?.(0) === (m >>> 0 & 0xffffffff)) || b.slice(0, 4).toString('hex') === 'cffaedfe' || b.slice(0, 4).toString('hex') === 'cefaedfe' },
  { name: 'java-class', test: (b) => b[0] === 0xca && b[1] === 0xfe && b[2] === 0xba && b[3] === 0xbe },
  { name: 'ms-installer', test: (b) => b[0] === 0x04 && b[1] === 0x4d && b[2] === 0xc2 && b[3] === 0xcf },
];

// Refused by extension even when the content looks benign: OSes treat these as
// runnable, and a chat drop is not the place to argue about it.
const BLOCKED_EXTENSIONS = new Set([
  'exe', 'dll', 'scr', 'msi', 'msp', 'msx', 'com', 'pif', 'bat', 'cmd', 'vbs', 'vbe',
  'jse', 'wsf', 'wsh', 'ps1', 'psm1', 'psd1', 'sh', 'cpl', 'lnk', 'jar', 'app',
  'deb', 'rpm', 'apk', 'isu', 'reg',
]);

function looksLikeText(head) {
  if (head.includes(0x00)) return false;
  const sample = head.slice(0, 4096);
  // A high ratio of control characters that are not tab/newline/CR means binary.
  let odd = 0;
  for (const byte of sample) {
    if (byte === 0x09 || byte === 0x0a || byte === 0x0d) continue;
    if (byte < 0x20 || byte === 0x7f) odd += 1;
  }
  if (sample.length && odd / sample.length > 0.05) return false;
  // Round-tripping through UTF-8 replaces invalid sequences with U+FFFD, which is
  // how a source file full of raw bytes gets caught without a second dependency.
  // The last few bytes are ignored: the sniff window can cut a multi-byte
  // character in half, and a split character is not a corrupt file.
  const safe = head.subarray(0, Math.max(0, head.length - 4));
  const decoded = Buffer.from(safe).toString('utf8');
  return !decoded.includes('\uFFFD');
}

function classify({ head, extension }) {
  for (const blocked of BLOCKED_SIGNATURES) {
    if (head.length >= 4 && blocked.test(head)) return { blocked: `the content is a ${blocked.name}` };
  }
  if (BLOCKED_EXTENSIONS.has(extension)) return { blocked: `.${extension} files are treated as executable by your operating system` };

  const named = SIGNATURES.find((entry) => entry.test(head));
  if (named) return { kind: named.kind, mime: named.mime, extension: named.ext };

  // No signature matched. Text/source is allowed — developers share code — but it
  // is labelled as text/plain, never as whatever the client claimed.
  if (looksLikeText(head)) return { kind: 'text', mime: 'text/plain; charset=utf-8', extension: extension || 'txt', text: true };
  return { kind: 'document', mime: 'application/octet-stream', extension: extension || 'bin' };
}

function createAttachments({ store, chat, connections, accounts, config, logger, now = Date.now }) {
  const filesDir = config.filesDir;
  const tmpDir = config.tmpDir;
  fs.mkdirSync(filesDir, { recursive: true });
  fs.mkdirSync(tmpDir, { recursive: true });

  const maxBytes = config.limits.maxFileBytes;

  function extensionOf(name) {
    const base = path.basename(String(name || ''));
    const dot = base.lastIndexOf('.');
    if (dot <= 0 || dot === base.length - 1) return '';
    return base.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12);
  }

  /** Rows are only ever handed out through this shape. */
  function row(rowIn) {
    return {
      id: rowIn.id,
      conversationId: rowIn.conversation_id || null,
      uploaderId: rowIn.uploader_id,
      fileName: rowIn.file_name,
      mimeType: rowIn.mime_type,
      kind: rowIn.kind,
      bytes: Number(rowIn.byte_size),
      sha256: rowIn.sha256,
      createdAt: Number(rowIn.created_at_ms),
      expiresAt: rowIn.expires_at_ms ? Number(rowIn.expires_at_ms) : null,
    };
  }

  /**
   * Release a temp upload: wait for the write stream's file handle to actually
   * close, then unlink.
   *
   * The order matters on Windows, where deleting a file that is still open fails.
   * The fire-and-forget `fs.rm(path, { force: true }, () => {})` this replaces
   * swallowed that failure in a callback nobody read, so a refused upload stayed on
   * disk - and a server that keeps every rejected upload is a disk that fills up.
   * Returns whether the file is gone, because the caller is answering a client and
   * should know if it is lying about cleanup.
   */
  function closeAndRemove(tempPath, sink) {
    return new Promise((resolve) => {
      let done = false;
      const unlink = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try {
          fs.rmSync(tempPath, { force: true });
          resolve(!fs.existsSync(tempPath));
        } catch (error) {
          logger.error?.('upload temp cleanup failed', { tempPath, error: error.message });
          resolve(false);
        }
      };
      const timer = setTimeout(unlink, 500);
      timer.unref?.();
      if (sink && !sink.closed && !sink.destroyed) sink.destroy();
      if (!sink || sink.closed) unlink();
      else sink.once('close', unlink);
    });
  }

  /**
   * Take one incoming stream into a temp file, counting bytes and hashing as it
   * goes. Shared by conversation uploads and profile photos so neither path can
   * drift from the other on the size rule — the declared length is only ever an
   * early bound, the real limit is bytes actually received.
   *
   * `res` is passed when the stream is an HTTP request: an upload that gets too big
   * must be *answered* before the connection is dropped, because a client that is
   * cut off mid-send cannot tell a rejected file from a broken network, and the UI
   * has to show the first one.
   * @returns {Promise<{head: Buffer, bytes: number, sha256: string, tempPath: string, sink: fs.WriteStream}>}
   */
  async function collect({ stream, cap, declaredBytes, res }) {
    const refuse = (limit) => {
      const error = new ApiError(413, 'file_too_large', `Files are limited to ${limit} bytes.`);
      return res ? refuseBody({ req: stream, res }, error, { corsOrigin: config.corsOrigin }) : error;
    };
    const declared = Number(declaredBytes);
    if (Number.isFinite(declared) && declared > cap) throw refuse(cap);
    const uploadId = newId();
    const tempPath = path.join(tmpDir, uploadId);
    const sink = fs.createWriteStream(tempPath);
    const hash = crypto.createHash('sha256');
    let received = 0;
    let head;
    let overflowed = false;
    try {
      head = await new Promise((resolve, reject) => {
        let headBuffer = Buffer.alloc(0);
        let ended = false;
        // Every rejection detaches first. A leftover `data` listener would keep
        // counting bytes the refusal already rejected, and - worse - keep writing
        // into a destroyed sink, turning a clean 413 into a storage error.
        const detach = () => {
          stream.off('data', onData);
          stream.off('error', onError);
          stream.off('end', onEnd);
          stream.off('close', onClose);
          sink.off('error', onSinkError);
          sink.destroy();
        };
        const onData = (chunk) => {
          received += chunk.length;
          if (received > cap) {
            overflowed = true;
            detach();
            reject(new ApiError(413, 'file_too_large', `Files are limited to ${cap} bytes.`));
            return;
          }
          hash.update(chunk);
          if (headBuffer.length < SNIFF_BYTES) headBuffer = Buffer.concat([headBuffer, chunk]).subarray(0, SNIFF_BYTES);
          if (!sink.write(chunk)) {
            stream.pause?.();
            sink.once('drain', () => stream.resume?.());
          }
        };
        const onError = () => { detach(); reject(new ApiError(400, 'upload_failed', 'The upload stream failed.')); };
        const onSinkError = () => { detach(); reject(new ApiError(500, 'storage_failed', 'The server could not write the upload.')); };
        const onEnd = () => {
          ended = true;
          // The `end` callback means "the bytes are handed over", not "the file
          // handle is closed", and the caller is about to rename this file. On
          // Windows a rename of a file that still has an open handle is a coin
          // flip, so the promise settles on the close instead.
          sink.end(() => {
            if (sink.closed) return resolve(headBuffer);
            sink.once('close', () => resolve(headBuffer));
            setTimeout(() => resolve(headBuffer), 500).unref?.();
          });
        };
        // A connection that stops without ever saying it is complete is an aborted
        // upload, not a short one. Resolving here instead - which is what an earlier
        // version did whenever `close` beat `end` - handed the caller a file that had
        // not been opened yet, and the rename after it failed with ENOENT.
        const onClose = () => {
          if (ended) return;
          detach();
          reject(new ApiError(400, 'upload_failed', 'The upload stopped before it was complete.'));
        };
        stream.on('data', onData);
        stream.on('error', onError);
        sink.on('error', onSinkError);
        stream.on('end', onEnd);
        stream.on('close', onClose);
      });
    } catch (error) {
      // Clean up first, then answer. The client cannot wait for us: an answer that
      // arrives while the partial file is still open on disk is a promise about a
      // cleanup that has not happened, and the refusals would quietly become litter.
      await closeAndRemove(tempPath, sink);
      if (overflowed) throw refuse(cap);
      throw error;
    }
    if (!received) {
      await closeAndRemove(tempPath, sink);
      throw new ApiError(400, 'empty_file', 'The uploaded file contained no bytes.');
    }
    return { head, bytes: received, sha256: hash.digest('hex'), tempPath, sink };
  }

  /**
   * Consume a request stream into a stored attachment.
   * @param {{userId, conversationId, fileName, declaredBytes, stream, res}} request
   */
  async function ingest({ userId, conversationId, fileName, declaredBytes, stream, res }) {
    const name = displayNameForFile(fileName);
    const conversation = chat.requireConversation(requiredId(conversationId, 'conversation id'));
    chat.requireMember(conversation.id, userId);
    const members = chat.memberIds(conversation.id);
    for (const member of members) {
      if (member === userId) continue;
      if (connections.isBlocked(member, userId)) throw new ApiError(403, 'blocked', 'One of the recipients cannot receive files from you.');
      if (!accounts.getPrivacy(member).attachmentsEnabled) {
        throw new ApiError(403, 'attachments_disabled', 'One of the recipients has turned file receiving off.');
      }
    }

    const { head, bytes: received, sha256, tempPath, sink } = await collect({ stream, cap: maxBytes, declaredBytes, res });
    const extension = extensionOf(name);
    const verdict = classify({ head, extension });
    if (verdict.blocked) {
      await closeAndRemove(tempPath, sink);
      logger.warn?.('upload refused', { userId, reason: verdict.blocked, bytes: received });
      throw new ApiError(415, 'file_type_refused', `This file cannot be shared: ${verdict.blocked}.`);
    }

    const id = newId();
    // Stored name is generated. The extension is the one WE detected, so a file
    // named "notes.txt" that is really a PE binary cannot masquerade on disk.
    const storedName = `${id}.${verdict.extension}`;
    fs.renameSync(tempPath, path.join(filesDir, storedName));

    const timestamp = now();
    const ttl = config.limits.attachmentTtlMs;
    store.run(
      `INSERT INTO attachments (id, conversation_id, uploader_id, file_name, stored_name, mime_type, kind,
                                byte_size, sha256, created_at_ms, expires_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, conversation.id, userId, name, storedName, verdict.mime, verdict.kind,
      received, sha256, timestamp, ttl ? timestamp + ttl : null,
    );
    logger.info?.('attachment stored', { attachmentId: id, conversationId: conversation.id, uploaderId: userId, bytes: received, kind: verdict.kind });
    return { attachment: row(store.get('SELECT * FROM attachments WHERE id = ?', id)) };
  }

  /**
   * A profile photo. Same streaming rules as any upload, three differences:
   *
   *   - only raster images are accepted. SVG is refused deliberately: an avatar is
   *     rendered inside someone else's UI without their consent, and SVG can carry
   *     scripts and external references
   *   - there is no conversation, so `conversation_id` is NULL and the row is not
   *     tied to a message. Reads go through `openAvatar`, not `find`
   *   - no expiry: a profile photo is not a transient file
   */
  async function saveAvatar({ userId, stream, declaredBytes, fileName, res }) {
    const name = displayNameForFile(fileName || 'avatar');
    const { head, bytes: received, sha256, tempPath, sink } = await collect({
      stream,
      cap: config.limits.maxAvatarBytes,
      declaredBytes,
      res,
    });
    const verdict = classify({ head, extension: extensionOf(name) });
    if (verdict.blocked) {
      await closeAndRemove(tempPath, sink);
      throw new ApiError(415, 'file_type_refused', `This image cannot be used: ${verdict.blocked}.`);
    }
    if (verdict.kind !== 'image' || verdict.extension === 'svg') {
      await closeAndRemove(tempPath, sink);
      throw new ApiError(415, 'not_an_image', 'A profile photo must be a PNG, JPEG, GIF, WebP or BMP file.');
    }

    const id = newId();
    fs.renameSync(tempPath, path.join(filesDir, `${id}.${verdict.extension}`));
    store.run(
      `INSERT INTO attachments (id, conversation_id, uploader_id, file_name, stored_name, mime_type, kind,
                                byte_size, sha256, created_at_ms, expires_at_ms)
       VALUES (?, NULL, ?, ?, ?, ?, 'image', ?, ?, ?, NULL)`,
      id, userId, name, `${id}.${verdict.extension}`, verdict.mime, received, sha256, now(),
    );
    logger.info?.('profile photo stored', { attachmentId: id, userId, bytes: received, mime: verdict.mime });
    return row(store.get('SELECT * FROM attachments WHERE id = ?', id));
  }

  /** Serve a profile photo. Public within the service: contacts need to see each other. */
  function openAvatar(id) {
    const record = store.get('SELECT * FROM attachments WHERE id = ?', requiredId(id, 'avatar id'));
    if (!record || record.deleted_at_ms || record.conversation_id || record.kind !== 'image') {
      throw new ApiError(404, 'no_avatar', 'That profile photo does not exist.');
    }
    const filePath = path.join(filesDir, path.basename(record.stored_name));
    if (!fs.existsSync(filePath)) throw new ApiError(410, 'file_lost', 'The stored image could not be read from disk.');
    return {
      stream: fs.createReadStream(filePath),
      meta: { fileName: record.file_name, mimeType: record.mime_type, bytes: Number(record.byte_size), sha256: record.sha256 },
    };
  }

  function find(id, viewerId) {
    const record = store.get('SELECT * FROM attachments WHERE id = ?', requiredId(id, 'attachment id'));
    if (!record || record.deleted_at_ms) throw new ApiError(404, 'no_file', 'That file is no longer available.');
    if (record.conversation_id) chat.requireMember(record.conversation_id, viewerId);
    else if (record.uploader_id !== viewerId) throw new ApiError(404, 'no_file', 'That file is no longer available.');
    if (record.expires_at_ms && Number(record.expires_at_ms) < now()) throw new ApiError(410, 'file_expired', 'That file has expired.');
    return record;
  }

  /** @returns {{stream: fs.ReadStream, meta: object}} */
  function openDownload(id, viewerId) {
    const record = find(id, viewerId);
    const filePath = path.join(filesDir, path.basename(record.stored_name));
    if (!fs.existsSync(filePath)) {
      // The row is the truth about what was shared; a missing blob is a storage
      // fault, reported as such instead of a silent empty download.
      logger.error?.('attachment blob missing', { attachmentId: record.id, conversationId: record.conversation_id });
      throw new ApiError(410, 'file_lost', 'The stored file could not be read from disk.');
    }
    const stat = fs.statSync(filePath);
    if (stat.size !== Number(record.byte_size)) {
      logger.error?.('attachment size drifted', { attachmentId: record.id, expected: Number(record.byte_size), actual: stat.size });
      throw new ApiError(500, 'file_inconsistent', 'The stored file no longer matches its recorded size.');
    }
    return {
      stream: fs.createReadStream(filePath),
      meta: {
        fileName: record.file_name,
        mimeType: record.mime_type,
        bytes: Number(record.byte_size),
        sha256: record.sha256,
        kind: record.kind,
      },
    };
  }

  function listFor(viewerId, conversationId) {
    chat.requireMember(conversationId, viewerId);
    return store.all(
      'SELECT * FROM attachments WHERE conversation_id = ? AND deleted_at_ms IS NULL ORDER BY created_at_ms DESC LIMIT 200',
      conversationId,
    ).map(row);
  }

  /**
   * Only the uploader may delete a file. Membership is not enough.
   *
   * The membership check comes first so that someone outside the conversation is
   * told "no such file" rather than "not yours": the latter confirms the id is
   * real, and `chat.requireMember` already answers 404 for exactly that reason.
   */
  function remove(id, userId) {
    const record = store.get('SELECT * FROM attachments WHERE id = ?', requiredId(id, 'attachment id'));
    if (!record || record.deleted_at_ms) return { ok: true, alreadyGone: true };
    if (record.conversation_id) chat.requireMember(record.conversation_id, userId);
    else if (record.uploader_id !== userId) throw new ApiError(404, 'no_file', 'That file is no longer available.');
    if (record.uploader_id !== userId) throw new ApiError(403, 'not_your_file', 'Only the person who sent a file can delete it here.');
    retire(record, now());
    logger.info?.('attachment deleted', { attachmentId: record.id, userId });
    return { ok: true };
  }

  /**
   * Take one attachment out of service: mark the row, drop its message links, and
   * unlink the blob.
   *
   * The links are removed, so the bytes become unreachable through anything at that
   * moment; keeping the file "just in case" - which an earlier version of this did
   * whenever a live message still referenced it - guaranteed an orphan on disk,
   * because nothing would ever point at that blob again. Each attachment row owns
   * exactly one uuid-named file, so retiring the row always takes the file with it.
   * Messages keep their text: history says the file is gone instead of offering a
   * dead download.
   */
  function retire(record, timestamp) {
    store.run('UPDATE attachments SET deleted_at_ms = ? WHERE id = ? AND deleted_at_ms IS NULL', timestamp, record.id);
    store.run('DELETE FROM message_attachments WHERE attachment_id = ?', record.id);
    try {
      fs.rmSync(path.join(filesDir, path.basename(record.stored_name)), { force: true });
    } catch (error) {
      logger.error?.('attachment blob cleanup failed', { attachmentId: record.id, error: error.message });
    }
    return true;
  }

  /**
   * Expiry sweep: soft-delete rows past their expiry, drop their blobs, and clear
   * abandoned partial uploads. Called on a timer, and safe to run twice.
   */
  function sweep() {
    const timestamp = now();
    const expired = store.all(
      'SELECT * FROM attachments WHERE deleted_at_ms IS NULL AND expires_at_ms IS NOT NULL AND expires_at_ms < ?',
      timestamp,
    );
    for (const record of expired) retire(record, timestamp);
    let temps = 0;
    try {
      for (const name of fs.readdirSync(tmpDir)) {
        const filePath = path.join(tmpDir, name);
        const stat = fs.statSync(filePath);
        if (timestamp - stat.mtimeMs > 60 * 60 * 1000) {
          fs.rmSync(filePath, { force: true });
          temps += 1;
        }
      }
    } catch (error) {
      logger.warn?.('temp sweep skipped', { error: error.message });
    }
    if (expired.length || temps) logger.info?.('attachment sweep', { expired: expired.length, tempFiles: temps });
    return { expired: expired.length, tempFiles: temps };
  }

  function stats() {
    const live = store.get("SELECT COUNT(*) AS n, COALESCE(SUM(byte_size), 0) AS bytes FROM attachments WHERE deleted_at_ms IS NULL");
    return { files: Number(live.n), bytes: Number(live.bytes) };
  }

  return {
    ingest,
    find,
    saveAvatar,
    openAvatar,
    openDownload,
    listFor,
    remove,
    retire,
    sweep,
    stats,
    closeAndRemove,
    row,
    classify,
    looksLikeText,
    extensionOf,
    SNIFF_BYTES,
    BLOCKED_EXTENSIONS,
    paths: { filesDir, tmpDir },
  };
}

module.exports = { createAttachments, classify, looksLikeText, SIGNATURES, BLOCKED_EXTENSIONS, BLOCKED_SIGNATURES };
