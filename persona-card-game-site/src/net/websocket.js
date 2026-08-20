/**
 * WebSocket transport — the same four methods as every other transport in this
 * project (see transport.js), carried over a socket to the relay.
 *
 * The relay (server/relay.js) is a dumb pipe: it seats two players in a room and
 * forwards their messages verbatim. Everything above this file — the match
 * protocol, the board, the rules engine — is unchanged and unaware. Swapping
 * WebRTC for this is swapping which object is handed to `createHostSession`.
 *
 * Two responsibilities beyond `send`/`onMessage`:
 *
 *  1. **Pipe is not payload.** The relay's own messages are namespaced under
 *     `relay` and are consumed here; the game never sees them.
 *  2. **Connected means BOTH players are here.** A host connects to an empty
 *     room and waits. `connected` resolves only once the relay reports a peer,
 *     because `createHostSession` starts dealing the moment it is constructed.
 */
import { TIMING } from './presence.js';

/** Close codes the relay uses, mirrored from server/relay.js. */
const RELAY_CLOSE = {
  4000: 'The relay rejected the connection.',
  4004: 'That match code is unknown or has expired.',
  4009: 'That match is already full.',
  4010: 'Your opponent disconnected.',
  4011: 'You reconnected to this match somewhere else.',
};

/**
 * Sent when a player leaves on purpose, so the relay frees their seat instead of
 * holding it open for a reconnect that is never coming. Mirrored from
 * server/relay.js — see the note there on why this is a close code and not a
 * message.
 */
export const GOODBYE_CODE = 4012;

/** Close codes that mean "do not try to come back". */
function isFinalClose(code) {
  return code === 4000 || code === 4004 || code === 4009 || code === 4011 || code === GOODBYE_CODE;
}

/**
 * Turn a close code into something worth showing a player.
 *
 * 1006 is the one worth knowing about: it means the socket died without a
 * proper close handshake, which in practice is almost always a proxy that has
 * not been told to forward the WebSocket upgrade (see the nginx config) or a
 * relay that is not running.
 */
export function closeReason(code, fallback = 'connection closed') {
  if (RELAY_CLOSE[code]) return RELAY_CLOSE[code];
  if (code === 1000 || code === 1005) return 'connection closed';
  if (code === 1006) return 'the connection dropped — is the relay running and proxied correctly?';
  if (code === 1001) return 'the other side navigated away';
  return fallback;
}

export function websocketSupported() {
  return typeof globalThis.WebSocket === 'function';
}

/**
 * Where the relay lives when nothing is configured: the same host the page came
 * from, at `/ws`, with the scheme upgraded alongside the page's own. That is
 * what the nginx config in the README sets up, so a deployed site needs no
 * setting at all.
 *
 * In `vite dev` the page is served from :5173 and the relay is not, so a
 * development override is expected — hence the setting.
 */
export function defaultRelayUrl(location = globalThis.location) {
  if (!location?.host) return '';
  return `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`;
}

/**
 * The relay's plain-HTTP health route, derived from its WebSocket URL.
 * `wss://host/ws` -> `https://host/ws/health`, which is what nginx forwards.
 */
export function relayHealthUrl(wsUrl) {
  const url = String(wsUrl || '').trim().replace(/\/+$/, '');
  if (!url) return '';
  return `${url.replace(/^ws/, 'http')}/health`;
}

/**
 * Is a relay actually there?
 *
 * Asked before the UI offers a link, so "no relay configured" and "relay is
 * down" both fall back to the copy-paste handshake rather than presenting a
 * link that cannot work. A failed probe is never an error the player sees.
 */
export async function relayAvailable(wsUrl, { fetchImpl = globalThis.fetch, timeoutMs = 2000 } = {}) {
  const url = relayHealthUrl(wsUrl);
  if (!url || typeof fetchImpl !== 'function') return false;

  const controller = typeof AbortController === 'function' ? new AbortController() : null;

  const probe = (async () => {
    try {
      const response = await fetchImpl(url, controller ? { signal: controller.signal } : undefined);
      return Boolean(response?.ok);
    } catch (error) {
      // A signal and a fetch from different realms (jsdom's AbortController over
      // Node's fetch, say) are refused by the implementation. The abort is a
      // courtesy, not the timeout — so drop it and let the race below do the
      // timing out, rather than reporting a live relay as dead.
      if (controller && /signal/i.test(error?.message ?? '')) {
        try {
          return Boolean((await fetchImpl(url))?.ok);
        } catch {
          return false;
        }
      }
      return false;
    }
  })();

  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      controller?.abort();
      resolve(false);
    }, timeoutMs);
  });

  try {
    return await Promise.race([probe, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `wss://host/ws` + room + role, with the code normalised the way the relay
 * expects. A `token` is added only when resuming a seat this client already
 * held — see the reconnect notes in server/relay.js.
 */
function relayUrl(base, code, role, token = '') {
  const url = String(base || '').trim().replace(/\/+$/, '');
  if (!url) throw new Error('No relay server is configured.');
  const query = `room=${encodeURIComponent(String(code).toUpperCase())}&role=${role}`;
  return token ? `${url}?${query}&token=${encodeURIComponent(token)}` : `${url}?${query}`;
}

/* ------------------------------------------------------------------ *
 * The transport
 * ------------------------------------------------------------------ */

/**
 * Wrap a live socket in the transport interface.
 *
 * DESIGN NOTE — the queue. `createHostSession` attaches its message handler
 * when it is constructed, which is AFTER `connected` resolves. The guest's
 * `hello` can easily arrive in between, and a dropped `hello` is a match that
 * never starts. So messages received before anyone is listening are queued and
 * flushed to the first handler that registers. This is the same race that bit
 * the relay smoke test, and it is the reason both files buffer.
 */
function wrapSocket(socket, { onPeerLeft, onPeerBack } = {}) {
  const messageHandlers = new Set();
  const closeHandlers = new Set();
  const pending = [];
  let closed = false;
  let lastCode = null;

  const shutdown = (reason) => {
    if (closed) return;
    closed = true;
    for (const handler of closeHandlers) handler(reason, lastCode);
  };

  socket.addEventListener('message', (event) => {
    let parsed;
    try {
      parsed = JSON.parse(event.data);
    } catch {
      return; // not our protocol; ignore rather than crash the match
    }

    // Pipe, not payload: the relay's own chatter stops here.
    if (parsed?.relay) {
      if (parsed.relay === 'peer' && parsed.state === 'left') {
        onPeerLeft?.({ deliberate: Boolean(parsed.deliberate) });
      }
      // A peer re-seating themselves mid-match is the end of a grace countdown.
      if (parsed.relay === 'peer' && parsed.state === 'joined') {
        onPeerBack?.({ resumed: Boolean(parsed.resumed) });
      }
      return;
    }

    if (!messageHandlers.size) {
      pending.push(parsed);
      return;
    }
    for (const handler of messageHandlers) handler(parsed);
  });

  socket.addEventListener('close', (event) => {
    lastCode = event?.code ?? null;
    shutdown(closeReason(event?.code));
  });
  socket.addEventListener('error', () => shutdown('connection error'));

  return {
    name: 'websocket',
    get closed() {
      return closed || socket.readyState !== 1;
    },
    /** The close code, once there has been one. Decides whether to re-dial. */
    get closeCode() {
      return lastCode;
    },
    send(message) {
      if (this.closed) throw new Error('Connection is closed');
      socket.send(JSON.stringify(message));
    },
    onMessage(handler) {
      messageHandlers.add(handler);
      // Whatever arrived before anyone was listening belongs to this handler.
      if (pending.length) {
        const queued = pending.splice(0, pending.length);
        for (const message of queued) handler(message);
      }
      return () => messageHandlers.delete(handler);
    },
    onClose(handler) {
      closeHandlers.add(handler);
      return () => closeHandlers.delete(handler);
    },
    /**
     * `deliberate` distinguishes quitting from dropping. It reaches the relay as
     * a close code, which frees the seat instead of holding it for a reconnect
     * that is not coming — and stops this client from trying to re-dial.
     */
    close(reason = 'closed', { deliberate = false } = {}) {
      if (deliberate) lastCode = GOODBYE_CODE;
      shutdown(reason);
      try {
        if (deliberate) socket.close(GOODBYE_CODE, 'goodbye');
        else socket.close();
      } catch {
        /* already gone */
      }
    },
  };
}

/**
 * Open a socket to the relay and wait until the room holds both players.
 *
 * @returns {{ code: string, connected: Promise<object>, cancel: () => void }}
 *   `connected` resolves with a transport, or rejects with a message fit to put
 *   in front of a player.
 */
function connect(role, { url, code, token = '', WebSocketImpl = globalThis.WebSocket, onPeerLeft, onPeerBack } = {}) {
  if (typeof WebSocketImpl !== 'function') throw new Error('This browser does not support WebSockets.');
  const target = relayUrl(url, code, role, token);
  const socket = new WebSocketImpl(target);

  let settled = false;
  let peerLeft = false;
  let seat = null;
  /** The relay's proof of who we are, needed to reclaim this seat later. */
  let seatToken = token;

  /**
   * Resolves as soon as the relay confirms the room, before any peer arrives.
   *
   * This is the difference between "I asked for a room" and "I have one". The
   * host must not show a match link until the room actually exists, or a code
   * the relay refused would be shared as though it worked.
   */
  let markJoined;
  let markJoinFailed;
  const joined = new Promise((resolve, reject) => {
    markJoined = resolve;
    markJoinFailed = reject;
  });

  const connected = new Promise((resolve, reject) => {
    // Built before the handshake completes, so no message can be missed
    // between the peer arriving and the game attaching its handlers.
    const transport = wrapSocket(socket, {
      onPeerLeft: (info) => {
        peerLeft = true;
        onPeerLeft?.(info);
      },
      onPeerBack: (info) => {
        peerLeft = false;
        onPeerBack?.(info);
      },
    });

    const fail = (message) => {
      markJoinFailed(new Error(message));
      if (settled) return;
      settled = true;
      try {
        socket.close();
      } catch {
        /* nothing to close */
      }
      reject(new Error(message));
    };

    const succeed = () => {
      if (settled) return;
      settled = true;
      resolve(transport);
    };

    socket.addEventListener('message', (event) => {
      if (settled) return;
      let parsed;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        return;
      }
      if (parsed?.relay === 'error') fail(parsed.message || 'The relay refused the connection.');
      if (parsed?.relay === 'joined') {
        seat = parsed.seat;
        seatToken = parsed.token || seatToken;
        markJoined({
          seat: parsed.seat,
          room: parsed.room,
          token: seatToken,
          resumed: Boolean(parsed.resumed),
        });
      }
      // `joined` already carries whether the other player is in the room, so a
      // guest joining a waiting host connects without a second round trip.
      if (parsed?.relay === 'joined' && parsed.peer) succeed();
      if (parsed?.relay === 'peer' && parsed.state === 'joined') succeed();
    });

    socket.addEventListener('close', (event) => {
      // Losing the socket before both players are seated is a failure to
      // connect; losing it afterwards is the transport's business, not ours.
      fail(closeReason(event?.code, 'The connection closed before the match began.'));
    });

    socket.addEventListener('error', () => {
      fail('Could not reach the relay server.');
    });
  });

  // Both promises are optional to the caller: the host awaits `joined` then
  // `connected`, the guest only `connected`. A rejection nobody is listening to
  // yet would otherwise surface as an unhandled rejection, so each is given a
  // no-op handler. Callers still see their own rejections as normal.
  joined.catch(() => {});
  connected.catch(() => {});

  return {
    code: String(code).toUpperCase(),
    joined,
    connected,
    /** Which seat the relay gave us, once it has said so. */
    get seat() {
      return seat;
    },
    /** Present it to reclaim this seat after a drop. */
    get token() {
      return seatToken;
    },
    /** True once the peer has been reported gone — used by the waiting screen. */
    get peerLeft() {
      return peerLeft;
    },
    cancel() {
      try {
        socket.close();
      } catch {
        /* nothing to close */
      }
    },
  };
}

/**
 * Host side: creates the room and waits for someone to open the link.
 * The code is generated by the caller (see shortcode.js) — the relay does not
 * mint codes, it only seats whoever quotes one.
 */
export function connectAsHost(options) {
  return connect('host', options);
}

/** Guest side: joins an existing room, failing fast if the code is wrong. */
export function connectAsGuest(options) {
  return connect('guest', options);
}

/* ------------------------------------------------------------------ *
 * Reconnecting transport
 * ------------------------------------------------------------------ */

/**
 * A transport that outlives the socket underneath it.
 *
 * Everything above this file holds ONE transport object for the whole match. When
 * the socket dies, this re-dials the relay — presenting the seat token, so it
 * lands back in the same seat — and swaps the new socket in underneath, with the
 * message handlers registered by `createHostSession`/`createGuestSession` still
 * attached. Neither session is rebuilt and no state is lost, which is what makes
 * "resume exactly where it was" possible at all.
 *
 * What it deliberately does NOT do is queue outbound messages while offline. A
 * move made during a disconnect would arrive seconds later against a position
 * that has moved on, and the host would reject it anyway. Instead `send` throws,
 * the UI blocks input behind the reconnect overlay, and the host re-sends the
 * full state on resume — one authoritative resync beats a replayed backlog.
 *
 * @returns a transport with the usual four methods, plus `status`/`onStatus` and
 *          `onPeerPresence` for the layer that draws the countdown.
 */
export function createResilientTransport(role, options = {}) {
  const {
    url,
    code,
    WebSocketImpl = globalThis.WebSocket,
    backoff = TIMING.RECONNECT_BACKOFF_MS,
    schedule = (fn, ms) => setTimeout(fn, ms),
    unschedule = (handle) => clearTimeout(handle),
  } = options;

  const messageHandlers = new Set();
  const closeHandlers = new Set();
  const statusHandlers = new Set();
  const peerHandlers = new Set();
  const pending = [];

  let inner = null;
  let token = options.token ?? '';
  let attempt = 0;
  /** Set once we are never coming back: quit, or the relay refused us for good. */
  let finished = false;
  let retryTimer = null;
  let status = 'connecting';
  /**
   * When the current run of reconnection attempts began. Retrying is given up
   * once the relay would have released the seat anyway — past that point there
   * is nothing left to reconnect to, and the match has already been decided by
   * the grace period.
   */
  let droppedAt = null;

  const setStatus = (next, detail) => {
    if (finished && next !== 'closed') return;
    if (next === status) return;
    status = next;
    for (const handler of statusHandlers) handler(next, detail);
  };

  const deliver = (message) => {
    if (!messageHandlers.size) {
      pending.push(message);
      return;
    }
    for (const handler of messageHandlers) handler(message);
  };

  const notifyPeer = (state, info) => {
    for (const handler of peerHandlers) handler(state, info);
  };

  const finish = (reason) => {
    if (finished) return;
    finished = true;
    setStatus('closed', reason);
    for (const handler of closeHandlers) handler(reason);
  };

  /** Attach a freshly connected socket transport as the live one. */
  const adopt = (transport, seated) => {
    inner = transport;
    if (seated?.token) token = seated.token;
    attempt = 0;
    droppedAt = null;
    transport.onMessage(deliver);
    transport.onClose((reason) => {
      if (transport !== inner) return; // an old socket finishing its death rattle
      inner = null;
      if (finished) return;
      if (isFinalClose(transport.closeCode)) {
        finish(reason);
        return;
      }
      if (droppedAt === null) droppedAt = Date.now();
      setStatus('reconnecting', reason);
      retry();
    });
    setStatus('online');
  };

  /** One re-dial, then schedule the next if it did not take. */
  const retry = () => {
    if (finished) return;
    if (droppedAt !== null && Date.now() - droppedAt > TIMING.SEAT_RESERVATION_MS) {
      finish('could not get back to the match in time');
      return;
    }
    const delay = backoff[Math.min(attempt, backoff.length - 1)];
    attempt += 1;
    retryTimer = schedule(async () => {
      retryTimer = null;
      if (finished) return;
      // The role is unchanged on purpose: a host reconnecting is still the host,
      // and the token is what proves the seat is theirs to take back.
      const dial = connect(role, {
        url,
        code,
        token,
        WebSocketImpl,
        onPeerLeft: (info) => notifyPeer('left', info),
        onPeerBack: (info) => notifyPeer('joined', info),
      });
      try {
        const seated = await dial.joined;
        const transport = await dial.connected;
        if (finished) {
          transport.close('cancelled');
          return;
        }
        adopt(transport, seated);
      } catch (error) {
        if (finished) return;
        // The relay telling us the seat is gone is terminal; anything else is
        // most likely still-no-network, so keep trying.
        if (/unknown or has expired|given up as lost|already has a/i.test(error?.message ?? '')) {
          finish(error.message);
          return;
        }
        retry();
      }
    }, delay);
  };

  // The opening connection is the caller's to await, so its rejection is theirs
  // to see — a bad code must fail loudly rather than retry forever.
  const open = connect(role, {
    url,
    code,
    token,
    WebSocketImpl,
    onPeerLeft: (info) => notifyPeer('left', info),
    onPeerBack: (info) => notifyPeer('joined', info),
  });

  const outer = {
    name: 'websocket-resilient',
    get closed() {
      return finished;
    },
    /** 'connecting' | 'online' | 'reconnecting' | 'closed' */
    get status() {
      return status;
    },
    get online() {
      return status === 'online' && Boolean(inner) && !inner.closed;
    },
    get token() {
      return token;
    },
    get seat() {
      return open.seat;
    },

    send(message) {
      if (finished) throw new Error('Connection is closed');
      if (!inner || inner.closed) throw new Error('Connection is down');
      inner.send(message);
    },
    onMessage(handler) {
      messageHandlers.add(handler);
      if (pending.length) {
        const queued = pending.splice(0, pending.length);
        for (const message of queued) handler(message);
      }
      return () => messageHandlers.delete(handler);
    },
    /** Fires once, when the match connection is over for good. */
    onClose(handler) {
      closeHandlers.add(handler);
      return () => closeHandlers.delete(handler);
    },
    /** Our own link state, for the "reconnecting" overlay on this side. */
    onStatus(handler) {
      statusHandlers.add(handler);
      return () => statusHandlers.delete(handler);
    },
    /** The relay's report of the OTHER player coming and going. */
    onPeerPresence(handler) {
      peerHandlers.add(handler);
      return () => peerHandlers.delete(handler);
    },
    close(reason = 'closed', { deliberate = true } = {}) {
      if (retryTimer !== null) unschedule(retryTimer);
      retryTimer = null;
      const live = inner;
      inner = null;
      try {
        // Telling the relay this was on purpose is what frees the seat rather
        // than holding it open for the reconnect window.
        live?.close(reason, { deliberate });
      } catch {
        /* already gone */
      }
      finish(reason);
    },
  };

  const firstConnection = (async () => {
    const seated = await open.joined;
    const transport = await open.connected;
    adopt(transport, seated);
    return outer;
  })();
  // The caller may await only `joined`, or neither; an unobserved rejection here
  // would otherwise surface as an unhandled promise. Their own awaits still see it.
  firstConnection.catch(() => {});

  return {
    code: String(code).toUpperCase(),
    joined: open.joined,
    /** Resolves with the durable transport, not the first socket. */
    connected: firstConnection,
    transport: outer,
    cancel() {
      outer.close('cancelled', { deliberate: true });
      open.cancel();
    },
  };
}
