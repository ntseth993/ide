'use strict';
/**
 * Conversations and messages — the durable truth of NovaLink Live.
 *
 * Three properties this module is built around, because everything else about
 * the feature depends on them:
 *
 *   - The database is the source of truth. A message is only "sent" once it is a
 *     row; the WebSocket is a notification about that row, and a client that
 *     misses the event can page for the same data.
 *   - Authorization is per row, not per request. Every read and write re-checks
 *     membership in `conversation_members`, so a guessed conversation id cannot
 *     return someone else's history.
 *   - A retried send must not duplicate. `client_id` is a partial unique index,
 *     so a client that resend because its connection dropped gets the original
 *     row back instead of a second copy in the recipient's inbox.
 *
 * Nothing here knows about sockets: `post()` returns the message and the list of
 * recipients that the caller must deliver to, which keeps this testable with no
 * network at all.
 */
const { ApiError, text, requiredId, optionalId, optionalLanguage, emoji, integer } = require('./validate');
const { newId } = require('./credentials');

const MAX_TITLE = 80;

function messageRow(row) {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    seq: Number(row.seq),
    senderId: row.sender_id,
    body: row.deleted_at_ms ? '' : row.body,
    language: row.language || null,
    replyToId: row.reply_to_id || null,
    clientId: row.client_id || null,
    createdAt: Number(row.created_at_ms),
    editedAt: row.edited_at_ms ? Number(row.edited_at_ms) : null,
    deleted: Boolean(row.deleted_at_ms),
    attachmentIds: [],
    reactions: [],
  };
}

function createChat({ store, accounts, connections, config, logger, now = Date.now }) {
  // ---------------------------------------------------------------------------
  // Membership
  // ---------------------------------------------------------------------------

  function memberIds(conversationId) {
    return store.all('SELECT user_id FROM conversation_members WHERE conversation_id = ?', conversationId).map((r) => r.user_id);
  }

  function isMember(conversationId, userId) {
    return Boolean(store.get('SELECT 1 AS hit FROM conversation_members WHERE conversation_id = ? AND user_id = ?', conversationId, userId));
  }

  function requireMember(conversationId, userId) {
    if (!isMember(conversationId, userId)) {
      // 404 rather than 403: telling a stranger that the id exists is an
      // information leak, and the legitimate case (a member of their own thread)
      // never hits this.
      throw new ApiError(404, 'no_conversation', 'No conversation you belong to has that id.');
    }
  }

  function conversationRow(conversationId) {
    return store.get('SELECT * FROM conversations WHERE id = ?', conversationId);
  }

  function requireConversation(conversationId) {
    const row = conversationRow(conversationId);
    if (!row) throw new ApiError(404, 'no_conversation', 'No conversation has that id.');
    return row;
  }

  /**
   * A direct thread is a two-person consent, so it is closed to new activity once
   * that consent is withdrawn - by a block, or by the pair no longer being
   * contacts (otherwise unblocking would hand a stranger the old thread back
   * without them ever being added again). History stays readable either way, and
   * groups are handled per recipient instead (see `recipientsFor`).
   * @param {object} conversation the conversation row
   * @param {string} action shown to a developer, e.g. "message"
   */
  function requireDirectOpen(conversation, userId, action = 'message') {
    if (conversation.kind !== 'direct') return;
    const other = memberIds(conversation.id).find((id) => id !== userId);
    if (!other) return;
    if (connections.isBlocked(userId, other)) {
      throw new ApiError(403, 'blocked', `You cannot ${action}: this thread is closed by a block.`);
    }
    if (!connections.areConnected(userId, other)) {
      throw new ApiError(403, 'not_connected', `You cannot ${action}: you are not contacts.`);
    }
  }

  function directKey(a, b) {
    return [a, b].sort().join(':');
  }

  function summary(conversation, viewerId) {
    const members = store.all(
      `SELECT u.id, u.username, u.display_name, u.avatar_id
         FROM conversation_members m JOIN users u ON u.id = m.user_id
        WHERE m.conversation_id = ? ORDER BY m.joined_at_ms ASC`,
      conversation.id,
    );
    const last = store.get(
      'SELECT id, body, sender_id, created_at_ms, deleted_at_ms FROM messages WHERE conversation_id = ? ORDER BY seq DESC LIMIT 1',
      conversation.id,
    );
    const me = store.get('SELECT last_read_seq FROM conversation_members WHERE conversation_id = ? AND user_id = ?', conversation.id, viewerId);
    const mySeq = Number(me?.last_read_seq || 0);
    const unread = store.get(
      'SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND seq > ? AND sender_id <> ? AND deleted_at_ms IS NULL',
      conversation.id, mySeq, viewerId,
    ).n;
    return {
      id: conversation.id,
      kind: conversation.kind,
      title: conversation.title || '',
      createdAt: Number(conversation.created_at_ms),
      lastMessageAt: Number(conversation.last_message_at_ms),
      members: members.map((m) => ({ id: m.id, username: m.username, displayName: m.display_name, avatarId: m.avatar_id || null })),
      unread: Number(unread),
      lastMessage: last
        ? { id: last.id, senderId: last.sender_id, createdAt: Number(last.created_at_ms), body: last.deleted_at_ms ? '' : String(last.body || '').slice(0, 160) }
        : null,
    };
  }

  // ---------------------------------------------------------------------------
  // Creating conversations
  // ---------------------------------------------------------------------------

  /**
   * A direct thread. Requires an accepted connection: "we are contacts" is the
   * consent that makes a private message acceptable, and it is also what stops
   * this becoming an unsolicited inbox.
   */
  function openDirect({ userId, otherUserId } = {}) {
    const other = requiredId(otherUserId, 'user id');
    if (other === userId) throw new ApiError(400, 'self_conversation', 'Open a group to talk to yourself.');
    if (!accounts.findUserById(other)) throw new ApiError(404, 'no_such_user', 'That account does not exist.');
    if (connections.isBlocked(userId, other)) throw new ApiError(403, 'blocked', 'You cannot message this person.');
    if (!connections.areConnected(userId, other)) {
      throw new ApiError(403, 'not_connected', 'You can only message accepted contacts. Send a connection request first.');
    }

    const key = directKey(userId, other);
    const existing = store.get("SELECT * FROM conversations WHERE kind = 'direct' AND direct_key = ?", key);
    if (existing) return summary(existing, userId);

    const id = newId();
    const timestamp = now();
    store.transaction(() => {
      store.run(
        `INSERT INTO conversations (id, kind, direct_key, title, created_by, created_at_ms, last_message_at_ms)
         VALUES (?, 'direct', ?, '', ?, ?, 0)`,
        id, key, userId, timestamp,
      );
      for (const member of [userId, other]) {
        store.run('INSERT INTO conversation_members (conversation_id, user_id, role, joined_at_ms) VALUES (?, ?, ?, ?)', id, member, 'member', timestamp);
      }
    });
    logger.info?.('direct conversation opened', { conversationId: id, ownerId: userId });
    return summary(requireConversation(id), userId);
  }

  function createGroup({ userId, memberIds: wanted, title } = {}) {
    const list = Array.isArray(wanted) ? wanted.map((id) => requiredId(id, 'member id')) : [];
    const unique = [...new Set(list.filter((id) => id !== userId))];
    if (!unique.length) throw new ApiError(400, 'no_members', 'A group needs at least one other contact.');
    if (unique.length + 1 > config.limits.groupMembersMax) {
      throw new ApiError(400, 'too_many_members', `A group is limited to ${config.limits.groupMembersMax} people.`);
    }
    const name = text(title, { field: 'title', max: MAX_TITLE, required: false });
    for (const member of unique) {
      if (!accounts.findUserById(member)) throw new ApiError(404, 'no_such_user', 'One of those accounts does not exist.');
      if (connections.isBlocked(userId, member)) throw new ApiError(403, 'blocked', 'One of those people cannot be added.');
      if (!connections.areConnected(userId, member)) {
        throw new ApiError(403, 'not_connected', 'Groups can only contain your accepted contacts.');
      }
    }

    const id = newId();
    const timestamp = now();
    store.transaction(() => {
      store.run(
        'INSERT INTO conversations (id, kind, title, created_by, created_at_ms, last_message_at_ms) VALUES (?, ?, ?, ?, ?, 0)',
        id, 'group', name, userId, timestamp,
      );
      store.run('INSERT INTO conversation_members (conversation_id, user_id, role, joined_at_ms) VALUES (?, ?, ?, ?)', id, userId, 'admin', timestamp);
      for (const member of unique) {
        store.run('INSERT INTO conversation_members (conversation_id, user_id, role, joined_at_ms) VALUES (?, ?, ?, ?)', id, member, 'member', timestamp);
      }
    });
    logger.info?.('group created', { conversationId: id, ownerId: userId, members: unique.length });
    return { conversation: summary(requireConversation(id), userId), memberIds: [userId, ...unique] };
  }

  function listFor(userId) {
    return store.all(
      `SELECT c.* FROM conversations c
        JOIN conversation_members m ON m.conversation_id = c.id
       WHERE m.user_id = ?
       ORDER BY c.last_message_at_ms DESC LIMIT 200`,
      userId,
    ).map((row) => summary(row, userId));
  }

  function getOne(conversationId, userId) {
    requireMember(conversationId, userId);
    return summary(requireConversation(conversationId), userId);
  }

  // ---------------------------------------------------------------------------
  // Messages
  // ---------------------------------------------------------------------------

  /**
   * Recipients for a send, minus anyone who blocked the sender. Delivering to a
   * blocker would put the message in a place they explicitly closed, and it is
   * the per-recipient rule that keeps groups usable after a falling out.
   */
  function recipientsFor(conversationId, senderId) {
    return memberIds(conversationId).filter((memberId) => memberId !== senderId && !connections.isBlocked(memberId, senderId));
  }

  function claimAttachments(conversationId, senderId, ids) {
    const list = Array.isArray(ids) ? ids.map((id) => requiredId(id, 'attachment id')) : [];
    if (list.length > config.limits.attachmentsPerMessage) {
      throw new ApiError(400, 'too_many_attachments', `A message can carry at most ${config.limits.attachmentsPerMessage} files.`);
    }
    const claimed = [];
    for (const id of list) {
      const row = store.get('SELECT * FROM attachments WHERE id = ?', id);
      if (!row || row.deleted_at_ms) throw new ApiError(404, 'no_attachment', 'One of those files is no longer available.');
      if (row.uploader_id !== senderId) throw new ApiError(403, 'not_your_file', 'You can only attach files you uploaded.');
      if (row.conversation_id !== conversationId) throw new ApiError(403, 'wrong_conversation', 'That file was uploaded for a different conversation.');
      if (row.expires_at_ms && Number(row.expires_at_ms) < now()) throw new ApiError(410, 'attachment_expired', 'One of those files has expired.');
      claimed.push(row.id);
    }
    return claimed;
  }

  /**
   * Persist one message.
   * @returns {{message: object, recipients: string[], reused: boolean}}
   */
  function post({ userId, conversationId, body, language, replyToId, attachmentIds, clientId } = {}) {
    const conversation = requireConversation(conversationId);
    requireMember(conversationId, userId);
    requireDirectOpen(conversation, userId, 'message');
    const content = text(body, { field: 'message', max: config.limits.maxMessageChars, required: false });
    const hasAttachments = Array.isArray(attachmentIds) && attachmentIds.length > 0;
    if (!content.trim() && !hasAttachments) throw new ApiError(400, 'empty_message', 'A message needs text or a file.');
    const reply = optionalId(replyToId, 'reply message id');
    if (reply) {
      const target = store.get('SELECT conversation_id FROM messages WHERE id = ?', reply);
      if (!target || target.conversation_id !== conversationId) throw new ApiError(400, 'bad_reply', 'You can only reply inside the same conversation.');
    }
    const lang = optionalLanguage(language);
    const client = clientId ? text(clientId, { field: 'client id', max: 80 }) : null;
    const claimed = claimAttachments(conversationId, userId, attachmentIds);

    if (client) {
      const seen = store.get(
        'SELECT id FROM messages WHERE conversation_id = ? AND sender_id = ? AND client_id = ?',
        conversationId, userId, client,
      );
      // A retry: hand back the original instead of writing a second copy.
      if (seen) {
        return { message: hydrate(store.get('SELECT * FROM messages WHERE id = ?', seen.id)), recipients: [], reused: true };
      }
    }

    const timestamp = now();
    const id = newId();
    const write = () => store.transaction(() => {
      const next = Number(store.get('SELECT COALESCE(MAX(seq), 0) AS seq FROM messages WHERE conversation_id = ?', conversationId).seq) + 1;
      store.run(
        `INSERT INTO messages (id, conversation_id, seq, sender_id, body, language, reply_to_id, client_id, created_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id, conversationId, next, userId, content, lang, reply, client, timestamp,
      );
      for (const attachmentId of claimed) {
        store.run('INSERT INTO message_attachments (message_id, attachment_id) VALUES (?, ?) ON CONFLICT DO NOTHING', id, attachmentId);
      }
      store.run('UPDATE conversations SET last_message_at_ms = ? WHERE id = ? AND last_message_at_ms < ?', timestamp, conversationId, timestamp);
      store.run('UPDATE conversation_members SET last_read_seq = ? WHERE conversation_id = ? AND user_id = ?', next, conversationId, userId);
      return next;
    });

    try {
      write();
    } catch (error) {
      // The unique index on (conversation_id, sender_id, client_id) is the real
      // arbiter under a genuine race; on collision, return the winner's row.
      if (client && /UNIQUE constraint failed: messages\./.test(String(error.message))) {
        const seen = store.get('SELECT * FROM messages WHERE conversation_id = ? AND sender_id = ? AND client_id = ?', conversationId, userId, client);
        if (seen) return { message: hydrate(seen), recipients: [], reused: true };
      }
      logger.error?.('message write failed', { conversationId, error: String(error.message || error) });
      throw new ApiError(500, 'write_failed', 'The message could not be stored. Try again.');
    }

    accounts.touch(userId);
    logger.info?.('message stored', { messageId: id, conversationId, senderId: userId, attachments: claimed.length });
    return {
      message: hydrate(store.get('SELECT * FROM messages WHERE id = ?', id)),
      recipients: recipientsFor(conversationId, userId),
      reused: false,
    };
  }

  /** Attach the reactions and file metadata a client actually renders. */
  function hydrate(row) {
    if (!row) return null;
    const message = messageRow(row);
    message.attachmentIds = store.all('SELECT attachment_id FROM message_attachments WHERE message_id = ?', row.id).map((r) => r.attachment_id);
    if (message.attachmentIds.length) {
      const placeholders = message.attachmentIds.map(() => '?').join(',');
      message.attachments = store.all(
        `SELECT id, file_name, mime_type, kind, byte_size, sha256, created_at_ms, expires_at_ms
           FROM attachments WHERE id IN (${placeholders}) AND deleted_at_ms IS NULL`,
        ...message.attachmentIds,
      ).map((a) => ({
        id: a.id,
        fileName: a.file_name,
        mimeType: a.mime_type,
        kind: a.kind,
        bytes: Number(a.byte_size),
        sha256: a.sha256,
        createdAt: Number(a.created_at_ms),
        expiresAt: a.expires_at_ms ? Number(a.expires_at_ms) : null,
      }));
    }
    message.reactions = store.all(
      'SELECT emoji, COUNT(*) AS n FROM reactions WHERE message_id = ? GROUP BY emoji ORDER BY n DESC',
      row.id,
    ).map((r) => ({ emoji: r.emoji, count: Number(r.n) }));
    return message;
  }

  function withSender(message, viewerId) {
    if (!message) return null;
    const sender = accounts.findUserById(message.senderId);
    return {
      ...message,
      senderName: sender ? sender.display_name : 'former member',
      senderUsername: sender ? sender.username : null,
      reactionsMine: store.all('SELECT emoji FROM reactions WHERE message_id = ? AND user_id = ?', message.id, viewerId || '').map((r) => r.emoji),
    };
  }

  /**
   * History page, oldest-first, cursor-based on `seq` so a page cannot shift
   * under an incoming message (offset paging does exactly that).
   */
  function history({ userId, conversationId, before, limit } = {}) {
    requireMember(conversationId, userId);
    const size = integer(limit, { field: 'limit', min: 1, max: config.limits.pageSizeMax, fallback: config.limits.pageSizeDefault });
    const cursor = before === undefined || before === null || before === '' ? null : Number(before);
    const rows = cursor === null
      ? store.all('SELECT * FROM messages WHERE conversation_id = ? ORDER BY seq DESC LIMIT ?', conversationId, size)
      : store.all('SELECT * FROM messages WHERE conversation_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?', conversationId, cursor, size);
    const items = rows.reverse().map((row) => withSender(hydrate(row), userId));
    return {
      items,
      // The client asks for `nextCursor` to walk further back; absent when the
      // beginning has been reached.
      nextCursor: items.length && rows.length === size ? String(items[0].seq) : null,
    };
  }

  function addReaction({ userId, messageId, value } = {}) {
    const row = store.get('SELECT id, conversation_id, sender_id FROM messages WHERE id = ?', requiredId(messageId, 'message id'));
    if (!row) throw new ApiError(404, 'no_message', 'That message no longer exists.');
    requireMember(row.conversation_id, userId);
    // Both rules: the thread must be open at all, and a block inside a group still
    // stops one member decorating another's words.
    requireDirectOpen(requireConversation(row.conversation_id), userId, 'react to a message');
    if (connections.isBlocked(userId, row.sender_id) || connections.isBlocked(row.sender_id, userId)) {
      throw new ApiError(403, 'blocked', 'You cannot react to this message.');
    }
    const mark = emoji(value);
    store.run(
      'INSERT INTO reactions (message_id, user_id, emoji, created_at_ms) VALUES (?, ?, ?, ?) ON CONFLICT(message_id, user_id, emoji) DO NOTHING',
      row.id, userId, mark, now(),
    );
    return { message: hydrate(store.get('SELECT * FROM messages WHERE id = ?', row.id)), recipients: recipientsFor(row.conversation_id, userId) };
  }

  function removeReaction({ userId, messageId, value } = {}) {
    const row = store.get('SELECT id, conversation_id FROM messages WHERE id = ?', requiredId(messageId, 'message id'));
    if (!row) throw new ApiError(404, 'no_message', 'That message no longer exists.');
    requireMember(row.conversation_id, userId);
    // Lifting a reaction is new activity in a closed thread, so the gate applies
    // both ways; otherwise a blocked account could keep editing the conversation.
    requireDirectOpen(requireConversation(row.conversation_id), userId, 'change a reaction');
    store.run('DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?', row.id, userId, emoji(value));
    return { message: hydrate(store.get('SELECT * FROM messages WHERE id = ?', row.id)), recipients: recipientsFor(row.conversation_id, userId) };
  }

  /**
   * Mark everything up to `seq` as read.
   * @returns {{conversationId, seq, userId, recipients}} — recipients respect the
   *          reader's own read-receipt setting; if they turned receipts off, the
   *          action still applies locally but nobody is told.
   */
  function markRead({ userId, conversationId, seq } = {}) {
    requireMember(conversationId, userId);
    const target = Number(seq);
    if (!Number.isFinite(target)) throw new ApiError(400, 'missing_seq', 'A message sequence number is required.');
    const current = Number(store.get('SELECT last_read_seq FROM conversation_members WHERE conversation_id = ? AND user_id = ?', conversationId, userId).last_read_seq);
    const next = Math.max(current, target);
    store.run('UPDATE conversation_members SET last_read_seq = ? WHERE conversation_id = ? AND user_id = ?', next, conversationId, userId);
    const privacy = accounts.getPrivacy(userId);
    const recipients = privacy.readReceiptsEnabled && next !== current ? recipientsFor(conversationId, userId) : [];
    return { conversationId, seq: next, userId, recipients, changed: next !== current };
  }

  function unreadTotal(userId) {
    const row = store.get(
      `SELECT COALESCE(SUM(
            (SELECT COUNT(*) FROM messages ms
              WHERE ms.conversation_id = c.id AND ms.seq > m.last_read_seq
                AND ms.sender_id <> ? AND ms.deleted_at_ms IS NULL)), 0) AS total
         FROM conversation_members m JOIN conversations c ON c.id = m.conversation_id
        WHERE m.user_id = ?`,
      userId, userId,
    );
    return Number(row.total);
  }

  /**
   * Full-text search across messages in the caller's conversations.
   * Only rows the caller can already read are returned: the FTS index is joined
   * back through membership, so a match in someone else's thread is not a
   * result, it is a bug.
   */
  function search({ userId, query, conversationId, limit } = {}) {
    const needle = text(query, { field: 'query', max: 200 });
    if (needle.trim().length < 2) return [];
    const size = integer(limit, { field: 'limit', min: 1, max: config.limits.searchResultsMax, fallback: 30 });
    const scope = conversationId ? requiredId(conversationId, 'conversation id') : null;
    if (scope) requireMember(scope, userId);

    if (store.searchMode === 'fts5') {
      // Each whitespace-separated term becomes a quoted phrase, so a user typing
      // `AND OR ("` gets a literal search instead of a syntax error.
      const match = needle.split(/\s+/).filter(Boolean).slice(0, 12).map((term) => `"${term.replaceAll('"', '""')}"`).join(' ');
      return store.all(
        `SELECT m.*, snippet(messages_fts, 0, '[', ']', '…', 12) AS hit
           FROM messages_fts f
           JOIN messages m ON m.rowid = f.rowid
           JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = ?
          WHERE messages_fts MATCH ?
            AND m.deleted_at_ms IS NULL
            AND (? IS NULL OR m.conversation_id = ?)
          ORDER BY bm25(messages_fts) LIMIT ?`,
        userId, match, scope, scope, size,
      ).map((row) => ({ ...withSender(hydrate(row), userId), hit: row.hit }));
    }

    const pattern = `%${needle.replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
    return store.all(
      `SELECT m.* FROM messages m
         JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = ?
        WHERE m.body LIKE ? ESCAPE '\\' AND m.deleted_at_ms IS NULL
          AND (? IS NULL OR m.conversation_id = ?)
        ORDER BY m.created_at_ms DESC LIMIT ?`,
      userId, pattern, scope, scope, size,
    ).map((row) => withSender(hydrate(row), userId));
  }

  return {
    MAX_TITLE,
    isMember,
    requireMember,
    memberIds,
    requireDirectOpen,
    recipientsFor,
    openDirect,
    createGroup,
    listFor,
    getOne,
    post,
    history,
    hydrate,
    withSender,
    addReaction,
    removeReaction,
    markRead,
    unreadTotal,
    search,
    summary,
    conversationRow,
    requireConversation,
  };
}

module.exports = { createChat, messageRow };
