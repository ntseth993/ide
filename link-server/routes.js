'use strict';
/**
 * The REST surface of NovaLink Live.
 *
 * Rules this file exists to enforce:
 *
 *   - Identity is never read from a request body. Every handler takes the user id
 *     from `ctx.user`, which `http.js` fills in from the session credential. A
 *     body that says `"userId": "someone-else"` is data to authorise against.
 *   - Authorization lives in the domain modules (`chat.requireMember`,
 *     `connections.isBlocked`, `accounts.getPrivacy`). A route that decided for
 *     itself that the caller is allowed is a route that goes stale the next time
 *     a setting changes, so routes only ever pass the caller along.
 *   - Anything that must survive a dropped connection is a request here, not a
 *     socket frame. The socket is for things that are worthless a minute later.
 *   - Uploads and downloads stream. Nothing that could be 25 MB is ever
 *     concatenated into a Buffer.
 *
 * Success is always a JSON object; failure is always
 * `{ error: { code, message, status } }`. Shapes are documented in PROTOCOL.md.
 */
const { ApiError, requiredId, integer, boolean: validBoolean, choice } = require('./validate');
const { securityHeaders, sendJson, sendError, readJsonBody, createRouter, createContext } = require('./http');

/** Returned by a handler that wrote its own response (the streaming routes). */
const HANDLED = Symbol('handled');

function created(status, body) {
  return { status, body };
}

function createRoutes({ store, accounts, connections, presence, chat, attachments, calls, hub, events, config, logger, limiter, admin }) {
  const router = createRouter();
  const searchMode = store.searchMode;

  // ---------------------------------------------------------------------------
  // Shared views
  // ---------------------------------------------------------------------------

  /** What the caller is allowed to see about another account. */
  function cardOf(userId, viewerId) {
    const profile = accounts.profileOf(userId);
    if (!profile) return null;
    return {
      ...profile,
      ...presence.presenceOf(userId, viewerId),
      connected: connections.areConnected(viewerId, userId),
      blocked: connections.isBlocked(viewerId, userId),
      requestPending: connections.isRequestPendingBetween(viewerId, userId),
    };
  }

  function directConversationId(a, b) {
    const row = store.get("SELECT id FROM conversations WHERE kind = 'direct' AND direct_key = ?", [a, b].sort().join(':'));
    return row ? row.id : null;
  }

  function pendingFor(userId) {
    // `connections.pendingRequests` already returns shaped rows with both ids.
    const all = connections.pendingRequests(userId);
    return {
      incoming: all.filter((request) => request.addresseeId === userId),
      outgoing: all.filter((request) => request.requesterId === userId),
    };
  }

  /**
   * Everything a client must know to behave correctly, in one place: limits it
   * should enforce before sending, the ICE servers it should build a
   * RTCPeerConnection with, and whether search results are ranked or substring.
   */
  function serverInfo() {
    return {
      limits: {
        maxMessageChars: config.limits.maxMessageChars,
        maxFileBytes: config.limits.maxFileBytes,
        maxAvatarBytes: config.limits.maxAvatarBytes,
        attachmentsPerMessage: config.limits.attachmentsPerMessage,
        groupMembersMax: config.limits.groupMembersMax,
        pageSizeMax: config.limits.pageSizeMax,
        attachmentTtlMs: config.limits.attachmentTtlMs,
      },
      rtc: { iceServers: config.rtc.iceServers, turnConfigured: config.rtc.turnConfigured },
      presence: { pingMs: config.presence.pingMs, deadMs: config.presence.deadMs, awayMinutes: config.presence.awayMinutes },
      search: { mode: searchMode, ranked: searchMode === 'fts5' },
      webSocketPath: '/link',
      serverTime: Date.now(),
    };
  }

  // ---------------------------------------------------------------------------
  // Public endpoints
  // ---------------------------------------------------------------------------

  router.add('GET', '/health', () => ({
    ok: true,
    uptimeSeconds: Math.round(process.uptime()),
    serverTime: Date.now(),
    liveSockets: presence.liveCount(),
    users: Number(store.get('SELECT COUNT(*) AS n FROM users WHERE deleted_at_ms IS NULL').n),
  }), { public: true });

  router.add('POST', '/api/register', (ctx) => {
    // Registration gets the same bucket as sign-in: an open server must not
    // become a free account-creation endpoint for a script.
    if (!limiter.take('auth', `register|${ctx.ip}`).allowed) {
      throw new ApiError(429, 'rate_limited', 'Too many registration attempts. Slow down.');
    }
    const result = accounts.register(ctx.body, { ip: ctx.ip });
    return created(201, {
      token: result.token,
      user: result.user,
      privacy: accounts.getPrivacy(result.user.id),
      sessions: accounts.listSessions(result.user.id),
      server: serverInfo(),
    });
  }, { public: true });

  router.add('POST', '/api/login', (ctx) => {
    const result = accounts.login(ctx.body, { ip: ctx.ip });
    return {
      token: result.token,
      user: result.user,
      privacy: accounts.getPrivacy(result.user.id),
      sessions: accounts.listSessions(result.user.id),
      server: serverInfo(),
    };
  }, { public: true });

  // ---------------------------------------------------------------------------
  // Session and profile
  // ---------------------------------------------------------------------------

  router.add('POST', '/api/logout', async (ctx) => {
    const user = await ctx.requireUser();
    accounts.logout(ctx.session.id);
    presence.detach(ctx.session.id);
    // Only the socket carrying this session id goes; the user's other devices
    // stay online, because signing out of one laptop is not signing out of all.
    hub.dropSession(ctx.session.id, 'signed out');
    events.notifyPresence(user.id, events.contactsAudience(user.id));
    return { ok: true };
  });
  router.add('GET', '/api/me', async (ctx) => {
    const user = await ctx.requireUser();
    return {
      user,
      privacy: accounts.getPrivacy(user.id),
      sessions: accounts.listSessions(user.id),
      unread: chat.unreadTotal(user.id),
      presence: presence.presenceOf(user.id, user.id),
      server: serverInfo(),
    };
  });

  /** One call so starting NovaCode costs one round trip. */
  router.add('GET', '/api/bootstrap', async (ctx) => {
    const user = await ctx.requireUser();
    return {
      user,
      privacy: accounts.getPrivacy(user.id),
      contacts: connections.contactsOf(user.id).map((contact) => ({
        ...contact,
        ...presence.presenceOf(contact.id, user.id),
        directConversationId: directConversationId(user.id, contact.id),
      })),
      conversations: chat.listFor(user.id),
      requests: pendingFor(user.id),
      blocked: connections.blockedList(user.id),
      unread: chat.unreadTotal(user.id),
      liveCall: calls.currentFor(user.id),
      server: serverInfo(),
    };
  });

  router.add('PATCH', '/api/me', async (ctx) => {
    const user = await ctx.requireUser();
    const updated = accounts.updateProfile(user.id, {
      displayName: ctx.body.displayName,
      bio: ctx.body.bio,
      identityKey: ctx.body.identityKey,
    });
    events.onProfileChanged(user.id);
    return { user: updated };
  });

  router.add('POST', '/api/me/avatar', async (ctx) => {
    const user = await ctx.requireUser();
    const saved = await attachments.saveAvatar({
      userId: user.id,
      stream: ctx.req,
      res: ctx.res,
      fileName: ctx.query.fileName || 'avatar',
      declaredBytes: ctx.query.bytes,
    });
    const previous = accounts.findUserById(user.id)?.avatar_id;
    accounts.updateProfile(user.id, { avatarId: saved.id });
    if (previous && previous !== saved.id) attachments.remove(previous, user.id);
    events.onProfileChanged(user.id);
    return created(201, { avatar: saved, user: accounts.profileOf(user.id) });
  }, { raw: true });

  router.add('DELETE', '/api/me/avatar', async (ctx) => {
    const user = await ctx.requireUser();
    const current = accounts.findUserById(user.id)?.avatar_id;
    if (current) attachments.remove(current, user.id);
    accounts.updateProfile(user.id, { avatarId: null });
    events.onProfileChanged(user.id);
    return { user: accounts.profileOf(user.id) };
  });

  router.add('PUT', '/api/me/password', async (ctx) => {
    const user = await ctx.requireUser();
    accounts.changePassword(user.id, { currentPassword: ctx.body.currentPassword, newPassword: ctx.body.newPassword });
    // changePassword revoked every session row; close the sockets that were using
    // them, otherwise a device would keep an authenticated link to a dead token.
    hub.disconnectUser(user.id, 'password changed');
    return { ok: true, sessions: [] };
  });

  router.add('PUT', '/api/me/privacy', async (ctx) => {
    const user = await ctx.requireUser();
    const patch = {};
    for (const key of ['presenceVisibleTo', 'contactRequestsFrom']) {
      if (ctx.body[key] !== undefined) patch[key] = ctx.body[key];
    }
    for (const key of ['appearOffline', 'showLastActive', 'readReceiptsEnabled', 'callsEnabled', 'attachmentsEnabled']) {
      if (ctx.body[key] !== undefined) patch[key] = validBoolean(ctx.body[key], key);
    }
    const privacy = accounts.updatePrivacy(user.id, patch);
    // Presence is computed at read time, so nothing needs recomputing here; the
    // notification only saves contacts from waiting for their next poll.
    events.notifyPresence(user.id, events.contactsAudience(user.id));
    return { privacy };
  });

  // ---------------------------------------------------------------------------
  // Directory, connections, blocks, reports
  // ---------------------------------------------------------------------------

  router.add('GET', '/api/users/search', async (ctx) => {
    const user = await ctx.requireUser();
    const limit = integer(ctx.query.limit, { field: 'limit', min: 1, max: 50, fallback: 25 });
    return { items: accounts.searchUsers(ctx.query.q || '', { limit }).map((row) => cardOf(row.id, user.id)).filter(Boolean) };
  });

  router.add('GET', '/api/users/:id', async (ctx) => {
    const user = await ctx.requireUser();
    const card = cardOf(ctx.params.id, user.id);
    if (!card) throw new ApiError(404, 'no_such_user', 'No account with that id exists.');
    return { user: card };
  });

  router.add('GET', '/api/contacts', async (ctx) => {
    const user = await ctx.requireUser();
    return {
      items: connections.contactsOf(user.id).map((contact) => ({
        ...contact,
        ...presence.presenceOf(contact.id, user.id),
        directConversationId: directConversationId(user.id, contact.id),
      })),
      blocked: connections.blockedList(user.id),
    };
  });

  router.add('GET', '/api/requests', async (ctx) => {
    const user = await ctx.requireUser();
    return { requests: pendingFor(user.id) };
  });

  router.add('POST', '/api/requests', async (ctx) => {
    const user = await ctx.requireUser();
    const result = connections.request({
      fromUserId: user.id,
      toUserId: ctx.body.userId,
      toUsername: ctx.body.username,
      message: ctx.body.message,
    });
    if (result.alreadyConnected) return { state: 'already_connected', request: null };
    if (result.reused) return { state: 'pending', request: null };
    const request = result.request;
    if (request) {
      hub.sendTo(request.addresseeId, { type: 'connection.request', request, from: cardOf(user.id, request.addresseeId) });
      logger.info?.('contact request sent', { requesterId: user.id, addresseeId: request.addresseeId });
    }
    return created(201, { state: 'pending', request });
  });

  router.add('POST', '/api/requests/:id/accept', (ctx) => resolveRoute(ctx, true));
  router.add('POST', '/api/requests/:id/reject', (ctx) => resolveRoute(ctx, false));

  function resolveRoute(ctx, accept) {
    return ctx.requireUser().then((user) => {
      const request = connections.row(connections.resolveRequest({ userId: user.id, requestId: ctx.params.id, accept }));
      const other = request.requesterId === user.id ? request.addresseeId : request.requesterId;
      if (accept) {
        // A connection is a pair, so both ends are told. Each still receives only
        // its own filtered view of the other's presence.
        hub.sendTo(other, { type: 'connection.accepted', request });
        hub.sendTo(user.id, { type: 'connection.accepted', request });
        events.notifyPresence(other, [user.id]);
        events.notifyPresence(user.id, [other]);
      } else {
        hub.sendTo(other, { type: 'connection.rejected', requestId: request.id });
      }
      return { request };
    });
  }
  router.add('DELETE', '/api/contacts/:id', async (ctx) => {
    const user = await ctx.requireUser();
    const other = requiredId(ctx.params.id, 'user id');
    connections.removeContact({ userId: user.id, otherUserId: other });
    hub.sendTo(other, { type: 'connection.removed', userId: user.id });
    events.notifyPresence(user.id, [other]);
    return { ok: true };
  });

  router.add('GET', '/api/blocked', async (ctx) => {
    const user = await ctx.requireUser();
    return { items: connections.blockedList(user.id) };
  });

  router.add('POST', '/api/block', async (ctx) => {
    const user = await ctx.requireUser();
    const other = requiredId(ctx.body.userId, 'user id');
    connections.block({ userId: user.id, otherUserId: other });
    // Blocking does NOT sign the other person out of the service: it closes the
    // channel between this pair. Every module re-checks blocks per operation, so
    // new messages, files and calls between them stop immediately.
    const live = calls.currentFor(user.id);
    if (live && chat.memberIds(live.call.conversationId).includes(other)) {
      // Leaving the call ends a one-to-one call and removes the blocker from a
      // group; either way the blocked peer no longer shares that media session.
      const outcome = calls.hangUp({ callId: live.call.id, userId: user.id, reason: 'blocked' });
      if (outcome.audience.length) {
        // Teardown is announced as an ordinary hang-up - or as one person leaving,
        // when the call carries on without them. `endReason` stays in the server's
        // own history, because a call ending is the one event the peer has a right
        // to see and the reason is theirs, not the peer's.
        const { endReason, ...call } = outcome.call;
        hub.sendToMany(outcome.audience, {
          type: outcome.ended ? 'call.ended' : 'call.participant_left',
          call,
          userId: user.id,
          reason: 'ended',
        });
      }
    }
    // Deliberately NOT sent to `other`: telling somebody they have been blocked
    // turns a quiet boundary into a confrontation and hands a blocked account a
    // list of people who closed their door. The blocker's own devices are synced
    // so their UI is correct; the blocked person's next send answers 403, which is
    // as much as they are entitled to know.
    hub.sendTo(user.id, { type: 'connection.blocked', userId: other });
    hub.sendTo(user.id, { type: 'presence', userId: other, ...presence.presenceOf(other, user.id) });
    return { ok: true };
  });

  router.add('DELETE', '/api/block/:id', async (ctx) => {
    const user = await ctx.requireUser();
    connections.unblock({ userId: user.id, otherUserId: ctx.params.id });
    events.notifyPresence(ctx.params.id, [user.id]);
    return { ok: true };
  });

  router.add('POST', '/api/report', async (ctx) => {
    const user = await ctx.requireUser();
    const report = connections.report({
      userId: user.id,
      otherUserId: ctx.body.userId,
      reason: ctx.body.reason,
      detail: ctx.body.detail,
    });
    // A report is not a message channel: nothing is relayed to the reported user.
    return created(201, { report });
  });

  // ---------------------------------------------------------------------------
  // Conversations and messages
  // ---------------------------------------------------------------------------

  router.add('GET', '/api/conversations', async (ctx) => {
    const user = await ctx.requireUser();
    return { items: chat.listFor(user.id), unread: chat.unreadTotal(user.id) };
  });

  router.add('POST', '/api/conversations', async (ctx) => {
    const user = await ctx.requireUser();
    const kind = choice(ctx.body.kind || (ctx.body.otherUserId ? 'direct' : 'group'), ['direct', 'group'], 'conversation kind');
    if (kind === 'direct') {
      const conversation = chat.openDirect({ userId: user.id, otherUserId: ctx.body.otherUserId });
      const other = conversation.members.find((member) => member.id !== user.id);
      if (other) {
        hub.sendTo(other.id, { type: 'conversation.opened', conversationId: conversation.id, from: cardOf(user.id, other.id) });
        hub.sendTo(other.id, { type: 'unread', total: chat.unreadTotal(other.id) });
      }
      return created(201, { conversation });
    }
    const result = chat.createGroup({ userId: user.id, memberIds: ctx.body.memberIds, title: ctx.body.title });
    hub.sendToMany(result.memberIds, { type: 'conversation.joined', conversationId: result.conversation.id, kind: 'group' }, { except: user.id });
    return created(201, { conversation: result.conversation });
  });

  router.add('GET', '/api/conversations/:id', async (ctx) => {
    const user = await ctx.requireUser();
    return { conversation: chat.getOne(ctx.params.id, user.id) };
  });

  router.add('GET', '/api/conversations/:id/messages', async (ctx) => {
    const user = await ctx.requireUser();
    return chat.history({
      userId: user.id,
      conversationId: ctx.params.id,
      before: ctx.query.before,
      limit: ctx.query.limit,
    });
  });

  router.add('POST', '/api/conversations/:id/messages', async (ctx) => {
    const user = await ctx.requireUser();
    if (!limiter.take('message', user.id).allowed) {
      throw new ApiError(429, 'rate_limited', 'Too many messages. Slow down.');
    }
    const { message, recipients, reused } = chat.post({
      userId: user.id,
      conversationId: ctx.params.id,
      body: ctx.body.body,
      language: ctx.body.language,
      replyToId: ctx.body.replyToId,
      attachmentIds: ctx.body.attachmentIds,
      clientId: ctx.body.clientId,
    });
    const delivered = {};
    if (!reused) {
      // The row is already committed and durable; what follows is notification.
      // A recipient that misses it pages history and finds the same message.
      const sender = accounts.profileOf(user.id);
      const from = sender ? { id: sender.id, displayName: sender.displayName, username: sender.username, avatarId: sender.avatarId } : null;
      Object.assign(delivered, events.notify('message', recipients, {
        conversationId: message.conversationId,
        message: chat.withSender(message, message.senderId),
        from,
      }));
      for (const recipient of recipients) {
        // A delivery receipt means "at least one of your devices was handed this
        // frame" — nothing more, and nothing stored.
        if (delivered[recipient]) {
          hub.sendTo(user.id, { type: 'message.delivered', messageId: message.id, conversationId: message.conversationId, userId: recipient, at: Date.now() });
        }
        hub.sendTo(recipient, { type: 'unread', total: chat.unreadTotal(recipient) });
        hub.sendTo(recipient, { type: 'conversation.updated', conversationId: message.conversationId });
      }
      logger.info?.('message stored', { messageId: message.id, conversationId: message.conversationId, recipients: recipients.length });
    }
    return created(reused ? 200 : 201, {
      message: chat.withSender(message, user.id),
      reused,
      deliveredTo: recipients.filter((id) => delivered[id]).length,
    });
  });

  /** The durable counterpart of the socket's `message.read` frame. */
  router.add('POST', '/api/conversations/:id/read', async (ctx) => {
    const user = await ctx.requireUser();
    const result = chat.markRead({ userId: user.id, conversationId: ctx.params.id, seq: ctx.body.seq });
    if (result.recipients.length) {
      events.notify('message.read', result.recipients, { conversationId: ctx.params.id, userId: user.id, seq: result.seq });
    }
    hub.sendTo(user.id, { type: 'unread', total: chat.unreadTotal(user.id) });
    return { conversationId: ctx.params.id, seq: result.seq, changed: result.changed };
  });

  router.add('GET', '/api/conversations/:id/attachments', async (ctx) => {
    const user = await ctx.requireUser();
    return { items: attachments.listFor(user.id, ctx.params.id) };
  });

  router.add('GET', '/api/messages/search', async (ctx) => {
    const user = await ctx.requireUser();
    const items = chat.search({
      userId: user.id,
      query: ctx.query.q,
      conversationId: ctx.query.conversationId,
      limit: ctx.query.limit,
    });
    return { items, mode: searchMode };
  });

  router.add('POST', '/api/messages/:id/reactions', async (ctx) => {
    const user = await ctx.requireUser();
    const result = chat.addReaction({ userId: user.id, messageId: ctx.params.id, value: ctx.body.emoji });
    events.notify('reaction', result.recipients, {
      conversationId: result.message.conversationId,
      messageId: result.message.id,
      userId: user.id,
      removed: false,
      reactions: result.message.reactions,
    });
    return { message: chat.withSender(result.message, user.id) };
  });

  router.add('DELETE', '/api/messages/:id/reactions', async (ctx) => {
    const user = await ctx.requireUser();
    const result = chat.removeReaction({ userId: user.id, messageId: ctx.params.id, value: ctx.query.emoji });
    events.notify('reaction', result.recipients, {
      conversationId: result.message.conversationId,
      messageId: result.message.id,
      userId: user.id,
      removed: true,
      reactions: result.message.reactions,
    });
    return { message: chat.withSender(result.message, user.id) };
  });

  // ---------------------------------------------------------------------------
  // Files
  // ---------------------------------------------------------------------------

  router.add('POST', '/api/uploads', async (ctx) => {
    const user = await ctx.requireUser();
    if (!limiter.take('upload', user.id).allowed) {
      throw new ApiError(429, 'rate_limited', 'Too many uploads. Slow down.');
    }
    const result = await attachments.ingest({
      userId: user.id,
      conversationId: requiredId(ctx.query.conversationId, 'conversation id'),
      fileName: ctx.query.fileName,
      declaredBytes: ctx.query.bytes,
      stream: ctx.req,
      res: ctx.res,
    });
    return created(201, result);
  }, { raw: true });

  router.add('GET', '/api/files/:id', fileRoute);
  router.add('HEAD', '/api/files/:id', fileRoute);

  async function fileRoute(ctx) {
    const user = await ctx.requireUser();
    const { stream, meta } = attachments.openDownload(ctx.params.id, user.id);
    ctx.res.writeHead(200, {
      'Content-Type': meta.mimeType,
      'Content-Length': String(meta.bytes),
      // The type and the disposition are both the server's decision, derived
      // from the bytes: nothing the client claimed is repeated back here.
      'Content-Disposition': `${dispositionFor(meta)}; filename*=UTF-8''${encodeURIComponent(meta.fileName)}`,
      'X-Content-Sha256': meta.sha256,
    });
    stream.pipe(ctx.res);
    stream.on('error', (error) => {
      logger.error?.('download failed', { attachmentId: ctx.params.id, error: error.message });
      ctx.res.destroy();
    });
    return HANDLED;
  }

  router.add('GET', '/api/avatars/:id', async (ctx) => {
    await ctx.requireUser();
    const { stream, meta } = attachments.openAvatar(ctx.params.id);
    ctx.res.writeHead(200, {
      'Content-Type': meta.mimeType,
      'Content-Length': String(meta.bytes),
      // `inline` is safe precisely because saveAvatar refuses anything that is
      // not a raster image.
      'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(meta.fileName)}`,
      'X-Content-Sha256': meta.sha256,
    });
    stream.pipe(ctx.res);
    stream.on('error', () => ctx.res.destroy());
    return HANDLED;
  });

  router.add('DELETE', '/api/files/:id', async (ctx) => {
    const user = await ctx.requireUser();
    return attachments.remove(ctx.params.id, user.id);
  });

  function dispositionFor(meta) {
    if (meta.kind === 'image' || meta.mimeType === 'application/pdf' || meta.kind === 'text') return 'inline';
    return 'attachment';
  }

  // ---------------------------------------------------------------------------
  // Calls
  // ---------------------------------------------------------------------------

  router.add('POST', '/api/conversations/:id/calls', async (ctx) => {
    const user = await ctx.requireUser();
    const { call, ringing, relayWarning } = calls.dial({ callerId: user.id, conversationId: ctx.params.id, mode: ctx.body.mode });
    // Identity only: who is calling, not what their presence looks like to each
    // recipient, which is decided when the recipient asks.
    const from = accounts.profileOf(user.id);
    const unreachable = [];
    for (const target of ringing) {
      const delivered = hub.sendTo(target, { type: 'call.incoming', call, conversationId: call.conversationId, from });
      if (!delivered) unreachable.push(target);
    }
    return created(201, { call, ringing, unreachable, relayWarning });
  });

  router.add('POST', '/api/calls/:id/accept', async (ctx) => {
    const user = await ctx.requireUser();
    const result = calls.accept({ callId: ctx.params.id, userId: user.id });
    if (result.audience.length) {
      hub.sendToMany(result.audience, {
        type: 'call.answered',
        call: result.call,
        userId: user.id,
        becameActive: Boolean(result.becameActive),
        from: accounts.profileOf(user.id),
      });
    }
    return { call: result.call, participants: calls.participants(ctx.params.id) };
  });

  router.add('POST', '/api/calls/:id/decline', async (ctx) => {
    const user = await ctx.requireUser();
    const result = calls.decline({ callId: ctx.params.id, userId: user.id });
    if (result.audience.length) {
      hub.sendToMany(result.audience, {
        type: result.ended ? 'call.ended' : 'call.declined',
        call: result.call,
        userId: user.id,
        reason: 'declined',
      });
    }
    return { call: result.call, ended: Boolean(result.ended) };
  });

  router.add('POST', '/api/calls/:id/end', async (ctx) => {
    const user = await ctx.requireUser();
    const result = calls.hangUp({ callId: ctx.params.id, userId: user.id, reason: ctx.body.reason });
    if (result.audience.length) {
      // One person leaving a group call is not the call ending; announcing it as
      // such tears down a panel the rest of the conversation is still using.
      // No `except`: the caller's OWN other devices are showing this call too, and
      // the REST response only convinces the one that asked. A second window that
      // kept a live call panel after a hang-up on the first is the bug.
      hub.sendToMany(result.audience, {
        type: result.ended ? 'call.ended' : 'call.participant_left',
        call: result.call,
        userId: user.id,
        reason: result.call.endReason || 'left',
      });
    }
    return { call: result.call, ended: result.ended };
  });

  router.add('POST', '/api/calls/:id/cancel', async (ctx) => {
    const user = await ctx.requireUser();
    const result = calls.cancel({ callId: ctx.params.id, userId: user.id });
    hub.sendToMany(result.audience, { type: 'call.ended', call: result.call, userId: user.id, reason: 'canceled' });
    return { call: result.call };
  });

  router.add('GET', '/api/calls/current', async (ctx) => {
    const user = await ctx.requireUser();
    return { call: calls.currentFor(user.id) };
  });

  router.add('GET', '/api/conversations/:id/calls', async (ctx) => {
    const user = await ctx.requireUser();
    return { items: calls.historyOf(ctx.params.id, user.id, ctx.query.limit) };
  });

  // ---------------------------------------------------------------------------
  // Dispatcher
  // ---------------------------------------------------------------------------

  async function dispatch(req, res, url) {
    const ctx = createContext({ req, res, url, config, accounts, logger });
    securityHeaders(res);
    try {
      const route = router.match(req.method, url.pathname);
      if (!route) throw new ApiError(404, 'not_found', `No route matches ${req.method} ${url.pathname}.`);
      ctx.params = route.params;

      // General bucket is keyed on the address plus the credential, so one busy
      // client cannot exhaust the budget of everyone behind the same proxy.
      const gate = limiter.take('general', `${ctx.ip}|${ctx.credential ? ctx.credential.slice(-8) : 'anon'}`);
      if (!gate.allowed) throw new ApiError(429, 'rate_limited', 'Too many requests. Slow down.');

      if (!route.route.options.raw && ctx.method !== 'GET' && ctx.method !== 'HEAD') {
        ctx.body = await readJsonBody(req, res, { maxBytes: config.limits.maxJsonBytes, corsOrigin: config.corsOrigin });
      }

      const result = await route.route.handler(ctx);
      if (result === HANDLED) return;
      if (result && typeof result === 'object' && 'body' in result && typeof result.status === 'number') {
        sendJson(res, result.status, result.body, { corsOrigin: config.corsOrigin });
        return;
      }
      sendJson(res, 200, result ?? {}, { corsOrigin: config.corsOrigin });
    } catch (error) {
      // `readJsonBody` already wrote the 413 for an oversized body; a second
      // response on the same socket would be an ERR_HTTP_HEADERS_SENT crash.
      if (error && error.answered) {
        logger.warn?.('request body refused', { method: req.method, path: url.pathname, status: error.status, code: error.code, ip: ctx.ip });
        return;
      }
      const { known } = sendError(res, error, { corsOrigin: config.corsOrigin });
      if (known) {
        logger[error.status === 404 ? 'debug' : 'warn']?.('request refused', {
          method: req.method, path: url.pathname, status: error.status, code: error.code, ip: ctx.ip,
        });
      } else {
        logger.error?.('request failed', { method: req.method, path: url.pathname, ip: ctx.ip, error: String(error.message || error) });
      }
    }
  }

  return { router, dispatch, HANDLED, routeCount: () => router.routes.length };
}

module.exports = { createRoutes };
